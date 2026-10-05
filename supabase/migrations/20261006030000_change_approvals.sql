-- Customer edits and deletes need a staff decision. Customers can no longer change or remove a delivery or product directly:
-- they send a change request, a warehouse or admin user approves or rejects it, and only an approval applies the change.
-- New products and new deliveries stay instant.

-- Like wms_org_access, but a customer is refused: only staff may change or delete existing records.
create or replace function public.wms_org_access_strict(p_org uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare r text := public.wms_org_access(p_org);
begin
  if r = 'customer' then raise exception 'Changes to existing items need approval. Send a change request instead.' using errcode = '42501'; end if;
  return r;
end $$;
revoke all on function public.wms_org_access_strict(uuid) from public, anon, authenticated;

-- The existing functions, now refusing customers.
create or replace function public.update_product(p_id uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.products; r text;
begin
  select * into p from public.products where id = p_id for update;
  if not found then raise exception 'Product not found'; end if;
  r := public.wms_org_access_strict(p.org_id);
  update public.products set
    name = case when p_patch ? 'name' then left(btrim(p_patch->>'name'), 200) else name end,
    length_cm = case when p_patch ? 'length_cm' then (p_patch->>'length_cm')::numeric else length_cm end,
    width_cm = case when p_patch ? 'width_cm' then (p_patch->>'width_cm')::numeric else width_cm end,
    height_cm = case when p_patch ? 'height_cm' then (p_patch->>'height_cm')::numeric else height_cm end,
    weight_g = case when p_patch ? 'weight_g' then (p_patch->>'weight_g')::integer else weight_g end,
    hs_code = case when p_patch ? 'hs_code' then nullif(left(btrim(p_patch->>'hs_code'), 20), '') else hs_code end,
    origin_country = case when p_patch ? 'origin_country' then nullif(left(upper(btrim(p_patch->>'origin_country')), 2), '') else origin_country end,
    tracks_lot = case when p_patch ? 'tracks_lot' then (p_patch->>'tracks_lot')::boolean else tracks_lot end,
    tracks_expiry = case when p_patch ? 'tracks_expiry' then (p_patch->>'tracks_expiry')::boolean else tracks_expiry end,
    active = case when p_patch ? 'active' then (p_patch->>'active')::boolean else active end
  where id = p_id;
  perform public.wms_audit(r, 'product.update', 'products', p_id::text, p.org_id, p_patch);
end $$;

create or replace function public.add_product_barcode(p_product uuid, p_barcode text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.products; r text; b text := btrim(coalesce(p_barcode, ''));
begin
  select * into p from public.products where id = p_product;
  if not found then raise exception 'Product not found'; end if;
  r := public.wms_org_access_strict(p.org_id);
  if b !~ '^[0-9A-Za-z._-]{4,40}$' then raise exception 'Barcode looks wrong. Use 4 to 40 letters or digits.'; end if;
  if exists (select 1 from public.product_barcodes where org_id = p.org_id and barcode = b) then raise exception 'That barcode is already in use'; end if;
  insert into public.product_barcodes (org_id, barcode, product_id) values (p.org_id, b, p_product);
  perform public.wms_audit(r, 'product.add_barcode', 'products', p_product::text, p.org_id, jsonb_build_object('barcode', b));
end $$;

create or replace function public.cancel_inbound(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.inbound_bookings; r text;
begin
  select * into b from public.inbound_bookings where id = p_id for update;
  if not found then raise exception 'Delivery not found'; end if;
  r := public.wms_org_access_strict(b.org_id);
  if b.status <> 'booked' then raise exception 'Only a delivery that has not arrived yet can be cancelled'; end if;
  update public.inbound_bookings set status = 'cancelled' where id = p_id;
  perform public.wms_audit(r, 'inbound.cancel', 'inbound_bookings', p_id::text, b.org_id, jsonb_build_object('ref', b.ref));
end $$;

create or replace function public.update_inbound(
  p_id uuid, p_carrier text, p_tracking text, p_expected date, p_notes text, p_lines jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare b public.inbound_bookings; r text; ln jsonb; q integer; pid uuid; seen uuid[] := '{}';
begin
  select * into b from public.inbound_bookings where id = p_id for update;
  if not found then raise exception 'Delivery not found'; end if;
  r := public.wms_org_access_strict(b.org_id);
  if b.status <> 'booked' or exists (select 1 from public.receipt_lines where booking_id = p_id) then raise exception 'Only a delivery that has not arrived yet can be edited'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one product'; end if;
  if jsonb_array_length(p_lines) > 200 then raise exception 'Too many lines in one delivery (200 maximum)'; end if;
  update public.inbound_bookings set carrier = nullif(left(btrim(coalesce(p_carrier, '')), 80), ''), tracking = nullif(left(btrim(coalesce(p_tracking, '')), 120), ''),
    expected_date = p_expected, notes = nullif(left(btrim(coalesce(p_notes, '')), 1000), '') where id = p_id;
  delete from public.inbound_lines where booking_id = p_id;
  for ln in select * from jsonb_array_elements(p_lines) loop
    pid := (ln->>'product_id')::uuid; q := (ln->>'qty')::integer;
    if q is null or q < 1 or q > 1000000 then raise exception 'Quantities must be between 1 and 1,000,000'; end if;
    if pid = any(seen) then raise exception 'Each product can appear once per delivery'; end if;
    if not exists (select 1 from public.products where id = pid and org_id = b.org_id and active) then raise exception 'A product on this delivery was not found or is switched off'; end if;
    seen := seen || pid;
    insert into public.inbound_lines (booking_id, org_id, product_id, expected_qty) values (p_id, b.org_id, pid, q);
  end loop;
  perform public.wms_audit(r, 'inbound.update', 'inbound_bookings', p_id::text, b.org_id, jsonb_build_object('ref', b.ref, 'lines', jsonb_array_length(p_lines)));
end $$;

create or replace function public.delete_inbound(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.inbound_bookings; r text;
begin
  select * into b from public.inbound_bookings where id = p_id for update;
  if not found then return; end if;
  r := public.wms_org_access_strict(b.org_id);
  if b.status not in ('booked','cancelled') or exists (select 1 from public.receipt_lines where booking_id = p_id) then raise exception 'This delivery has goods received against it and cannot be deleted'; end if;
  delete from public.inbound_bookings where id = p_id;
  perform public.wms_audit(r, 'inbound.delete', 'inbound_bookings', p_id::text, b.org_id, jsonb_build_object('ref', b.ref));
end $$;

create or replace function public.delete_product(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.products; r text;
begin
  select * into p from public.products where id = p_id for update;
  if not found then return; end if;
  r := public.wms_org_access_strict(p.org_id);
  if exists (select 1 from public.stock_movements where product_id = p_id) or exists (select 1 from public.stock_levels where product_id = p_id)
     or exists (select 1 from public.receipt_lines where product_id = p_id) or exists (select 1 from public.discrepancies where product_id = p_id)
     or exists (select 1 from public.inbound_lines where product_id = p_id) then
    raise exception 'This product has been used on a delivery or in stock. Switch it off instead of deleting it.';
  end if;
  delete from public.products where id = p_id;
  perform public.wms_audit(r, 'product.delete', 'products', p_id::text, p.org_id, jsonb_build_object('sku', p.sku, 'name', p.name));
end $$;

-- ---------- change requests ----------
create table public.change_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  entity text not null check (entity in ('inbound','product')),
  entity_id uuid not null,
  action text not null check (action in ('update','delete')),
  payload jsonb not null default '{}'::jsonb,
  summary text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  requested_by uuid references auth.users(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision_note text
);
create unique index change_one_pending on public.change_requests (entity, entity_id) where status = 'pending';
create index change_requests_status_idx on public.change_requests (status, requested_at);
create index change_requests_org_idx on public.change_requests (org_id, requested_at desc);
alter table public.change_requests enable row level security;
create policy "staff read change requests" on public.change_requests for select using (public.has_staff_role('admin','support','warehouse'));
create policy "members read own change requests" on public.change_requests for select using (public.is_member(org_id));
revoke insert, update, delete, truncate on public.change_requests from anon, authenticated;

-- A customer asks for a change. A newer request for the same item replaces the older pending one.
create or replace function public.request_change(p_entity text, p_id uuid, p_action text, p_payload jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare org uuid; r text; sm text; cid uuid; ln jsonb; q integer; pid uuid; seen uuid[] := '{}'; bk public.inbound_bookings; pr public.products; pl jsonb := coalesce(p_payload, '{}'::jsonb);
begin
  if p_entity not in ('inbound','product') or p_action not in ('update','delete') then raise exception 'Unknown change'; end if;
  if p_entity = 'inbound' then
    select * into bk from public.inbound_bookings where id = p_id;
    if not found then raise exception 'Delivery not found'; end if;
    org := bk.org_id;
  else
    select * into pr from public.products where id = p_id;
    if not found then raise exception 'Product not found'; end if;
    org := pr.org_id;
  end if;
  r := public.wms_org_access(org);
  if r <> 'customer' then raise exception 'Staff make changes directly, not through a request'; end if;

  if p_entity = 'inbound' then
    if bk.status not in ('booked','cancelled') or exists (select 1 from public.receipt_lines where booking_id = p_id) then raise exception 'This delivery has arrived and can no longer be changed'; end if;
    if p_action = 'update' then
      if bk.status <> 'booked' then raise exception 'A cancelled delivery cannot be edited'; end if;
      if jsonb_typeof(pl->'lines') is distinct from 'array' or jsonb_array_length(pl->'lines') = 0 then raise exception 'Add at least one product'; end if;
      if jsonb_array_length(pl->'lines') > 200 then raise exception 'Too many lines in one delivery (200 maximum)'; end if;
      for ln in select * from jsonb_array_elements(pl->'lines') loop
        pid := (ln->>'product_id')::uuid; q := (ln->>'qty')::integer;
        if q is null or q < 1 or q > 1000000 then raise exception 'Quantities must be between 1 and 1,000,000'; end if;
        if pid = any(seen) then raise exception 'Each product can appear once per delivery'; end if;
        if not exists (select 1 from public.products where id = pid and org_id = org and active) then raise exception 'A product on this delivery was not found or is switched off'; end if;
        seen := seen || pid;
      end loop;
      pl := jsonb_build_object('carrier', pl->'carrier', 'tracking', pl->'tracking', 'expected', pl->'expected', 'notes', pl->'notes', 'lines', pl->'lines');
      sm := 'Edit delivery ' || bk.ref;
    else
      sm := 'Delete delivery ' || bk.ref; pl := '{}'::jsonb;
    end if;
  else
    if p_action = 'update' then
      if not (pl ? 'name' or pl ? 'active' or pl ? 'ean') then raise exception 'Nothing to change'; end if;
      if pl ? 'name' and length(btrim(coalesce(pl->>'name', ''))) = 0 then raise exception 'The name cannot be empty'; end if;
      if pl ? 'ean' and coalesce(pl->>'ean', '') !~ '^[0-9A-Za-z._-]{4,40}$' then raise exception 'Barcode looks wrong. Use 4 to 40 letters or digits.'; end if;
      pl := jsonb_strip_nulls(jsonb_build_object('name', pl->'name', 'active', pl->'active', 'ean', pl->'ean'));
      sm := case when pl ? 'active' and (pl->>'active')::boolean is false then 'Switch off product ' when pl ? 'active' then 'Switch on product ' else 'Edit product ' end || pr.sku;
    else
      if exists (select 1 from public.stock_movements where product_id = p_id) or exists (select 1 from public.inbound_lines where product_id = p_id) or exists (select 1 from public.receipt_lines where product_id = p_id)
        then raise exception 'This product has been used on a delivery or in stock. Ask us to switch it off instead of deleting it.'; end if;
      sm := 'Delete product ' || pr.sku; pl := '{}'::jsonb;
    end if;
  end if;

  update public.change_requests set status = 'cancelled', decided_at = now(), decision_note = 'Replaced by a newer request' where entity = p_entity and entity_id = p_id and status = 'pending';
  insert into public.change_requests (org_id, entity, entity_id, action, payload, summary, requested_by) values (org, p_entity, p_id, p_action, pl, sm, auth.uid()) returning id into cid;
  perform public.wms_audit(r, 'change.request', 'change_requests', cid::text, org, jsonb_build_object('summary', sm));
  return cid;
end $$;

create or replace function public.cancel_change(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.change_requests; r text;
begin
  select * into c from public.change_requests where id = p_id for update;
  if not found then raise exception 'Request not found'; end if;
  r := public.wms_org_access(c.org_id);
  if c.status <> 'pending' then raise exception 'This request was already decided'; end if;
  update public.change_requests set status = 'cancelled', decided_at = now(), decision_note = 'Cancelled by the requester' where id = p_id;
  perform public.wms_audit(r, 'change.cancel', 'change_requests', p_id::text, c.org_id, jsonb_build_object('summary', c.summary));
end $$;

-- Staff decision. Approving applies the change in the same transaction; if it cannot be applied the whole decision is refused.
create or replace function public.decide_change(p_id uuid, p_approve boolean, p_note text default null) returns public.change_requests
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); c public.change_requests; pl jsonb; note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into c from public.change_requests where id = p_id for update;
  if not found then raise exception 'Request not found'; end if;
  if c.status <> 'pending' then raise exception 'This request was already decided'; end if;
  if not p_approve and (note is null or length(note) < 3) then raise exception 'Say why you are declining, the customer will see it'; end if;
  pl := c.payload;
  if p_approve then
    if c.entity = 'inbound' and c.action = 'update' then
      perform public.update_inbound(c.entity_id, pl->>'carrier', pl->>'tracking', nullif(pl->>'expected', '')::date, pl->>'notes', pl->'lines');
    elsif c.entity = 'inbound' and c.action = 'delete' then
      perform public.delete_inbound(c.entity_id);
    elsif c.entity = 'product' and c.action = 'update' then
      perform public.update_product(c.entity_id, pl - 'ean');
      if pl ? 'ean' then perform public.add_product_barcode(c.entity_id, pl->>'ean'); end if;
    elsif c.entity = 'product' and c.action = 'delete' then
      perform public.delete_product(c.entity_id);
    end if;
  end if;
  update public.change_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now(), decision_note = note where id = p_id returning * into c;
  perform public.wms_audit(r, case when p_approve then 'change.approve' else 'change.reject' end, 'change_requests', p_id::text, c.org_id, jsonb_build_object('summary', c.summary), note);
  return c;
end $$;

do $$ declare f text; begin
  foreach f in array array['request_change(text,uuid,text,jsonb)', 'cancel_change(uuid)', 'decide_change(uuid,boolean,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

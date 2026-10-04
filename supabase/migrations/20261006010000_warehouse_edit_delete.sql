-- Corrections: edit a delivery that has not arrived, delete things that were never used. Anything with history is switched off instead,
-- so the ledger and the audit trail always stay whole.

-- Edit a booked delivery (details and lines). Only while nothing has been received against it.
create or replace function public.update_inbound(
  p_id uuid, p_carrier text, p_tracking text, p_expected date, p_notes text, p_lines jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare b public.inbound_bookings; r text; ln jsonb; q integer; pid uuid; seen uuid[] := '{}';
begin
  select * into b from public.inbound_bookings where id = p_id for update;
  if not found then raise exception 'Delivery not found'; end if;
  r := public.wms_org_access(b.org_id);
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

-- Remove a delivery that never had goods received (booked or cancelled).
create or replace function public.delete_inbound(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.inbound_bookings; r text;
begin
  select * into b from public.inbound_bookings where id = p_id for update;
  if not found then return; end if;
  r := public.wms_org_access(b.org_id);
  if b.status not in ('booked','cancelled') or exists (select 1 from public.receipt_lines where booking_id = p_id) then raise exception 'This delivery has goods received against it and cannot be deleted'; end if;
  delete from public.inbound_bookings where id = p_id;
  perform public.wms_audit(r, 'inbound.delete', 'inbound_bookings', p_id::text, b.org_id, jsonb_build_object('ref', b.ref));
end $$;

-- Delete a product that has never been used anywhere. Otherwise it can only be switched off.
create or replace function public.delete_product(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.products; r text;
begin
  select * into p from public.products where id = p_id for update;
  if not found then return; end if;
  r := public.wms_org_access(p.org_id);
  if exists (select 1 from public.stock_movements where product_id = p_id) or exists (select 1 from public.stock_levels where product_id = p_id)
     or exists (select 1 from public.receipt_lines where product_id = p_id) or exists (select 1 from public.discrepancies where product_id = p_id)
     or exists (select 1 from public.inbound_lines where product_id = p_id) then
    raise exception 'This product has been used on a delivery or in stock. Switch it off instead of deleting it.';
  end if;
  delete from public.products where id = p_id;
  perform public.wms_audit(r, 'product.delete', 'products', p_id::text, p.org_id, jsonb_build_object('sku', p.sku, 'name', p.name));
end $$;

-- Locations: rename, and delete one that was never used.
create or replace function public.update_location(p_id uuid, p_label text) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); l public.locations;
begin
  select * into l from public.locations where id = p_id for update;
  if not found then raise exception 'Location not found'; end if;
  update public.locations set label = nullif(left(btrim(coalesce(p_label, '')), 100), '') where id = p_id;
  perform public.wms_audit(r, 'location.update', 'locations', p_id::text, null, jsonb_build_object('code', l.code, 'label', p_label));
end $$;

create or replace function public.delete_location(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); l public.locations;
begin
  select * into l from public.locations where id = p_id for update;
  if not found then return; end if;
  if exists (select 1 from public.stock_movements where location_id = p_id) or exists (select 1 from public.stock_levels where location_id = p_id)
     or exists (select 1 from public.location_assignments where location_id = p_id) then
    raise exception 'Location % has been used (stock or a customer assignment). Switch it off instead of deleting it.', l.code;
  end if;
  delete from public.locations where id = p_id;
  perform public.wms_audit(r, 'location.delete', 'locations', p_id::text, null, jsonb_build_object('code', l.code, 'kind', l.kind));
end $$;

do $$ declare f text; begin
  foreach f in array array['update_inbound(uuid,text,text,date,text,jsonb)', 'delete_inbound(uuid)', 'delete_product(uuid)', 'update_location(uuid,text)', 'delete_location(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

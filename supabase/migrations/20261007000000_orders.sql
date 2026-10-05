-- Phase C, piece 1: customer orders and reserving stock.
-- An order is accepted only if the WHOLE order can be reserved. If any line is short, nothing is reserved and the order is held, with the
-- reason, until stock arrives. Reservations are the `reserved` column on stock_levels (which can never exceed on_hand), so two orders can
-- never claim the same last unit. All writes go through functions that check the caller and write the audit log.

create sequence public.order_seq;
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  ref text not null unique default ('ORD-' || lpad(nextval('public.order_seq')::text, 6, '0')),
  external_ref text,                                   -- the customer's own order number
  channel text not null default 'manual' check (channel in ('manual','csv')),
  status text not null default 'new' check (status in ('new','held','allocated','picking','packed','shipped','cancelled')),
  hold_reason text,
  ship_name text not null, ship_company text, ship_email text, ship_phone text,
  ship_line1 text not null, ship_line2 text, ship_postal text not null, ship_city text not null,
  ship_country text not null check (ship_country ~ '^[A-Z]{2}$'),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  allocated_at timestamptz, cancelled_at timestamptz,
  held_notified_at timestamptz
);
create unique index orders_external_ref_unique on public.orders (org_id, external_ref) where external_ref is not null;
create index orders_status_idx on public.orders (status, created_at);
create index orders_org_idx on public.orders (org_id, created_at desc);
alter table public.orders enable row level security;

create table public.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id),
  qty integer not null check (qty > 0),
  unique (order_id, product_id)
);
alter table public.order_lines enable row level security;

create table public.allocations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  order_line_id uuid not null references public.order_lines(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id),
  location_id uuid not null references public.locations(id),
  lot text not null default '',
  qty integer not null check (qty > 0),
  status text not null default 'reserved' check (status in ('reserved','picked','released')),
  created_at timestamptz not null default now()
);
create index allocations_order_idx on public.allocations (order_id);
alter table public.allocations enable row level security;

do $$ declare t text; begin
  foreach t in array array['orders','order_lines','allocations'] loop
    execute format('create policy "staff read %1$s" on public.%1$s for select using (public.has_staff_role(''admin'',''support'',''warehouse''))', t);
    execute format('create policy "members read own %1$s" on public.%1$s for select using (public.is_member(org_id))', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Reserve stock for one order (all lines or nothing). Picks from bins and pallets only (never the receiving area or quarantine),
-- earliest expiry first, then by location code. Locks this customer's stock rows first so concurrent orders queue up.
create or replace function public.wms_allocate(p_order uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare o public.orders; ln record; sr record; need integer; take integer; short text := '';
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status not in ('new','held') then return o.status; end if;
  perform 1 from public.stock_levels sl where sl.org_id = o.org_id and sl.product_id in (select product_id from public.order_lines where order_id = p_order)
    order by sl.product_id, sl.location_id, sl.lot for update;
  for ln in
    select ol.product_id, ol.qty, p.sku,
      (select coalesce(sum(sl.on_hand - sl.reserved), 0)::int from public.stock_levels sl join public.locations l on l.id = sl.location_id
        where sl.org_id = o.org_id and sl.product_id = ol.product_id and l.kind in ('bin','pallet') and l.active) as free
    from public.order_lines ol join public.products p on p.id = ol.product_id where ol.order_id = p_order order by p.sku
  loop
    if ln.free < ln.qty then short := short || case when short = '' then '' else '; ' end || ln.sku || ': need ' || ln.qty || ', available ' || ln.free; end if;
  end loop;
  if short <> '' then
    update public.orders set status = 'held', hold_reason = short where id = p_order;
    return 'held';
  end if;
  for ln in select ol.id, ol.product_id, ol.qty from public.order_lines ol where ol.order_id = p_order order by ol.product_id loop
    need := ln.qty;
    for sr in
      select sl.location_id, sl.lot, sl.on_hand - sl.reserved as free
      from public.stock_levels sl join public.locations l on l.id = sl.location_id
      where sl.org_id = o.org_id and sl.product_id = ln.product_id and l.kind in ('bin','pallet') and l.active and sl.on_hand - sl.reserved > 0
      order by sl.expiry nulls last, l.code, sl.lot
    loop
      exit when need <= 0;
      take := least(need, sr.free);
      update public.stock_levels set reserved = reserved + take, updated_at = now()
        where org_id = o.org_id and product_id = ln.product_id and location_id = sr.location_id and lot = sr.lot;
      insert into public.allocations (order_id, order_line_id, org_id, product_id, location_id, lot, qty) values (p_order, ln.id, o.org_id, ln.product_id, sr.location_id, sr.lot, take);
      need := need - take;
    end loop;
    if need > 0 then raise exception 'Stock changed while reserving, please try again'; end if;
  end loop;
  update public.orders set status = 'allocated', hold_reason = null, allocated_at = now() where id = p_order;
  return 'allocated';
end $$;

-- When stock lands in a bin or is added by a count, give held orders of that customer another go, oldest first.
create or replace function public.wms_allocate_held(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o record;
begin
  for o in select id from public.orders where org_id = p_org and status = 'held' order by created_at loop
    perform public.wms_allocate(o.id);
  end loop;
end $$;
revoke all on function public.wms_allocate(uuid), public.wms_allocate_held(uuid) from public, anon, authenticated;

-- Create an order. Customers (who handle stock) and warehouse staff may. Replaying the same external_ref returns the existing order.
create or replace function public.create_order(
  p_org uuid, p_external_ref text, p_ship jsonb, p_notes text, p_lines jsonb, p_channel text default 'manual'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_org_access(p_org); oid uuid; oref text; st text; ln jsonb; q integer; pid uuid; seen uuid[] := '{}'; ext text := nullif(btrim(coalesce(p_external_ref, '')), '');
  nm text := btrim(coalesce(p_ship->>'name', '')); l1 text := btrim(coalesce(p_ship->>'line1', '')); pc text := btrim(coalesce(p_ship->>'postal', '')); ct text := btrim(coalesce(p_ship->>'city', '')); cc text := upper(btrim(coalesce(p_ship->>'country', '')));
  em text := nullif(btrim(coalesce(p_ship->>'email', '')), '');
begin
  if r = 'customer' and not exists (select 1 from public.organizations where id = p_org and status = 'active') then raise exception 'Your plan is not active yet'; end if;
  if p_channel not in ('manual','csv') then raise exception 'Unknown channel'; end if;
  if ext is not null then
    select id, ref, status into oid, oref, st from public.orders where org_id = p_org and external_ref = ext;
    if found then return jsonb_build_object('id', oid, 'ref', oref, 'status', st, 'duplicate', true); end if;
  end if;
  if nm = '' or length(nm) > 120 then raise exception 'The recipient name is required'; end if;
  if l1 = '' or length(l1) > 160 then raise exception 'The recipient street address is required'; end if;
  if pc = '' or length(pc) > 20 then raise exception 'The recipient postal code is required'; end if;
  if ct = '' or length(ct) > 100 then raise exception 'The recipient city is required'; end if;
  if cc !~ '^[A-Z]{2}$' then raise exception 'Use a two-letter country code, for example PL or DE'; end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'The recipient email looks wrong'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one product'; end if;
  if jsonb_array_length(p_lines) > 100 then raise exception 'Too many lines in one order (100 maximum)'; end if;
  insert into public.orders (org_id, external_ref, channel, ship_name, ship_company, ship_email, ship_phone, ship_line1, ship_line2, ship_postal, ship_city, ship_country, notes, created_by)
  values (p_org, ext, p_channel, left(nm, 120), nullif(left(btrim(coalesce(p_ship->>'company', '')), 120), ''), em, nullif(left(btrim(coalesce(p_ship->>'phone', '')), 40), ''),
          left(l1, 160), nullif(left(btrim(coalesce(p_ship->>'line2', '')), 160), ''), left(pc, 20), left(ct, 100), cc, nullif(left(btrim(coalesce(p_notes, '')), 500), ''), auth.uid())
  returning id, ref into oid, oref;
  for ln in select * from jsonb_array_elements(p_lines) loop
    q := (ln->>'qty')::integer;
    if q is null or q < 1 or q > 100000 then raise exception 'Quantities must be between 1 and 100,000'; end if;
    if ln ? 'product_id' and ln->>'product_id' is not null then
      pid := (ln->>'product_id')::uuid;
      if not exists (select 1 from public.products where id = pid and org_id = p_org and active) then raise exception 'A product on this order was not found or is switched off'; end if;
    else
      select id into pid from public.products where org_id = p_org and sku = btrim(coalesce(ln->>'sku', '')) and active;
      if pid is null then raise exception 'Unknown SKU %', coalesce(ln->>'sku', ''); end if;
    end if;
    if pid = any(seen) then raise exception 'Each product can appear once per order'; end if;
    seen := seen || pid;
    insert into public.order_lines (order_id, org_id, product_id, qty) values (oid, p_org, pid, q);
  end loop;
  st := public.wms_allocate(oid);
  perform public.wms_audit(r, 'order.create', 'orders', oid::text, p_org, jsonb_build_object('ref', oref, 'status', st, 'lines', jsonb_array_length(p_lines), 'channel', p_channel));
  return jsonb_build_object('id', oid, 'ref', oref, 'status', st, 'duplicate', false);
end $$;

-- Create many orders at once (a CSV import). Each order succeeds or fails on its own and the answer lists every one.
create or replace function public.import_orders(p_org uuid, p_orders jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o jsonb; res jsonb := '[]'::jsonb; one jsonb;
begin
  perform public.wms_org_access(p_org);
  if jsonb_typeof(p_orders) is distinct from 'array' or jsonb_array_length(p_orders) = 0 then raise exception 'There are no orders to import'; end if;
  if jsonb_array_length(p_orders) > 200 then raise exception 'Import at most 200 orders at a time'; end if;
  for o in select * from jsonb_array_elements(p_orders) loop
    begin
      one := public.create_order(p_org, o->>'external_ref', o->'ship', o->>'notes', o->'lines', 'csv');
      res := res || jsonb_build_array(jsonb_build_object('external_ref', o->>'external_ref', 'ok', true, 'ref', one->>'ref', 'status', one->>'status', 'duplicate', (one->>'duplicate')::boolean));
    exception when others then
      res := res || jsonb_build_array(jsonb_build_object('external_ref', o->>'external_ref', 'ok', false, 'error', sqlerrm));
    end;
  end loop;
  return res;
end $$;

-- Staff: try to reserve a held order now (for example after stock was found).
create or replace function public.allocate_order(p_order uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); st text; o public.orders;
begin
  select * into o from public.orders where id = p_order;
  if not found then raise exception 'Order not found'; end if;
  st := public.wms_allocate(p_order);
  perform public.wms_audit(r, 'order.allocate', 'orders', p_order::text, o.org_id, jsonb_build_object('ref', o.ref, 'status', st));
  return st;
end $$;

-- Cancel an order that is not being picked yet: reservations are released. Staff only. Customers ask through a change request.
create or replace function public.cancel_order(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; r text; a record;
begin
  select * into o from public.orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  r := public.wms_org_access_strict(o.org_id);
  if o.status = 'cancelled' then return; end if;
  if o.status not in ('new','held','allocated') then raise exception 'This order is already being picked or has shipped and cannot be cancelled here'; end if;
  for a in select * from public.allocations where order_id = p_id and status = 'reserved' loop
    update public.stock_levels set reserved = reserved - a.qty, updated_at = now() where org_id = a.org_id and product_id = a.product_id and location_id = a.location_id and lot = a.lot;
  end loop;
  update public.allocations set status = 'released' where order_id = p_id and status = 'reserved';
  update public.orders set status = 'cancelled', cancelled_at = now(), hold_reason = null where id = p_id;
  perform public.wms_audit(r, 'order.cancel', 'orders', p_id::text, o.org_id, jsonb_build_object('ref', o.ref));
  perform public.wms_allocate_held(o.org_id);   -- freed stock may let a held order go ahead
end $$;

-- Customers can ask to cancel an order, like every other change to something that exists: a staff member approves it.
alter table public.change_requests drop constraint change_requests_entity_check;
alter table public.change_requests add constraint change_requests_entity_check check (entity in ('inbound','product','order'));

create or replace function public.request_change(p_entity text, p_id uuid, p_action text, p_payload jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare org uuid; r text; sm text; cid uuid; ord public.orders; ln jsonb; q integer; pid uuid; seen uuid[] := '{}'; bk public.inbound_bookings; pr public.products; pl jsonb := coalesce(p_payload, '{}'::jsonb);
begin
  if p_entity not in ('inbound','product','order') or p_action not in ('update','delete') then raise exception 'Unknown change'; end if;
  if p_entity = 'order' and p_action <> 'delete' then raise exception 'An order can only be cancelled, not edited'; end if;
  if p_entity = 'order' then
    select * into ord from public.orders where id = p_id;
    if not found then raise exception 'Order not found'; end if;
    org := ord.org_id;
  elsif p_entity = 'inbound' then
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

  if p_entity = 'order' then
    if ord.status not in ('new','held','allocated') then raise exception 'This order is already being picked or has shipped and can no longer be cancelled here'; end if;
    sm := 'Cancel order ' || ord.ref; pl := '{}'::jsonb;
  elsif p_entity = 'inbound' then
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
    elsif c.entity = 'order' and c.action = 'delete' then
      perform public.cancel_order(c.entity_id);
    end if;
  end if;
  update public.change_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now(), decision_note = note where id = p_id returning * into c;
  perform public.wms_audit(r, case when p_approve then 'change.approve' else 'change.reject' end, 'change_requests', p_id::text, c.org_id, jsonb_build_object('summary', c.summary), note);
  return c;
end $$;

-- Putaway and count adjustments now give held orders another go.
create or replace function public.putaway(
  p_org uuid, p_product uuid, p_from uuid, p_to uuid, p_qty integer, p_lot text default '', p_key text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); sl public.stock_levels; lt text := coalesce(btrim(p_lot), ''); lf public.locations; lt2 public.locations;
begin
  if p_key is not null and exists (select 1 from public.stock_movements where idempotency_key = p_key || ':out') then return; end if;   -- replayed scan
  if p_qty is null or p_qty < 1 then raise exception 'Enter a quantity of at least 1'; end if;
  if p_from = p_to then raise exception 'Choose a different destination'; end if;
  select * into lf from public.locations where id = p_from; select * into lt2 from public.locations where id = p_to;
  if lf.id is null or lt2.id is null then raise exception 'Location not found'; end if;
  if lt2.kind in ('receiving','shipping') then raise exception 'Stock cannot be moved into %', lt2.code; end if;
  select * into sl from public.stock_levels where org_id = p_org and product_id = p_product and location_id = p_from and lot = lt for update;
  if not found or sl.on_hand - sl.reserved < p_qty then raise exception 'Not enough free stock at % (have %)', lf.code, coalesce(sl.on_hand - sl.reserved, 0); end if;
  perform public.wms_post(p_org, p_product, p_from, -p_qty, 'putaway', 'putaway', p_to::text, lt, sl.expiry, case when p_key is null then null else p_key || ':out' end, null);
  perform public.wms_post(p_org, p_product, p_to, p_qty, 'putaway', 'putaway', p_from::text, lt, sl.expiry, case when p_key is null then null else p_key || ':in' end, null);
  perform public.wms_allocate_held(p_org);
  perform public.wms_audit(r, 'stock.putaway', 'products', p_product::text, p_org, jsonb_build_object('from', lf.code, 'to', lt2.code, 'qty', p_qty));
end $$;

create or replace function public.adjust_stock(
  p_org uuid, p_product uuid, p_location uuid, p_delta integer, p_reason text, p_lot text default '', p_key text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); sl public.stock_levels; lt text := coalesce(btrim(p_lot), ''); l public.locations; have integer;
begin
  if p_key is not null and exists (select 1 from public.stock_movements where idempotency_key = p_key) then return; end if;   -- replayed
  if p_delta is null or p_delta = 0 then raise exception 'The change cannot be zero'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'A reason is required'; end if;
  if abs(p_delta) > 20 and r <> 'admin' then raise exception 'Changes above 20 units need an admin'; end if;
  select * into l from public.locations where id = p_location;
  if not found then raise exception 'Location not found'; end if;
  select * into sl from public.stock_levels where org_id = p_org and product_id = p_product and location_id = p_location and lot = lt for update;
  have := coalesce(sl.on_hand, 0);
  if have + p_delta < 0 then raise exception 'That would leave negative stock at % (have %)', l.code, have; end if;
  if have + p_delta < coalesce(sl.reserved, 0) then raise exception 'Part of this stock is reserved for orders'; end if;
  perform public.wms_post(p_org, p_product, p_location, p_delta, 'adjust', 'adjustment', null, lt, null, p_key, left(btrim(p_reason), 500));
  perform public.wms_allocate_held(p_org);
  perform public.wms_audit(r, 'stock.adjust', 'products', p_product::text, p_org, jsonb_build_object('location', l.code, 'delta', p_delta), btrim(p_reason));
end $$;

do $$ declare f text; begin
  foreach f in array array['create_order(uuid,text,jsonb,text,jsonb,text)', 'import_orders(uuid,jsonb)', 'allocate_order(uuid)', 'cancel_order(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

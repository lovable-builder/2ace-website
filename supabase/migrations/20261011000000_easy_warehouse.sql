-- Easier warehouse: fewer steps, fewer things to set up first.
--  * Good goods are received straight into the customer's own bin and are available immediately (like Odoo's one-step receipt).
--  * The customer's bin, the receiving area, quarantine and the packing station are created automatically the first time they are needed.
--  * "Add stock" puts units on the shelf in one step (opening stock, a recount, or testing) without booking and receiving a delivery.
-- A setting keeps the old two-step flow available ('auto_putaway' = 'off').

create table public.wms_settings (key text primary key, value text not null);
insert into public.wms_settings values ('auto_putaway', 'on');
alter table public.wms_settings enable row level security;
create policy "staff read wms settings" on public.wms_settings for select using (public.has_staff_role('admin','support','warehouse'));
revoke insert, update, delete, truncate on public.wms_settings from anon, authenticated;
create or replace function public.wms_setting(p_key text) returns text language sql stable security definer set search_path = '' as $$ select value from public.wms_settings where key = p_key $$;

-- The first free area of this kind, or a new one with the given code.
create or replace function public.wms_ensure_location(p_kind text, p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select l.id into v_id from public.locations l where l.active and l.kind = p_kind order by l.code limit 1;
  if v_id is not null then return v_id; end if;
  insert into public.locations (code, kind, label) values (p_code, p_kind, 'Created automatically') on conflict (code) do nothing returning locations.id into v_id;
  if v_id is null then raise exception 'Location code % is already taken by something else. Create a % location first.', p_code, p_kind; end if;
  perform public.wms_audit(public.staff_role(), 'location.auto_create', 'locations', v_id::text, null, jsonb_build_object('code', p_code, 'kind', p_kind));
  return v_id;
end $$;

-- The customer's bin for new stock: their first active bin or pallet slot, else a new bin named after them and assigned to them.
create or replace function public.wms_default_bin(p_org uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text; v_base text; v_code text; n integer := 0;
begin
  select l.id into v_id from public.locations l join public.location_assignments a on a.location_id = l.id and a.released_at is null and a.org_id = p_org
    where l.active and l.kind in ('bin','pallet') order by (l.kind = 'bin') desc, l.code limit 1;
  if v_id is not null then return v_id; end if;
  select name into v_name from public.organizations where id = p_org;
  if not found then raise exception 'Customer not found'; end if;
  v_base := upper(left(regexp_replace(coalesce(v_name, ''), '[^A-Za-z0-9]', '', 'g'), 10)); if v_base = '' then v_base := 'CUST'; end if;
  loop
    n := n + 1; v_code := v_base || '-' || lpad(n::text, 2, '0');
    exit when not exists (select 1 from public.locations where code = v_code);
    if n > 99 then raise exception 'Could not find a free bin code for this customer. Create a bin by hand.'; end if;
  end loop;
  insert into public.locations (code, kind, label) values (v_code, 'bin', 'Default bin (created automatically)') returning locations.id into v_id;
  insert into public.location_assignments (location_id, org_id, assigned_by) values (v_id, p_org, auth.uid());
  perform public.wms_audit(public.staff_role(), 'location.auto_create', 'locations', v_id::text, p_org, jsonb_build_object('code', v_code, 'kind', 'bin'));
  return v_id;
end $$;
revoke all on function public.wms_setting(text), public.wms_ensure_location(text,text), public.wms_default_bin(uuid) from public, anon, authenticated;

create or replace function public.receive_line(
  p_booking uuid, p_product uuid, p_qty integer, p_condition text, p_lot text default '', p_expiry date default null, p_note text default null, p_key text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); b public.inbound_bookings; pr public.products; cond text := p_condition; loc uuid; mid bigint; lt text := coalesce(btrim(p_lot), ''); rid uuid;
begin
  select * into b from public.inbound_bookings where id = p_booking for update;
  if not found then raise exception 'Delivery not found'; end if;
  if b.status not in ('booked','receiving') then raise exception 'This delivery is already %', b.status; end if;
  select * into pr from public.products where id = p_product and org_id = b.org_id;
  if not found then raise exception 'That product does not belong to this customer'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 1000000 then raise exception 'Enter a quantity of at least 1'; end if;
  if cond not in ('good','damaged','unexpected') then raise exception 'Choose good or damaged'; end if;
  if cond = 'good' and not exists (select 1 from public.inbound_lines where booking_id = p_booking and product_id = p_product) then cond := 'unexpected'; end if;
  if pr.tracks_lot and lt = '' then raise exception 'This product needs a lot number'; end if;
  if pr.tracks_expiry and p_expiry is null then raise exception 'This product needs an expiry date'; end if;
  -- Good goods go straight into the customer's own bin (created automatically on first use) and are available at once.
  -- Damaged goods go to quarantine and unexpected goods to the receiving area, where a person decides. Those areas are created on first use.
  if cond = 'good' and public.wms_setting('auto_putaway') = 'on' then loc := public.wms_default_bin(b.org_id);
  elsif cond = 'damaged' then loc := public.wms_ensure_location('quarantine', 'QUARANTINE');
  else loc := public.wms_ensure_location('receiving', 'RECEIVING'); end if;
  mid := public.wms_post(b.org_id, p_product, loc, p_qty, 'receive', 'inbound', p_booking::text, lt, p_expiry, p_key, p_note);
  select id into rid from public.receipt_lines where movement_id = mid;
  if rid is null then
    insert into public.receipt_lines (booking_id, org_id, product_id, qty, condition, lot, expiry, note, received_by, movement_id)
    values (p_booking, b.org_id, p_product, p_qty, cond, lt, p_expiry, nullif(left(btrim(coalesce(p_note, '')), 500), ''), auth.uid(), mid) returning id into rid;
    if b.status = 'booked' then update public.inbound_bookings set status = 'receiving' where id = p_booking; end if;
    perform public.wms_audit(r, 'inbound.receive_line', 'inbound_bookings', p_booking::text, b.org_id, jsonb_build_object('product', p_product, 'qty', p_qty, 'condition', cond));
  end if;
  if (select kind from public.locations where id = loc) in ('bin','pallet') then perform public.wms_allocate_held(b.org_id); end if;   -- goods in a bin can fill waiting orders
  return jsonb_build_object('movement_id', mid, 'condition', cond, 'receipt_id', rid, 'location', (select code from public.locations where id = loc));
end $$;

create or replace function public.pick_line(p_allocation uuid, p_key text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); a public.allocations; o public.orders; packloc uuid; remaining integer;
begin
  select * into a from public.allocations where id = p_allocation for update;
  if not found then raise exception 'Pick line not found'; end if;
  if p_key is not null and exists (select 1 from public.stock_movements where idempotency_key = p_key || ':out') then return jsonb_build_object('replayed', true); end if;   -- a repeated scan
  select * into o from public.orders where id = a.order_id for update;
  if o.status not in ('allocated','picking') then raise exception 'This order is % and cannot be picked', o.status; end if;
  if a.status <> 'reserved' then raise exception 'This line was already picked'; end if;
  packloc := public.wms_ensure_location('pack', 'PACK-1');
  -- release the reservation first, so the stock row never holds more reserved than it has on hand
  update public.stock_levels set reserved = reserved - a.qty, updated_at = now() where org_id = a.org_id and product_id = a.product_id and location_id = a.location_id and lot = a.lot;
  perform public.wms_post(a.org_id, a.product_id, a.location_id, -a.qty, 'pick', 'order', a.order_id::text, a.lot, null, case when p_key is null then null else p_key || ':out' end, null);
  perform public.wms_post(a.org_id, a.product_id, packloc, a.qty, 'pick', 'order', a.order_id::text, a.lot, null, case when p_key is null then null else p_key || ':in' end, null);
  update public.allocations set status = 'picked', picked_at = now(), picked_by = auth.uid(), pack_location_id = packloc where id = a.id;
  if o.status = 'allocated' then update public.orders set status = 'picking', pick_started_at = now(), pick_started_by = auth.uid() where id = o.id; end if;
  select count(*) into remaining from public.allocations where order_id = a.order_id and status = 'reserved';
  perform public.wms_audit(r, 'order.pick', 'orders', a.order_id::text, a.org_id, jsonb_build_object('ref', o.ref, 'product', a.product_id, 'qty', a.qty, 'remaining', remaining));
  return jsonb_build_object('remaining', remaining, 'replayed', false);
end $$;


-- Put units on the shelf in one step: opening stock, a recount, or test stock. No delivery to book and nothing to put away.
create or replace function public.add_stock(p_org uuid, p_product uuid, p_qty integer, p_note text default null, p_key text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); v_loc uuid; v_code text; v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
begin
  if not exists (select 1 from public.organizations where id = p_org) then raise exception 'Customer not found'; end if;
  if not exists (select 1 from public.products where id = p_product and org_id = p_org and active) then raise exception 'That product was not found for this customer, or it is switched off'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 1000000 then raise exception 'Enter a quantity between 1 and 1,000,000'; end if;
  v_loc := public.wms_default_bin(p_org);
  select code into v_code from public.locations where id = v_loc;
  perform public.wms_post(p_org, p_product, v_loc, p_qty, 'adjust', 'add_stock', p_org::text, '', null, p_key, coalesce(v_note, 'Stock added by hand'));
  perform public.wms_allocate_held(p_org);
  perform public.wms_audit(r, 'stock.add', 'products', p_product::text, p_org, jsonb_build_object('qty', p_qty, 'location', v_code), v_note);
  return jsonb_build_object('location', v_code, 'qty', p_qty);
end $$;
revoke all on function public.add_stock(uuid,uuid,integer,text,text) from public, anon;
grant execute on function public.add_stock(uuid,uuid,integer,text,text) to authenticated;

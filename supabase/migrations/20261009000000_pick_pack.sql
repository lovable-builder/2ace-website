-- Phase C, piece 2: picking and packing.
-- Picking turns a reservation into a real stock movement: the units leave the bin and arrive at the packing station (both are ledger rows).
-- Packing records the parcels (weight and size), which is what a shipping label is bought with in the next piece.
-- All writes are functions for warehouse staff and admins; every step writes the audit log.

alter table public.stock_movements drop constraint stock_movements_reason_check;
alter table public.stock_movements add constraint stock_movements_reason_check check (reason in ('receive','putaway','adjust','pick','ship'));

alter table public.orders add column pick_started_at timestamptz, add column pick_started_by uuid references auth.users(id), add column packed_at timestamptz;
alter table public.allocations add column picked_at timestamptz, add column picked_by uuid references auth.users(id), add column pack_location_id uuid references public.locations(id);

create table public.parcels (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  seq integer not null check (seq > 0),
  weight_g integer not null check (weight_g between 1 and 70000),
  length_cm numeric not null check (length_cm > 0 and length_cm <= 300),
  width_cm numeric not null check (width_cm > 0 and width_cm <= 300),
  height_cm numeric not null check (height_cm > 0 and height_cm <= 300),
  packed_by uuid references auth.users(id),
  packed_at timestamptz not null default now(),
  unique (order_id, seq)
);
alter table public.parcels enable row level security;
create policy "staff read parcels" on public.parcels for select using (public.has_staff_role('admin','support','warehouse'));
create policy "members read own parcels" on public.parcels for select using (public.is_member(org_id));
revoke insert, update, delete, truncate on public.parcels from anon, authenticated;

-- Pick one reserved line: the reservation is released and the units move from the bin to the packing station.
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
  select id into packloc from public.locations where kind = 'pack' and active order by code limit 1;
  if packloc is null then raise exception 'Create a packing station first: a location of type pack'; end if;
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

-- Close packing: every line must be picked. Records the parcels (weight in grams, size in cm).
create or replace function public.pack_order(p_order uuid, p_parcels jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); o public.orders; pc jsonb; i integer := 0;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'packed' then return jsonb_build_object('replayed', true, 'parcels', (select count(*) from public.parcels where order_id = p_order)); end if;
  if o.status <> 'picking' then raise exception 'Only an order that has been picked can be packed (this one is %)', o.status; end if;
  if exists (select 1 from public.allocations where order_id = p_order and status = 'reserved') then raise exception 'Not everything has been picked yet'; end if;
  if jsonb_typeof(p_parcels) is distinct from 'array' or jsonb_array_length(p_parcels) = 0 then raise exception 'Add at least one parcel with its weight and size'; end if;
  if jsonb_array_length(p_parcels) > 10 then raise exception 'At most 10 parcels per order'; end if;
  for pc in select * from jsonb_array_elements(p_parcels) loop
    i := i + 1;
    if coalesce((pc->>'weight_g')::integer, 0) not between 1 and 70000 then raise exception 'Parcel %: enter a weight between 1 g and 70 kg', i; end if;
    if coalesce((pc->>'length_cm')::numeric, 0) <= 0 or coalesce((pc->>'width_cm')::numeric, 0) <= 0 or coalesce((pc->>'height_cm')::numeric, 0) <= 0 then raise exception 'Parcel %: enter its length, width and height in cm', i; end if;
    if (pc->>'length_cm')::numeric > 300 or (pc->>'width_cm')::numeric > 300 or (pc->>'height_cm')::numeric > 300 then raise exception 'Parcel %: no side can be longer than 300 cm', i; end if;
    insert into public.parcels (order_id, org_id, seq, weight_g, length_cm, width_cm, height_cm, packed_by)
    values (p_order, o.org_id, i, (pc->>'weight_g')::integer, (pc->>'length_cm')::numeric, (pc->>'width_cm')::numeric, (pc->>'height_cm')::numeric, auth.uid());
  end loop;
  update public.orders set status = 'packed', packed_at = now() where id = p_order;
  perform public.wms_audit(r, 'order.pack', 'orders', p_order::text, o.org_id, jsonb_build_object('ref', o.ref, 'parcels', i));
  return jsonb_build_object('replayed', false, 'parcels', i);
end $$;

-- Could not find it, or something is wrong: stop the order. Every reservation is released and the order goes on hold.
-- Units already picked stay at the packing station (the ledger still says so): staff return them to the shelf and fix the count.
create or replace function public.report_pick_problem(p_order uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); o public.orders; a record; n text := btrim(coalesce(p_note, '')); had_picked boolean;
begin
  if length(n) < 3 then raise exception 'Say what is wrong (for example: bin A-01-01 is empty)'; end if;
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status not in ('allocated','picking') then raise exception 'This order is % and cannot be stopped', o.status; end if;
  select exists (select 1 from public.allocations where order_id = p_order and status = 'picked') into had_picked;
  for a in select * from public.allocations where order_id = p_order and status = 'reserved' loop
    update public.stock_levels set reserved = reserved - a.qty, updated_at = now() where org_id = a.org_id and product_id = a.product_id and location_id = a.location_id and lot = a.lot;
  end loop;
  update public.allocations set status = 'released' where order_id = p_order and status in ('reserved','picked');
  update public.orders set status = 'held', hold_reason = 'Picking problem: ' || left(n, 300) || case when had_picked then ' (items already picked are at the packing station and must go back on the shelf)' else '' end where id = p_order;
  perform public.wms_audit(r, 'order.pick_problem', 'orders', p_order::text, o.org_id, jsonb_build_object('ref', o.ref), n);
end $$;

do $$ declare f text; begin
  foreach f in array array['pick_line(uuid,text)', 'pack_order(uuid,jsonb)', 'report_pick_problem(uuid,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

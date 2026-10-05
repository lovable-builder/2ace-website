-- Phase C, piece 3: shipments (shipping labels bought through Furgonetka).
-- A shipment row is written BEFORE any money is spent ('buying'), so a crash can never leave a bought label without a record.
-- The label cost, the markup and what the customer will be charged are stored here. This table is staff-readable only:
-- customers must never see our cost or margin (a customer-facing function comes with the tracking screen).

alter table public.allocations drop constraint allocations_status_check;
alter table public.allocations add constraint allocations_status_check check (status in ('reserved','picked','released','shipped'));
alter table public.orders add column shipped_at timestamptz;

create table public.shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  org_id uuid not null references public.organizations(id) on delete restrict,
  status text not null default 'buying' check (status in ('buying','purchased','failed','cancelled')),
  env text not null check (env in ('sandbox','production')),
  order_uuid uuid not null default gen_random_uuid(),          -- sent to the carrier API so an order retried after a crash is never placed twice
  service_id integer not null,
  carrier text,
  service_name text,
  provider_package_id text,
  tracking_numbers text[] not null default '{}',
  currency text not null default 'PLN',
  cost_net numeric(10,2) not null check (cost_net >= 0),
  cost_gross numeric(10,2) not null check (cost_gross >= 0),
  tax_percent integer not null default 23,
  markup_percent numeric(5,2) not null check (markup_percent >= 0),
  bill_net numeric(10,2) not null check (bill_net >= 0),         -- what the customer is charged, before VAT
  bill_gross numeric(10,2) not null check (bill_gross >= 0),
  billing_status text not null default 'pending' check (billing_status in ('pending','invoiced','waived')),
  error text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  purchased_at timestamptz
);
create unique index shipments_one_active on public.shipments (order_id) where status in ('buying','purchased');
create unique index shipments_provider_pkg on public.shipments (env, provider_package_id) where provider_package_id is not null;
create index shipments_day_idx on public.shipments (env, created_at);
alter table public.shipments enable row level security;
create policy "staff read shipments" on public.shipments for select using (public.has_staff_role('admin','support','warehouse'));
revoke insert, update, delete, truncate on public.shipments from anon, authenticated;

-- Step 1, before paying: checks the order is packed and its goods are still at the packing station, then writes the 'buying' row.
create or replace function public.begin_shipment(
  p_order uuid, p_env text, p_service_id integer, p_carrier text, p_service_name text,
  p_cost_net numeric, p_cost_gross numeric, p_tax integer, p_markup numeric
) returns public.shipments
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); o public.orders; s public.shipments; a record; have integer; bn numeric(10,2); bg numeric(10,2);
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'shipped' then raise exception 'This order has already shipped'; end if;
  if o.status <> 'packed' then raise exception 'Only a packed order can be shipped (this one is %)', o.status; end if;
  if not exists (select 1 from public.parcels where order_id = p_order) then raise exception 'This order has no parcels recorded'; end if;
  if p_env not in ('sandbox','production') then raise exception 'Unknown environment'; end if;
  if p_cost_net is null or p_cost_gross is null or p_cost_net < 0 or p_cost_gross < p_cost_net then raise exception 'The label price is not valid'; end if;
  if p_markup is null or p_markup < 0 or p_markup > 500 then raise exception 'The markup is not valid'; end if;
  if exists (select 1 from public.shipments where order_id = p_order and status in ('buying','purchased')) then raise exception 'A label is already being bought or has been bought for this order'; end if;
  -- the picked goods must still be at the packing station, or the stock cannot leave the books after the label is paid
  for a in select product_id, pack_location_id as location_id, lot, sum(qty)::integer as q from public.allocations where order_id = p_order and status = 'picked' group by 1,2,3 loop
    select on_hand into have from public.stock_levels where org_id = o.org_id and product_id = a.product_id and location_id = a.location_id and lot = a.lot;
    if coalesce(have, 0) < a.q then raise exception 'The packed goods are no longer all at the packing station. Move them back before shipping.'; end if;
  end loop;
  bn := round(p_cost_net * (1 + p_markup / 100), 2);
  bg := round(bn * (1 + coalesce(p_tax, 23) / 100.0), 2);
  insert into public.shipments (order_id, org_id, env, service_id, carrier, service_name, cost_net, cost_gross, tax_percent, markup_percent, bill_net, bill_gross, created_by)
  values (p_order, o.org_id, p_env, p_service_id, left(p_carrier, 40), left(p_service_name, 120), p_cost_net, p_cost_gross, coalesce(p_tax, 23), p_markup, bn, bg, auth.uid())
  returning * into s;
  perform public.wms_audit(r, 'shipment.begin', 'shipments', s.id::text, o.org_id, jsonb_build_object('order', o.ref, 'carrier', p_carrier, 'cost_gross', p_cost_gross, 'env', p_env));
  return s;
end $$;

-- Step 2, after the label is paid: records the carrier's package id and tracking numbers, takes the goods out of stock and marks the order shipped.
create or replace function public.finish_shipment(p_id uuid, p_package_id text, p_tracking text[]) returns public.shipments
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); s public.shipments; o public.orders; a record;
begin
  select * into s from public.shipments where id = p_id for update;
  if not found then raise exception 'Shipment not found'; end if;
  if s.status = 'purchased' then
    if s.provider_package_id is distinct from p_package_id then raise exception 'This shipment was recorded with a different package'; end if;
    return s;                                                              -- repeated call: nothing changes
  end if;
  if s.status <> 'buying' then raise exception 'This shipment is % and cannot be completed', s.status; end if;
  if coalesce(btrim(p_package_id), '') = '' then raise exception 'The carrier package id is missing'; end if;
  select * into o from public.orders where id = s.order_id for update;
  for a in select * from public.allocations where order_id = s.order_id and status = 'picked' loop
    perform public.wms_post(a.org_id, a.product_id, a.pack_location_id, -a.qty, 'ship', 'order', a.order_id::text, a.lot, null, 'ship:' || a.id::text, null);
  end loop;
  update public.allocations set status = 'shipped' where order_id = s.order_id and status = 'picked';
  update public.orders set status = 'shipped', shipped_at = now() where id = s.order_id;
  update public.shipments set status = 'purchased', provider_package_id = p_package_id, tracking_numbers = coalesce(p_tracking, '{}'), purchased_at = now() where id = p_id returning * into s;
  perform public.wms_audit(r, 'shipment.purchase', 'shipments', p_id::text, s.org_id, jsonb_build_object('order', o.ref, 'carrier', s.carrier, 'package', p_package_id, 'cost_gross', s.cost_gross, 'bill_net', s.bill_net, 'env', s.env));
  return s;
end $$;

-- The carrier refused or the call failed before any charge: the row is closed so another attempt can start.
create or replace function public.fail_shipment(p_id uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); s public.shipments;
begin
  select * into s from public.shipments where id = p_id for update;
  if not found then raise exception 'Shipment not found'; end if;
  if s.status <> 'buying' then raise exception 'Only a shipment still being bought can be marked failed'; end if;
  update public.shipments set status = 'failed', error = left(coalesce(p_error, 'Unknown error'), 800) where id = p_id;
  perform public.wms_audit(r, 'shipment.fail', 'shipments', p_id::text, s.org_id, jsonb_build_object('error', left(coalesce(p_error, ''), 300)));
end $$;

do $$ declare f text; begin
  foreach f in array array['begin_shipment(uuid,text,integer,text,text,numeric,numeric,integer,numeric)', 'finish_shipment(uuid,text,text[])', 'fail_shipment(uuid,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Customer-prepared labels, step 2: the customer's OWN label (a PDF from Allegro, InPost, Amazon, their carrier...) and "mark shipped".
-- No money is involved here: our staff print and stick the label. Everything the customer can do goes through the customer-shipping
-- function, which checks the file; the database functions below are callable only by that function (service role) or by staff.

-- 1. Shipping an order and taking its goods out of stock is now a step of its own, shared by every way an order can ship.
create or replace function public.wms_ship_order_stock(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare a record;
begin
  perform 1 from public.orders where id = p_order for update;
  for a in select * from public.allocations where order_id = p_order and status = 'picked' loop
    perform public.wms_post(a.org_id, a.product_id, a.pack_location_id, -a.qty, 'ship', 'order', a.order_id::text, a.lot, null, 'ship:' || a.id::text, null);
  end loop;
  update public.allocations set status = 'shipped' where order_id = p_order and status = 'picked';
  update public.orders set status = 'shipped', shipped_at = now() where id = p_order;
end $$;
revoke all on function public.wms_ship_order_stock(uuid) from public, anon, authenticated;

-- finish_shipment behaves exactly as before; it just uses the shared step.
create or replace function public.finish_shipment(p_id uuid, p_package_id text, p_tracking text[]) returns public.shipments
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); s public.shipments; o public.orders;
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
  perform public.wms_ship_order_stock(s.order_id);
  update public.shipments set status = 'purchased', provider_package_id = p_package_id, tracking_numbers = coalesce(p_tracking, '{}'), purchased_at = now() where id = p_id returning * into s;
  perform public.wms_audit(r, 'shipment.purchase', 'shipments', p_id::text, s.org_id, jsonb_build_object('order', o.ref, 'carrier', s.carrier, 'package', p_package_id, 'cost_gross', s.cost_gross, 'bill_net', s.bill_net, 'env', s.env));
  return s;
end $$;

-- 2. The customer's own labels.
create table public.own_labels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  storage_path text,
  filename text,
  size_bytes integer check (size_bytes is null or size_bytes between 1 and 2097152),
  tracking_numbers text[] not null default '{}',
  carrier_name text,
  uploaded_by uuid references auth.users(id),
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  check (storage_path is not null or cardinality(tracking_numbers) > 0)
);
create unique index own_labels_one_active on public.own_labels (order_id) where voided_at is null;
alter table public.own_labels enable row level security;
create policy "staff read own labels" on public.own_labels for select using (public.has_staff_role('admin','support','warehouse'));
create policy "members read own labels" on public.own_labels for select using (public.is_member(org_id));
revoke insert, update, delete, truncate on public.own_labels from anon, authenticated;

-- 3. Where the PDFs live: private, PDF only, 2 MB, one folder per customer and order.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('labels', 'labels', false, 2097152, array['application/pdf'])
on conflict (id) do nothing;
create policy "labels: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'labels' and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.pdf$'
    and public.wms_can_write_org(((storage.foldername(name))[1])::uuid)
    and exists (select 1 from public.orders o where o.id = ((storage.foldername(name))[2])::uuid and o.org_id = ((storage.foldername(name))[1])::uuid and o.status not in ('shipped','cancelled')));
create policy "labels: remove" on storage.objects for delete to authenticated
  using (bucket_id = 'labels' and name ~ '^[0-9a-f-]{36}/' and public.wms_can_write_org(((storage.foldername(name))[1])::uuid));
create policy "labels: read" on storage.objects for select to authenticated
  using (bucket_id = 'labels' and (
    public.has_staff_role('admin','support','warehouse')
    or case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.is_member(((storage.foldername(name))[1])::uuid) else false end));

-- 4. Attach (or replace) the customer's own label on an order. Service role only: the function has already checked the file is a real PDF.
-- Returns the id and the path of the label it replaced (so the function can delete that file).
create or replace function public.attach_own_label(p_org uuid, p_order uuid, p_path text, p_filename text, p_size integer, p_tracking text[], p_carrier text, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.orders; t text[]; old public.own_labels; v_id uuid; mode text; x text;
begin
  select * into o from public.orders where id = p_order for update;
  if not found or o.org_id is distinct from p_org then raise exception 'Order not found'; end if;
  if o.status not in ('new','held','allocated','picking','packed') then raise exception 'This order is %, so a label can no longer be added', o.status; end if;
  mode := public.org_fulfil_mode(p_org);
  if mode not in ('full','payg') then raise exception 'Your plan does not include fulfilment, so we cannot ship orders for you'; end if;
  if exists (select 1 from public.shipments where order_id = p_order and status in ('buying','purchased')) then raise exception 'A 2ACE label has already been bought for this order'; end if;
  select coalesce(array_agg(btrim(z)), '{}') into t from unnest(coalesce(p_tracking, '{}')) z where btrim(z) <> '';
  if cardinality(t) > 5 then raise exception 'At most 5 tracking numbers'; end if;
  foreach x in array t loop
    if x !~ '^[A-Za-z0-9][A-Za-z0-9 ._/-]{2,59}$' then raise exception 'A tracking number looks wrong (letters and digits, 3 to 60 characters)'; end if;
  end loop;
  if p_path is null and cardinality(t) = 0 then raise exception 'Add the label file, or at least a tracking number'; end if;
  if p_path is not null then
    if p_path !~ ('^' || p_org::text || '/' || p_order::text || '/[0-9a-f-]{36}\.pdf$') then raise exception 'Invalid label file'; end if;
    if not exists (select 1 from storage.objects where bucket_id = 'labels' and name = p_path) then raise exception 'The label file was not uploaded'; end if;
  end if;
  if p_carrier is not null and length(btrim(p_carrier)) > 60 then raise exception 'The carrier name is too long'; end if;
  select * into old from public.own_labels where order_id = p_order and voided_at is null for update;
  if found then update public.own_labels set voided_at = now() where id = old.id; end if;
  insert into public.own_labels (org_id, order_id, storage_path, filename, size_bytes, tracking_numbers, carrier_name, uploaded_by)
  values (p_org, p_order, p_path, left(nullif(btrim(coalesce(p_filename, '')), ''), 120), p_size, t, nullif(btrim(coalesce(p_carrier, '')), ''), p_actor) returning id into v_id;
  update public.orders set label_source = 'own', label_flag = null where id = p_order;
  perform public.audit_write(p_actor, 'customer', 'order.own_label', 'orders', p_order::text, p_org, null, jsonb_build_object('order', o.ref, 'file', p_path is not null, 'tracking', cardinality(t)), null, null);
  return jsonb_build_object('id', v_id, 'replaced_path', old.storage_path);
end $$;

create or replace function public.remove_own_label(p_org uuid, p_order uuid, p_actor uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare o public.orders; old public.own_labels;
begin
  select * into o from public.orders where id = p_order for update;
  if not found or o.org_id is distinct from p_org then raise exception 'Order not found'; end if;
  if o.status in ('shipped','cancelled') then raise exception 'This order is %, so its label can no longer be removed', o.status; end if;
  select * into old from public.own_labels where order_id = p_order and voided_at is null for update;
  if not found then return null; end if;
  update public.own_labels set voided_at = now() where id = old.id;
  update public.orders set label_source = null where id = p_order and label_source = 'own';
  perform public.audit_write(p_actor, 'customer', 'order.own_label_removed', 'orders', p_order::text, p_org, null, jsonb_build_object('order', o.ref), null, null);
  return old.storage_path;
end $$;
revoke all on function public.attach_own_label(uuid,uuid,text,text,integer,text[],text,uuid), public.remove_own_label(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.attach_own_label(uuid,uuid,text,text,integer,text[],text,uuid), public.remove_own_label(uuid,uuid,uuid) to service_role;

-- 5. Staff: the order leaves the building. Needs a label (the customer's own, or one that has been bought) and a packed order.
create or replace function public.ship_order(p_order uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); o public.orders; src text;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'shipped' then return jsonb_build_object('replayed', true); end if;
  if o.status <> 'packed' then raise exception 'Only a packed order can be shipped (this one is %)', o.status; end if;
  if exists (select 1 from public.shipments where order_id = p_order and status = 'buying') then raise exception 'A label is still being bought for this order. Check it first.'; end if;
  if exists (select 1 from public.shipments where order_id = p_order and status = 'purchased') then src := '2ace';
  elsif exists (select 1 from public.own_labels where order_id = p_order and voided_at is null) then src := 'own';
  else raise exception 'This order has no label yet. Buy one, or ask the customer for theirs.'; end if;
  perform public.wms_ship_order_stock(p_order);
  perform public.wms_audit(r, 'order.ship', 'orders', p_order::text, o.org_id, jsonb_build_object('order', o.ref, 'label', src));
  return jsonb_build_object('replayed', false, 'label', src);
end $$;
revoke all on function public.ship_order(uuid) from public, anon; grant execute on function public.ship_order(uuid) to authenticated;

-- 6. A label bought by us and a label brought by the customer exclude each other.
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
  if exists (select 1 from public.own_labels where order_id = p_order and voided_at is null) then raise exception 'The customer provided their own label for this order. Use it, or ask them to remove it first.'; end if;
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

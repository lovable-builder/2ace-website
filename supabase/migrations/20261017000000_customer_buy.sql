-- Fulfilment as you go: customers buy their own shipping label, before the parcel is packed.
-- The customer-shipping function checks everything first; the functions below repeat the rules that protect money (caps, who may buy,
-- one label per order) inside the database, under a lock, so two clicks or two browser tabs can never overspend. Only that function (service role) can call them.

alter table public.shipments
  add column buyer_role text not null default 'staff' check (buyer_role in ('staff', 'customer')),
  add column parcels jsonb;                                         -- the parcels the label was bought for (weight_g, length_cm, width_cm, height_cm), what the packing check compares against
alter table public.orders add column label_flag_note text;

-- ---------- comparing what the customer declared with what was really packed ----------
-- Returns null when the real parcels fit the label, else a sentence saying what differs. Over-declared parcels are fine.
create or replace function public.wms_parcel_mismatch(p_order uuid, p_declared jsonb) returns text
language plpgsql stable security definer set search_path = '' as $$
declare o public.orders; st public.org_shipping_settings; pct integer := 10; gr integer := 100; dim numeric := 2; dn integer; rn integer; r record; msgs text[] := '{}';
begin
  select * into o from public.orders where id = p_order;
  if not found then return null; end if;
  select * into st from public.org_shipping_settings where org_id = o.org_id;
  if found then pct := st.tol_weight_pct; gr := st.tol_weight_g; dim := st.tol_dim_cm; end if;
  dn := jsonb_array_length(p_declared);
  select count(*) into rn from public.parcels where order_id = p_order;
  if rn <> dn then return format('The customer declared %s parcel(s), we packed %s.', dn, rn); end if;
  for r in
    with d as (select row_number() over (order by (e->>'weight_g')::numeric desc) n, (e->>'weight_g')::numeric w,
                 array(select x from unnest(array[(e->>'length_cm')::numeric, (e->>'width_cm')::numeric, (e->>'height_cm')::numeric]) x order by x desc) dims from jsonb_array_elements(p_declared) e),
         p as (select row_number() over (order by weight_g desc) n, weight_g::numeric w, array(select x from unnest(array[length_cm, width_cm, height_cm]) x order by x desc) dims from public.parcels where order_id = p_order)
    select d.n, d.w dw, p.w pw, d.dims dd, p.dims pd from d join p using (n) order by d.n
  loop
    if r.pw > r.dw * (1 + pct / 100.0) + gr then msgs := array_append(msgs, format('Parcel %s weighs %s g, the label was bought for %s g.', r.n, r.pw, r.dw)); end if;
    if r.pd[1] > r.dd[1] + dim or r.pd[2] > r.dd[2] + dim or r.pd[3] > r.dd[3] + dim then
      msgs := array_append(msgs, format('Parcel %s measures %s x %s x %s cm, the label was bought for %s x %s x %s cm.', r.n, r.pd[1], r.pd[2], r.pd[3], r.dd[1], r.dd[2], r.dd[3]));
    end if;
  end loop;
  return case when array_length(msgs, 1) is null then null else array_to_string(msgs, ' ') end;
end $$;
revoke all on function public.wms_parcel_mismatch(uuid, jsonb) from public, anon, authenticated;

-- ---------- guards that hold whoever changes the order ----------
-- Packing: a label still being bought blocks it; a customer's label is compared with the real parcels and a difference is flagged.
-- Cancelling: refused while a label is being bought or has been bought (that money would be wasted; staff handle it).
create or replace function public.orders_label_guards() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s public.shipments; msg text;
begin
  if new.status = 'packed' and old.status is distinct from 'packed' then
    if exists (select 1 from public.shipments where order_id = new.id and status = 'buying') then raise exception 'A label is still being bought for this order. Wait a moment, then pack it.'; end if;
    select * into s from public.shipments where order_id = new.id and status = 'purchased' and buyer_role = 'customer' and parcels is not null;
    if found then
      msg := public.wms_parcel_mismatch(new.id, s.parcels);
      if msg is not null then new.label_flag := 'mismatch'; new.label_flag_note := msg; end if;
    end if;
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' and exists (select 1 from public.shipments where order_id = new.id and status in ('buying', 'purchased')) then
    raise exception 'A shipping label has been bought for this order, so it cannot be cancelled here. Contact 2ACE first.';
  end if;
  return new;
end $$;
create trigger orders_label_guards before update of status on public.orders for each row execute function public.orders_label_guards();

-- ---------- the customer's purchase: begin, finish, fail ----------
create or replace function public.cs_begin_shipment(
  p_org uuid, p_order uuid, p_actor uuid, p_env text, p_service_id integer, p_carrier text, p_service_name text,
  p_cost_net numeric, p_cost_gross numeric, p_tax integer, p_markup numeric, p_parcels jsonb
) returns public.shipments
language plpgsql security definer set search_path = '' as $$
declare o public.orders; org public.organizations; st public.org_shipping_settings; s public.shipments; bn numeric(10,2); bg numeric(10,2); exposure numeric; used integer; pc jsonb; n integer := 0;
  dstart timestamptz := (date_trunc('day', now() at time zone 'Europe/Warsaw')) at time zone 'Europe/Warsaw';
begin
  perform pg_advisory_xact_lock(hashtext('csbuy:' || p_org::text));            -- one purchase per customer at a time: the caps below cannot be raced
  select * into o from public.orders where id = p_order for update;
  if not found or o.org_id <> p_org then raise exception 'Order not found'; end if;
  select * into org from public.organizations where id = p_org;
  if org.status <> 'active' then raise exception 'Your plan is not active, so labels cannot be bought.'; end if;
  if public.org_fulfil_mode(p_org) <> 'payg' then raise exception 'Buying labels yourself is part of Fulfilment as you go.'; end if;
  select * into st from public.org_shipping_settings where org_id = p_org;
  if not found or not st.label_buying_enabled then raise exception 'Buying labels yourself is not switched on for your account yet. Please contact us.'; end if;
  if o.status not in ('allocated', 'picking', 'packed') then raise exception 'A label can be bought for an order that is reserved and not shipped yet (this one is %).', o.status; end if;
  if exists (select 1 from public.shipments where order_id = p_order and status in ('buying', 'purchased')) then raise exception 'A label is already being bought or has been bought for this order'; end if;
  if exists (select 1 from public.own_labels where order_id = p_order and voided_at is null) then raise exception 'You already added your own label to this order. Remove it first to buy one here.'; end if;
  if p_env not in ('sandbox', 'production') then raise exception 'Unknown environment'; end if;
  if jsonb_typeof(p_parcels) is distinct from 'array' or jsonb_array_length(p_parcels) not between 1 and 3 then raise exception 'Enter 1 to 3 parcels'; end if;
  for pc in select * from jsonb_array_elements(p_parcels) loop
    n := n + 1;
    if coalesce((pc->>'weight_g')::integer, 0) not between 1 and 30000 then raise exception 'Parcel %: the weight must be between 1 g and 30 kg', n; end if;
    if coalesce((pc->>'length_cm')::numeric, 0) <= 0 or coalesce((pc->>'width_cm')::numeric, 0) <= 0 or coalesce((pc->>'height_cm')::numeric, 0) <= 0
       or (pc->>'length_cm')::numeric > 150 or (pc->>'width_cm')::numeric > 150 or (pc->>'height_cm')::numeric > 150 then raise exception 'Parcel %: each side must be between 1 and 150 cm', n; end if;
  end loop;
  if p_cost_net is null or p_cost_gross is null or p_cost_net < 0 or p_cost_gross < p_cost_net then raise exception 'The label price is not valid'; end if;
  if p_markup is null or p_markup < 0 or p_markup > 500 then raise exception 'The markup is not valid'; end if;
  bn := round(p_cost_net * (1 + p_markup / 100), 2);
  bg := round(bn * (1 + coalesce(p_tax, 23) / 100.0), 2);
  if st.max_label_net is not null and bn > st.max_label_net then raise exception 'This label (% zł + VAT) is above the % zł limit set for your account.', bn, st.max_label_net; end if;
  select coalesce(sum(bill_net), 0) into exposure from public.shipments where org_id = p_org and status in ('buying', 'purchased') and billing_status = 'pending';
  if exposure + bn > st.exposure_cap_net then raise exception 'Your shipping labels not invoiced yet are % zł. This one (% zł) would pass your limit of % zł. Please contact us.', exposure, bn, st.exposure_cap_net; end if;
  select count(*) into used from public.shipments where org_id = p_org and buyer_role = 'customer' and status in ('buying', 'purchased') and created_at >= dstart;
  if used >= st.daily_label_cap then raise exception 'You have reached the limit of % labels for today. Please try again tomorrow.', st.daily_label_cap; end if;
  insert into public.shipments (order_id, org_id, env, service_id, carrier, service_name, cost_net, cost_gross, tax_percent, markup_percent, bill_net, bill_gross, created_by, buyer_role, parcels)
  values (p_order, p_org, p_env, p_service_id, left(p_carrier, 40), left(p_service_name, 120), p_cost_net, p_cost_gross, coalesce(p_tax, 23), p_markup, bn, bg, p_actor, 'customer', p_parcels)
  returning * into s;
  perform public.audit_write(p_actor, 'customer', 'shipment.begin', 'shipments', s.id::text, p_org, null, jsonb_build_object('order', o.ref, 'carrier', p_carrier, 'bill_net', bn, 'env', p_env, 'by', 'customer'), null, null);
  return s;
end $$;

-- The label is paid. The order does NOT ship here (it still has to be picked and packed): only the purchase is recorded.
create or replace function public.cs_finish_shipment(p_id uuid, p_package_id text, p_tracking text[], p_actor uuid) returns public.shipments
language plpgsql security definer set search_path = '' as $$
declare s public.shipments; o public.orders; msg text;
begin
  select * into s from public.shipments where id = p_id for update;
  if not found or s.buyer_role <> 'customer' then raise exception 'Shipment not found'; end if;
  if s.status = 'purchased' then
    if s.provider_package_id is distinct from p_package_id then raise exception 'This shipment was recorded with a different package'; end if;
    return s;                                                               -- repeated call: nothing changes
  end if;
  if s.status <> 'buying' then raise exception 'This shipment is % and cannot be completed', s.status; end if;
  if coalesce(btrim(p_package_id), '') = '' then raise exception 'The carrier package id is missing'; end if;
  select * into o from public.orders where id = s.order_id for update;
  update public.shipments set status = 'purchased', provider_package_id = p_package_id, tracking_numbers = coalesce(p_tracking, '{}'), purchased_at = now() where id = p_id returning * into s;
  update public.orders set label_source = '2ace' where id = s.order_id;
  if o.status = 'packed' then                                               -- bought after packing: check the real parcels at once
    msg := public.wms_parcel_mismatch(o.id, s.parcels);
    if msg is not null then update public.orders set label_flag = 'mismatch', label_flag_note = msg where id = o.id; end if;
  end if;
  perform public.audit_write(p_actor, 'customer', 'shipment.purchase', 'shipments', p_id::text, s.org_id, null, jsonb_build_object('order', o.ref, 'carrier', s.carrier, 'package', p_package_id, 'bill_net', s.bill_net, 'env', s.env, 'by', 'customer'), null, null);
  return s;
end $$;

create or replace function public.cs_fail_shipment(p_id uuid, p_error text, p_actor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shipments;
begin
  select * into s from public.shipments where id = p_id for update;
  if not found or s.buyer_role <> 'customer' then raise exception 'Shipment not found'; end if;
  if s.status <> 'buying' then raise exception 'Only a shipment still being bought can be marked failed'; end if;
  update public.shipments set status = 'failed', error = left(coalesce(p_error, 'Unknown error'), 800) where id = p_id;
  perform public.audit_write(p_actor, 'customer', 'shipment.fail', 'shipments', p_id::text, s.org_id, null, jsonb_build_object('error', left(coalesce(p_error, ''), 300)), null, null);
end $$;

create or replace function public.cs_save_package(p_id uuid, p_package_id text) returns void
language sql security definer set search_path = '' as $$
  update public.shipments set provider_package_id = p_package_id where id = p_id and buyer_role = 'customer' and status = 'buying';
$$;

do $$ declare f text; begin
  foreach f in array array['cs_begin_shipment(uuid,uuid,uuid,text,integer,text,text,numeric,numeric,integer,numeric,jsonb)', 'cs_finish_shipment(uuid,text,text[],uuid)', 'cs_fail_shipment(uuid,text,uuid)', 'cs_save_package(uuid,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---------- staff: shipping the order, and a parcel that does not fit the label ----------
create or replace function public.ship_order(p_order uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); o public.orders; src text;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'shipped' then return jsonb_build_object('replayed', true); end if;
  if o.status <> 'packed' then raise exception 'Only a packed order can be shipped (this one is %)', o.status; end if;
  if exists (select 1 from public.shipments where order_id = p_order and status = 'buying') then raise exception 'A label is still being bought for this order. Check it first.'; end if;
  if o.label_flag = 'mismatch' then raise exception 'The parcel does not match the label. % Accept it first (with a surcharge if the carrier will charge more).', coalesce(o.label_flag_note, ''); end if;
  if exists (select 1 from public.shipments where order_id = p_order and status = 'purchased') then src := '2ace';
  elsif exists (select 1 from public.own_labels where order_id = p_order and voided_at is null) then src := 'own';
  else raise exception 'This order has no label yet. Buy one, or ask the customer for theirs.'; end if;
  perform public.wms_ship_order_stock(p_order);
  perform public.wms_audit(r, 'order.ship', 'orders', p_order::text, o.org_id, jsonb_build_object('order', o.ref, 'label', src));
  return jsonb_build_object('replayed', false, 'label', src);
end $$;
revoke all on function public.ship_order(uuid) from public, anon; grant execute on function public.ship_order(uuid) to authenticated;

-- The real parcel is bigger or heavier than the label was bought for. Staff accept it; an admin may add what the carrier will charge extra to the customer's account.
create or replace function public.accept_label_mismatch(p_order uuid, p_adjustment_net numeric default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); o public.orders; s public.shipments; seq integer;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.label_flag is distinct from 'mismatch' then raise exception 'This order has no parcel difference to accept'; end if;
  if p_adjustment_net is not null and p_adjustment_net <> 0 then
    if r <> 'admin' then raise exception 'Only an admin can add a charge to the customer'; end if;
    if p_adjustment_net < 0 or p_adjustment_net > 500 then raise exception 'The extra charge must be between 0 and 500 zł'; end if;
    select * into s from public.shipments where order_id = p_order and status = 'purchased' order by purchased_at desc limit 1;
    if not found then raise exception 'There is no bought label to add the charge to'; end if;
    select coalesce(max(c.seq), 0) + 1 into seq from public.shipping_charges c where c.shipment_id = s.id and c.kind = 'adjustment';
    insert into public.shipping_charges (org_id, order_id, shipment_id, kind, seq, net, tax_percent, status, env, note)
    values (s.org_id, p_order, s.id, 'adjustment', seq, p_adjustment_net, s.tax_percent, case when s.env = 'sandbox' then 'waived' else 'pending' end, s.env, left(coalesce(nullif(btrim(p_note), ''), 'Parcel larger than declared'), 300));
  end if;
  update public.orders set label_flag = null, label_flag_note = null where id = p_order;
  perform public.wms_audit(r, 'order.accept_mismatch', 'orders', p_order::text, o.org_id, jsonb_build_object('order', o.ref, 'was', o.label_flag_note, 'extra_net', p_adjustment_net), p_note);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.accept_label_mismatch(uuid, numeric, text) from public, anon; grant execute on function public.accept_label_mismatch(uuid, numeric, text) to authenticated;

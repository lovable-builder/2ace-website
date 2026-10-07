-- Returns, pay as you go: the customer announces a return and issues the return label (addressed to our warehouse) themselves; we receive it, inspect and grade it,
-- put good goods back on the customer's shelf, and charge a handling fee per return on the plans that are pay as you go for returns.
-- Customers create and read their returns; the label purchase goes through the customer-shipping function (service role) with the same caps as outgoing labels.

create sequence public.return_ref_seq start 1;

create table public.returns (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('RET-' || lpad(nextval('public.return_ref_seq')::text, 6, '0')),
  org_id uuid not null references public.organizations(id) on delete restrict,
  order_id uuid references public.orders(id) on delete set null,
  status text not null default 'announced' check (status in ('announced', 'label_issued', 'received', 'graded', 'cancelled')),
  fee_mode text not null default 'flat' check (fee_mode in ('flat', 'payg')),      -- stamped when the return is announced, like orders
  reason text check (reason is null or length(reason) <= 500),
  buyer_name text not null, buyer_company text, buyer_email text, buyer_phone text not null,
  buyer_line1 text not null, buyer_line2 text, buyer_postal text not null, buyer_city text not null, buyer_country text not null check (buyer_country ~ '^[A-Z]{2}$'),
  label_source text check (label_source in ('2ace')),
  weight_g integer, side_cm numeric(6,1),                                           -- what the parcel measured when it arrived
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  received_at timestamptz, graded_at timestamptz, notified_at timestamptz, cancelled_at timestamptz,
  staff_note text check (staff_note is null or length(staff_note) <= 1000)
);
create index returns_org_idx on public.returns (org_id, created_at desc);
create table public.return_lines (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.returns(id) on delete cascade,
  org_id uuid not null references public.organizations(id),
  product_id uuid not null references public.products(id),
  qty integer not null check (qty between 1 and 100000),                            -- what the customer says is coming back
  received_qty integer check (received_qty is null or received_qty >= 0),
  grade text check (grade in ('A', 'B', 'C')),                                       -- A: restocked. B and C: set aside in quarantine (damaged, not sellable)
  note text check (note is null or length(note) <= 500),
  unique (return_id, product_id)
);
alter table public.returns enable row level security; alter table public.return_lines enable row level security;
create policy "members read own returns" on public.returns for select using (public.is_member(org_id));
create policy "staff read returns" on public.returns for select using (public.has_staff_role('admin', 'support', 'warehouse'));
create policy "members read own return lines" on public.return_lines for select using (public.is_member(org_id));
create policy "staff read return lines" on public.return_lines for select using (public.has_staff_role('admin', 'support', 'warehouse'));
revoke insert, update, delete, truncate on public.returns, public.return_lines from anon, authenticated;

-- Which fee a return pays: pay as you go when the plan has Returns as you go (or an admin overrides the customer to pay as you go for testing).
create or replace function public.org_returns_mode(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when (select fulfil_mode_override from public.org_shipping_settings where org_id = p_org) = 'payg' then 'payg'
              when coalesce((select (config->'pkgs'->>'retp') = 'true' from public.plans where org_id = p_org and status = 'active' order by created_at desc limit 1), false) then 'payg'
              else 'flat' end;
$$;
revoke all on function public.org_returns_mode(uuid) from public, anon, authenticated;
create or replace function public.returns_stamp_mode() returns trigger language plpgsql security definer set search_path = '' as $$
begin new.fee_mode := public.org_returns_mode(new.org_id); return new; end $$;
create trigger returns_stamp_mode before insert on public.returns for each row execute function public.returns_stamp_mode();

-- ---------- a label for a return is a shipment too ----------
alter table public.shipments alter column order_id drop not null;
alter table public.shipments add column return_id uuid references public.returns(id) on delete restrict;
alter table public.shipments add constraint shipments_order_or_return check ((order_id is not null) <> (return_id is not null));
create unique index shipments_one_active_return on public.shipments (return_id) where status in ('buying', 'purchased');
create or replace function public.shipments_write_charge() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'purchased' and (tg_op = 'INSERT' or old.status is distinct from 'purchased') then
    insert into public.shipping_charges (org_id, order_id, return_id, shipment_id, kind, seq, net, tax_percent, status, env)
    values (new.org_id, new.order_id, new.return_id, new.id, case when new.return_id is not null then 'return_label' else 'label' end, 1, new.bill_net, new.tax_percent, case when new.env = 'sandbox' then 'waived' else 'pending' end, new.env)
    on conflict (shipment_id, kind, seq) do nothing;
    update public.shipments set billing_status = case when new.env = 'sandbox' then 'waived' else 'pending' end where id = new.id and billing_status is distinct from (case when new.env = 'sandbox' then 'waived' else 'pending' end);
  end if;
  return null;
end $$;

-- ---------- the customer announces a return ----------
create or replace function public.create_return(p_org uuid, p_order uuid, p_buyer jsonb, p_reason text, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_org_access(p_org); chk jsonb; ret public.returns; o public.orders; ln jsonb; pid uuid; q integer; seen uuid[] := '{}'; em text := nullif(btrim(coalesce(p_buyer->>'email', '')), ''); ordered integer;
begin
  if r = 'customer' and not exists (select 1 from public.organizations where id = p_org and status = 'active') then raise exception 'Your plan is not active yet'; end if;
  if p_order is not null then
    select * into o from public.orders where id = p_order and org_id = p_org;
    if not found then raise exception 'Order not found'; end if;
    if o.status <> 'shipped' then raise exception 'Only an order that has shipped can come back (this one is %)', o.status; end if;
  end if;
  chk := public.wms_check_ship(jsonb_build_object('name', p_buyer->>'name', 'line1', p_buyer->>'line1', 'line2', p_buyer->>'line2', 'postal', p_buyer->>'postal', 'city', p_buyer->>'city', 'country', p_buyer->>'country', 'phone', p_buyer->>'phone'));
  if btrim(coalesce(p_buyer->>'city', '')) = '' then raise exception 'The buyer''s city is required'; end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'The buyer''s email looks wrong'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 50 then raise exception 'Add at least one product that is coming back'; end if;
  insert into public.returns (org_id, order_id, reason, buyer_name, buyer_company, buyer_email, buyer_phone, buyer_line1, buyer_line2, buyer_postal, buyer_city, buyer_country, created_by)
  values (p_org, p_order, nullif(left(btrim(coalesce(p_reason, '')), 500), ''), left(chk->>'name', 120), nullif(left(btrim(coalesce(p_buyer->>'company', '')), 120), ''), em, chk->>'phone', left(btrim(p_buyer->>'line1'), 160),
          nullif(left(btrim(coalesce(p_buyer->>'line2', '')), 160), ''), chk->>'postal', left(btrim(p_buyer->>'city'), 100), chk->>'country', auth.uid()) returning * into ret;
  for ln in select * from jsonb_array_elements(p_lines) loop
    pid := (ln->>'product_id')::uuid; q := (ln->>'qty')::integer;
    if q is null or q < 1 or q > 100000 then raise exception 'Quantities must be between 1 and 100,000'; end if;
    if pid = any(seen) then raise exception 'Each product can appear once per return'; end if;
    if not exists (select 1 from public.products where id = pid and org_id = p_org) then raise exception 'A product on this return was not found'; end if;
    if p_order is not null then
      select coalesce(sum(qty), 0) into ordered from public.order_lines where order_id = p_order and product_id = pid;
      if ordered = 0 then raise exception 'A product on this return was not on that order'; end if;
      if q + coalesce((select sum(rl.qty) from public.return_lines rl join public.returns x on x.id = rl.return_id where x.order_id = p_order and rl.product_id = pid and x.status <> 'cancelled' and x.id <> ret.id), 0) > ordered then raise exception 'More units are coming back than were on the order'; end if;
    end if;
    seen := seen || pid;
    insert into public.return_lines (return_id, org_id, product_id, qty) values (ret.id, p_org, pid, q);
  end loop;
  perform public.wms_audit(r, 'return.create', 'returns', ret.id::text, p_org, jsonb_build_object('ref', ret.ref, 'order', p_order, 'lines', jsonb_array_length(p_lines)));
  return jsonb_build_object('id', ret.id, 'ref', ret.ref, 'fee_mode', ret.fee_mode);
end $$;
revoke all on function public.create_return(uuid, uuid, jsonb, text, jsonb) from public, anon; grant execute on function public.create_return(uuid, uuid, jsonb, text, jsonb) to authenticated;

-- The customer (or staff) withdraws a return that has no bought label yet.
create or replace function public.cancel_return(p_return uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ret public.returns; r text;
begin
  select * into ret from public.returns where id = p_return for update;
  if not found then raise exception 'Return not found'; end if;
  r := public.wms_org_access(ret.org_id);
  if ret.status = 'cancelled' then return; end if;
  if ret.status <> 'announced' then raise exception 'This return is %, so it cannot be cancelled here', ret.status; end if;
  if exists (select 1 from public.shipments where return_id = p_return and status in ('buying', 'purchased')) then raise exception 'A return label has been bought for this return, so it cannot be cancelled here. Contact 2ACE.'; end if;
  update public.returns set status = 'cancelled', cancelled_at = now() where id = p_return;
  perform public.wms_audit(r, 'return.cancel', 'returns', p_return::text, ret.org_id, jsonb_build_object('ref', ret.ref));
end $$;
revoke all on function public.cancel_return(uuid) from public, anon; grant execute on function public.cancel_return(uuid) to authenticated;

-- ---------- the return label (customer, through the customer-shipping function only) ----------
create or replace function public.cs_begin_return_shipment(
  p_org uuid, p_return uuid, p_actor uuid, p_env text, p_service_id integer, p_carrier text, p_service_name text,
  p_cost_net numeric, p_cost_gross numeric, p_tax integer, p_markup numeric, p_parcels jsonb
) returns public.shipments
language plpgsql security definer set search_path = '' as $$
declare ret public.returns; org public.organizations; st public.org_shipping_settings; s public.shipments; bn numeric(10,2); bg numeric(10,2); exposure numeric; used integer; pc jsonb; n integer := 0;
  dstart timestamptz := (date_trunc('day', now() at time zone 'Europe/Warsaw')) at time zone 'Europe/Warsaw';
begin
  perform pg_advisory_xact_lock(hashtext('csbuy:' || p_org::text));
  select * into ret from public.returns where id = p_return for update;
  if not found or ret.org_id <> p_org then raise exception 'Return not found'; end if;
  select * into org from public.organizations where id = p_org;
  if org.status <> 'active' then raise exception 'Your plan is not active, so labels cannot be bought.'; end if;
  select * into st from public.org_shipping_settings where org_id = p_org;
  if not found or not st.label_buying_enabled then raise exception 'Buying labels yourself is not switched on for your account yet. Please contact us.'; end if;
  if ret.status <> 'announced' then raise exception 'A return label can be bought for a return that has not been sent yet (this one is %).', ret.status; end if;
  if exists (select 1 from public.shipments where return_id = p_return and status in ('buying', 'purchased')) then raise exception 'A label is already being bought or has been bought for this return'; end if;
  if p_env not in ('sandbox', 'production') then raise exception 'Unknown environment'; end if;
  if jsonb_typeof(p_parcels) is distinct from 'array' or jsonb_array_length(p_parcels) <> 1 then raise exception 'A return is sent as one parcel'; end if;
  for pc in select * from jsonb_array_elements(p_parcels) loop
    n := n + 1;
    if coalesce((pc->>'weight_g')::integer, 0) not between 1 and 30000 then raise exception 'The weight must be between 1 g and 30 kg'; end if;
    if coalesce((pc->>'length_cm')::numeric, 0) <= 0 or coalesce((pc->>'width_cm')::numeric, 0) <= 0 or coalesce((pc->>'height_cm')::numeric, 0) <= 0
       or (pc->>'length_cm')::numeric > 150 or (pc->>'width_cm')::numeric > 150 or (pc->>'height_cm')::numeric > 150 then raise exception 'Each side must be between 1 and 150 cm'; end if;
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
  insert into public.shipments (return_id, org_id, env, service_id, carrier, service_name, cost_net, cost_gross, tax_percent, markup_percent, bill_net, bill_gross, created_by, buyer_role, parcels)
  values (p_return, p_org, p_env, p_service_id, left(p_carrier, 40), left(p_service_name, 120), p_cost_net, p_cost_gross, coalesce(p_tax, 23), p_markup, bn, bg, p_actor, 'customer', p_parcels) returning * into s;
  perform public.audit_write(p_actor, 'customer', 'shipment.begin', 'shipments', s.id::text, p_org, null, jsonb_build_object('return', ret.ref, 'carrier', p_carrier, 'bill_net', bn, 'env', p_env, 'by', 'customer'), null, null);
  return s;
end $$;

create or replace function public.cs_finish_return_shipment(p_id uuid, p_package_id text, p_tracking text[], p_actor uuid) returns public.shipments
language plpgsql security definer set search_path = '' as $$
declare s public.shipments; ret public.returns;
begin
  select * into s from public.shipments where id = p_id for update;
  if not found or s.buyer_role <> 'customer' or s.return_id is null then raise exception 'Shipment not found'; end if;
  if s.status = 'purchased' then
    if s.provider_package_id is distinct from p_package_id then raise exception 'This shipment was recorded with a different package'; end if;
    return s;
  end if;
  if s.status <> 'buying' then raise exception 'This shipment is % and cannot be completed', s.status; end if;
  if coalesce(btrim(p_package_id), '') = '' then raise exception 'The carrier package id is missing'; end if;
  select * into ret from public.returns where id = s.return_id for update;
  update public.shipments set status = 'purchased', provider_package_id = p_package_id, tracking_numbers = coalesce(p_tracking, '{}'), purchased_at = now() where id = p_id returning * into s;
  update public.returns set status = 'label_issued', label_source = '2ace' where id = s.return_id;
  perform public.audit_write(p_actor, 'customer', 'shipment.purchase', 'shipments', p_id::text, s.org_id, null, jsonb_build_object('return', ret.ref, 'carrier', s.carrier, 'package', p_package_id, 'bill_net', s.bill_net, 'env', s.env, 'by', 'customer'), null, null);
  return s;
end $$;
revoke all on function public.cs_begin_return_shipment(uuid,uuid,uuid,text,integer,text,text,numeric,numeric,integer,numeric,jsonb), public.cs_finish_return_shipment(uuid,text,text[],uuid) from public, anon, authenticated;
grant execute on function public.cs_begin_return_shipment(uuid,uuid,uuid,text,integer,text,text,numeric,numeric,integer,numeric,jsonb), public.cs_finish_return_shipment(uuid,text,text[],uuid) to service_role;

-- ---------- the warehouse ----------
-- The parcel arrives: scan it in, with what it weighs and how long its longest side is (this decides the handling class).
create or replace function public.receive_return(p_return uuid, p_weight_g integer, p_side_cm numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin', 'warehouse'); ret public.returns;
begin
  select * into ret from public.returns where id = p_return for update;
  if not found then raise exception 'Return not found'; end if;
  if ret.status = 'received' then return jsonb_build_object('replayed', true); end if;
  if ret.status not in ('announced', 'label_issued') then raise exception 'This return is %, so it cannot be received', ret.status; end if;
  if p_weight_g is null or p_weight_g not between 1 and 70000 then raise exception 'Enter the weight of the parcel, from 1 g to 70 kg'; end if;
  if p_side_cm is null or p_side_cm <= 0 or p_side_cm > 300 then raise exception 'Enter the longest side of the parcel in cm'; end if;
  update public.returns set status = 'received', received_at = now(), weight_g = p_weight_g, side_cm = p_side_cm where id = p_return;
  perform public.wms_audit(r, 'return.receive', 'returns', p_return::text, ret.org_id, jsonb_build_object('ref', ret.ref, 'weight_g', p_weight_g, 'side_cm', p_side_cm));
  return jsonb_build_object('replayed', false);
end $$;

-- Inspect one line: how many came back, and the grade. A goes back on the customer's shelf. B and C (damaged, not sellable) are set aside in quarantine.
-- When every line is graded the return is finished and its handling fee is written.
create or replace function public.grade_return_line(p_line uuid, p_received integer, p_grade text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin', 'warehouse'); l public.return_lines; ret public.returns; loc uuid; left_ integer;
begin
  select * into l from public.return_lines where id = p_line for update;
  if not found then raise exception 'Return line not found'; end if;
  select * into ret from public.returns where id = l.return_id for update;
  if l.grade is not null then return jsonb_build_object('replayed', true); end if;                -- a repeated grade changes nothing
  if ret.status <> 'received' then raise exception 'Receive the parcel first (this return is %)', ret.status; end if;
  if p_received is null or p_received < 0 or p_received > 100000 then raise exception 'Enter how many came back'; end if;
  if p_received > 0 and (p_grade is null or p_grade not in ('A', 'B', 'C')) then raise exception 'Choose a grade: A (sellable), B or C (not sellable)'; end if;
  if p_received = 0 then p_grade := 'C'; end if;
  if p_received > 0 then
    loc := case when p_grade = 'A' then public.wms_default_bin(ret.org_id) else public.wms_ensure_location('quarantine', 'QUARANTINE') end;
    perform public.wms_post(ret.org_id, l.product_id, loc, p_received, 'receive', 'return', ret.id::text, '', null, 'return:' || l.id::text, p_note);
    if p_grade = 'A' then perform public.wms_allocate_held(ret.org_id); end if;
  end if;
  update public.return_lines set received_qty = p_received, grade = p_grade, note = nullif(left(btrim(coalesce(p_note, '')), 500), '') where id = p_line;
  perform public.wms_audit(r, 'return.grade', 'return_lines', p_line::text, ret.org_id, jsonb_build_object('ref', ret.ref, 'received', p_received, 'grade', p_grade));
  select count(*) into left_ from public.return_lines where return_id = ret.id and grade is null;
  if left_ = 0 then
    update public.returns set status = 'graded', graded_at = now() where id = ret.id;
    perform public.wms_write_return_handling(ret.id);
  end if;
  return jsonb_build_object('replayed', false, 'finished', left_ = 0);
end $$;

-- The fee for one return: the class of the parcel that arrived, in the return column of the tariff, plus the customer's discount or surcharge. Written once, never for flat plans.
create or replace function public.wms_write_return_handling(p_return uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ret public.returns; st public.org_shipping_settings; adj numeric := 0; live boolean := false; tier public.handling_tiers; net numeric(10,2); oversize boolean := false;
begin
  select * into ret from public.returns where id = p_return;
  if not found or ret.fee_mode <> 'payg' or ret.weight_g is null then return; end if;
  if exists (select 1 from public.shipping_charges where return_id = p_return and kind = 'return_handling') then return; end if;
  select * into st from public.org_shipping_settings where org_id = ret.org_id;
  if found then adj := st.handling_adjust_percent; live := st.usage_billing_live; end if;
  select * into tier from public.handling_tiers where ret.weight_g <= max_weight_g and ret.side_cm <= max_side_cm order by sort limit 1;
  if not found then oversize := true; net := 0; else net := round(tier.return_net * (1 + adj / 100), 2); end if;
  insert into public.shipping_charges (org_id, return_id, kind, seq, net, tax_percent, status, env, size_class, note)
  values (ret.org_id, p_return, 'return_handling', 1, net, 23, case when oversize or not live then 'waived' else 'pending' end, case when live then 'production' else 'sandbox' end,
          case when oversize then 'oversize' else tier.size_class end, case when oversize then 'The parcel is larger than the biggest class: no tariff, set the charge by hand' else format('Return %s, class %s', ret.ref, tier.size_class) end)
  on conflict do nothing;
end $$;
create unique index shipping_charges_one_return_fee on public.shipping_charges (return_id) where kind = 'return_handling';
revoke all on function public.wms_write_return_handling(uuid) from public, anon, authenticated;

do $$ declare f text; begin
  foreach f in array array['receive_return(uuid,integer,numeric)', 'grade_return_line(uuid,integer,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------- what a customer may see of the charges on their account (never our cost, markup or margin) ----------
create or replace function public.my_charges(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_member(p_org) then raise exception 'No access'; end if;
  return coalesce((select jsonb_agg(x order by (x->>'at') desc) from (
    select jsonb_build_object('at', c.created_at, 'kind', c.kind, 'net', c.net, 'tax_percent', c.tax_percent, 'status', case when c.status = 'waived' then 'test' else c.status end, 'size_class', c.size_class,
           'order_ref', o.ref, 'return_ref', rt.ref, 'note', case when c.kind = 'credit' then c.note when c.kind = 'adjustment' then c.note else null end) x
    from public.shipping_charges c left join public.orders o on o.id = c.order_id left join public.returns rt on rt.id = c.return_id where c.org_id = p_org order by c.created_at desc limit 200) t), '[]'::jsonb);
end $$;
revoke all on function public.my_charges(uuid) from public, anon; grant execute on function public.my_charges(uuid) to authenticated;

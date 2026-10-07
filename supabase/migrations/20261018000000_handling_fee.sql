-- Pay-as-you-go fulfilment, step 1: the handling fee (packing, priced like Allegro One Fulfillment: by the size of the parcel).
-- Every order of a customer on Fulfilment as you go ("payg") is charged one handling fee when it ships, from a tariff table staff can edit.
-- The charge goes into the same ledger as shipping labels. It is only ever billed (pending) for customers an admin has marked live: everyone else is waived,
-- so tests can never bill a real customer. The monthly ceiling (350 zł per m²) is applied when invoicing, in a later step, never per order.

-- ---------- the tariff ----------
create table public.handling_tiers (
  size_class text primary key,
  sort integer not null unique,
  max_weight_g integer not null check (max_weight_g between 1 and 70000),
  max_side_cm numeric(6,1) not null check (max_side_cm between 1 and 300),      -- the longest side of the parcel
  handling_net numeric(8,2) not null check (handling_net >= 0),                 -- packing one order of this size, excluding VAT
  return_net numeric(8,2) not null check (return_net >= 0)                      -- handling one return of this size
);
create table public.billing_rates (key text primary key, value numeric(8,2) not null check (value >= 0));
alter table public.handling_tiers enable row level security;
alter table public.billing_rates enable row level security;
create policy "staff read handling tiers" on public.handling_tiers for select using (public.has_staff_role('admin','support','warehouse'));
create policy "staff read billing rates" on public.billing_rates for select using (public.has_staff_role('admin','support','warehouse'));
revoke insert, update, delete, truncate on public.handling_tiers, public.billing_rates from anon, authenticated;
-- Starting prices (placeholders until the owner sets them in the admin panel). A return costs 1.5 times a packed order of the same size.
insert into public.handling_tiers (size_class, sort, max_weight_g, max_side_cm, handling_net, return_net) values
  ('XS', 1, 500, 35, 3.20, 4.80), ('S', 2, 1000, 40, 4.20, 6.30), ('M', 3, 5000, 60, 5.90, 8.85), ('L', 4, 10000, 80, 8.50, 12.75), ('XL', 5, 30000, 120, 12.90, 19.35);
insert into public.billing_rates (key, value) values ('handling_extra_parcel', 0.60), ('return_extra_parcel', 0.90);

-- The tariff is public information (it is shown when choosing a plan), so anyone may read it through this function.
create or replace function public.handling_tariff() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'tiers', coalesce((select jsonb_agg(jsonb_build_object('size_class', size_class, 'max_weight_g', max_weight_g, 'max_side_cm', max_side_cm, 'handling_net', handling_net, 'return_net', return_net) order by sort) from public.handling_tiers), '[]'::jsonb),
    'extra_parcel', coalesce((select value from public.billing_rates where key = 'handling_extra_parcel'), 0),
    'return_extra_parcel', coalesce((select value from public.billing_rates where key = 'return_extra_parcel'), 0));
$$;
revoke all on function public.handling_tariff() from public; grant execute on function public.handling_tariff() to anon, authenticated;

-- Admin: replace the whole tariff. Sizes must grow from one class to the next so every parcel falls in exactly one class.
create or replace function public.set_handling_tiers(p_tiers jsonb, p_rates jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin'); t jsonb; i integer := 0; pw integer := 0; ps numeric := 0; w integer; sd numeric; k text;
begin
  if jsonb_typeof(p_tiers) is distinct from 'array' or jsonb_array_length(p_tiers) not between 1 and 12 then raise exception 'Enter 1 to 12 size classes'; end if;
  for t in select * from jsonb_array_elements(p_tiers) loop
    i := i + 1; w := (t->>'max_weight_g')::integer; sd := (t->>'max_side_cm')::numeric;
    if coalesce(btrim(t->>'size_class'), '') = '' or length(t->>'size_class') > 12 then raise exception 'Class %: give it a short name', i; end if;
    if w is null or sd is null or w <= pw or sd < ps then raise exception 'Class %: each class must allow more weight than the one before, and not a shorter side', i; end if;
    if (t->>'handling_net')::numeric is null or (t->>'handling_net')::numeric < 0 or (t->>'return_net')::numeric is null or (t->>'return_net')::numeric < 0 then raise exception 'Class %: enter the two prices', i; end if;
    pw := w; ps := sd;
  end loop;
  if p_rates is not null then
    for k in select jsonb_object_keys(p_rates) loop if k not in ('handling_extra_parcel', 'return_extra_parcel') then raise exception 'Unknown rate %', k; end if; end loop;
  end if;
  delete from public.handling_tiers;
  i := 0;
  for t in select * from jsonb_array_elements(p_tiers) loop
    i := i + 1;
    insert into public.handling_tiers (size_class, sort, max_weight_g, max_side_cm, handling_net, return_net) values (btrim(t->>'size_class'), i, (t->>'max_weight_g')::integer, (t->>'max_side_cm')::numeric, round((t->>'handling_net')::numeric, 2), round((t->>'return_net')::numeric, 2));
  end loop;
  if p_rates is not null then
    for k in select jsonb_object_keys(p_rates) loop update public.billing_rates set value = round((p_rates->>k)::numeric, 2) where key = k; end loop;
  end if;
  perform public.wms_audit(r, 'billing.tariff', 'handling_tiers', null, null, jsonb_build_object('tiers', p_tiers, 'rates', p_rates));
end $$;
revoke all on function public.set_handling_tiers(jsonb, jsonb) from public, anon; grant execute on function public.set_handling_tiers(jsonb, jsonb) to authenticated;

-- ---------- per-customer settings ----------
alter table public.org_shipping_settings
  add column handling_adjust_percent numeric(5,2) not null default 0 check (handling_adjust_percent between -100 and 500),   -- a discount (negative) or surcharge on the tariff for this customer
  add column handling_cap_per_m2 numeric(8,2) not null default 350 check (handling_cap_per_m2 between 0 and 5000),        -- the most handling fees can add up to in a month, per m² of their space
  add column return_cap_per_m2 numeric(8,2) not null default 150 check (return_cap_per_m2 between 0 and 5000),
  add column usage_billing_live boolean not null default false;                                                              -- until an admin sets this, handling and return fees are recorded as waived

create or replace function public.set_org_shipping(p_org uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin'); k text;
begin
  if not exists (select 1 from public.organizations where id = p_org) then raise exception 'Customer not found'; end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Nothing to change'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('markup_percent','max_label_net','exposure_cap_net','daily_label_cap','label_buying_enabled','tol_weight_pct','tol_weight_g','tol_dim_cm','fulfil_mode_override','handling_adjust_percent','handling_cap_per_m2','return_cap_per_m2','usage_billing_live') then raise exception 'Unknown setting %', k; end if;
  end loop;
  if (p_patch ? 'fulfil_mode_override') and nullif(p_patch->>'fulfil_mode_override', '') is not null and (p_patch->>'fulfil_mode_override') not in ('full','payg','storage') then raise exception 'Choose full, payg or storage'; end if;
  insert into public.org_shipping_settings (org_id) values (p_org) on conflict (org_id) do nothing;
  update public.org_shipping_settings set
    markup_percent = case when p_patch ? 'markup_percent' then nullif(p_patch->>'markup_percent', '')::numeric else markup_percent end,
    max_label_net = case when p_patch ? 'max_label_net' then nullif(p_patch->>'max_label_net', '')::numeric else max_label_net end,
    exposure_cap_net = case when p_patch ? 'exposure_cap_net' then (p_patch->>'exposure_cap_net')::numeric else exposure_cap_net end,
    daily_label_cap = case when p_patch ? 'daily_label_cap' then (p_patch->>'daily_label_cap')::integer else daily_label_cap end,
    label_buying_enabled = case when p_patch ? 'label_buying_enabled' then (p_patch->>'label_buying_enabled')::boolean else label_buying_enabled end,
    tol_weight_pct = case when p_patch ? 'tol_weight_pct' then (p_patch->>'tol_weight_pct')::integer else tol_weight_pct end,
    tol_weight_g = case when p_patch ? 'tol_weight_g' then (p_patch->>'tol_weight_g')::integer else tol_weight_g end,
    tol_dim_cm = case when p_patch ? 'tol_dim_cm' then (p_patch->>'tol_dim_cm')::numeric else tol_dim_cm end,
    fulfil_mode_override = case when p_patch ? 'fulfil_mode_override' then nullif(p_patch->>'fulfil_mode_override', '') else fulfil_mode_override end,
    handling_adjust_percent = case when p_patch ? 'handling_adjust_percent' then coalesce(nullif(p_patch->>'handling_adjust_percent', '')::numeric, 0) else handling_adjust_percent end,
    handling_cap_per_m2 = case when p_patch ? 'handling_cap_per_m2' then (p_patch->>'handling_cap_per_m2')::numeric else handling_cap_per_m2 end,
    return_cap_per_m2 = case when p_patch ? 'return_cap_per_m2' then (p_patch->>'return_cap_per_m2')::numeric else return_cap_per_m2 end,
    usage_billing_live = case when p_patch ? 'usage_billing_live' then (p_patch->>'usage_billing_live')::boolean else usage_billing_live end,
    updated_by = auth.uid(), updated_at = now()
  where org_id = p_org;
  perform public.wms_audit(r, 'org.shipping_settings', 'organizations', p_org::text, p_org, p_patch);
end $$;
revoke all on function public.set_org_shipping(uuid, jsonb) from public, anon; grant execute on function public.set_org_shipping(uuid, jsonb) to authenticated;

-- ---------- the ledger learns about usage charges ----------
alter table public.shipping_charges drop constraint shipping_charges_kind_check;
alter table public.shipping_charges add constraint shipping_charges_kind_check check (kind in ('label','adjustment','credit','handling','return_handling','return_label'));
alter table public.shipping_charges alter column shipment_id drop not null, alter column order_id drop not null;       -- handling belongs to an order, a return fee to a return
alter table public.shipping_charges add column return_id uuid, add column size_class text;
create unique index shipping_charges_one_handling on public.shipping_charges (order_id) where kind = 'handling';

-- ---------- the fee for one order ----------
-- The order pays the tier of its dearest parcel once, plus a small fee for every further parcel. A parcel bigger than the biggest class has no tariff: the row
-- is written with 0 and "oversize" and staff add the charge by hand.
create or replace function public.wms_write_handling(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; st public.org_shipping_settings; adj numeric := 0; live boolean := false; n integer; p record; tier public.handling_tiers; best numeric := -1; cls text; oversize boolean := false; extra numeric; net numeric(10,2);
begin
  select * into o from public.orders where id = p_order;
  if not found or o.fulfil_mode <> 'payg' then return; end if;                                   -- flat-fee plans pay no handling fee
  if exists (select 1 from public.shipping_charges where order_id = p_order and kind = 'handling') then return; end if;
  select count(*) into n from public.parcels where order_id = p_order;
  if n = 0 then return; end if;
  select * into st from public.org_shipping_settings where org_id = o.org_id;
  if found then adj := st.handling_adjust_percent; live := st.usage_billing_live; end if;
  for p in select weight_g, greatest(length_cm, width_cm, height_cm) side from public.parcels where order_id = p_order loop
    select * into tier from public.handling_tiers where p.weight_g <= max_weight_g and p.side <= max_side_cm order by sort limit 1;
    if not found then oversize := true; elsif tier.handling_net > best then best := tier.handling_net; cls := tier.size_class; end if;
  end loop;
  select coalesce(value, 0) into extra from public.billing_rates where key = 'handling_extra_parcel';
  net := case when oversize then 0 else round((best + coalesce(extra, 0) * (n - 1)) * (1 + adj / 100), 2) end;
  insert into public.shipping_charges (org_id, order_id, kind, seq, net, tax_percent, status, env, size_class, note)
  values (o.org_id, p_order, 'handling', 1, net, 23, case when oversize or not live then 'waived' else 'pending' end, case when live then 'production' else 'sandbox' end,
          case when oversize then 'oversize' else cls end,
          case when oversize then 'A parcel is larger than the biggest class: no tariff, set the charge by hand' else format('%s parcel(s), class %s', n, cls) end)
  on conflict do nothing;
end $$;
revoke all on function public.wms_write_handling(uuid) from public, anon, authenticated;

-- The order leaves stock here (for every way an order can ship), so this is where its handling fee is written, once.
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
  perform public.wms_write_handling(p_order);
end $$;
revoke all on function public.wms_ship_order_stock(uuid) from public, anon, authenticated;

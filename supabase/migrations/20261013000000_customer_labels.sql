-- Customer-prepared shipping labels, step 1: the foundation.
--  * per-customer shipping settings (markup, caps, switches), kept in a table only staff can read (organizations is readable by the customer)
--  * which fulfilment mode a customer is on: 'full' (we do everything), 'payg' (fulfilment as you go: they prepare labels) or 'storage' (neither)
--  * a ledger of shipping charges, one row per label bought, which is what gets invoiced later. Test (sandbox) labels are never billed.

create table public.org_shipping_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  markup_percent numeric(5,2) check (markup_percent is null or markup_percent between 0 and 500),     -- null = the default (SHIPPING_MARKUP_PERCENT, 30)
  max_label_net numeric(10,2) check (max_label_net is null or max_label_net >= 0),                      -- per-label cap for this customer, null = default
  exposure_cap_net numeric(10,2) not null default 300 check (exposure_cap_net between 0 and 100000),   -- labels bought but not yet paid for
  daily_label_cap integer not null default 10 check (daily_label_cap between 0 and 1000),
  label_buying_enabled boolean not null default false,                                                   -- may this customer buy labels themselves
  tol_weight_pct integer not null default 10 check (tol_weight_pct between 0 and 100),
  tol_weight_g integer not null default 100 check (tol_weight_g between 0 and 5000),
  tol_dim_cm numeric(5,1) not null default 2 check (tol_dim_cm between 0 and 50),
  fulfil_mode_override text check (fulfil_mode_override in ('full','payg','storage')),                   -- for testing before billing is wired; null = follow the plan
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
alter table public.org_shipping_settings enable row level security;
create policy "staff read org shipping settings" on public.org_shipping_settings for select using (public.has_staff_role('admin','support','warehouse'));
revoke insert, update, delete, truncate on public.org_shipping_settings from anon, authenticated;

-- The mode: the staff override if set, else what the customer's active plan includes.
create or replace function public.org_fulfil_mode(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select fulfil_mode_override from public.org_shipping_settings where org_id = p_org),
    (select case when (config->'pkgs'->>'ful') = 'true' then 'full' when (config->'pkgs'->>'payg') = 'true' then 'payg' else 'storage' end
       from public.plans where org_id = p_org and status = 'active' order by created_at desc limit 1),
    'storage');
$$;
revoke all on function public.org_fulfil_mode(uuid) from public, anon, authenticated;
-- The same, for the people allowed to see it: the customer's own team and staff.
create or replace function public.my_fulfil_mode(p_org uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_member(p_org) or public.has_staff_role('admin','support','warehouse')) then raise exception 'No access'; end if;
  return public.org_fulfil_mode(p_org);
end $$;
revoke all on function public.my_fulfil_mode(uuid) from public, anon; grant execute on function public.my_fulfil_mode(uuid) to authenticated;

-- Admin only: change a customer's shipping settings. Only the keys sent are changed.
create or replace function public.set_org_shipping(p_org uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin'); k text;
begin
  if not exists (select 1 from public.organizations where id = p_org) then raise exception 'Customer not found'; end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Nothing to change'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('markup_percent','max_label_net','exposure_cap_net','daily_label_cap','label_buying_enabled','tol_weight_pct','tol_weight_g','tol_dim_cm','fulfil_mode_override') then raise exception 'Unknown setting %', k; end if;
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
    updated_by = auth.uid(), updated_at = now()
  where org_id = p_org;
  perform public.wms_audit(r, 'org.shipping_settings', 'organizations', p_org::text, p_org, p_patch);
end $$;
revoke all on function public.set_org_shipping(uuid, jsonb) from public, anon; grant execute on function public.set_org_shipping(uuid, jsonb) to authenticated;

-- Every order remembers the mode its customer was on when it was placed, so a later plan change cannot strand an order in flight.
alter table public.orders
  add column fulfil_mode text not null default 'full' check (fulfil_mode in ('full','payg','storage')),
  add column label_source text check (label_source in ('2ace','own')),
  add column label_flag text check (label_flag in ('mismatch','missing_label'));
create or replace function public.orders_stamp_mode() returns trigger
language plpgsql security definer set search_path = '' as $$
begin new.fulfil_mode := public.org_fulfil_mode(new.org_id); return new; end $$;
create trigger orders_stamp_mode before insert on public.orders for each row execute function public.orders_stamp_mode();

-- The ledger of shipping charges: one 'label' row per label bought. This, not shipments.billing_status, is what gets invoiced.
create table public.shipping_charges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  shipment_id uuid not null references public.shipments(id) on delete restrict,
  kind text not null default 'label' check (kind in ('label','adjustment','credit')),
  seq integer not null default 1,
  net numeric(10,2) not null,                                       -- signed: credits are negative
  tax_percent integer not null default 23,
  status text not null default 'pending' check (status in ('pending','queued','invoiced','paid','waived','void')),
  env text not null check (env in ('sandbox','production')),
  stripe_invoice_item_id text,
  stripe_invoice_id text,
  note text,
  created_at timestamptz not null default now(),
  unique (shipment_id, kind, seq)
);
create index shipping_charges_org_idx on public.shipping_charges (org_id, status);
alter table public.shipping_charges enable row level security;
create policy "staff read shipping charges" on public.shipping_charges for select using (public.has_staff_role('admin','support','warehouse'));
revoke insert, update, delete, truncate on public.shipping_charges from anon, authenticated;

-- One choke point for every way a label can be bought (staff, customer, recheck): when a shipment becomes 'purchased' its charge is written, once.
-- Labels bought in the sandbox (test) are 'waived', so test orders can never bill a real customer.
create or replace function public.shipments_write_charge() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'purchased' and (tg_op = 'INSERT' or old.status is distinct from 'purchased') then
    insert into public.shipping_charges (org_id, order_id, shipment_id, kind, seq, net, tax_percent, status, env)
    values (new.org_id, new.order_id, new.id, 'label', 1, new.bill_net, new.tax_percent, case when new.env = 'sandbox' then 'waived' else 'pending' end, new.env)
    on conflict (shipment_id, kind, seq) do nothing;
    update public.shipments set billing_status = case when new.env = 'sandbox' then 'waived' else 'pending' end where id = new.id and billing_status is distinct from (case when new.env = 'sandbox' then 'waived' else 'pending' end);
  end if;
  return null;
end $$;
create trigger shipments_write_charge after insert or update of status on public.shipments for each row execute function public.shipments_write_charge();

-- Labels bought before this existed get their charge row now.
insert into public.shipping_charges (org_id, order_id, shipment_id, kind, seq, net, tax_percent, status, env)
select org_id, order_id, id, 'label', 1, bill_net, tax_percent, case when env = 'sandbox' then 'waived' else 'pending' end, env from public.shipments where status = 'purchased'
on conflict (shipment_id, kind, seq) do nothing;

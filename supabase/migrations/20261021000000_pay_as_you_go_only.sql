-- One model from now on: storage is the only fixed monthly price. Fulfilment and returns are pay as you go for every customer:
-- a handling fee per shipped order and per return (by parcel size), plus labels at carrier price and markup. There are no flat monthly fees for them and no monthly ceiling.

-- Every customer with an active plan is pay as you go (an admin can still override a customer, for testing). Without a plan nothing can ship.
create or replace function public.org_fulfil_mode(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select fulfil_mode_override from public.org_shipping_settings where org_id = p_org),
    (select 'payg' from public.plans where org_id = p_org and status = 'active' limit 1),
    'storage');
$$;
revoke all on function public.org_fulfil_mode(uuid) from public, anon, authenticated;
create or replace function public.org_returns_mode(p_org uuid) returns text language sql stable set search_path = '' as $$ select 'payg'::text $$;
revoke all on function public.org_returns_mode(uuid) from public, anon, authenticated;

-- The monthly ceiling is gone: every pending charge goes on the invoice as it is.
create or replace function public.usage_prepare_invoice(p_org uuid, p_invoice text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare lines jsonb; total numeric;
begin
  if coalesce(btrim(p_invoice), '') = '' then raise exception 'The invoice id is missing'; end if;
  perform pg_advisory_xact_lock(hashtext('usage:' || p_org::text));
  update public.shipping_charges set status = 'queued', stripe_invoice_id = p_invoice
  where org_id = p_org and status = 'pending' and env = 'production' and not exists (select 1 from public.shipping_charges x where x.org_id = p_org and x.stripe_invoice_id = p_invoice and x.status in ('queued', 'invoiced', 'paid'));
  select coalesce(jsonb_agg(jsonb_build_object('kind', k, 'note', n, 'count', c, 'net_cents', round(s * 100)::integer) order by k, n), '[]'::jsonb), coalesce(sum(s), 0) into lines, total
  from (select kind k, case when kind = 'credit' then note else null end n, count(*) c, sum(net) s from public.shipping_charges where org_id = p_org and stripe_invoice_id = p_invoice and status in ('queued', 'invoiced', 'paid') group by kind, case when kind = 'credit' then note else null end) g;
  return jsonb_build_object('lines', lines, 'total_cents', round(total * 100)::integer);
end $$;
revoke all on function public.usage_prepare_invoice(uuid, text) from public, anon, authenticated; grant execute on function public.usage_prepare_invoice(uuid, text) to service_role;
drop function if exists public.org_area_m2(uuid);

alter table public.org_shipping_settings drop column handling_cap_per_m2, drop column return_cap_per_m2;
create or replace function public.set_org_shipping(p_org uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin'); k text;
begin
  if not exists (select 1 from public.organizations where id = p_org) then raise exception 'Customer not found'; end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Nothing to change'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('markup_percent','max_label_net','exposure_cap_net','daily_label_cap','label_buying_enabled','tol_weight_pct','tol_weight_g','tol_dim_cm','fulfil_mode_override','handling_adjust_percent','usage_billing_live') then raise exception 'Unknown setting %', k; end if;
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
    usage_billing_live = case when p_patch ? 'usage_billing_live' then (p_patch->>'usage_billing_live')::boolean else usage_billing_live end,
    updated_by = auth.uid(), updated_at = now()
  where org_id = p_org;
  perform public.wms_audit(r, 'org.shipping_settings', 'organizations', p_org::text, p_org, p_patch);
end $$;
revoke all on function public.set_org_shipping(uuid, jsonb) from public, anon; grant execute on function public.set_org_shipping(uuid, jsonb) to authenticated;

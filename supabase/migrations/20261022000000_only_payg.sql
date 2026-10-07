-- The flat "full" fulfilment mode no longer exists: a customer is pay as you go (payg) or has no active plan (storage).
update public.orders set fulfil_mode = 'payg' where fulfil_mode = 'full';
update public.org_shipping_settings set fulfil_mode_override = 'payg' where fulfil_mode_override = 'full';
alter table public.orders drop constraint orders_fulfil_mode_check;
alter table public.orders add constraint orders_fulfil_mode_check check (fulfil_mode in ('payg', 'storage'));
alter table public.org_shipping_settings drop constraint org_shipping_settings_fulfil_mode_override_check;
alter table public.org_shipping_settings add constraint org_shipping_settings_fulfil_mode_override_check check (fulfil_mode_override in ('payg', 'storage'));
create or replace function public.set_org_shipping(p_org uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin'); k text;
begin
  if not exists (select 1 from public.organizations where id = p_org) then raise exception 'Customer not found'; end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Nothing to change'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('markup_percent','max_label_net','exposure_cap_net','daily_label_cap','label_buying_enabled','tol_weight_pct','tol_weight_g','tol_dim_cm','fulfil_mode_override','handling_adjust_percent','usage_billing_live') then raise exception 'Unknown setting %', k; end if;
  end loop;
  if (p_patch ? 'fulfil_mode_override') and nullif(p_patch->>'fulfil_mode_override', '') is not null and (p_patch->>'fulfil_mode_override') not in ('payg','storage') then raise exception 'Choose payg or storage'; end if;
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

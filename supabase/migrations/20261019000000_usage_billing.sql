-- Pay-as-you-go billing, step 3: putting usage charges on the monthly invoice.
-- When Stripe creates the customer's monthly subscription invoice (still a draft for about an hour), the stripe-webhook function calls usage_prepare_invoice:
-- it takes every pending live charge of that customer (labels, handling fees, return fees, return labels, adjustments), applies the monthly ceiling per m² to
-- handling and return fees as a visible credit line, marks everything as queued for that invoice and returns the lines to add. Calling it again for the same
-- invoice returns the same lines and changes nothing, so a retried webhook can never double-bill. Later events move the rows to invoiced, paid or back to pending.
-- Only the server (service role) can call these functions.

create or replace function public.org_area_m2(p_org uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when config ? 'm2' and nullif(config->>'m2', '') is not null then (config->>'m2')::numeric
              when config->>'storageType' = 'shelf' then coalesce((config->>'qty')::numeric, 0) * 0.3
              when config->>'storageType' = 'pallet' then coalesce((config->>'qty')::numeric, 0) * 1.2 end
  from public.plans where org_id = p_org and status = 'active' order by created_at desc limit 1;
$$;
revoke all on function public.org_area_m2(uuid) from public, anon, authenticated;

create or replace function public.usage_prepare_invoice(p_org uuid, p_invoice text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st public.org_shipping_settings; m2 numeric := public.org_area_m2(p_org); h_sum numeric; r_sum numeric; h_cap numeric; r_cap numeric; lines jsonb; total numeric; already integer;
begin
  if coalesce(btrim(p_invoice), '') = '' then raise exception 'The invoice id is missing'; end if;
  perform pg_advisory_xact_lock(hashtext('usage:' || p_org::text));
  select count(*) into already from public.shipping_charges where org_id = p_org and stripe_invoice_id = p_invoice and status in ('queued', 'invoiced', 'paid');
  if already = 0 then
    select * into st from public.org_shipping_settings where org_id = p_org;
    -- the ceiling: handling fees and return fees of this invoice can never add up to more than the ceiling per m² of the customer's space
    if m2 is not null and m2 > 0 then
      h_cap := round(coalesce(st.handling_cap_per_m2, 350) * m2, 2); r_cap := round(coalesce(st.return_cap_per_m2, 150) * m2, 2);
      select coalesce(sum(net), 0) into h_sum from public.shipping_charges where org_id = p_org and status = 'pending' and env = 'production' and kind = 'handling';
      select coalesce(sum(net), 0) into r_sum from public.shipping_charges where org_id = p_org and status = 'pending' and env = 'production' and kind = 'return_handling';
      if h_sum > h_cap then insert into public.shipping_charges (org_id, kind, seq, net, tax_percent, status, env, note) values (p_org, 'credit', 1, -(h_sum - h_cap), 23, 'pending', 'production', format('Monthly ceiling on handling fees: %s zł per m² x %s m²', coalesce(st.handling_cap_per_m2, 350), m2)); end if;
      if r_sum > r_cap then insert into public.shipping_charges (org_id, kind, seq, net, tax_percent, status, env, note) values (p_org, 'credit', 2, -(r_sum - r_cap), 23, 'pending', 'production', format('Monthly ceiling on return fees: %s zł per m² x %s m²', coalesce(st.return_cap_per_m2, 150), m2)); end if;
    end if;
    update public.shipping_charges set status = 'queued', stripe_invoice_id = p_invoice where org_id = p_org and status = 'pending' and env = 'production';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind', k, 'note', n, 'count', c, 'net_cents', round(s * 100)::integer) order by k, n), '[]'::jsonb), coalesce(sum(s), 0) into lines, total
  from (select kind k, case when kind = 'credit' then note else null end n, count(*) c, sum(net) s from public.shipping_charges where org_id = p_org and stripe_invoice_id = p_invoice and status in ('queued', 'invoiced', 'paid') group by kind, case when kind = 'credit' then note else null end) g;
  return jsonb_build_object('lines', lines, 'total_cents', round(total * 100)::integer, 'area_m2', m2);
end $$;

-- Stripe tells us what happened to the invoice. finalized: the invoice is out. paid: it was paid. voided: it will never be paid, so the charges go back to waiting for the next invoice.
create or replace function public.usage_invoice_event(p_invoice text, p_event text) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if p_event = 'finalized' then
    update public.shipping_charges set status = 'invoiced' where stripe_invoice_id = p_invoice and status = 'queued';
  elsif p_event = 'paid' then
    update public.shipping_charges set status = 'paid' where stripe_invoice_id = p_invoice and status in ('queued', 'invoiced');
  elsif p_event = 'voided' then
    update public.shipping_charges set status = 'void' where stripe_invoice_id = p_invoice and kind = 'credit' and note like 'Monthly ceiling%' and status in ('queued', 'invoiced');
    update public.shipping_charges set status = 'pending', stripe_invoice_id = null where stripe_invoice_id = p_invoice and status in ('queued', 'invoiced');
  else raise exception 'Unknown invoice event'; end if;
  get diagnostics n = row_count;
  return n;
end $$;

do $$ declare f text; begin
  foreach f in array array['usage_prepare_invoice(uuid,text)', 'usage_invoice_event(text,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

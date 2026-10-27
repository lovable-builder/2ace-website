-- Customers are created by 2ACE in the admin panel (self-service plans are off). The admin invites the person by email: the sign-up trigger builds their profile,
-- company and owner membership (the company starts as 'pending'). These two functions then make the company a working customer: active, with one managed
-- service record (no price in the plan: fulfilment and returns are charged per use, anything else is agreed in writing). Only the server (service role) can call them.

create or replace function public.admin_activate_customer(p_org uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
  if not exists (select 1 from public.organizations where id = p_org) then raise exception 'Customer not found'; end if;
  update public.organizations set status = 'active' where id = p_org;
  update public.plans set status = 'canceled' where org_id = p_org and status = 'active';   -- one live service at a time
  insert into public.plans (org_id, config, monthly_pln, once_pln, status)
  values (p_org, jsonb_build_object('service', 'managed') || case when note is null then '{}'::jsonb else jsonb_build_object('note', note) end, 0, 0, 'active');
end $$;

-- What was agreed, in words, shown to the customer on their overview. Changes the live service record only.
create or replace function public.admin_set_service_note(p_org uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
  update public.plans set config = case when note is null then config - 'note' else config || jsonb_build_object('note', note) end
   where org_id = p_org and status = 'active' and config->>'service' = 'managed';
  if not found then raise exception 'This customer has no managed service. Only customers added in the admin panel have one.'; end if;
end $$;

do $$ declare f text; begin
  foreach f in array array['admin_activate_customer(uuid,text)', 'admin_set_service_note(uuid,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

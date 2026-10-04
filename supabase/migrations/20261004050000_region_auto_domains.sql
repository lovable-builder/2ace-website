-- Voivodeship (needed for .pl registrant contacts) + bookkeeping for automatic domain purchases.
alter table public.organizations add column region text;
grant update (region) on public.organizations to authenticated;

alter table public.domain_orders
  add column auto boolean not null default false,        -- bought through the Hostinger API (counts toward the monthly cap)
  add column whois_id integer,
  add column order_ref text;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  md jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  org uuid;
  company text := nullif(left(btrim(coalesce(md->>'company','')), 200), '');
begin
  insert into public.profiles (user_id, full_name, phone)
  values (new.id, nullif(left(btrim(coalesce(md->>'full_name','')), 200), ''), nullif(left(btrim(coalesce(md->>'phone','')), 40), ''));

  if company is not null then
    insert into public.organizations (name, country, vat_id, address_line, city, postal_code, phone, region)
    values (company,
            nullif(left(btrim(coalesce(md->>'country','')), 8), ''),
            nullif(left(btrim(coalesce(md->>'vat_id','')), 40), ''),
            nullif(left(btrim(coalesce(md->>'address_line','')), 200), ''),
            nullif(left(btrim(coalesce(md->>'city','')), 100), ''),
            nullif(left(btrim(coalesce(md->>'postal_code','')), 20), ''),
            nullif(left(btrim(coalesce(md->>'phone','')), 40), ''),
            nullif(left(btrim(coalesce(md->>'region','')), 60), ''))
    returning id into org;
    insert into public.members (org_id, user_id, role) values (org, new.id, 'owner');
  end if;
  return new;
end $$;

drop function if exists public.create_my_org(text,text,text,text,text,text,text);
create or replace function public.create_my_org(
  p_name text, p_country text, p_vat_id text default null, p_address_line text default null,
  p_city text default null, p_postal_code text default null, p_phone text default null, p_region text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); org uuid;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.members where user_id = uid) then raise exception 'You already have a company'; end if;
  if nullif(btrim(coalesce(p_name,'')), '') is null then raise exception 'Company name is required'; end if;
  insert into public.organizations (name, country, vat_id, address_line, city, postal_code, phone, region)
  values (left(btrim(p_name),200), nullif(left(btrim(coalesce(p_country,'')),8),''), nullif(left(btrim(coalesce(p_vat_id,'')),40),''),
          nullif(left(btrim(coalesce(p_address_line,'')),200),''), nullif(left(btrim(coalesce(p_city,'')),100),''),
          nullif(left(btrim(coalesce(p_postal_code,'')),20),''), nullif(left(btrim(coalesce(p_phone,'')),40),''),
          nullif(left(btrim(coalesce(p_region,'')),60),''))
  returning id into org;
  insert into public.members (org_id, user_id, role) values (org, uid, 'owner');
  return org;
end $$;
revoke all on function public.create_my_org(text,text,text,text,text,text,text,text) from public, anon;
grant execute on function public.create_my_org(text,text,text,text,text,text,text,text) to authenticated;

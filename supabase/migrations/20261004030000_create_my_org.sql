-- Lets a signed-in user without a company create theirs (e.g. account made before company fields existed).
create or replace function public.create_my_org(
  p_name text, p_country text, p_vat_id text default null, p_address_line text default null,
  p_city text default null, p_postal_code text default null, p_phone text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); org uuid;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.members where user_id = uid) then raise exception 'You already have a company'; end if;
  if nullif(btrim(coalesce(p_name,'')), '') is null then raise exception 'Company name is required'; end if;
  insert into public.organizations (name, country, vat_id, address_line, city, postal_code, phone)
  values (left(btrim(p_name),200), nullif(left(btrim(coalesce(p_country,'')),8),''), nullif(left(btrim(coalesce(p_vat_id,'')),40),''),
          nullif(left(btrim(coalesce(p_address_line,'')),200),''), nullif(left(btrim(coalesce(p_city,'')),100),''),
          nullif(left(btrim(coalesce(p_postal_code,'')),20),''), nullif(left(btrim(coalesce(p_phone,'')),40),''))
  returning id into org;
  insert into public.members (org_id, user_id, role) values (org, uid, 'owner');
  return org;
end $$;
revoke all on function public.create_my_org(text,text,text,text,text,text,text) from public, anon;
grant execute on function public.create_my_org(text,text,text,text,text,text,text) to authenticated;

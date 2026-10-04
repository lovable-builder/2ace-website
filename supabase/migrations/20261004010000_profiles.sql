-- Full signup details + self-service editing.

alter table public.organizations
  add column address_line text,
  add column city text,
  add column postal_code text,
  add column phone text;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "own profile read" on public.profiles for select using (user_id = auth.uid());
create policy "own profile insert" on public.profiles for insert with check (user_id = auth.uid());
create policy "own profile update" on public.profiles for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Owners and finance can edit company details. Column grants keep billing/status fields server-only.
create policy "owner/finance update org" on public.organizations for update
  using (exists (select 1 from public.members m where m.org_id = id and m.user_id = auth.uid() and m.role in ('owner','finance')))
  with check (exists (select 1 from public.members m where m.org_id = id and m.user_id = auth.uid() and m.role in ('owner','finance')));
revoke update on public.organizations from authenticated, anon;
grant update (name, country, vat_id, address_line, city, postal_code, phone) on public.organizations to authenticated;
grant select, insert, update on public.profiles to authenticated;

-- On signup, build the profile + company from the metadata sent by login.html.
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
    insert into public.organizations (name, country, vat_id, address_line, city, postal_code, phone)
    values (company,
            nullif(left(btrim(coalesce(md->>'country','')), 8), ''),
            nullif(left(btrim(coalesce(md->>'vat_id','')), 40), ''),
            nullif(left(btrim(coalesce(md->>'address_line','')), 200), ''),
            nullif(left(btrim(coalesce(md->>'city','')), 100), ''),
            nullif(left(btrim(coalesce(md->>'postal_code','')), 20), ''),
            nullif(left(btrim(coalesce(md->>'phone','')), 40), ''))
    returning id into org;
    insert into public.members (org_id, user_id, role) values (org, new.id, 'owner');
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

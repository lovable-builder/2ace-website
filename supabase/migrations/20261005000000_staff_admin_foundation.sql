-- Phase A foundation: staff accounts + roles, append-only audit log, requests inbox, staff read access.
-- Writes by staff never happen through table policies: they go through edge functions / RPCs (service role) that also write the audit log.

-- ---------- staff identity ----------
create table public.staff_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','support','warehouse')),
  active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.staff_users enable row level security;

-- The caller's active staff role, or null. Admin and support need a second factor (aal2); warehouse does not.
create or replace function public.staff_role() returns text
language sql stable security definer set search_path = '' as $$
  select s.role from public.staff_users s
  where s.user_id = auth.uid() and s.active
    and (s.role = 'warehouse' or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2');
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$ select public.staff_role() is not null; $$;
create or replace function public.has_staff_role(variadic roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$ select coalesce(public.staff_role() = any(roles), false); $$;
grant execute on function public.staff_role(), public.is_staff(), public.has_staff_role(text[]) to authenticated;

create policy "staff read own row, admin reads all" on public.staff_users for select
  using (user_id = auth.uid() or public.has_staff_role('admin'));

-- ---------- audit log (append-only) ----------
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_role text,
  action text not null,
  entity text,
  entity_id text,
  org_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  ip text
);
alter table public.audit_log enable row level security;
create policy "admin and support read audit" on public.audit_log for select using (public.has_staff_role('admin','support'));
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;
create or replace function public.audit_block_change() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only'; end $$;
create trigger audit_log_no_update before update or delete on public.audit_log for each row execute function public.audit_block_change();
create trigger audit_log_no_truncate before truncate on public.audit_log for each statement execute function public.audit_block_change();

-- Edge functions write audit rows through this (service role only).
create or replace function public.audit_write(
  p_actor uuid, p_role text, p_action text, p_entity text, p_entity_id text, p_org uuid,
  p_before jsonb, p_after jsonb, p_reason text, p_ip text
) returns void language sql security definer set search_path = '' as $$
  insert into public.audit_log (actor_id, actor_role, action, entity, entity_id, org_id, before, after, reason, ip)
  values (p_actor, p_role, p_action, p_entity, p_entity_id, p_org, p_before, p_after, p_reason, p_ip);
$$;
revoke all on function public.audit_write(uuid,text,text,text,text,uuid,jsonb,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.audit_write(uuid,text,text,text,text,uuid,jsonb,jsonb,text,text) to service_role;

-- ---------- requests inbox ----------
create table public.requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  requester_name text,
  requester_email text,
  subject text not null,
  source text not null default 'website',
  status text not null default 'new' check (status in ('new','open','waiting','resolved')),
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  assignee uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index requests_status_idx on public.requests (status, last_message_at desc);
create index requests_org_idx on public.requests (org_id);
alter table public.requests enable row level security;
create policy "staff read requests" on public.requests for select using (public.has_staff_role('admin','support'));
create policy "members read own requests" on public.requests for select using (org_id is not null and public.is_member(org_id));

create table public.request_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  direction text not null check (direction in ('in','out','note')),   -- note = internal, never shown to customers
  author_id uuid references auth.users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index request_messages_req_idx on public.request_messages (request_id, created_at);
alter table public.request_messages enable row level security;
create policy "staff read messages" on public.request_messages for select using (public.has_staff_role('admin','support'));
create policy "members read non-internal messages" on public.request_messages for select
  using (direction <> 'note' and exists (select 1 from public.requests r where r.id = request_id and r.org_id is not null and public.is_member(r.org_id)));

-- Existing leads become requests so nothing is lost.
insert into public.requests (org_id, lead_id, requester_name, requester_email, subject, source, created_at, last_message_at)
select l.org_id, l.id, l.name, l.email, coalesce(l.subject, 'Message from the website'), l.source, l.created_at, l.created_at from public.leads l;
insert into public.request_messages (request_id, direction, body, created_at)
select r.id, 'in', l.message, l.created_at from public.requests r join public.leads l on l.id = r.lead_id where coalesce(l.message, '') <> '';

-- ---------- owner email on profiles (staff need it; it lives only in auth.users today) ----------
alter table public.profiles add column email text;
update public.profiles p set email = u.email from auth.users u where u.id = p.user_id and p.email is null;
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  md jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  org uuid;
  company text := nullif(left(btrim(coalesce(md->>'company','')), 200), '');
begin
  insert into public.profiles (user_id, full_name, phone, email)
  values (new.id, nullif(left(btrim(coalesce(md->>'full_name','')), 200), ''), nullif(left(btrim(coalesce(md->>'phone','')), 40), ''), new.email);

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

-- ---------- staff read access to customer data (admin and support only) ----------
create policy "staff read organizations" on public.organizations for select using (public.has_staff_role('admin','support'));
create policy "staff read members" on public.members for select using (public.has_staff_role('admin','support'));
create policy "staff read profiles" on public.profiles for select using (public.has_staff_role('admin','support'));
create policy "staff read plans" on public.plans for select using (public.has_staff_role('admin','support'));
create policy "staff read subscriptions" on public.subscriptions for select using (public.has_staff_role('admin','support'));
create policy "staff read agreements" on public.agreements for select using (public.has_staff_role('admin','support'));
create policy "staff read domain orders" on public.domain_orders for select using (public.has_staff_role('admin','support'));
create policy "staff read leads" on public.leads for select using (public.has_staff_role('admin','support'));

-- One query for the customers screen.
create or replace function public.admin_customers() returns table (
  org_id uuid, name text, country text, status text, created_at timestamptz,
  owner_name text, owner_email text, monthly_pln integer, plan_status text, sub_status text, domain text, open_requests bigint
) language sql stable security definer set search_path = '' as $$
  select o.id, o.name, o.country, o.status, o.created_at,
         p.full_name, p.email,
         pl.monthly_pln, pl.status, sb.status,
         (select d.domain from public.domain_orders d where d.org_id = o.id and d.status in ('pending','registered') order by d.created_at desc limit 1),
         (select count(*) from public.requests r where r.org_id = o.id and r.status <> 'resolved')
  from public.organizations o
  left join public.members m on m.org_id = o.id and m.role = 'owner'
  left join public.profiles p on p.user_id = m.user_id
  left join lateral (select * from public.plans x where x.org_id = o.id and x.status in ('active','checkout') order by (x.status = 'active') desc, x.created_at desc limit 1) pl on true
  left join lateral (select * from public.subscriptions s where s.org_id = o.id order by s.updated_at desc limit 1) sb on true
  where public.has_staff_role('admin','support')
  order by o.created_at desc;
$$;
revoke all on function public.admin_customers() from public, anon;
grant execute on function public.admin_customers() to authenticated;

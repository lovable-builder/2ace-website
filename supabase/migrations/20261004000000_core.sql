-- Core tables for accounts, plans, payments. All access is through RLS or service-role Edge Functions.

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  message text,
  created_at timestamptz not null default now()
);
alter table public.leads enable row level security;  -- no policies: only the service role (lead function) writes

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text,
  vat_id text,
  stripe_customer_id text unique,
  status text not null default 'pending' check (status in ('pending','active','past_due','canceled')),
  created_at timestamptz not null default now()
);
alter table public.organizations enable row level security;

create table public.members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','operations','finance','marketing','staff')),
  primary key (org_id, user_id)
);
alter table public.members enable row level security;

create or replace function public.is_member(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where org_id = o and user_id = auth.uid());
$$;

create policy "members read own memberships" on public.members for select using (user_id = auth.uid());
create policy "members read own org" on public.organizations for select using (public.is_member(id));

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  config jsonb not null,
  monthly_pln integer not null,   -- whole zloty, net of VAT
  once_pln integer not null,
  status text not null default 'draft' check (status in ('draft','checkout','active','canceled')),
  created_at timestamptz not null default now()
);
alter table public.plans enable row level security;
create policy "members read plans" on public.plans for select using (public.is_member(org_id));

create table public.subscriptions (
  stripe_subscription_id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  status text not null,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
create policy "members read subscriptions" on public.subscriptions for select using (public.is_member(org_id));

create table public.agreements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  signer_name text not null,
  version text not null,
  ip text,
  signed_at timestamptz not null default now()
);
alter table public.agreements enable row level security;
create policy "members read agreements" on public.agreements for select using (public.is_member(org_id));

-- Webhook idempotency: each Stripe event is processed once.
create table public.webhook_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);
alter table public.webhook_events enable row level security;

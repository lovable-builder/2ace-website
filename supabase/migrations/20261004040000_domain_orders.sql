-- One row per domain a customer's plan needs registered. Filled by the Stripe webhook after payment.
create table public.domain_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  plan_id uuid unique references public.plans(id) on delete set null,   -- unique: one order per paid plan, webhook retries are safe
  domain text not null,
  status text not null default 'pending' check (status in ('pending','registered','failed','cancelled')),
  availability text,            -- result of the re-check at payment time: free / taken / unknown
  notes text,
  created_at timestamptz not null default now(),
  registered_at timestamptz
);
alter table public.domain_orders enable row level security;
create policy "members read domain orders" on public.domain_orders for select using (public.is_member(org_id));
-- No insert/update policies: only the service role (webhook, staff) changes these rows.

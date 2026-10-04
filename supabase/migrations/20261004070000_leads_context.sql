-- Requests from logged-in customers keep their company and the topic they picked.
alter table public.leads
  add column subject text,
  add column org_id uuid references public.organizations(id) on delete set null,
  add column source text not null default 'website';

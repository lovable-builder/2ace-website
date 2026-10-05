-- Shipping connection (Furgonetka). The cached login token lives here, readable by the server only: no policies, no client access.
-- (The account password and API keys are never stored in the database. They are server settings.)
create table public.shipping_tokens (
  key text primary key,                       -- '<environment>:<client id>', so sandbox and production never mix
  access_token text not null,
  refresh_token text,
  expires_at double precision not null,       -- unix seconds
  updated_at timestamptz not null default now()
);
alter table public.shipping_tokens enable row level security;
revoke all on public.shipping_tokens from anon, authenticated;

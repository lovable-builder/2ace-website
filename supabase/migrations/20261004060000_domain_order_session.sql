-- One domain order per Stripe checkout session (covers the stand-alone domain purchase, where plan_id is null).
alter table public.domain_orders add column session_id text unique;

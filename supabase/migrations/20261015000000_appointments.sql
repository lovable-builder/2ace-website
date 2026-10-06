-- Booking calls and meetings: customers pick a language (English, Chinese, Arabic) and a time, everyone is emailed, and reminders go out.
-- Public booking goes through the `booking` edge function (service role). Nothing here is readable or writable by visitors directly.

create sequence public.appointment_ref_seq start 1;

-- One row per meeting language: when that team member can be booked, in which time zone, who is notified.
create table public.booking_settings (
  lang text primary key check (lang in ('en', 'zh', 'ar')),
  enabled boolean not null default false,
  tz text not null default 'Europe/Warsaw',
  host_emails text[] not null default '{}',
  windows jsonb not null default '[]'::jsonb,        -- [{"dow":1,"from":"10:00","to":"14:00"}], dow 1 = Monday ... 7 = Sunday, in the time zone above
  slot_minutes integer not null default 30 check (slot_minutes between 15 and 120),
  buffer_minutes integer not null default 0 check (buffer_minutes between 0 and 120),
  notice_hours integer not null default 12 check (notice_hours between 0 and 720),
  horizon_days integer not null default 30 check (horizon_days between 1 and 120),
  default_link text check (default_link is null or (default_link ~ '^https://[^\s]+$' and length(default_link) between 12 and 500)),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
insert into public.booking_settings (lang, tz) values ('en', 'Europe/Warsaw'), ('zh', 'Asia/Shanghai'), ('ar', 'Europe/Warsaw');

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('APT-' || lpad(nextval('public.appointment_ref_seq')::text, 6, '0')),
  lang text not null check (lang in ('en', 'zh', 'ar')),               -- the language of the meeting
  ui_lang text not null default 'en' check (ui_lang in ('en', 'zh', 'ar')),  -- the language of the emails
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled', 'completed', 'no_show')),
  name text not null check (length(name) between 1 and 200),
  email text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 200),
  phone text check (phone is null or length(phone) <= 40),
  company text check (company is null or length(company) <= 200),
  topic text check (topic is null or length(topic) <= 2000),
  customer_tz text not null default 'Europe/Warsaw',
  meeting_link text check (meeting_link is null or (meeting_link ~ '^https://[^\s]+$' and length(meeting_link) between 12 and 500)),
  link_sent_at timestamptz,
  manage_token text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  confirmation_sent_at timestamptz,
  reminder_24h_sent_at timestamptz,
  reminder_1h_sent_at timestamptz,
  reschedule_count integer not null default 0,
  cancelled_at timestamptz,
  cancelled_by text check (cancelled_by in ('customer', 'staff')),
  cancel_reason text,
  staff_notes text check (staff_notes is null or length(staff_notes) <= 4000),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index appointments_starts_idx on public.appointments (starts_at) where status = 'confirmed';
create index appointments_email_idx on public.appointments (lower(email), starts_at);
-- Two confirmed meetings can never start at the same moment in the same language, whatever else goes wrong.
create unique index appointments_one_per_start on public.appointments (lang, starts_at) where status = 'confirmed';

-- Heartbeat of the reminder job, so the admin screen can say honestly whether reminders are running.
create table public.booking_runs (
  key text primary key,
  ran_at timestamptz not null default now(),
  sent integer not null default 0
);

alter table public.booking_settings enable row level security;
alter table public.appointments enable row level security;
alter table public.booking_runs enable row level security;
create policy "staff read booking settings" on public.booking_settings for select using (public.has_staff_role('admin', 'support'));
create policy "staff read appointments" on public.appointments for select using (public.has_staff_role('admin', 'support'));
create policy "staff read booking runs" on public.booking_runs for select using (public.has_staff_role('admin', 'support'));
revoke insert, update, delete, truncate on public.booking_settings, public.appointments, public.booking_runs from anon, authenticated;

-- Book a slot. The caller (the edge function) has already checked the time against the opening hours; this makes the insert atomic.
create or replace function public.booking_create(
  p_lang text, p_ui_lang text, p_start timestamptz, p_end timestamptz, p_buffer integer, p_name text, p_email text, p_phone text, p_company text, p_topic text, p_tz text, p_link text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.appointments;
begin
  perform pg_advisory_xact_lock(hashtext('appt:' || p_lang));
  if p_start <= now() then raise exception 'That time has already passed'; end if;
  if exists (select 1 from public.appointments where lang = p_lang and status = 'confirmed'
             and tstzrange(starts_at - make_interval(mins => coalesce(p_buffer, 0)), ends_at + make_interval(mins => coalesce(p_buffer, 0)), '[)') && tstzrange(p_start, p_end, '[)')) then
    raise exception 'That time was just taken. Please choose another.';
  end if;
  if (select count(*) from public.appointments where lower(email) = lower(btrim(p_email)) and status = 'confirmed' and starts_at > now()) >= 3 then
    raise exception 'You already have 3 upcoming bookings. Cancel one first, or write to hello@2ace.pl.';
  end if;
  insert into public.appointments (lang, ui_lang, starts_at, ends_at, name, email, phone, company, topic, customer_tz, meeting_link)
  values (p_lang, coalesce(p_ui_lang, 'en'), p_start, p_end, left(btrim(p_name), 200), left(btrim(p_email), 200), nullif(left(btrim(coalesce(p_phone, '')), 40), ''),
          nullif(left(btrim(coalesce(p_company, '')), 200), ''), nullif(left(btrim(coalesce(p_topic, '')), 2000), ''), coalesce(nullif(btrim(p_tz), ''), 'Europe/Warsaw'), p_link)
  returning * into a;
  return jsonb_build_object('id', a.id, 'ref', a.ref, 'token', a.manage_token);
end $$;

-- Move a booking to another slot (the customer's own link). Reminders start again.
create or replace function public.booking_reschedule(p_token text, p_start timestamptz, p_end timestamptz, p_buffer integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.appointments;
begin
  select * into a from public.appointments where manage_token = p_token for update;
  if not found then raise exception 'Booking not found'; end if;
  perform pg_advisory_xact_lock(hashtext('appt:' || a.lang));
  if a.status <> 'confirmed' then raise exception 'This booking is %, so it cannot be moved', a.status; end if;
  if a.starts_at <= now() then raise exception 'This meeting has already started'; end if;
  if p_start <= now() then raise exception 'That time has already passed'; end if;
  if exists (select 1 from public.appointments where lang = a.lang and status = 'confirmed' and id <> a.id
             and tstzrange(starts_at - make_interval(mins => coalesce(p_buffer, 0)), ends_at + make_interval(mins => coalesce(p_buffer, 0)), '[)') && tstzrange(p_start, p_end, '[)')) then
    raise exception 'That time was just taken. Please choose another.';
  end if;
  update public.appointments set starts_at = p_start, ends_at = p_end, reschedule_count = reschedule_count + 1, reminder_24h_sent_at = null, reminder_1h_sent_at = null, confirmation_sent_at = null
  where id = a.id returning * into a;
  return jsonb_build_object('id', a.id, 'ref', a.ref);
end $$;

-- Cancel from the customer's own link or by staff.
create or replace function public.booking_cancel(p_token text, p_by text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.appointments;
begin
  select * into a from public.appointments where manage_token = p_token for update;
  if not found then raise exception 'Booking not found'; end if;
  if a.status <> 'confirmed' then raise exception 'This booking is already %', a.status; end if;
  if a.starts_at <= now() and p_by = 'customer' then raise exception 'This meeting has already started'; end if;
  update public.appointments set status = 'cancelled', cancelled_at = now(), cancelled_by = p_by, cancel_reason = nullif(left(btrim(coalesce(p_reason, '')), 500), '') where id = a.id returning * into a;
  return jsonb_build_object('id', a.id, 'ref', a.ref);
end $$;

-- Only the server (service role) may call these three; they trust the checks already done by the edge function.
do $$ declare f text; begin
  foreach f in array array['booking_create(text,text,timestamptz,timestamptz,integer,text,text,text,text,text,text,text)', 'booking_reschedule(text,timestamptz,timestamptz,integer)', 'booking_cancel(text,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- Reminders: call the reminder function every 10 minutes from inside the database (Supabase pg_cron + pg_net, both free).
-- The function is safe to call by anyone: it only sends reminders that are due, once each, and answers with counts.
-- If the extensions are not available (a test database), this is skipped and the admin screen shows that reminders are not running.
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron with schema pg_catalog;
    create extension if not exists pg_net with schema extensions;
    perform cron.schedule('booking-reminders', '*/10 * * * *',
      $job$ select net.http_post(url := 'https://hvbcmilcjragrcezwzlo.supabase.co/functions/v1/booking-reminders', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 20000) $job$);
  end if;
exception when others then
  raise notice 'Could not schedule the booking reminders automatically: %', sqlerrm;
end $$;

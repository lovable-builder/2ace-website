import { ROOT } from '../lib/root.mjs';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
const dir = ROOT + '/supabase/migrations/';
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  -> ' + extra)); };

await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb, aud text, role text, instance_id uuid);
`);
await db.exec(`create function auth.uid() returns uuid language sql stable as $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
grant usage on schema auth to anon, authenticated, service_role; grant usage on schema public to anon, authenticated, service_role;
grant select on auth.users to service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
await db.exec(`create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now());
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to anon, authenticated, service_role; grant all on storage.objects, storage.buckets to authenticated, service_role;`);
for (const f of fs.readdirSync(dir).sort()) { if (f.includes('logos')) continue; await db.exec(fs.readFileSync(dir + f, 'utf8')); }
await db.exec("update public.wms_settings set value='off'");   // these suites test the classic two-step flow; auto mode has its own suite

const as = async (uid, aal, q, params = []) => {
  await db.exec('savepoint s');
  try {
    await db.exec('set local role authenticated');
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated', aal })]);
    const r = await db.query(q, params); return { rows: r.rows };
  } catch (e) { return { err: e.message }; }
  finally { await db.exec('rollback to savepoint s'); await db.exec('reset role'); }
};
// Same, but keeps the changes (for steps that build state).
const run = async (uid, aal, q, params = []) => {
  await db.exec('savepoint s');
  try {
    await db.exec('set local role authenticated');
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated', aal })]);
    const r = await db.query(q, params); await db.exec('reset role'); await db.exec('release savepoint s'); return { rows: r.rows };
  } catch (e) { await db.exec('rollback to savepoint s'); await db.exec('reset role'); return { err: e.message }; }
};
const asAnon = async (q) => { await db.exec('savepoint s'); try { await db.exec('set local role anon'); await db.query(`select set_config('request.jwt.claims','{"role":"anon"}',true)`); return { rows: (await db.query(q)).rows }; } catch (e) { return { err: e.message }; } finally { await db.exec('rollback to savepoint s'); await db.exec('reset role'); } };
const one = async (q, p = []) => (await db.query(q, p)).rows;

await db.exec('begin');
const mk = async (email) => (await one(`insert into auth.users (email, raw_user_meta_data, aud, role) values ($1, '{}', 'authenticated','authenticated') returning id`, [email]))[0].id;
const admin = await mk('adm@t.pl'), support = await mk('sup@t.pl'), wh = await mk('wh@t.pl'), cust = await mk('c@t.pl', { company: 'Org' });
await db.query(`insert into public.staff_users (user_id, role) values ($1,'admin'), ($2,'support'), ($3,'warehouse')`, [admin, support, wh]);
const svc = async (q, p = []) => { await db.exec('savepoint s'); try { await db.exec('set local role service_role'); const r = await db.query(q, p); await db.exec('reset role'); await db.exec('release savepoint s'); return { rows: r.rows }; } catch (e) { await db.exec('rollback to savepoint s'); await db.exec('reset role'); return { err: e.message }; } };
const call = run;
const T = (h) => new Date(Date.now() + h * 3600000).toISOString();
const book = (lang, h, over = {}) => svc(`select public.booking_create($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) r`, [lang, over.ui ?? lang, T(h), T(h + 0.5), over.buf ?? 0, over.name ?? 'Li Wei', over.email ?? 'li@example.com', null, 'Acme', 'Storage', 'Asia/Shanghai', over.link ?? null]);

// ---- settings ----
ok('three meeting languages exist, all switched off until an admin opens them', (await one(`select string_agg(lang || ':' || enabled::text, ',' order by lang) s from public.booking_settings`))[0].s === 'ar:false,en:false,zh:false');
ok('the defaults keep each team in its own zone', (await one(`select string_agg(lang || ':' || tz, ',' order by lang) s from public.booking_settings`))[0].s === 'ar:Europe/Warsaw,en:Europe/Warsaw,zh:Asia/Shanghai');
ok('an unknown language is refused', !!(await svc(`insert into public.booking_settings (lang) values ('fr')`)).err);
{ const direct = async (q) => { await db.exec('savepoint d'); try { const r = { rows: (await db.query(q)).rows }; await db.exec('release savepoint d'); return r; } catch (e) { await db.exec('rollback to savepoint d'); return { err: e.message }; } }; const r1 = await direct(`update public.booking_settings set default_link='http://x.com/a' where lang='en'`), r2 = await direct(`update public.booking_settings set default_link='https://meet.example.com/a' where lang='en'`); ok('a meeting link must be https', !!r1.err && !r2.err, JSON.stringify([r1, r2])); }

// ---- booking ----
const b1 = await book('en', 48); ok('a slot can be booked, and gets a reference and a long secret token', /^APT-\d{6}$/.test(b1.rows?.[0]?.r?.ref) && b1.rows[0].r.token.length === 64, JSON.stringify(b1));
const row1 = (await one(`select * from public.appointments where ref=$1`, [b1.rows[0].r.ref]))[0];
ok('it is confirmed, in the chosen languages, with the customer time zone kept', row1.status === 'confirmed' && row1.lang === 'en' && row1.ui_lang === 'en' && row1.customer_tz === 'Asia/Shanghai');
ok('the same moment cannot be booked twice in the same language', /just taken/.test((await book('en', 48, { email: 'x@example.com' })).err ?? ''));
ok('an overlapping time is refused too', /just taken/.test((await svc(`select public.booking_create('en','en',$1,$2,0,'A B','a@example.com',null,null,null,'Europe/Warsaw',null)`, [T(48.25), T(48.75)])).err ?? ''));
ok('another language at the same moment is fine (different person)', !!(await book('zh', 48, { email: 'z@example.com' })).rows);
ok('a break between calls is enforced', /just taken/.test((await book('en', 49, { buf: 45, email: 'y@example.com' })).err ?? ''));
ok('a time in the past is refused', /already passed/.test((await book('en', -1, { email: 'p@example.com' })).err ?? ''));
ok('the same email can have at most 3 upcoming bookings', !!(await book('en', 72)).rows && !!(await book('en', 96)).rows && /already have 3/.test((await book('en', 120)).err ?? ''));
ok('the email is checked by the table', !!(await svc(`insert into public.appointments (lang, starts_at, ends_at, name, email) values ('en', now() + interval '9 days', now() + interval '9 days 30 minutes', 'A', 'nope')`)).err);
ok('a booking cannot end before it starts', !!(await svc(`insert into public.appointments (lang, starts_at, ends_at, name, email) values ('en', now() + interval '9 days', now() + interval '8 days', 'A', 'a@b.pl')`)).err);

// ---- move and cancel ----
const tok = b1.rows[0].r.token;
ok('a booking can be moved to a free time, and the reminders start again', !(await svc(`update public.appointments set reminder_24h_sent_at=now(), reminder_1h_sent_at=now() where manage_token=$1`, [tok])).err
  && !!(await svc(`select public.booking_reschedule($1,$2,$3,0) r`, [tok, T(200), T(200.5)])).rows
  && (await one(`select reschedule_count c, reminder_24h_sent_at r24, reminder_1h_sent_at r1 from public.appointments where manage_token=$1`, [tok]))[0].c === 1
  && (await one(`select reminder_24h_sent_at r from public.appointments where manage_token=$1`, [tok]))[0].r === null);
ok('moving onto a taken time is refused', /just taken/.test((await svc(`select public.booking_reschedule($1,$2,$3,0)`, [tok, T(72), T(72.5)])).err ?? ''));
ok('the old time is free again after moving', !!(await book('en', 48, { email: 'new@example.com' })).rows);
ok('a wrong token finds nothing', /not found/.test((await svc(`select public.booking_cancel('nope','customer',null)`)).err ?? ''));
ok('a booking is cancelled with a reason and who did it', !!(await svc(`select public.booking_cancel($1,'customer','Plans changed')`, [tok])).rows
  && (await one(`select status, cancelled_by, cancel_reason from public.appointments where manage_token=$1`, [tok]))[0].cancel_reason === 'Plans changed');
ok('it cannot be cancelled twice, nor moved once cancelled', /already cancelled/.test((await svc(`select public.booking_cancel($1,'customer',null)`, [tok])).err ?? '') && /cancelled/.test((await svc(`select public.booking_reschedule($1,$2,$3,0)`, [tok, T(300), T(300.5)])).err ?? ''));
ok('a cancelled time can be booked by someone else', !!(await book('en', 200, { email: 'again@example.com' })).rows);
await db.query(`update public.appointments set starts_at = now() - interval '1 hour', ends_at = now() - interval '30 minutes' where ref = $1`, [row1.ref === b1.rows[0].r.ref ? (await one(`select ref from public.appointments where email='new@example.com'`))[0].ref : '']);
{ const t = (await one(`select manage_token t from public.appointments where email='new@example.com'`))[0].t;
  ok('a customer cannot cancel a meeting that already started, staff can', /already started/.test((await svc(`select public.booking_cancel($1,'customer',null)`, [t])).err ?? '') && !!(await svc(`select public.booking_cancel($1,'staff','No show')`, [t])).rows); }

// ---- who can see and do what ----
ok('visitors (anon) cannot read bookings or settings, and cannot call the booking functions', !!(await asAnon(`select * from public.appointments`)).err || (await asAnon(`select count(*)::int n from public.appointments`)).rows?.[0]?.n === 0);
ok('visitors cannot read the settings (host emails stay private)', !!(await asAnon(`select * from public.booking_settings`)).err || (await asAnon(`select count(*)::int n from public.booking_settings`)).rows?.[0]?.n === 0);
ok('anon cannot book directly', !!(await asAnon(`select public.booking_create('en','en', now() + interval '30 days', now() + interval '30 days 30 minutes', 0, 'A B', 'a@b.pl', null, null, null, 'Europe/Warsaw', null)`)).err);
ok('a signed-in customer cannot book, move or cancel through the database either', !!(await call(cust, 'aal1', `select public.booking_cancel('x','customer',null)`)).err && !!(await call(cust, 'aal1', `select public.booking_create('en','en', now() + interval '30 days', now() + interval '30 days 30 minutes', 0, 'A B', 'a@b.pl', null, null, null, 'Europe/Warsaw', null)`)).err);
ok('a customer sees no bookings', (await call(cust, 'aal1', `select count(*)::int n from public.appointments`)).rows[0].n === 0);
ok('admin and support read bookings, warehouse does not', (await call(admin, 'aal2', `select count(*)::int n from public.appointments`)).rows[0].n > 0 && (await call(support, 'aal2', `select count(*)::int n from public.appointments`)).rows[0].n > 0 && (await call(wh, 'aal1', `select count(*)::int n from public.appointments`)).rows[0].n === 0);
ok('nobody can write the tables directly, not even an admin (writes go through the server)', !!(await call(admin, 'aal2', `update public.appointments set meeting_link='https://x.com/aaa'`)).err && !!(await call(admin, 'aal2', `update public.booking_settings set enabled=true`)).err && !!(await call(admin, 'aal2', `delete from public.appointments`)).err);
await db.query(`insert into public.booking_runs (key, sent) values ('reminders', 2)`);
ok('the reminder heartbeat is readable by admin, not by warehouse', (await call(admin, 'aal2', `select count(*)::int n from public.booking_runs`)).rows[0].n === 1 && (await call(wh, 'aal1', `select count(*)::int n from public.booking_runs`)).rows[0].n === 0);

await db.exec('rollback');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

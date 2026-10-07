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
const mk = async (email, meta = {}) => (await one(`insert into auth.users (email, raw_user_meta_data, aud, role) values ($1, $2, 'authenticated','authenticated') returning id`, [email, JSON.stringify(meta)]))[0].id;
const admin = await mk('adm@t.pl'), support = await mk('sup@t.pl'), wh = await mk('wh@t.pl'), wh2 = await mk('wh2@t.pl');
const ua = await mk('a@t.pl', { company: 'Org A' }), ub = await mk('b@t.pl', { company: 'Org B' }), uc = await mk('c@t.pl', { company: 'Org C' });
await db.query(`insert into public.staff_users (user_id, role) values ($1,'admin'), ($2,'support'), ($3,'warehouse'), ($4,'warehouse')`, [admin, support, wh, wh2]);
const orgOf = async (u) => (await one(`select org_id from public.members where user_id=$1`, [u]))[0].org_id;
const orgA = await orgOf(ua), orgB = await orgOf(ub), orgC = await orgOf(uc);
await db.query(`update public.organizations set status='active' where id in ($1,$2)`, [orgA, orgB]);   // C stays pending
const call = (u, aal, sql, p) => run(u, aal, sql, p);
const W = (sql, p) => call(wh, 'aal1', sql, p);


const raw = async (q, p = []) => { await db.exec('savepoint r'); try { await db.query(q, p); await db.exec('release savepoint r'); return ''; } catch (e) { await db.exec('rollback to savepoint r'); return e.message; } };
const mkLoc = async (code, kind) => (await W('select public.create_location($1,$2) id', [code, kind])).rows?.[0]?.id;
const R1 = await mkLoc('R1', 'receiving'), Q1 = await mkLoc('Q1', 'quarantine'), B1 = await mkLoc('A-01', 'bin'), B2 = await mkLoc('A-02', 'bin'), B3 = await mkLoc('B-01', 'bin');
await W('select public.assign_location($1,$2)', [B1, orgA]); await W('select public.assign_location($1,$2)', [B2, orgA]); await W('select public.assign_location($1,$2)', [B3, orgB]);
const pr = async (u, org, sku, name) => (await call(u, 'aal1', 'select public.create_product($1,$2,$3) id', [org, sku, name])).rows?.[0]?.id;
const S1 = await pr(ua, orgA, 'MUG-BLUE', 'Blue mug'), S2 = await pr(ua, orgA, 'MUG-RED', 'Red mug'), SB = await pr(ub, orgB, 'B-ONE', 'B product');
const lines = (a) => JSON.stringify(a);
// stock: 10 blue mugs in bin A-01 and 5 red mugs in A-02, put away through the real functions
let k = 0; const stock = async (org, prod, qty, bin, cond = 'good') => {
  const bk = (await call(ua, 'aal1', `select public.book_inbound($1,'DHL',null,null,null,$2::jsonb) id`, [org, lines([{ product_id: prod, qty }])])).rows[0].id;
  await W(`select public.receive_line($1,$2,$3,$4,'',null,null,$5)`, [bk, prod, qty, cond, 'seed' + (++k)]);
  if (bin) await W('select public.putaway($1,$2,$3,$4,$5,$6,$7)', [org, prod, R1, bin, qty, '', 'put' + k]);
};
await stock(orgA, S1, 10, B1); await stock(orgA, S2, 5, B2);
const lvl = async (p, l) => (await one('select on_hand, reserved from public.stock_levels where product_id=$1 and location_id=$2', [p, l]))[0];
const ship = { name: 'Jan Nowak', line1: 'Prosta 1', postal: '00-001', city: 'Warszawa', country: 'PL', email: 'jan@example.pl', phone: '+48600100200' };
const order = (u, aal, org, ext, ls, sh = ship) => call(u, aal, `select public.create_order($1,$2,$3::jsonb,null,$4::jsonb) r`, [org, ext, JSON.stringify(sh), lines(ls)]);

// =============== Usage charges on the invoice ===============
const svc = async (q, p = []) => { await db.exec('savepoint s'); try { await db.exec('set local role service_role'); const r = await db.query(q, p); await db.exec('reset role'); await db.exec('release savepoint s'); return { rows: r.rows }; } catch (e) { await db.exec('rollback to savepoint s'); await db.exec('reset role'); return { err: e.message }; } };
const direct = async (q, p = []) => { await db.exec('savepoint d'); try { const r = await db.query(q, p); await db.exec('release savepoint d'); return { rows: r.rows }; } catch (e) { await db.exec('rollback to savepoint d'); return { err: e.message }; } };
const add = (org, kind, net, status = 'pending', env = 'production', note = null) => direct(`insert into public.shipping_charges (org_id, kind, seq, net, status, env, note) values ($1,$2,1,$3,$4,$5,$6)`, [org, kind, net, status, env, note]);
const prep = (org, inv) => svc(`select public.usage_prepare_invoice($1,$2) r`, [org, inv]);
const rowsOf = async (org, inv) => (await one(`select kind, net::float n, status from public.shipping_charges where org_id=$1 and stripe_invoice_id=$2 order by kind, net`, [org, inv]));
const lineOf = (r, kind) => r.rows[0].r.lines.find((l) => l.kind === kind);
await direct(`insert into public.plans (org_id, config, monthly_pln, once_pln, status) values ($1,'{"m2":10,"pkgs":{"payg":true}}'::jsonb,3000,0,'active')`, [orgA]);
ok('the area of the customer is read from the active plan (10 m²; an old pallet plan counts 1.2 m² each)', Number((await direct(`select public.org_area_m2($1) a`, [orgA])).rows[0].a) === 10);

// ---- one invoice: everything pending is queued, nothing else is touched ----
await add(orgA, 'label', 13); await add(orgA, 'label', 20); await add(orgA, 'adjustment', 6.5); await add(orgA, 'handling', 3.2); await add(orgA, 'handling', 4.2); await add(orgA, 'return_handling', 4.8); await add(orgA, 'return_label', 14);
await add(orgA, 'handling', 3.2, 'waived', 'sandbox'); await add(orgA, 'label', 99, 'pending', 'sandbox'); await add(orgB, 'label', 50);
const p1 = await prep(orgA, 'in_1');
ok('the lines are grouped by kind with the count and the amount in grosz', lineOf(p1, 'label').count === 2 && lineOf(p1, 'label').net_cents === 3300 && lineOf(p1, 'handling').count === 2 && lineOf(p1, 'handling').net_cents === 740 && lineOf(p1, 'return_handling').net_cents === 480 && lineOf(p1, 'return_label').net_cents === 1400 && lineOf(p1, 'adjustment').net_cents === 650, JSON.stringify(p1));
ok('the total is the sum', p1.rows[0].r.total_cents === 3300 + 650 + 740 + 480 + 1400, String(p1.rows[0].r.total_cents));
ok('the charges are queued for that invoice', (await rowsOf(orgA, 'in_1')).length === 7 && (await rowsOf(orgA, 'in_1')).every((x) => x.status === 'queued'));
ok('test (waived) charges, sandbox charges and other customers\' charges are left alone', (await one(`select count(*)::int n from public.shipping_charges where org_id=$1 and status in ('waived','pending')`, [orgA]))[0].n === 2 && (await one(`select status from public.shipping_charges where org_id=$1`, [orgB]))[0].status === 'pending');
ok('under the ceilings there is no credit line', !lineOf(p1, 'credit'));
const p1b = await prep(orgA, 'in_1');
ok('asking again for the same invoice (a retried webhook) returns the same lines and changes nothing', JSON.stringify(p1b.rows[0].r) === JSON.stringify(p1.rows[0].r) && (await rowsOf(orgA, 'in_1')).length === 7);
// ---- events ----
ok('finalized moves the queued charges to invoiced', (await svc(`select public.usage_invoice_event('in_1','finalized') n`)).rows[0].n === 7 && (await rowsOf(orgA, 'in_1')).every((x) => x.status === 'invoiced'));
ok('paid moves them to paid, and a repeat changes nothing', (await svc(`select public.usage_invoice_event('in_1','paid') n`)).rows[0].n === 7 && (await rowsOf(orgA, 'in_1')).every((x) => x.status === 'paid') && (await svc(`select public.usage_invoice_event('in_1','paid') n`)).rows[0].n === 0);
ok('once paid, preparing the same invoice again returns the same lines', JSON.stringify((await prep(orgA, 'in_1')).rows[0].r) === JSON.stringify(p1.rows[0].r));
ok('an unknown event is refused', /Unknown invoice event/.test((await svc(`select public.usage_invoice_event('in_1','exploded')`)).err ?? ''));

// ---- the ceiling per m² ----
await add(orgA, 'handling', 2000); await add(orgA, 'handling', 2000); await add(orgA, 'return_handling', 2000); await add(orgA, 'label', 40);
const p2 = await prep(orgA, 'in_2');
ok('handling fees above 350 zł x 10 m² = 3 500 are cut back by a visible credit line (4 000 - 3 500 = 500)', lineOf(p2, 'credit') && p2.rows[0].r.lines.filter((l) => l.kind === 'credit').some((l) => l.net_cents === -50000 && /handling/.test(l.note)), JSON.stringify(p2.rows[0].r.lines));
ok('return fees above 150 zł x 10 m² = 1 500 are cut back too (2 000 - 1 500 = 500), as a separate line', p2.rows[0].r.lines.filter((l) => l.kind === 'credit').some((l) => l.net_cents === -50000 && /return/.test(l.note)));
ok('labels are never capped', lineOf(p2, 'label').net_cents === 4000);
ok('the invoice total is what the customer really owes: 4 000 + 2 000 + 40 - 1 000', p2.rows[0].r.total_cents === 400000 + 200000 + 4000 - 100000, String(p2.rows[0].r.total_cents));
ok('asking again does not add another credit', (await one(`select count(*)::int n from public.shipping_charges where org_id=$1 and kind='credit' and stripe_invoice_id='in_2'`, [orgA]))[0].n === 2 && JSON.stringify((await prep(orgA, 'in_2')).rows[0].r) === JSON.stringify(p2.rows[0].r) && (await one(`select count(*)::int n from public.shipping_charges where org_id=$1 and kind='credit'`, [orgA]))[0].n === 2);
// ---- a voided invoice gives the charges back ----
ok('a voided invoice puts its charges back to pending and cancels its ceiling credits', (await svc(`select public.usage_invoice_event('in_2','voided')`)).rows !== undefined && (await one(`select count(*)::int n from public.shipping_charges where org_id=$1 and status='pending' and stripe_invoice_id is null and kind <> 'credit'`, [orgA]))[0].n >= 4 && (await one(`select count(*)::int n from public.shipping_charges where org_id=$1 and kind='credit' and status='void'`, [orgA]))[0].n === 2);
const p3 = await prep(orgA, 'in_3');
ok('they go on the next invoice, with the ceiling worked out afresh', p3.rows[0].r.lines.filter((l) => l.kind === 'credit').length === 2 && p3.rows[0].r.total_cents === 400000 + 200000 + 4000 - 100000);
// ---- per-customer ceiling and no known area ----
await svc(`select public.usage_invoice_event('in_3','paid')`);
await direct(`insert into public.org_shipping_settings (org_id, handling_cap_per_m2) values ($1, 100) on conflict (org_id) do update set handling_cap_per_m2 = 100`, [orgA]);
await add(orgA, 'handling', 1500); const p4 = await prep(orgA, 'in_4');
ok('a customer\'s own ceiling is used (100 zł x 10 m² = 1 000: 1 500 becomes 1 000)', p4.rows[0].r.lines.some((l) => l.kind === 'credit' && l.net_cents === -50000) && p4.rows[0].r.total_cents === 100000, JSON.stringify(p4.rows[0].r));
await direct(`update public.plans set status='canceled' where org_id=$1`, [orgA]); await add(orgA, 'handling', 9000); const p5 = await prep(orgA, 'in_5');
ok('with no active plan there is no area to cap against: the fees are billed as they are, and the area is reported as unknown', !lineOf(p5, 'credit') && lineOf(p5, 'handling').net_cents === 900000 && p5.rows[0].r.area_m2 === null);
ok('an empty invoice id is refused', /invoice id is missing/.test((await prep(orgA, '')).err ?? ''));
const none = await prep(orgB, 'in_b'); ok('a customer with nothing pending gets no lines... except what is really pending (50 zł of labels)', lineOf(none, 'label').net_cents === 5000);
const empty = await prep(orgC, 'in_c'); ok('a customer with no charges gets an empty answer', empty.rows[0].r.lines.length === 0 && empty.rows[0].r.total_cents === 0);
// ---- who may call ----
ok('visitors, customers and even admins cannot call the billing functions, only the server', !!(await asAnon(`select public.usage_prepare_invoice('${orgA}','x')`)).err && !!(await call(ua, 'aal1', `select public.usage_prepare_invoice($1,'x')`, [orgA])).err && !!(await call(admin, 'aal2', `select public.usage_invoice_event('in_1','paid')`)).err && !!(await call(ua, 'aal1', `select public.org_area_m2($1)`, [orgA])).err);

await db.exec('rollback');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

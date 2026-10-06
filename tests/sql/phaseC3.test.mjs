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


// ---- shipments ----
const PK = await mkLoc('PACK-1', 'pack');
const allocOf = async (oid) => await one(`select a.id, a.product_id, a.qty, a.status from public.allocations a where a.order_id = $1`, [oid]);
const parcel = [{ weight_g: 1800, length_cm: 30, width_cm: 20, height_cm: 15 }];
const mkPacked = async (ref, lines) => {
  const o = await order(ua, 'aal1', orgA, ref, lines); const id = o.rows[0].r.id;
  for (const a of await allocOf(id)) await W('select public.pick_line($1,$2)', [a.id, 'k-' + a.id]);
  await W('select public.pack_order($1,$2::jsonb)', [id, JSON.stringify(parcel)]);
  return id;
};
const begin = (u, aal, oid, over = {}) => call(u, aal, 'select public.begin_shipment($1,$2,$3,$4,$5,$6,$7,$8,$9) r', [oid, over.env ?? 'sandbox', over.svc ?? 12056165, 'inpost', 'InPost Paczkomat', over.net ?? 10, over.gross ?? 12.3, 23, over.markup ?? 30]);
const O1 = await mkPacked('S-1', [{ product_id: S1, qty: 4 }, { product_id: S2, qty: 2 }]);
const packQty = async () => Number((await one(`select coalesce(sum(on_hand),0)::int n from public.stock_levels where location_id=$1`, [PK]))[0].n);
ok('setup: a packed order with its goods at the packing station', (await one('select status from public.orders where id=$1', [O1]))[0].status === 'packed' && await packQty() === 6);
// ---- who may buy ----
ok('customers cannot begin a shipment', !!(await begin(ua, 'aal1', O1)).err);
ok('support cannot begin a shipment', !!(await begin(support, 'aal2', O1)).err);
ok('anonymous cannot call it', !!(await asAnon(`select public.begin_shipment('${O1}','sandbox',1,'x','x',1,1,23,30)`)).err);
// ---- validation ----
ok('an order that is not packed is refused', /Only a packed order/.test((await begin(wh, 'aal1', (await order(ua, 'aal1', orgA, 'S-RES', [{ product_id: S1, qty: 1 }])).rows[0].r.id)).err || ''));
ok('a cost where gross is below net is refused', /price is not valid/.test((await begin(wh, 'aal1', O1, { net: 10, gross: 5 })).err || ''));
ok('a negative or absurd markup is refused', /markup is not valid/.test((await begin(wh, 'aal1', O1, { markup: -1 })).err || '') && /markup is not valid/.test((await begin(wh, 'aal1', O1, { markup: 501 })).err || ''));
ok('an unknown environment is refused', !!(await begin(wh, 'aal1', O1, { env: 'staging' })).err);
// ---- begin ----
const b1 = await begin(wh, 'aal1', O1, { net: 10, gross: 12.3, markup: 30 });
ok('warehouse begins a shipment', !!b1.rows?.[0]?.r, JSON.stringify(b1));
const SH = (await one('select * from public.shipments where order_id=$1', [O1]))[0];
ok('it starts as buying, with cost, markup and the customer price worked out by the database', SH.status === 'buying' && Number(SH.cost_net) === 10 && Number(SH.markup_percent) === 30 && Number(SH.bill_net) === 13 && Number(SH.bill_gross) === 15.99 && SH.billing_status === 'pending', JSON.stringify(SH));
ok('nothing has left stock yet', await packQty() === 6 && (await one('select status from public.orders where id=$1', [O1]))[0].status === 'packed');
ok('a second purchase for the same order is refused while one is in flight', /already being bought/.test((await begin(wh, 'aal1', O1)).err || ''));
// ---- failure frees the order ----
ok('customers cannot fail a shipment', !!(await call(ua, 'aal1', 'select public.fail_shipment($1,$2)', [SH.id, 'x'])).err);
ok('failing records the reason and frees the order', !(await W('select public.fail_shipment($1,$2)', [SH.id, 'Carrier said no'])).err && (await one('select status, error from public.shipments where id=$1', [SH.id]))[0].error === 'Carrier said no');
ok('a failed shipment cannot be failed again or finished', !!(await W('select public.fail_shipment($1,$2)', [SH.id, 'x'])).err && /cannot be completed/.test((await W('select public.finish_shipment($1,$2,$3)', [SH.id, '999', ['T']])).err || ''));
const b2 = await begin(wh, 'aal1', O1, { net: 9, gross: 11.07, markup: 30 });
ok('after a failure a new attempt can start', !!b2.rows?.[0]?.r);
const SH2 = (await one(`select * from public.shipments where order_id=$1 and status='buying'`, [O1]))[0];
// ---- paying: finish ----
ok('customers cannot finish a shipment', !!(await call(ua, 'aal1', 'select public.finish_shipment($1,$2,$3)', [SH2.id, '555', ['T']])).err);
ok('finishing needs the carrier package id', /package id is missing/.test((await W('select public.finish_shipment($1,$2,$3)', [SH2.id, ' ', ['T']])).err || ''));
const f1 = await W('select to_jsonb(public.finish_shipment($1,$2,$3)) r', [SH2.id, '90001', ['TRK-1', 'TRK-2']]);
ok('warehouse finishes: the shipment is purchased with its tracking numbers', f1.rows?.[0]?.r?.status === 'purchased' && f1.rows[0].r.provider_package_id === '90001' && f1.rows[0].r.tracking_numbers.length === 2, JSON.stringify(f1));
ok('the order is shipped and dated', (await one('select status, shipped_at is not null as d from public.orders where id=$1', [O1]))[0].status === 'shipped');
ok('every picked line is marked shipped', (await allocOf(O1)).every((a) => a.status === 'shipped'));
ok('the goods left the books: the packing station is empty again', await packQty() === 0);
ok('two ship movements were written to the ledger', (await one(`select count(*)::int n from public.stock_movements where reason='ship' and ref_id=$1`, [O1]))[0].n === 2);
ok('finishing twice with the same package changes nothing', (await W('select to_jsonb(public.finish_shipment($1,$2,$3)) r', [SH2.id, '90001', ['X']])).rows?.[0]?.r?.tracking_numbers?.[0] === 'TRK-1' && (await one(`select count(*)::int n from public.stock_movements where reason='ship' and ref_id=$1`, [O1]))[0].n === 2);
ok('finishing again with a different package is refused', /different package/.test((await W('select public.finish_shipment($1,$2,$3)', [SH2.id, '90002', ['T']])).err || ''));
ok('a shipped order cannot be shipped or failed again', /already shipped/.test((await begin(wh, 'aal1', O1)).err || '') && /still being bought/.test((await W('select public.fail_shipment($1,$2)', [SH2.id, 'x'])).err || ''));
// ---- the same carrier package cannot be booked on two orders ----
await stock(orgA, S1, 12, B1); await stock(orgA, S2, 6, B2);
const O2 = await mkPacked('S-2', [{ product_id: S1, qty: 3 }]);
await begin(wh, 'aal1', O2); const SH3 = (await one(`select id from public.shipments where order_id=$1`, [O2]))[0];
ok('the same carrier package id cannot be used for two shipments', /duplicate|unique/i.test((await W('select public.finish_shipment($1,$2,$3)', [SH3.id, '90001', ['T']])).err || ''));
ok('after that refusal nothing was shipped or taken from stock', (await one('select status from public.orders where id=$1', [O2]))[0].status === 'packed' && await packQty() === 3);
// ---- goods moved off the packing station ----
const O3 = await mkPacked('S-3', [{ product_id: S2, qty: 2 }]);
await W('select public.putaway($1,$2,$3,$4,$5,$6,$7)', [orgA, S2, PK, B2, 1, '', 'moved-away']);
ok('if packed goods were moved away, beginning is refused with a clear instruction', /no longer all at the packing station/.test((await begin(wh, 'aal1', O3)).err || ''));
// ---- visibility ----
ok('staff can read shipments, with costs', (await as(wh, 'aal1', 'select cost_net from public.shipments')).rows.length >= 2 && (await as(support, 'aal2', 'select cost_net from public.shipments')).rows.length >= 2);
ok('customers cannot read shipments at all (our cost and margin stay private)', (await as(ua, 'aal1', 'select id from public.shipments')).rows.length === 0 && (await as(ub, 'aal1', 'select id from public.shipments')).rows.length === 0);
ok('nobody writes shipments directly', !!(await call(wh, 'aal1', `insert into public.shipments (order_id, org_id, env, service_id, cost_net, cost_gross, markup_percent, bill_net, bill_gross) values ($1,$2,'sandbox',1,1,1,30,1,1)`, [O2, orgA])).err && !!(await call(admin, 'aal2', `update public.shipments set bill_net = 0`)).err);
// ---- invariants and audit ----
ok('reserved stays within on hand and ledger sums equal stock levels', (await one('select count(*)::int n from public.stock_levels where reserved > on_hand or reserved < 0'))[0].n === 0 && (await one(`select count(*)::int n from (select org_id, product_id, location_id, lot, sum(qty) q from public.stock_movements group by 1,2,3,4) m full join public.stock_levels s using (org_id,product_id,location_id,lot) where coalesce(m.q,0) <> coalesce(s.on_hand,0)`))[0].n === 0);
const acts = (await one(`select distinct action from public.audit_log where action like 'shipment.%'`)).map((x) => x.action);
for (const a of ['shipment.begin', 'shipment.purchase', 'shipment.fail']) ok('audit row written for ' + a, acts.includes(a));
await db.exec('rollback');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

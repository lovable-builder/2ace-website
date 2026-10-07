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

let planTick = 0;   // every plan gets its own moment, as it would in real life (a transaction otherwise gives them all the same time)
const plan = (org, config, status = 'active') => db.query(`insert into public.plans (org_id, config, monthly_pln, once_pln, status, created_at) values ($1,$2::jsonb,1000,0,$3, now() + ($4 || ' seconds')::interval)`, [org, JSON.stringify(config), status, String(++planTick)]);
const mode = async (org) => (await one('select public.org_fulfil_mode($1) m', [org]))[0].m;
const setOrg = (u, aal, org, patch) => call(u, aal, 'select public.set_org_shipping($1,$2::jsonb)', [org, JSON.stringify(patch)]);
const cfg = async (org) => (await one('select * from public.org_shipping_settings where org_id=$1', [org]))[0];

// ---- the mode of a customer ----
ok('a customer with no plan is on storage only', await mode(orgA) === 'storage');
await plan(orgA, { m2: 10, pkgs: { ful: true } }, 'checkout'); ok('a plan still in checkout does not count', await mode(orgA) === 'storage');
await plan(orgA, { m2: 10, pkgs: {} }); ok('any active plan makes the customer pay as you go: there is nothing else to choose', await mode(orgA) === 'payg');
await plan(orgB, { storageType: 'pallet', qty: 12, pkgs: {} }); ok('an old-format plan is pay as you go too', await mode(orgB) === 'payg');
await plan(orgA, { m2: 10, pkgs: { payg: true } });
// ---- who can read the mode ----
ok('a member reads their own mode', (await call(ua, 'aal1', 'select public.my_fulfil_mode($1) m', [orgA])).rows?.[0]?.m === 'payg');
ok('another customer cannot read it', !!(await call(ub, 'aal1', 'select public.my_fulfil_mode($1)', [orgA])).err);
ok('staff can read it, support included', (await call(support, 'aal2', 'select public.my_fulfil_mode($1) m', [orgA])).rows?.[0]?.m === 'payg' && (await W('select public.my_fulfil_mode($1) m', [orgA])).rows?.[0]?.m === 'payg');
ok('anonymous cannot', !!(await asAnon(`select public.my_fulfil_mode('${orgA}')`)).err);
ok('the internal function is not callable by anyone signed in', !!(await call(ua, 'aal1', 'select public.org_fulfil_mode($1)', [orgA])).err && !!(await W('select public.org_fulfil_mode($1)', [orgA])).err);
// ---- the settings ----
ok('settings start at the safe defaults: nothing bought by customers, 300 zł exposure, default markup', (await cfg(orgA)) === undefined);
ok('customers cannot change settings', !!(await setOrg(ua, 'aal1', orgA, { label_buying_enabled: true })).err);
ok('warehouse and support cannot change settings, only an admin can', !!(await setOrg(wh, 'aal1', orgA, { markup_percent: 10 })).err && !!(await setOrg(support, 'aal2', orgA, { markup_percent: 10 })).err);
ok('anonymous cannot', !!(await asAnon(`select public.set_org_shipping('${orgA}','{}'::jsonb)`)).err);
const a1 = await setOrg(admin, 'aal2', orgA, { markup_percent: 25, label_buying_enabled: true });
ok('an admin changes only the settings they send', !a1.err && (await cfg(orgA)).markup_percent === '25.00' && (await cfg(orgA)).label_buying_enabled === true && Number((await cfg(orgA)).exposure_cap_net) === 300 && (await cfg(orgA)).daily_label_cap === 10 && (await cfg(orgA)).fulfil_mode_override === null, JSON.stringify(a1));
ok('an unrelated change leaves the earlier ones alone', !(await setOrg(admin, 'aal2', orgA, { exposure_cap_net: 450 })).err && (await cfg(orgA)).markup_percent === '25.00' && Number((await cfg(orgA)).exposure_cap_net) === 450);
ok('an empty markup goes back to the default', !(await setOrg(admin, 'aal2', orgA, { markup_percent: '' })).err && (await cfg(orgA)).markup_percent === null);
for (const [label, patch, re] of [['a markup above 500', { markup_percent: 501 }, /./], ['a negative markup', { markup_percent: -1 }, /./], ['an unknown setting', { price: 1 }, /Unknown setting/], ['a bad mode', { fulfil_mode_override: 'everything' }, /Choose payg or storage/], ['a huge cap', { exposure_cap_net: 1e9 }, /./], ['not an object', [1], /Nothing to change/]]) ok('settings refuse ' + label, re.test((await setOrg(admin, 'aal2', orgA, patch)).err || ''));
ok('an unknown customer is refused', /Customer not found/.test((await setOrg(admin, 'aal2', '00000000-0000-0000-0000-000000000000', { markup_percent: 5 })).err || ''));
ok('the markup, caps and switches are invisible to the customer (they cannot read the table)', (await as(ua, 'aal1', 'select * from public.org_shipping_settings')).rows.length === 0);
ok('staff can read them, support included', (await as(support, 'aal2', 'select * from public.org_shipping_settings')).rows.length === 1 && (await as(wh, 'aal1', 'select * from public.org_shipping_settings')).rows.length === 1);
ok('nobody writes the table directly', !!(await call(admin, 'aal2', `update public.org_shipping_settings set markup_percent = 0`)).err && !!(await call(ua, 'aal1', `insert into public.org_shipping_settings (org_id) values ($1)`, [orgB])).err);
ok('changes are audited', (await one(`select count(*)::int n from public.audit_log where action='org.shipping_settings'`))[0].n >= 3);
// ---- the override ----
await setOrg(admin, 'aal2', orgA, { fulfil_mode_override: 'storage' }); ok('the override beats the plan', await mode(orgA) === 'storage');
await setOrg(admin, 'aal2', orgA, { fulfil_mode_override: '' }); ok('clearing it follows the plan again', await mode(orgA) === 'payg');
// ---- orders remember the mode they were placed in ----
await stock(orgA, S1, 30, B1);
const oP = await order(ua, 'aal1', orgA, 'M-1', [{ product_id: S1, qty: 1 }]);
ok('an order is stamped with the customer\'s mode when it is placed', (await one('select fulfil_mode from public.orders where id=$1', [oP.rows[0].r.id]))[0].fulfil_mode === 'payg');
await plan(orgA, { m2: 10, pkgs: {} }); await setOrg(admin, 'aal2', orgA, { fulfil_mode_override: 'storage' });
ok('a later change of mode does not change an order already placed', (await one('select fulfil_mode from public.orders where id=$1', [oP.rows[0].r.id]))[0].fulfil_mode === 'payg');
const oF = await order(ua, 'aal1', orgA, 'M-2', [{ product_id: S1, qty: 1 }]);
ok('but the next order follows the new mode', (await one('select fulfil_mode from public.orders where id=$1', [oF.rows[0].r.id]))[0].fulfil_mode === 'storage'); await setOrg(admin, 'aal2', orgA, { fulfil_mode_override: '' });
ok('new label columns exist and start empty', (await one('select label_source, label_flag from public.orders where id=$1', [oF.rows[0].r.id]))[0].label_source === null);
// ---- the ledger of shipping charges ----
const O1 = await mkPacked('S-1', [{ product_id: S1, qty: 4 }, { product_id: S2, qty: 2 }]);
await begin(wh, 'aal1', O1, { env: 'production', net: 10, gross: 12.3, markup: 30 });
const SH = (await one(`select * from public.shipments where order_id=$1 and status='buying'`, [O1]))[0];
ok('nothing is charged while a label is only being bought', (await one('select count(*)::int n from public.shipping_charges where shipment_id=$1', [SH.id]))[0].n === 0);
await W('select public.finish_shipment($1,$2,$3)', [SH.id, '70001', ['T1']]);
const ch = await one('select * from public.shipping_charges where shipment_id=$1', [SH.id]);
ok('buying a live label writes exactly one charge: the customer price, pending', ch.length === 1 && ch[0].kind === 'label' && Number(ch[0].net) === 13 && ch[0].status === 'pending' && ch[0].env === 'production' && ch[0].org_id === orgA && ch[0].order_id === O1, JSON.stringify(ch));
ok('the shipment\'s billing status follows', (await one('select billing_status from public.shipments where id=$1', [SH.id]))[0].billing_status === 'pending');
await W('select public.finish_shipment($1,$2,$3)', [SH.id, '70001', ['T1']]);
ok('finishing again does not add a second charge', (await one('select count(*)::int n from public.shipping_charges where shipment_id=$1', [SH.id]))[0].n === 1);
ok('the ledger refuses a second label charge for the same shipment', /duplicate|unique/i.test(await raw(`insert into public.shipping_charges (org_id, order_id, shipment_id, net, env) values ('${orgA}','${O1}','${SH.id}',1,'production')`)));
// a test (sandbox) label is never billed
await stock(orgA, S1, 12, B1);
const O2 = await mkPacked('S-2', [{ product_id: S1, qty: 3 }]);
await begin(wh, 'aal1', O2, { env: 'sandbox', net: 9, gross: 11.07, markup: 30 });
const SH2 = (await one(`select id from public.shipments where order_id=$1`, [O2]))[0];
await W('select public.finish_shipment($1,$2,$3)', [SH2.id, '70002', ['T2']]);
const ch2 = (await one('select * from public.shipping_charges where shipment_id=$1', [SH2.id]))[0];
ok('a label bought in the sandbox is recorded as waived, so test orders can never bill a real customer', ch2.status === 'waived' && ch2.env === 'sandbox' && Number(ch2.net) === 11.7, JSON.stringify(ch2));
ok('and its shipment says waived too', (await one('select billing_status from public.shipments where id=$1', [SH2.id]))[0].billing_status === 'waived');
// who can see the ledger
const LEDGER = (await one('select count(*)::int n from public.shipping_charges'))[0].n;
ok('staff can read the ledger, customers cannot', (await as(wh, 'aal1', 'select id from public.shipping_charges')).rows.length === LEDGER && (await as(support, 'aal2', 'select id from public.shipping_charges')).rows.length === LEDGER && (await as(ua, 'aal1', 'select id from public.shipping_charges')).rows.length === 0 && (await as(ub, 'aal1', 'select id from public.shipping_charges')).rows.length === 0);
ok('nobody writes the ledger directly', !!(await call(admin, 'aal2', `update public.shipping_charges set net = 0`)).err && !!(await call(wh, 'aal1', `delete from public.shipping_charges`)).err);
// existing flows are untouched
ok('the staff flow still ships the order and takes the goods out of stock', (await one('select status from public.orders where id=$1', [O1]))[0].status === 'shipped' && (await one(`select count(*)::int n from public.stock_movements where reason='ship' and ref_id=$1`, [O1]))[0].n === 2);
ok('ledger and stock levels still agree everywhere', (await one(`select count(*)::int n from (select org_id, product_id, location_id, lot, sum(qty) q from public.stock_movements group by 1,2,3,4) m full join public.stock_levels s using (org_id,product_id,location_id,lot) where coalesce(m.q,0) <> coalesce(s.on_hand,0)`))[0].n === 0);
await db.exec('rollback');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

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

// ---- reserving ----
let r1 = await order(ua, 'aal1', orgA, 'SHOP-1', [{ product_id: S1, qty: 4 }]);
ok('customer creates an order and it is reserved at once', r1.rows?.[0]?.r?.status === 'allocated' && /^ORD-\d{6}$/.test(r1.rows[0].r.ref), JSON.stringify(r1));
const O1 = r1.rows[0].r.id;
ok('reservation shows on the stock row and in allocations', (await lvl(S1, B1)).reserved === 4 && (await one('select sum(qty)::int n from public.allocations where order_id=$1 and status=\'reserved\'', [O1]))[0].n === 4);
ok('allocation names the bin it will be picked from', (await one('select location_id from public.allocations where order_id=$1', [O1]))[0].location_id === B1);
ok('order stays in the ledger untouched: reserving moves no stock', (await lvl(S1, B1)).on_hand === 10);
let r2 = await order(ua, 'aal1', orgA, 'SHOP-2', [{ product_id: S1, qty: 7 }, { product_id: S2, qty: 1 }]);
ok('an order that cannot be filled completely is held', r2.rows?.[0]?.r?.status === 'held', JSON.stringify(r2));
const O2 = r2.rows[0].r.id;
const h2 = (await one('select hold_reason from public.orders where id=$1', [O2]))[0].hold_reason;
ok('the hold says exactly what is short', /MUG-BLUE: need 7, available 6/.test(h2) && !/MUG-RED/.test(h2), h2);
ok('a held order reserves nothing at all, not even the lines that were in stock', (await lvl(S2, B2)).reserved === 0 && (await lvl(S1, B1)).reserved === 4);
let r3 = await order(ua, 'aal1', orgA, 'SHOP-3', [{ product_id: S1, qty: 2 }, { product_id: S2, qty: 99 }]);
ok('partial stock holds the whole order', r3.rows?.[0]?.r?.status === 'held' && (await lvl(S1, B1)).reserved === 4);
const O3 = r3.rows[0].r.id;
let r4 = await order(ua, 'aal1', orgA, 'SHOP-4', [{ product_id: S1, qty: 6 }]);
ok('the last free units can be taken by exactly one order', r4.rows?.[0]?.r?.status === 'allocated' && (await lvl(S1, B1)).reserved === 10);
let r5 = await order(ua, 'aal1', orgA, 'SHOP-5', [{ product_id: S1, qty: 1 }]);
ok('the next order for the same stock is held', r5.rows?.[0]?.r?.status === 'held');
const O5 = r5.rows[0].r.id;
ok('reserved never exceeds on hand', (await one('select count(*)::int n from public.stock_levels where reserved > on_hand'))[0].n === 0);
ok('reservations equal the active allocations', (await one(`select coalesce(sum(reserved),0)::int n from public.stock_levels`))[0].n === (await one(`select coalesce(sum(qty),0)::int n from public.allocations where status='reserved'`))[0].n);
// stock in the receiving area or quarantine is not for sale
await stock(orgA, S2, 20, null);
let r6 = await order(ua, 'aal1', orgA, 'SHOP-6', [{ product_id: S2, qty: 10 }]);
ok('goods still in the receiving area cannot be sold yet', r6.rows?.[0]?.r?.status === 'held');
await stock(orgA, S2, 5, null, 'damaged');
ok('quarantined goods cannot be sold either', (await lvl(S2, Q1)).on_hand === 5 && (await order(ua, 'aal1', orgA, 'SHOP-7', [{ product_id: S2, qty: 8 }])).rows?.[0]?.r?.status === 'held');
const O6 = r6.rows[0].r.id;
// ---- held orders get another go ----
await W('select public.putaway($1,$2,$3,$4,$5,$6,$7)', [orgA, S2, R1, B2, 20, '', 'putS2']);
ok('putting stock away reserves the oldest held order that now fits', (await one('select status from public.orders where id=$1', [O6]))[0].status === 'allocated');
ok('held orders that still do not fit stay held', (await one('select status from public.orders where id=$1', [O2]))[0].status === 'held');
ok('a count increase also re-checks held orders', await (async () => { await W(`select public.adjust_stock($1,$2,$3,5,'Found 5 more','', 'adjA')`, [orgA, S1, B1]); return (await one('select status from public.orders where id=$1', [O5]))[0].status === 'allocated'; })());
// ---- protecting reserved stock ----
ok('reserved units cannot be moved away', /Not enough free stock/.test((await W('select public.putaway($1,$2,$3,$4,$5,$6)', [orgA, S1, B1, B2, 15, ''])).err || '') );
ok('a count cannot take away reserved units', /reserved/.test((await W(`select public.adjust_stock($1,$2,$3,-5,'oops','')`, [orgA, S1, B1])).err || ''));
// ---- cancelling ----
ok('customers cannot cancel directly', /need approval|Changes to existing/.test((await call(ua, 'aal1', 'select public.cancel_order($1)', [O1])).err || ''));
const free0 = (await lvl(S1, B1)).reserved;
ok('staff cancel an order and its reservation is released', !(await W('select public.cancel_order($1)', [O1])).err && (await one('select status from public.orders where id=$1', [O1]))[0].status === 'cancelled' && (await one(`select count(*)::int n from public.allocations where order_id=$1 and status='released'`, [O1]))[0].n >= 1 && (await one(`select count(*)::int n from public.allocations where order_id=$1 and status='reserved'`, [O1]))[0].n === 0);
ok('cancelling twice is harmless', !(await W('select public.cancel_order($1)', [O1])).err);
ok('freed stock lets a held order go ahead (oldest first) and reservations still add up', (await one(`select count(*)::int n from public.orders where status='held'`))[0].n < 3 && (await one('select coalesce(sum(reserved),0)::int n from public.stock_levels'))[0].n === (await one(`select coalesce(sum(qty),0)::int n from public.allocations where status='reserved'`))[0].n);
// customer cancel through a request
const O7 = (await order(ua, 'aal1', orgA, 'SHOP-8', [{ product_id: S2, qty: 1 }])).rows[0].r.id;
const cq = await call(ua, 'aal1', `select public.request_change('order',$1,'delete','{}'::jsonb) id`, [O7]);
ok('a customer can ask to cancel an order', !!cq.rows?.[0]?.id && /Cancel order ORD-/.test((await one('select summary from public.change_requests where id=$1', [cq.rows[0].id]))[0].summary), cq.err);
ok('the order is untouched until approval', (await one('select status from public.orders where id=$1', [O7]))[0].status === 'allocated');
ok('an order cannot be edited through a request', /can only be cancelled/.test((await call(ua, 'aal1', `select public.request_change('order',$1,'update','{}'::jsonb)`, [O7])).err || ''));
ok('support cannot approve', !!(await call(support, 'aal2', 'select public.decide_change($1,true,null)', [cq.rows[0].id])).err);
ok('warehouse approves and the order is cancelled with stock released', !(await W('select public.decide_change($1,true,null)', [cq.rows[0].id])).err && (await one('select status from public.orders where id=$1', [O7]))[0].status === 'cancelled');
const O8 = (await order(ua, 'aal1', orgA, 'SHOP-9', [{ product_id: S2, qty: 1 }])).rows[0].r.id;
await db.query(`update public.orders set status='picking' where id=$1`, [O8]);
ok('an order that is being picked cannot be cancelled', /already being picked/.test((await W('select public.cancel_order($1)', [O8])).err || '') && /already being picked/.test((await call(ua, 'aal1', `select public.request_change('order',$1,'delete','{}'::jsonb)`, [O8])).err || ''));
// ---- who can do what ----
ok('another customer cannot see these orders', (await as(ub, 'aal1', 'select id from public.orders')).rows.length === 0 && (await as(ub, 'aal1', 'select id from public.allocations')).rows.length === 0);
ok('a customer sees their own orders and lines', (await as(ua, 'aal1', 'select id from public.orders')).rows.length >= 8 && (await as(ua, 'aal1', 'select id from public.order_lines')).rows.length >= 8);
ok("another customer cannot create an order for this company", !!(await order(ub, 'aal1', orgA, 'X-1', [{ product_id: S1, qty: 1 }])).err);
ok("and cannot order this company's products", !!(await order(ub, 'aal1', orgB, 'X-2', [{ product_id: S1, qty: 1 }])).err);
ok('support is read-only', /read-only/.test((await order(support, 'aal2', orgA, 'X-3', [{ product_id: S2, qty: 1 }])).err || '') && (await as(support, 'aal2', 'select id from public.orders')).rows.length >= 8);
ok('warehouse can create an order for a customer', !(await order(wh, 'aal1', orgA, 'PHONE-1', [{ product_id: S2, qty: 1 }])).err);
ok('a plan that is not active cannot order', /not active/.test((await order(uc, 'aal1', orgC, 'C-1', [{ product_id: (await pr(uc, orgC, 'C1', 'c')), qty: 1 }])).err || ''));
ok('nobody writes the order tables directly', !!(await call(ua, 'aal1', `insert into public.orders (org_id, ship_name, ship_line1, ship_postal, ship_city, ship_country) values ($1,'x','x','x','x','PL')`, [orgA])).err && !!(await call(wh, 'aal1', `update public.orders set status='shipped'`)).err && !!(await call(ua, 'aal1', `update public.stock_levels set reserved = 0`)).err);
ok('anonymous cannot call the order functions', !!(await asAnon(`select public.create_order('${orgA}',null,'{}'::jsonb,null,'[]'::jsonb)`)).err);
// ---- validation ----
const bad = async (sh, ls, ext) => (await order(ua, 'aal1', orgA, ext, ls, sh)).err || '';
ok('a recipient name is required', /name is required/.test(await bad({ ...ship, name: '' }, [{ product_id: S2, qty: 1 }], 'V1')));
ok('a two-letter country is required', /two-letter country/.test(await bad({ ...ship, country: 'Poland' }, [{ product_id: S2, qty: 1 }], 'V2')));
ok('address, postal code and city are required', /street address/.test(await bad({ ...ship, line1: '' }, [{ product_id: S2, qty: 1 }], 'V3')) && /postal code/.test(await bad({ ...ship, postal: '' }, [{ product_id: S2, qty: 1 }], 'V4')) && /city/.test(await bad({ ...ship, city: '' }, [{ product_id: S2, qty: 1 }], 'V5')));
ok('a bad email is refused', /email looks wrong/.test(await bad({ ...ship, email: 'nope' }, [{ product_id: S2, qty: 1 }], 'V6')));
ok('empty orders, zero quantities and repeated products are refused', /at least one/.test(await bad(ship, [], 'V7')) && /between 1/.test(await bad(ship, [{ product_id: S2, qty: 0 }], 'V8')) && /once per order/.test(await bad(ship, [{ product_id: S2, qty: 1 }, { product_id: S2, qty: 1 }], 'V9')));
ok('an unknown SKU is refused by name', /Unknown SKU NOPE/.test(await bad(ship, [{ sku: 'NOPE', qty: 1 }], 'V10')));
ok('a failed order leaves nothing behind', (await one(`select count(*)::int n from public.orders where external_ref like 'V%'`))[0].n === 0);
ok('lines can use a SKU instead of an id', (await order(ua, 'aal1', orgA, 'SKU-ORDER', [{ sku: 'MUG-RED', qty: 1 }])).rows?.[0]?.r?.ref?.startsWith('ORD-'));
// ---- replays and import ----
const again = await order(ua, 'aal1', orgA, 'SHOP-1', [{ product_id: S1, qty: 4 }]);
ok('the same customer order number returns the existing order and creates no second one', again.rows?.[0]?.r?.duplicate === true && again.rows[0].r.id === O1 && (await one(`select count(*)::int n from public.orders where external_ref='SHOP-1'`))[0].n === 1);
const imp = await call(ua, 'aal1', 'select public.import_orders($1,$2::jsonb) r', [orgA, JSON.stringify([
  { external_ref: 'CSV-1', ship, lines: [{ sku: 'MUG-RED', qty: 1 }] },
  { external_ref: 'CSV-2', ship, lines: [{ sku: 'GHOST', qty: 1 }] },
  { external_ref: 'CSV-1', ship, lines: [{ sku: 'MUG-RED', qty: 1 }] },
  { external_ref: 'CSV-3', ship: { ...ship, country: 'XX1' }, lines: [{ sku: 'MUG-RED', qty: 1 }] },
])]);
const rr = imp.rows?.[0]?.r || [];
ok('an import reports every order separately', rr.length === 4 && rr[0].ok && /^ORD-/.test(rr[0].ref) && !rr[1].ok && /Unknown SKU GHOST/.test(rr[1].error) && rr[2].ok && rr[2].duplicate === true && !rr[3].ok && /country/.test(rr[3].error), JSON.stringify(rr));
ok('a failing row does not undo the good ones', (await one(`select count(*)::int n from public.orders where external_ref='CSV-1'`))[0].n === 1 && (await one(`select count(*)::int n from public.orders where external_ref in ('CSV-2','CSV-3')`))[0].n === 0);
ok('imported orders are marked as CSV', (await one(`select channel from public.orders where external_ref='CSV-1'`))[0].channel === 'csv');
ok('an import is limited to 200 orders', /at most 200/.test((await call(ua, 'aal1', 'select public.import_orders($1,$2::jsonb)', [orgA, JSON.stringify(Array.from({ length: 201 }, (_, i) => ({ external_ref: 'M' + i, ship, lines: [{ sku: 'MUG-RED', qty: 1 }] })))])).err || ''));
// ---- staff re-check wrapper and audit ----
ok('staff can re-check a held order', !(await W('select public.allocate_order($1)', [O3])).err);
ok('customers cannot use the staff re-check', !!(await call(ua, 'aal1', 'select public.allocate_order($1)', [O3])).err);
const acts = (await one(`select distinct action from public.audit_log where action like 'order.%'`)).map((x) => x.action);
for (const a of ['order.create', 'order.allocate', 'order.cancel']) ok('audit row written for ' + a, acts.includes(a));
ok('final invariants hold: reserved within on hand, equal to active allocations', (await one('select count(*)::int n from public.stock_levels where reserved > on_hand or reserved < 0'))[0].n === 0 && (await one(`select coalesce(sum(reserved),0)::int n from public.stock_levels`))[0].n === (await one(`select coalesce(sum(qty),0)::int n from public.allocations where status='reserved'`))[0].n);

// ---- an order must carry what the shipping label needs ----
{
  const bad = async (patch, re, name) => { const r = await order(ua, 'aal1', orgA, 'BAD-' + name, [{ product_id: S1, qty: 1 }], { ...ship, ...patch }); ok('refused: ' + name, !!r.err && re.test(String(r.err.message ?? r.err)), JSON.stringify(r.err)); };
  await bad({ name: 'Jan' }, /first name and surname/, 'a name without a surname');
  await bad({ name: 'Jan 2ACE' }, /first name and surname/, 'a name with digits');
  await bad({ phone: '' }, /phone number is required/, 'no phone');
  await bad({ phone: '6081809461' }, /9 digits/, 'a Polish phone with 10 digits');
  await bad({ phone: '12345' }, /9 digits/, 'a Polish phone that is too short');
  await bad({ postal: '0001' }, /look like 00-001/, 'a bad Polish postal code');
  await bad({ line1: 'Prosta' }, /house number/, 'a Polish street without a number');
  await bad({ line1: '' }, /street address is required/, 'no street');
  await bad({ country: 'DE', phone: '12' }, /7 to 15 digits/, 'a foreign phone that is too short');
  const chk = async (sh) => (await call(ua, 'aal1', `select public.wms_check_ship($1::jsonb) r`, [JSON.stringify({ ...ship, ...sh })])).rows?.[0]?.r;
  const forms = ['608180946', '+48 608 180 946', '0048608180946', '48608180946', '0608180946', '608-180-946'];
  for (const f of forms) ok('phone ' + f + ' is stored as 608180946', (await chk({ phone: f }))?.phone === '608180946');
  ok('a five-digit Polish postal code gets its dash, and a Polish name with accents is accepted', (await chk({ postal: '05090', name: 'Zażółć Gęślą-Jaźń' }))?.postal === '05-090' && (await chk({ name: 'Łukasz Żółć' }))?.name === 'Łukasz Żółć');
  ok('a German order with a plain phone and no house number rule still passes', (await chk({ country: 'DE', phone: '+49 30 1234567', postal: '10115', line1: 'Hauptstrasse' }))?.phone === '4930 1234567'.replace(' ', ''));
}
await db.exec('rollback');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

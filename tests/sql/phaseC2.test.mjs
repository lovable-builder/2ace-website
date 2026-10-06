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


// ---- before there is a packing station ----
let o1 = await order(ua, 'aal1', orgA, 'P-1', [{ product_id: S1, qty: 4 }, { product_id: S2, qty: 2 }]);
ok('the order is reserved first', o1.rows?.[0]?.r?.status === 'allocated', JSON.stringify(o1));
const O1 = o1.rows[0].r.id;
const allocOf = async (oid) => await one(`select a.id, a.product_id, a.qty, a.status, l.code from public.allocations a join public.locations l on l.id = a.location_id where a.order_id = $1 order by l.code`, [oid]);
let al = await allocOf(O1); const A1 = al.find((x) => x.product_id === S1), A2 = al.find((x) => x.product_id === S2);
// (a packing station is now created automatically on the first pick; see phaseD.test.mjs)
const PK = await mkLoc('PACK-1', 'pack');
// ---- who may pick ----
ok('customers cannot pick', !!(await call(ua, 'aal1', 'select public.pick_line($1,$2)', [A1.id, 'kc'])).err);
ok('support cannot pick', !!(await call(support, 'aal2', 'select public.pick_line($1,$2)', [A1.id, 'ks'])).err);
ok('anonymous cannot pick', !!(await asAnon(`select public.pick_line('${A1.id}','x')`)).err);
// ---- picking ----
const before = { bin: await lvl(S1, B1), pack: await lvl(S1, PK) };
const p1 = await W('select public.pick_line($1,$2) r', [A1.id, 'pick-1']);
ok('warehouse picks a line', p1.rows?.[0]?.r?.remaining === 1 && p1.rows[0].r.replayed === false, JSON.stringify(p1));
const after = { bin: await lvl(S1, B1), pack: await lvl(S1, PK) };
ok('the units left the bin and reached the packing station', after.bin.on_hand === before.bin.on_hand - 4 && after.pack.on_hand === 4);
ok('the reservation was released with the move', after.bin.reserved === before.bin.reserved - 4);
ok('two ledger rows record the pick', (await one(`select count(*)::int n from public.stock_movements where reason='pick' and ref_id=$1 and product_id=$2`, [O1, S1]))[0].n === 2);
ok('the allocation is marked picked, by whom and when', (await one(`select status, picked_by is not null as who, picked_at is not null as at, pack_location_id from public.allocations where id=$1`, [A1.id]))[0].status === 'picked');
ok('the order moved to picking', (await one('select status, pick_started_at is not null as s from public.orders where id=$1', [O1]))[0].status === 'picking');
const dup = await W('select public.pick_line($1,$2) r', [A1.id, 'pick-1']);
ok('a repeated scan with the same key changes nothing', dup.rows?.[0]?.r?.replayed === true && (await lvl(S1, PK)).on_hand === 4);
ok('the same line cannot be picked twice with a new key', /already picked/.test((await W('select public.pick_line($1,$2)', [A1.id, 'pick-1b'])).err || ''));
ok('an order being picked cannot be cancelled', /already being picked/.test((await W('select public.cancel_order($1)', [O1])).err || ''));
// ---- packing ----
const parcel = [{ weight_g: 1800, length_cm: 30, width_cm: 20, height_cm: 15 }];
ok('packing before everything is picked is refused', /Not everything has been picked yet/.test((await W('select public.pack_order($1,$2::jsonb)', [O1, JSON.stringify(parcel)])).err || ''));
ok('customers and support cannot pack', !!(await call(ua, 'aal1', 'select public.pack_order($1,$2::jsonb)', [O1, JSON.stringify(parcel)])).err && !!(await call(support, 'aal2', 'select public.pack_order($1,$2::jsonb)', [O1, JSON.stringify(parcel)])).err);
await W('select public.pick_line($1,$2)', [A2.id, 'pick-2']);
ok('all lines picked: nothing is reserved for this order any more', (await one(`select count(*)::int n from public.allocations where order_id=$1 and status='reserved'`, [O1]))[0].n === 0);
for (const [label, bad, re] of [['no parcels', [], /at least one parcel/], ['zero weight', [{ ...parcel[0], weight_g: 0 }], /Parcel 1: enter a weight/], ['over 70 kg', [{ ...parcel[0], weight_g: 70001 }], /between 1 g and 70 kg/], ['missing size', [{ weight_g: 500, length_cm: 10, width_cm: 10 }], /length, width and height/], ['a side over 3 m', [{ ...parcel[0], length_cm: 301 }], /longer than 300 cm/], ['eleven parcels', Array.from({ length: 11 }, () => parcel[0]), /At most 10/]]) {
  ok('packing refuses ' + label, re.test((await W('select public.pack_order($1,$2::jsonb)', [O1, JSON.stringify(bad)])).err || ''));
}
ok('a refused pack leaves no parcels and the status unchanged', (await one('select count(*)::int n from public.parcels where order_id=$1', [O1]))[0].n === 0 && (await one('select status from public.orders where id=$1', [O1]))[0].status === 'picking');
const pk = await W('select public.pack_order($1,$2::jsonb) r', [O1, JSON.stringify([parcel[0], { weight_g: 900, length_cm: 25.5, width_cm: 18, height_cm: 10 }])]);
ok('warehouse packs the order into two parcels', pk.rows?.[0]?.r?.parcels === 2 && pk.rows[0].r.replayed === false, JSON.stringify(pk));
ok('the order is packed and the parcels are recorded', (await one('select status, packed_at is not null as p from public.orders where id=$1', [O1]))[0].status === 'packed' && (await one('select count(*)::int n from public.parcels where order_id=$1', [O1]))[0].n === 2);
ok('parcel sizes keep their decimals', Number((await one('select length_cm from public.parcels where order_id=$1 and seq=2', [O1]))[0].length_cm) === 25.5);
ok('packing again is harmless and adds nothing', (await W('select public.pack_order($1,$2::jsonb) r', [O1, JSON.stringify(parcel)])).rows?.[0]?.r?.replayed === true && (await one('select count(*)::int n from public.parcels where order_id=$1', [O1]))[0].n === 2);
ok('a packed order cannot be picked, stopped or cancelled', /cannot be picked/.test((await W('select public.pick_line($1,$2)', [A1.id, 'zz'])).err || '') && /cannot be stopped/.test((await W('select public.report_pick_problem($1,$2)', [O1, 'x problem'])).err || '') && /already being picked/.test((await W('select public.cancel_order($1)', [O1])).err || ''));
// ---- who sees parcels ----
ok('the customer sees their own parcels, another customer does not', (await as(ua, 'aal1', 'select id from public.parcels')).rows.length === 2 && (await as(ub, 'aal1', 'select id from public.parcels')).rows.length === 0);
ok('nobody writes parcels directly', !!(await call(wh, 'aal1', `insert into public.parcels (order_id, org_id, seq, weight_g, length_cm, width_cm, height_cm) values ($1,$2,9,1,1,1,1)`, [O1, orgA])).err);
// ---- a picking problem ----
await stock(orgA, S1, 6, B1); await stock(orgA, S2, 3, B2);
let o2 = await order(ua, 'aal1', orgA, 'P-2', [{ product_id: S1, qty: 3 }, { product_id: S2, qty: 2 }]);
const O2 = o2.rows[0].r.id; const al2 = await allocOf(O2); const B2A = al2.find((x) => x.product_id === S2), B1A = al2.find((x) => x.product_id === S1);
await W('select public.pick_line($1,$2)', [B1A.id, 'pp-1']);
ok('a problem needs a description', /Say what is wrong/.test((await W('select public.report_pick_problem($1,$2)', [O2, ' '])).err || ''));
ok('customers cannot stop an order', !!(await call(ua, 'aal1', 'select public.report_pick_problem($1,$2)', [O2, 'nope nope'])).err);
const resBefore = (await lvl(S2, B2)).reserved;
ok('staff report that a bin is empty', !(await W('select public.report_pick_problem($1,$2)', [O2, 'Bin A-02 is empty'])).err);
ok('the order is on hold and says why, including where the picked items are', (await one('select status, hold_reason from public.orders where id=$1', [O2]))[0].status === 'held' && /Bin A-02 is empty/.test((await one('select hold_reason from public.orders where id=$1', [O2]))[0].hold_reason) && /packing station/.test((await one('select hold_reason from public.orders where id=$1', [O2]))[0].hold_reason));
ok('every reservation of that order is released', (await lvl(S2, B2)).reserved === resBefore - 2 && (await one(`select count(*)::int n from public.allocations where order_id=$1 and status in ('reserved','picked')`, [O2]))[0].n === 0);
ok('the picked units are still at the packing station in the ledger', (await lvl(S1, PK)).on_hand === 4 + 3);
// returning them to the shelf gives the held order another go
const reserveBefore = (await one('select status from public.orders where id=$1', [O2]))[0].status;
await W('select public.putaway($1,$2,$3,$4,$5,$6,$7)', [orgA, S1, PK, B1, 3, '', 'back-1']);
ok('returning the picked items to a bin lets the held order be reserved again', reserveBefore === 'held' && (await one('select status from public.orders where id=$1', [O2]))[0].status === 'allocated');
// ---- invariants and audit ----
ok('reserved stays within on hand and equals the active allocations', (await one('select count(*)::int n from public.stock_levels where reserved > on_hand or reserved < 0'))[0].n === 0 && (await one(`select coalesce(sum(reserved),0)::int n from public.stock_levels`))[0].n === (await one(`select coalesce(sum(qty),0)::int n from public.allocations where status='reserved'`))[0].n);
ok('ledger sums still equal the stock levels everywhere', (await one(`select count(*)::int n from (select org_id, product_id, location_id, lot, sum(qty) q from public.stock_movements group by 1,2,3,4) m full join public.stock_levels s using (org_id,product_id,location_id,lot) where coalesce(m.q,0) <> coalesce(s.on_hand,0)`))[0].n === 0);
const acts = (await one(`select distinct action from public.audit_log where action like 'order.%'`)).map((x) => x.action);
for (const a of ['order.pick', 'order.pack', 'order.pick_problem']) ok('audit row written for ' + a, acts.includes(a));
ok('the product lookup the scan page relies on finds a product by SKU for this customer', (await W(`select public.wms_lookup('MUG-BLUE',$1) r`, [orgA])).rows?.[0]?.r?.type === 'product');
await db.exec('rollback');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

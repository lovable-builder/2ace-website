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

// =============== Fulfilment as you go: the customer buys the label ===============
const svc = async (q, p = []) => { await db.exec('savepoint s'); try { await db.exec('set local role service_role'); const r = await db.query(q, p); await db.exec('reset role'); await db.exec('release savepoint s'); return { rows: r.rows }; } catch (e) { await db.exec('rollback to savepoint s'); await db.exec('reset role'); return { err: e.message }; } };
const direct = async (q, p = []) => { await db.exec('savepoint d'); try { const r = await db.query(q, p); await db.exec('release savepoint d'); return { rows: r.rows }; } catch (e) { await db.exec('rollback to savepoint d'); return { err: e.message }; } };
const settings = (o) => direct(`insert into public.org_shipping_settings (org_id, label_buying_enabled, fulfil_mode_override, exposure_cap_net, daily_label_cap, max_label_net) values ($1, $2, $3, $4, $5, $6)
  on conflict (org_id) do update set label_buying_enabled = $2, fulfil_mode_override = $3, exposure_cap_net = $4, daily_label_cap = $5, max_label_net = $6`, [orgA, o.on ?? true, o.mode ?? 'payg', o.cap ?? 100, o.daily ?? 5, o.max ?? 50]);
await settings({});
const PARCEL = JSON.stringify([{ weight_g: 1800, length_cm: 30, width_cm: 20, height_cm: 15 }]);
await stock(orgA, S1, 60, B1);
const mkOrd = async (ext) => (await order(ua, 'aal1', orgA, ext, [{ product_id: S1, qty: 1 }])).rows[0].r;
const O = await mkOrd('PAYG-1');
ok('the test order is reserved', O.status === 'allocated');
const begin = (oid, over = {}) => svc(`select * from public.cs_begin_shipment($1,$2,$3,$4,$5,'dpd','DPD · package',$6,$7,23,30,$8::jsonb)`, [over.org ?? orgA, oid, ua, over.env ?? 'sandbox', over.service ?? 7, over.net ?? 10, over.gross ?? 12.3, over.parcels ?? PARCEL]);
const finish = (id, pkg = '555', tr = ['WB1']) => svc(`select * from public.cs_finish_shipment($1,$2,$3::text[],$4)`, [id, pkg, tr, ua]);

// ---- who may call it ----
ok('visitors and signed-in customers cannot call the purchase functions directly', !!(await asAnon(`select * from public.cs_begin_shipment('${orgA}','${O.id}','${ua}','sandbox',7,'dpd','x',10,12.3,23,30,'[]'::jsonb)`)).err
  && !!(await call(ua, 'aal1', `select * from public.cs_begin_shipment($1,$2,$3,'sandbox',7,'dpd','x',10,12.3,23,30,$4::jsonb)`, [orgA, O.id, ua, PARCEL])).err
  && !!(await call(ua, 'aal1', `select public.cs_finish_shipment($1,'1',null,$2)`, [O.id, ua])).err);
// ---- the rules before any money moves ----
ok('another company\'s order is "not found", even for a valid customer', /Order not found/.test((await begin(O.id, { org: orgB })).err ?? ''));
await settings({ on: false }); ok('labels cannot be bought until staff switch it on for that customer', /not switched on/.test((await begin(O.id)).err ?? ''));
await settings({ mode: 'storage' }); ok('only a Fulfilment-as-you-go customer can buy', /Fulfilment as you go/.test((await begin(O.id)).err ?? ''));
await settings({}); await direct(`update public.organizations set status='past_due' where id=$1`, [orgA]); ok('a customer whose plan is not active cannot buy', /not active/.test((await begin(O.id)).err ?? '')); await direct(`update public.organizations set status='active' where id=$1`, [orgA]);
{ const H = (await order(ua, 'aal1', orgA, 'PAYG-HELD', [{ product_id: S2, qty: 500 }])).rows[0].r; ok('an order on hold (nothing reserved) cannot get a label', H.status === 'held' && /reserved and not shipped/.test((await begin(H.id)).err ?? '')); }
ok('parcels are checked: none, four, too heavy, too big', /1 to 3 parcels/.test((await begin(O.id, { parcels: '[]' })).err ?? '') && /1 to 3 parcels/.test((await begin(O.id, { parcels: JSON.stringify(Array(4).fill({ weight_g: 100, length_cm: 10, width_cm: 10, height_cm: 10 })) })).err ?? '')
  && /between 1 g and 30 kg/.test((await begin(O.id, { parcels: JSON.stringify([{ weight_g: 31000, length_cm: 10, width_cm: 10, height_cm: 10 }]) })).err ?? '') && /between 1 and 150 cm/.test((await begin(O.id, { parcels: JSON.stringify([{ weight_g: 500, length_cm: 200, width_cm: 10, height_cm: 10 }]) })).err ?? ''));
ok('a label above the customer\'s per-label limit is refused (50 zł net; 50 + 30% = 65)', /above the 50(\.00)? zł limit/.test((await begin(O.id, { net: 50, gross: 61.5 })).err ?? ''));
// ---- a purchase ----
const b1 = await begin(O.id); const S = b1.rows?.[0];
ok('begin records the purchase before any money moves: customer, price with markup, parcels kept', S && S.status === 'buying' && S.buyer_role === 'customer' && Number(S.bill_net) === 13 && Number(S.bill_gross) === 15.99 && S.parcels[0].weight_g === 1800, JSON.stringify(b1));
ok('a second click or tab cannot start another purchase for the same order', /already being bought/.test((await begin(O.id)).err ?? ''));
ok('customers cannot read shipment records (our cost and margin stay private)', (await call(ua, 'aal1', `select count(*)::int n from public.shipments`)).rows[0].n === 0);
ok('a failed attempt is closed with the reason and the order can try again', !(await svc(`select public.cs_fail_shipment($1,'carrier refused',$2)`, [S.id, ua])).err && (await one(`select status, error from public.shipments where id=$1`, [S.id]))[0].error === 'carrier refused' && !!(await begin(O.id)).rows);
const S2r = (await one(`select id from public.shipments where order_id=$1 and status='buying'`, [O.id]))[0];
const f1 = await finish(S2r.id);
ok('finish records the purchase with its tracking, and marks the label as ours', f1.rows?.[0]?.status === 'purchased' && f1.rows[0].tracking_numbers[0] === 'WB1' && (await one(`select label_source from public.orders where id=$1`, [O.id]))[0].label_source === '2ace');
ok('the order does NOT ship and no stock moves when a customer buys a label', (await one(`select status from public.orders where id=$1`, [O.id]))[0].status === 'allocated' && (await lvl(S1, B1)).reserved >= 1);
ok('test (sandbox) labels are never billed: the charge is written as waived', (await one(`select kind, status, net from public.shipping_charges where shipment_id=$1`, [S2r.id]))[0].status === 'waived');
ok('finishing twice changes nothing, a different package id is refused', (await finish(S2r.id)).rows?.[0]?.status === 'purchased' && /different package/.test((await finish(S2r.id, '999')).err ?? ''));
ok('the audit log says it was the customer', (await one(`select count(*)::int n from public.audit_log where entity='shipments' and entity_id=$1 and action in ('shipment.begin','shipment.purchase') and actor_role='customer'`, [S2r.id]))[0].n === 2);
{ const c = await W(`select public.cancel_order($1)`, [O.id]); ok('nobody can cancel an order that has a bought label (staff must deal with it first)', /label has been bought/.test(c.err ?? ''), JSON.stringify(c)); }
ok('nor can one label be added to an order that has one, or an own label next to it', /already being bought or has been bought/.test((await begin(O.id)).err ?? '') && !!(await svc(`select public.attach_own_label($1,$2,null,null,null,array['T1'],'InPost',$3)`, [orgA, O.id, ua])).err);

// ---- limits across orders ----
const O2 = await mkOrd('PAYG-2'), O3 = await mkOrd('PAYG-3'), O4 = await mkOrd('PAYG-4');
await direct(`update public.shipments set billing_status='pending', env='production' where id=$1`, [S2r.id]);      // pretend the first label is a live one not yet invoiced: 13 zł exposure
await settings({ cap: 20 }); ok('unpaid labels are limited: 13 zł already owed + 13 zł would pass the 20 zł limit', /would pass your limit of 20/.test((await begin(O2.id, { env: 'production' })).err ?? ''));
await settings({ cap: 100, daily: 1 }); ok('labels per day are limited', /limit of 1 labels for today/.test((await begin(O2.id)).err ?? ''));
await settings({ cap: 1000, daily: 50 });
const b3 = await begin(O3.id, { env: 'production' }); ok('within the limits a live label is recorded as owed (pending)', !!b3.rows && b3.rows[0].billing_status === 'pending');
await finish(b3.rows[0].id, '777'); ok('a live label writes a pending charge, to be invoiced', (await one(`select status, net from public.shipping_charges where shipment_id=$1`, [b3.rows[0].id]))[0].status === 'pending');

// ---- packing against what was declared ----
const pack = async (oid, parcels) => { await direct(`update public.orders set status='picking' where id=$1`, [oid]); for (const [i, p] of parcels.entries()) await direct(`insert into public.parcels (order_id, org_id, seq, weight_g, length_cm, width_cm, height_cm) values ($1,$2,$3,$4,$5,$6,$7)`, [oid, orgA, i + 1, p[0], p[1], p[2], p[3]]); return direct(`update public.orders set status='packed' where id=$1 returning label_flag, label_flag_note`, [oid]); };
const flag = async (oid) => (await one(`select label_flag f, label_flag_note n from public.orders where id=$1`, [oid]))[0];
const b4 = await begin(O4.id); await finish(b4.rows[0].id, '888');
const pk = await pack(O4.id, [[1800, 30, 20, 15]]); ok('a parcel that matches the label is not flagged', (await flag(O4.id)).f === null);
const OA = await mkOrd('PAYG-A'); await finish((await begin(OA.id)).rows[0].id, '901'); await pack(OA.id, [[1850, 31, 20, 15]]); ok('a little over (within 10% + 100 g, +2 cm) is accepted', (await flag(OA.id)).f === null);
const OB = await mkOrd('PAYG-B'); await finish((await begin(OB.id)).rows[0].id, '902'); await pack(OB.id, [[2600, 30, 20, 15]]); const fb = await flag(OB.id); ok('a heavier parcel is flagged, with the numbers', fb.f === 'mismatch' && /weighs 2600 g, the label was bought for 1800 g/.test(fb.n), JSON.stringify(fb));
const OC = await mkOrd('PAYG-C'); await finish((await begin(OC.id)).rows[0].id, '903'); await pack(OC.id, [[1800, 30, 20, 25]]); ok('a taller parcel is flagged', /measures 30 x 25 x 20 cm, the label was bought for 30 x 20 x 15/.test((await flag(OC.id)).n ?? ''));
const OD = await mkOrd('PAYG-D'); await finish((await begin(OD.id)).rows[0].id, '904'); await pack(OD.id, [[1000, 20, 10, 10]]); ok('a smaller parcel than declared is fine', (await flag(OD.id)).f === null);
const OE2 = await mkOrd('PAYG-E'); await finish((await begin(OE2.id)).rows[0].id, '905'); await pack(OE2.id, [[900, 30, 20, 15], [900, 30, 20, 15]]); ok('a different number of parcels is flagged', /declared 1 parcel\(s\), we packed 2/.test((await flag(OE2.id)).n ?? ''));
{ const OF = await mkOrd('PAYG-F'); const bf = await begin(OF.id); await direct(`update public.orders set status='picking' where id=$1`, [OF.id]); const r = await direct(`update public.orders set status='packed' where id=$1`, [OF.id]); ok('an order cannot be packed while its label is still being bought', /still being bought/.test(r.err ?? ''));
  await svc(`select public.cs_fail_shipment($1,'x',$2)`, [bf.rows[0].id, ua]); }
{ const OG = await mkOrd('PAYG-G'); await direct(`update public.orders set status='picking' where id=$1`, [OG.id]); await direct(`insert into public.parcels (order_id, org_id, seq, weight_g, length_cm, width_cm, height_cm) values ($1,$2,1,3000,30,20,15)`, [OG.id, orgA]); await direct(`update public.orders set status='packed' where id=$1`, [OG.id]);
  const bg = await begin(OG.id); await finish(bg.rows[0].id, '906'); ok('a label bought after packing is checked against the real parcel at once', (await flag(OG.id)).f === 'mismatch'); }

// ---- staff: accept a difference ----
ok('an order with a parcel difference cannot be shipped until it is accepted', /does not match the label/.test((await W(`select public.ship_order($1)`, [OB.id])).err ?? ''));
ok('warehouse staff can accept the difference, but only an admin can add a charge', !!(await W(`select public.accept_label_mismatch($1,null,'we will take it')`, [OC.id])).rows && /Only an admin/.test((await W(`select public.accept_label_mismatch($1,6)`, [OB.id])).err ?? ''));
ok('an admin can add what the carrier charges extra, to the customer\'s account', !!(await call(admin, 'aal2', `select public.accept_label_mismatch($1,6.5,'DPD weight surcharge')`, [OB.id])).rows
  && (await one(`select kind, net, status, note from public.shipping_charges where order_id=$1 and kind='adjustment'`, [OB.id]))[0].note === 'DPD weight surcharge');
ok('after acceptance the flag is gone and the order can ship with its label', (await flag(OB.id)).f === null && !!(await W(`select public.ship_order($1) r`, [OB.id])).rows && (await one(`select status from public.orders where id=$1`, [OB.id]))[0].status === 'shipped');
ok('accepting an order that has no difference is refused, and customers cannot accept', /no parcel difference/.test((await W(`select public.accept_label_mismatch($1)`, [OD.id])).err ?? '') && !!(await call(ua, 'aal1', `select public.accept_label_mismatch($1)`, [OE2.id])).err);
ok('a bought label by the customer shows in staff screens as bought by the customer', (await one(`select buyer_role from public.shipments where order_id=$1 and status='purchased'`, [OB.id]))[0].buyer_role === 'customer');
ok('staff cannot buy a second label for an order the customer already bought one for', /already being bought or has been bought|Only a packed order/.test((await W(`select * from public.begin_shipment($1,'sandbox',7,'dpd','x',10,12.3,23,30)`, [OD.id])).err ?? ''));

await db.exec('rollback');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

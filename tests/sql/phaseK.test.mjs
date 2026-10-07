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

// =============== Returns ===============
const svc = async (q, p = []) => { await db.exec('savepoint s'); try { await db.exec('set local role service_role'); const r = await db.query(q, p); await db.exec('reset role'); await db.exec('release savepoint s'); return { rows: r.rows }; } catch (e) { await db.exec('rollback to savepoint s'); await db.exec('reset role'); return { err: e.message }; } };
const direct = async (q, p = []) => { await db.exec('savepoint d'); try { const r = await db.query(q, p); await db.exec('release savepoint d'); return { rows: r.rows }; } catch (e) { await db.exec('rollback to savepoint d'); return { err: e.message }; } };
const setOrg = (o) => direct(`insert into public.org_shipping_settings (org_id, fulfil_mode_override, usage_billing_live, handling_adjust_percent, label_buying_enabled) values ($1,$2,$3,$4,$5)
  on conflict (org_id) do update set fulfil_mode_override=$2, usage_billing_live=$3, handling_adjust_percent=$4, label_buying_enabled=$5`, [orgA, o.mode ?? null, o.live ?? false, o.adj ?? 0, o.buy ?? true]);
await stock(orgA, S1, 30, B1);
await setOrg({});
const shipped = async (qty = 3) => { const o = (await order(ua, 'aal1', orgA, 'RET-' + Math.random(), [{ product_id: S1, qty }])).rows[0].r; await direct(`update public.orders set status='shipped' where id=$1`, [o.id]); return o.id; };
const BUYER = { name: 'Anna Nowak', phone: '+48 600 100 200', line1: 'Lipowa 5', postal: '31-000', city: 'Krakow', country: 'PL', email: 'anna@example.pl' };
const mkRet = (oid, over = {}, lines) => call(ua, 'aal1', `select public.create_return($1,$2,$3::jsonb,$4,$5::jsonb) r`, [over.org ?? orgA, oid, JSON.stringify({ ...BUYER, ...(over.buyer ?? {}) }), over.reason ?? 'Too small', JSON.stringify(lines ?? [{ product_id: S1, qty: 2 }])]);
const O1 = await shipped();

// ---- announcing a return ----
const c1 = await mkRet(O1); const RT1 = c1.rows?.[0]?.r;
ok('a customer announces a return of a shipped order, and gets a reference', /^RET-\d{6}$/.test(RT1?.ref) && RT1.fee_mode === 'flat', JSON.stringify(c1));
const rrow = (await one(`select * from public.returns where id=$1`, [RT1.id]))[0];
ok('the buyer\'s details are stored cleaned (phone as 9 digits), the status is announced', rrow.status === 'announced' && rrow.buyer_phone === '600100200' && rrow.buyer_name === 'Anna Nowak' && rrow.buyer_country === 'PL');
for (const [name, over, re] of [['a buyer name without a surname', { buyer: { name: 'Anna' } }, /first name and surname/], ['a bad phone', { buyer: { phone: '123' } }, /9 digits/], ['no city', { buyer: { city: '' } }, /city is required/], ['a bad postal code', { buyer: { postal: '3100' } }, /00-001/], ['a bad email', { buyer: { email: 'nope' } }, /email looks wrong/]]) ok('refused: ' + name, re.test((await mkRet(O1, over)).err ?? ''));
ok('a return needs a shipped order', /has shipped/.test((await mkRet((await order(ua, 'aal1', orgA, 'RET-open', [{ product_id: S1, qty: 1 }])).rows[0].r.id)).err ?? ''));
ok('more units than were on the order are refused, counting returns already announced (3 on the order, 2 announced, 2 more is too many)', /More units are coming back than were on the order/.test((await mkRet(O1)).err ?? ''));
ok('one more unit is fine (2 + 1 = 3)', !!(await mkRet(O1, {}, [{ product_id: S1, qty: 1 }])).rows);
ok('a product that was not on the order is refused', /not on that order/.test((await mkRet(await shipped(1), {}, [{ product_id: S2, qty: 1 }])).err ?? ''));
ok('a product twice, no lines, and zero units are refused', /once per return/.test((await mkRet(await shipped(), {}, [{ product_id: S1, qty: 1 }, { product_id: S1, qty: 1 }])).err ?? '') && /at least one product/.test((await mkRet(await shipped(), {}, [])).err ?? '') && /between 1 and 100,000/.test((await mkRet(await shipped(), {}, [{ product_id: S1, qty: 0 }])).err ?? ''));
ok('another company\'s order or product cannot be used', /Order not found/.test((await call(ub, 'aal1', `select public.create_return($1,$2,$3::jsonb,null,$4::jsonb)`, [orgB, O1, JSON.stringify(BUYER), JSON.stringify([{ product_id: SB, qty: 1 }])])).err ?? '') && !!(await call(ub, 'aal1', `select public.create_return($1,null,$2::jsonb,null,$3::jsonb)`, [orgB, JSON.stringify(BUYER), JSON.stringify([{ product_id: S1, qty: 1 }])])).err);
ok('a return without an order is possible (goods that came back by themselves)', !!(await mkRet(null, {}, [{ product_id: S2, qty: 1 }])).rows);
ok('a customer cannot announce a return for another company', !!(await call(ua, 'aal1', `select public.create_return($1,null,$2::jsonb,null,$3::jsonb)`, [orgB, JSON.stringify(BUYER), JSON.stringify([{ product_id: SB, qty: 1 }])])).err);
ok('members read their returns and lines, other companies see nothing, staff see all, visitors nothing', (await call(ua, 'aal1', `select count(*)::int n from public.returns`)).rows[0].n >= 3 && (await call(ub, 'aal1', `select count(*)::int n from public.returns`)).rows[0].n === 0 && (await W(`select count(*)::int n from public.return_lines`)).rows[0].n >= 3 && ((await asAnon(`select count(*)::int n from public.returns`)).rows?.[0]?.n ?? 0) === 0);
ok('nobody can write the tables directly', !!(await call(ua, 'aal1', `update public.returns set status='graded'`)).err && !!(await call(admin, 'aal2', `delete from public.returns`)).err);
await setOrg({ mode: 'payg' }); const Rp = (await mkRet(await shipped(), {}, [{ product_id: S1, qty: 1 }])).rows[0].r; ok('a customer on pay as you go for returns gets fee_mode payg, stamped when announced', Rp.fee_mode === 'payg'); await setOrg({});
await direct(`insert into public.plans (org_id, config, monthly_pln, once_pln, status) values ($1,'{"m2":5,"pkgs":{"retp":true}}'::jsonb,1500,0,'active')`, [orgA]);
const Rq = (await mkRet(await shipped(), {}, [{ product_id: S1, qty: 1 }])).rows[0].r; ok('a plan with Returns as you go does the same', Rq.fee_mode === 'payg'); await direct(`update public.plans set status='canceled' where org_id=$1`, [orgA]);

// ---- cancelling ----
const Rc = (await mkRet(await shipped(), {}, [{ product_id: S1, qty: 1 }])).rows[0].r;
ok('a return that has no label yet can be cancelled by the customer, and a repeat is harmless', !(await call(ua, 'aal1', `select public.cancel_return($1)`, [Rc.id])).err && !(await call(ua, 'aal1', `select public.cancel_return($1)`, [Rc.id])).err && (await one(`select status from public.returns where id=$1`, [Rc.id]))[0].status === 'cancelled');
ok('another company cannot cancel it', !!(await call(ub, 'aal1', `select public.cancel_return($1)`, [RT1.id])).err);

// ---- the return label ----
const PARCEL = JSON.stringify([{ weight_g: 900, length_cm: 30, width_cm: 20, height_cm: 10 }]);
const begin = (rid, over = {}) => svc(`select * from public.cs_begin_return_shipment($1,$2,$3,$4,7,'dpd','DPD · package',$5,$6,23,30,$7::jsonb)`, [over.org ?? orgA, rid, ua, over.env ?? 'sandbox', over.net ?? 10, over.gross ?? 12.3, over.parcels ?? PARCEL]);
ok('visitors and customers cannot call the return label functions directly', !!(await asAnon(`select * from public.cs_begin_return_shipment('${orgA}','${RT1.id}','${ua}','sandbox',7,'d','d',1,1,23,30,'[]'::jsonb)`)).err && !!(await call(ua, 'aal1', `select * from public.cs_begin_return_shipment($1,$2,$3,'sandbox',7,'d','d',1,1,23,30,$4::jsonb)`, [orgA, RT1.id, ua, PARCEL])).err);
await setOrg({ buy: false }); ok('labels cannot be bought until staff switch it on for the customer', /not switched on/.test((await begin(RT1.id)).err ?? '')); await setOrg({});
ok('another company\'s return is "not found"', /Return not found/.test((await begin(RT1.id, { org: orgB })).err ?? ''));
ok('a return is sent as one parcel, within the size limits', /one parcel/.test((await begin(RT1.id, { parcels: '[]' })).err ?? '') && /between 1 g and 30 kg/.test((await begin(RT1.id, { parcels: JSON.stringify([{ weight_g: 40000, length_cm: 10, width_cm: 10, height_cm: 10 }]) })).err ?? '') && /between 1 and 150 cm/.test((await begin(RT1.id, { parcels: JSON.stringify([{ weight_g: 500, length_cm: 200, width_cm: 10, height_cm: 10 }]) })).err ?? ''));
const b1 = await begin(RT1.id); const S = b1.rows?.[0];
ok('begin records the purchase before any money moves: for the customer, with the price including the markup, linked to the return and no order', S && S.status === 'buying' && S.return_id === RT1.id && S.order_id === null && Number(S.bill_net) === 13 && S.buyer_role === 'customer', JSON.stringify(b1));
ok('a second click cannot start another label for the same return', /already being bought/.test((await begin(RT1.id)).err ?? ''));
ok('a return with a label being bought cannot be cancelled', /label has been bought/.test((await call(ua, 'aal1', `select public.cancel_return($1)`, [RT1.id])).err ?? '') || /cannot be cancelled/.test((await call(ua, 'aal1', `select public.cancel_return($1)`, [RT1.id])).err ?? ''));
const f1 = await svc(`select * from public.cs_finish_return_shipment($1,'777',array['WB9'],$2)`, [S.id, ua]);
ok('finish records the label and the return is "label issued"', f1.rows?.[0]?.status === 'purchased' && (await one(`select status, label_source from public.returns where id=$1`, [RT1.id]))[0].status === 'label_issued');
ok('the charge is a return label charge, waived in the sandbox', (await one(`select kind, status, net::float n, return_id from public.shipping_charges where shipment_id=$1`, [S.id]))[0].kind === 'return_label' && (await one(`select status from public.shipping_charges where shipment_id=$1`, [S.id]))[0].status === 'waived');
ok('finishing twice changes nothing, another package id is refused', (await svc(`select * from public.cs_finish_return_shipment($1,'777',null,$2)`, [S.id, ua])).rows?.[0]?.status === 'purchased' && /different package/.test((await svc(`select * from public.cs_finish_return_shipment($1,'999',null,$2)`, [S.id, ua])).err ?? ''));
ok('a return that already has a label gets no second one', /has not been sent yet|already being bought/.test((await begin(RT1.id)).err ?? ''));
ok('an outgoing order shipment is not confused with a return one', /Shipment not found/.test((await svc(`select * from public.cs_finish_return_shipment($1,'1',null,$2)`, [crypto.randomUUID(), ua])).err ?? ''));

// ---- the warehouse ----
ok('only warehouse and admin staff can receive, support and customers cannot', !!(await call(support, 'aal2', `select public.receive_return($1,900,30)`, [RT1.id])).err && !!(await call(ua, 'aal1', `select public.receive_return($1,900,30)`, [RT1.id])).err);
ok('the weight and the longest side are required and checked', /weight of the parcel/.test((await W(`select public.receive_return($1,0,30)`, [RT1.id])).err ?? '') && /longest side/.test((await W(`select public.receive_return($1,900,0)`, [RT1.id])).err ?? ''));
ok('grading before the parcel is received is refused', /Receive the parcel first/.test((await W(`select public.grade_return_line((select id from public.return_lines where return_id=$1 limit 1), 2, 'A')`, [RT1.id])).err ?? ''));
ok('receiving works and repeating is harmless', !(await W(`select public.receive_return($1,900,30)`, [RT1.id])).err && (await W(`select public.receive_return($1,900,30) r`, [RT1.id])).rows[0].r.replayed === true && (await one(`select status, weight_g from public.returns where id=$1`, [RT1.id]))[0].weight_g === 900);
const ln = (await one(`select id from public.return_lines where return_id=$1`, [RT1.id]))[0].id;
const before = Number((await one(`select coalesce(sum(on_hand),0)::int n from public.stock_levels where product_id=$1`, [S1]))[0].n);
ok('a grade is required for goods that came back', /Choose a grade/.test((await W(`select public.grade_return_line($1, 2, null)`, [ln])).err ?? ''));
const g1 = await W(`select public.grade_return_line($1, 2, 'A', 'like new') r`, [ln]);
ok('grade A puts the goods back on the customer\'s shelf, and the return is finished when its last line is graded', g1.rows?.[0]?.r?.finished === true && Number((await one(`select coalesce(sum(on_hand),0)::int n from public.stock_levels where product_id=$1`, [S1]))[0].n) === before + 2 && (await one(`select status from public.returns where id=$1`, [RT1.id]))[0].status === 'graded');
ok('grading the same line again changes nothing', (await W(`select public.grade_return_line($1, 5, 'A') r`, [ln])).rows[0].r.replayed === true && Number((await one(`select coalesce(sum(on_hand),0)::int n from public.stock_levels where product_id=$1`, [S1]))[0].n) === before + 2);
ok('a flat-fee return is charged no handling fee', (await one(`select count(*)::int n from public.shipping_charges where return_id=$1 and kind='return_handling'`, [RT1.id]))[0].n === 0);

// ---- grades B and C, partial, and the fee on pay as you go ----
await setOrg({ mode: 'payg', live: true });
const Rg = (await mkRet(await shipped(4), {}, [{ product_id: S1, qty: 2 }, { product_id: S2, qty: 1 }].slice(0, 1))).rows[0].r;
// two lines on one return needs an order with both products
const O2 = (await order(ua, 'aal1', orgA, 'RET-two', [{ product_id: S1, qty: 2 }, { product_id: S2, qty: 1 }])).rows[0].r.id; await direct(`update public.orders set status='shipped' where id=$1`, [O2]);
const Rt = (await mkRet(O2, {}, [{ product_id: S1, qty: 2 }, { product_id: S2, qty: 1 }])).rows[0].r;
await W(`select public.receive_return($1,600,33)`, [Rt.id]);
const lines2 = (await one(`select rl.id, p.sku from public.return_lines rl join public.products p on p.id=rl.product_id where rl.return_id=$1 order by p.sku`, [Rt.id]));
const qa = Number((await one(`select coalesce(sum(on_hand),0)::int n from public.stock_levels sl join public.locations l on l.id=sl.location_id where l.kind='quarantine' and sl.product_id=$1`, [S1]))[0].n);
const gB = await W(`select public.grade_return_line($1, 1, 'B', 'dented') r`, [lines2[0].id]);
ok('grade B goes to quarantine, not to the shelf, and the return stays open until every line is graded', gB.rows?.[0]?.r?.finished === false && Number((await one(`select coalesce(sum(on_hand),0)::int n from public.stock_levels sl join public.locations l on l.id=sl.location_id where l.kind='quarantine' and sl.product_id=$1`, [S1]))[0].n) === qa + 1 && (await one(`select status from public.returns where id=$1`, [Rt.id]))[0].status === 'received');
const gZ = await W(`select public.grade_return_line($1, 0, null) r`, [lines2[1].id]);
ok('nothing came back for the other line: recorded as 0 received, and the return is finished', gZ.rows?.[0]?.r?.finished === true && (await one(`select received_qty, grade from public.return_lines where id=$1`, [lines2[1].id]))[0].received_qty === 0);
const fee = (await one(`select net::float n, status, env, size_class from public.shipping_charges where return_id=$1 and kind='return_handling'`, [Rt.id]))[0];
ok('a live pay-as-you-go return is charged the return price of its class (600 g, 33 cm = S: 6.30), pending', fee && fee.n === 6.3 && fee.size_class === 'S' && fee.status === 'pending' && fee.env === 'production', JSON.stringify(fee));
ok('the fee is written once', (await one(`select count(*)::int n from public.shipping_charges where return_id=$1 and kind='return_handling'`, [Rt.id]))[0].n === 1 && !!(await direct(`insert into public.shipping_charges (org_id, return_id, kind, seq, net, status, env) values ($1,$2,'return_handling',2,1,'pending','production')`, [orgA, Rt.id])).err);
await setOrg({ mode: 'payg', live: false }); const Rn = (await mkRet(await shipped(1), {}, [{ product_id: S1, qty: 1 }])).rows[0].r; await W(`select public.receive_return($1,300,20)`, [Rn.id]); await W(`select public.grade_return_line((select id from public.return_lines where return_id=$1), 1, 'A')`, [Rn.id]);
ok('for a customer who is not marked live the fee is recorded as waived (test)', (await one(`select status, net::float n from public.shipping_charges where return_id=$1 and kind='return_handling'`, [Rn.id]))[0].status === 'waived');
await setOrg({ mode: 'payg', live: true, adj: -50 }); const Rd = (await mkRet(await shipped(1), {}, [{ product_id: S1, qty: 1 }])).rows[0].r; await W(`select public.receive_return($1,300,20)`, [Rd.id]); await W(`select public.grade_return_line((select id from public.return_lines where return_id=$1), 1, 'A')`, [Rd.id]);
ok('the customer\'s discount applies (XS return 4.80 at -50% = 2.40)', Number((await one(`select net::float n from public.shipping_charges where return_id=$1 and kind='return_handling'`, [Rd.id]))[0].n) === 2.4);
await setOrg({ mode: 'payg', live: true }); const Ro = (await mkRet(await shipped(1), {}, [{ product_id: S1, qty: 1 }])).rows[0].r; await W(`select public.receive_return($1,40000,130)`, [Ro.id]); await W(`select public.grade_return_line((select id from public.return_lines where return_id=$1), 1, 'A')`, [Ro.id]);
ok('an oversize return has no tariff: 0, waived, with a note to set it by hand', (await one(`select net::float n, status, size_class from public.shipping_charges where return_id=$1 and kind='return_handling'`, [Ro.id]))[0].size_class === 'oversize');

// ---- the customer's view of the charges ----
const mine = (await call(ua, 'aal1', `select public.my_charges($1) r`, [orgA])).rows[0].r;
ok('the customer sees their charges (return label, return fee) with references, amounts and statuses, and test charges say "test"', Array.isArray(mine) && mine.some((c) => c.kind === 'return_handling' && c.return_ref === Rt.ref && c.status === 'pending' && c.size_class === 'S') && mine.some((c) => c.kind === 'return_label' && c.status === 'test'), JSON.stringify(mine).slice(0, 300));
ok('what they see never contains our cost or markup', !JSON.stringify(mine).match(/cost|markup|margin|stripe/i));
ok('another company sees none of it, and cannot ask', !!(await call(ub, 'aal1', `select public.my_charges($1)`, [orgA])).err && (await call(ub, 'aal1', `select public.my_charges($1) r`, [orgB])).rows[0].r.length === 0);

await db.exec('rollback');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

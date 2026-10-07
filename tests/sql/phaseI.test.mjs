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

// =============== Pay-as-you-go fulfilment: the handling fee ===============
const svc = async (q, p = []) => { await db.exec('savepoint s'); try { await db.exec('set local role service_role'); const r = await db.query(q, p); await db.exec('reset role'); await db.exec('release savepoint s'); return { rows: r.rows }; } catch (e) { await db.exec('rollback to savepoint s'); await db.exec('reset role'); return { err: e.message }; } };
const direct = async (q, p = []) => { await db.exec('savepoint d'); try { const r = await db.query(q, p); await db.exec('release savepoint d'); return { rows: r.rows }; } catch (e) { await db.exec('rollback to savepoint d'); return { err: e.message }; } };
const setOrg = (o) => direct(`insert into public.org_shipping_settings (org_id, fulfil_mode_override, usage_billing_live, handling_adjust_percent) values ($1,$2,$3,$4)
  on conflict (org_id) do update set fulfil_mode_override=$2, usage_billing_live=$3, handling_adjust_percent=$4`, [orgA, o.mode ?? 'payg', o.live ?? false, o.adj ?? 0]);
await stock(orgA, S1, 80, B1);
await setOrg({});
const mkOrd = async (ext) => (await order(ua, 'aal1', orgA, ext, [{ product_id: S1, qty: 1 }])).rows[0].r;
// pack with the given parcels [weight g, length, width, height], give it a label, ship it as staff
const shipIt = async (oid, parcels) => {
  await direct(`update public.orders set status='picking' where id=$1`, [oid]);
  for (const [i, p] of parcels.entries()) await direct(`insert into public.parcels (order_id, org_id, seq, weight_g, length_cm, width_cm, height_cm) values ($1,$2,$3,$4,$5,$6,$7)`, [oid, orgA, i + 1, p[0], p[1], p[2], p[3]]);
  await direct(`update public.orders set status='packed' where id=$1`, [oid]);
  const at = await svc(`select public.attach_own_label($1,$2,null,null,null,array['TRK12345'],'InPost',$3)`, [orgA, oid, ua]);
  return W(`select public.ship_order($1) r`, [oid]);
};
const fee = async (oid) => (await one(`select kind, net, status, env, size_class, note from public.shipping_charges where order_id=$1 and kind='handling'`, [oid]))[0];

// ---- the tariff ----
const tariff = (await asAnon(`select public.handling_tariff() t`)).rows?.[0]?.t;
ok('the tariff is public (it is shown when choosing a plan) and lists five classes with a fee per extra parcel', tariff?.tiers?.length === 5 && tariff.tiers[0].size_class === 'XS' && Number(tariff.tiers[0].handling_net) === 3.2 && Number(tariff.extra_parcel) === 0.6, JSON.stringify(tariff));
ok('customers and visitors cannot read the tariff tables directly, staff can', (await asAnon(`select count(*)::int n from public.handling_tiers`)).err !== undefined || (await asAnon(`select count(*)::int n from public.handling_tiers`)).rows[0].n === 0);
ok('staff can read the tariff table, a customer sees none of it', (await W(`select count(*)::int n from public.handling_tiers`)).rows[0].n === 5 && (await call(ua, 'aal1', `select count(*)::int n from public.handling_tiers`)).rows[0].n === 0);
const T5 = JSON.stringify([{ size_class: 'S', max_weight_g: 1000, max_side_cm: 40, handling_net: 4, return_net: 6 }, { size_class: 'M', max_weight_g: 5000, max_side_cm: 60, handling_net: 6, return_net: 9 }]);
ok('only an admin can change the tariff', !!(await W(`select public.set_handling_tiers($1::jsonb)`, [T5])).err && !!(await call(support, 'aal2', `select public.set_handling_tiers($1::jsonb)`, [T5])).err && !!(await call(ua, 'aal1', `select public.set_handling_tiers($1::jsonb)`, [T5])).err);
for (const [name, bad, re] of [['no classes', '[]', /1 to 12/], ['weights that do not grow', JSON.stringify([{ size_class: 'A', max_weight_g: 1000, max_side_cm: 40, handling_net: 4, return_net: 6 }, { size_class: 'B', max_weight_g: 900, max_side_cm: 60, handling_net: 6, return_net: 9 }]), /more weight/], ['a negative price', JSON.stringify([{ size_class: 'A', max_weight_g: 1000, max_side_cm: 40, handling_net: -1, return_net: 6 }]), /two prices/], ['no name', JSON.stringify([{ size_class: '', max_weight_g: 1000, max_side_cm: 40, handling_net: 4, return_net: 6 }]), /short name/]]) ok('the tariff is refused: ' + name, re.test((await call(admin, 'aal2', `select public.set_handling_tiers($1::jsonb)`, [bad])).err ?? ''));
ok('an unknown extra rate is refused', /Unknown rate/.test((await call(admin, 'aal2', `select public.set_handling_tiers($1::jsonb, '{"nope":1}'::jsonb)`, [T5])).err ?? ''));
ok('the tariff has not changed after refusals', (await W(`select count(*)::int n from public.handling_tiers`)).rows[0].n === 5);

// ---- the fee when an order ships ----
const sizes = [['XS: 400 g, 30 cm', [[400, 30, 20, 10]], 'XS', 3.2], ['S: 600 g (just over XS)', [[600, 30, 20, 10]], 'S', 4.2], ['S: light but 36 cm long (the longest side counts)', [[300, 36, 10, 10]], 'S', 4.2], ['exactly the XS limit stays XS', [[500, 35, 20, 10]], 'XS', 3.2],
  ['M: 2 kg, 50 cm', [[2000, 50, 30, 20]], 'M', 5.9], ['L: 8 kg', [[8000, 70, 40, 30]], 'L', 8.5], ['XL: 25 kg, 110 cm', [[25000, 110, 50, 40]], 'XL', 12.9]];
for (const [name, parcels, cls, net] of sizes) { const o = await mkOrd('H-' + name); await shipIt(o.id, parcels); const f = await fee(o.id); ok('handling fee, ' + name, f && f.size_class === cls && Number(f.net) === net, JSON.stringify(f)); }
{ const o = await mkOrd('H-two'); await shipIt(o.id, [[400, 30, 20, 10], [600, 30, 20, 10]]); const f = await fee(o.id); ok('two parcels: the dearest class once (S 4.20) plus 0.60 for the extra parcel', Number(f.net) === 4.8 && f.size_class === 'S' && /2 parcel/.test(f.note), JSON.stringify(f)); }
{ const o = await mkOrd('H-big'); await shipIt(o.id, [[35000, 130, 60, 50]]); const f = await fee(o.id); ok('a parcel bigger than the biggest class has no tariff: 0, "oversize", waived, with a note to set it by hand', f && f.size_class === 'oversize' && Number(f.net) === 0 && f.status === 'waived' && /by hand/.test(f.note), JSON.stringify(f)); }
{ const o = await mkOrd('H-test'); await shipIt(o.id, [[400, 30, 20, 10]]); const f = await fee(o.id); ok('for a customer not marked live the fee is recorded as waived (test), never billed', f.status === 'waived' && f.env === 'sandbox'); }
await setOrg({ live: true });
{ const o = await mkOrd('H-live'); await shipIt(o.id, [[400, 30, 20, 10]]); const f = await fee(o.id); ok('for a live customer the fee is pending, to be invoiced', f.status === 'pending' && f.env === 'production' && Number(f.net) === 3.2, JSON.stringify(f)); }
await setOrg({ live: true, adj: -10 });
{ const o = await mkOrd('H-disc'); await shipIt(o.id, [[400, 30, 20, 10]]); ok('a customer discount applies to the tariff (-10%: 3.20 becomes 2.88)', Number((await fee(o.id)).net) === 2.88); }
await setOrg({ live: true, adj: 25 });
{ const o = await mkOrd('H-sur'); await shipIt(o.id, [[400, 30, 20, 10]]); ok('a surcharge applies too (+25%: 3.20 becomes 4.00)', Number((await fee(o.id)).net) === 4); }
await setOrg({ mode: 'full', live: true });
{ const o = await mkOrd('H-flat'); await shipIt(o.id, [[400, 30, 20, 10]]); ok('an order of a flat-fee plan (Fulfilment) is charged no handling fee', (await fee(o.id)) === undefined && (await one(`select fulfil_mode from public.orders where id=$1`, [o.id]))[0].fulfil_mode === 'full'); }
await setOrg({ mode: 'payg', live: true });
{ const o = await mkOrd('H-once'); await shipIt(o.id, [[400, 30, 20, 10]]); await W(`select public.ship_order($1)`, [o.id]); await direct(`select public.wms_write_handling('${o.id}')`);
  ok('the fee is written once, however many times shipping is repeated', (await one(`select count(*)::int n from public.shipping_charges where order_id=$1 and kind='handling'`, [o.id]))[0].n === 1);
  ok('a second row for the same order is refused by the database', !!(await direct(`insert into public.shipping_charges (org_id, order_id, kind, seq, net, status, env) values ($1,$2,'handling',2,1,'pending','production')`, [orgA, o.id])).err); }
{ const o = await mkOrd('H-moved'); await setOrg({ mode: 'full', live: true }); await shipIt(o.id, [[400, 30, 20, 10]]); ok('the mode stamped when the order was placed decides, not the plan at shipping time', (await fee(o.id))?.size_class === 'XS'); await setOrg({ mode: 'payg', live: true }); }
ok('customers cannot read the charge ledger, staff can', (await call(ua, 'aal1', `select count(*)::int n from public.shipping_charges`)).rows[0].n === 0 && (await W(`select count(*)::int n from public.shipping_charges where kind='handling'`)).rows[0].n > 5);
ok('nobody can call the fee writer directly', !!(await call(ua, 'aal1', `select public.wms_write_handling($1)`, [orgA])).err && !!(await asAnon(`select public.wms_write_handling('${orgA}')`)).err && !!(await call(admin, 'aal2', `select public.wms_write_handling($1)`, [orgA])).err);

// ---- per-customer settings ----
ok('admins can set the cap and the discount per customer, and mark a customer live', !!(await call(admin, 'aal2', `select public.set_org_shipping($1,'{"handling_cap_per_m2":300,"return_cap_per_m2":120,"handling_adjust_percent":-5,"usage_billing_live":true}'::jsonb)`, [orgA])).rows
  && (await one(`select handling_cap_per_m2 h, return_cap_per_m2 r, handling_adjust_percent a, usage_billing_live l from public.org_shipping_settings where org_id=$1`, [orgA]))[0].h == 300);
ok('out-of-range values are refused', !!(await call(admin, 'aal2', `select public.set_org_shipping($1,'{"handling_cap_per_m2":99999}'::jsonb)`, [orgA])).err && !!(await call(admin, 'aal2', `select public.set_org_shipping($1,'{"handling_adjust_percent":-150}'::jsonb)`, [orgA])).err && !!(await call(admin, 'aal2', `select public.set_org_shipping($1,'{"made_up":1}'::jsonb)`, [orgA])).err);
ok('support cannot change them', !!(await call(support, 'aal2', `select public.set_org_shipping($1,'{"usage_billing_live":true}'::jsonb)`, [orgA])).err);
// ---- a new tariff is used by the next order ----
ok('an admin replaces the tariff', !!(await call(admin, 'aal2', `select public.set_handling_tiers($1::jsonb, '{"handling_extra_parcel":1}'::jsonb)`, [T5])).rows && (await W(`select count(*)::int n from public.handling_tiers`)).rows[0].n === 2);
await setOrg({ live: true });
{ const o = await mkOrd('H-newtariff'); await shipIt(o.id, [[400, 30, 20, 10], [900, 30, 20, 10]]); const f = await fee(o.id); ok('the next order uses the new tariff and extra-parcel fee (S 4.00 + 1.00)', Number(f.net) === 5 && f.size_class === 'S', JSON.stringify(f)); }
ok('the change is in the audit log', (await one(`select count(*)::int n from public.audit_log where action='billing.tariff'`))[0].n >= 1);

await db.exec('rollback');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

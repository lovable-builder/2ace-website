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


let planTick = 0;   // each plan gets its own moment, as in real life
const plan = (org, config) => db.query(`insert into public.plans (org_id, config, monthly_pln, once_pln, status, created_at) values ($1,$2::jsonb,1000,0,'active', now() + ($3 || ' seconds')::interval)`, [org, JSON.stringify(config), String(++planTick)]);
const packQty = async () => Number((await one(`select coalesce(sum(on_hand),0)::int n from public.stock_levels where location_id=$1`, [PK]))[0].n);
const uuid = () => crypto.randomUUID();
const pdf = (org, ord) => `${org}/${ord}/${uuid()}.pdf`;
const upload = (u, aal, path) => call(u, aal, `insert into storage.objects (bucket_id, name, owner) values ('labels', $1, $2)`, [path, u]);
const putFile = (path) => db.query(`insert into storage.objects (bucket_id, name) values ('labels', $1)`, [path]);   // as the service would, bypassing the policy
const svc = async (q, p = []) => { await db.exec('savepoint sv'); try { await db.exec('set local role service_role'); const r = await db.query(q, p); await db.exec('reset role'); await db.exec('release savepoint sv'); return { rows: r.rows }; } catch (e) { await db.exec('rollback to savepoint sv'); await db.exec('reset role'); return { err: e.message }; } };
const attach = (org, ord, path, name, size, tr, carrier, actor = ua) => svc('select public.attach_own_label($1,$2,$3,$4,$5,$6::text[],$7,$8) r', [org, ord, path, name, size, tr, carrier, actor]);
await plan(orgA, { m2: 10, pkgs: { payg: true } });
await stock(orgA, S1, 40, B1); await stock(orgA, S2, 20, B2);
const oA = (await order(ua, 'aal1', orgA, 'L-1', [{ product_id: S1, qty: 2 }])).rows[0].r.id;
const oB = (await order(ub, 'aal1', orgB, 'LB-1', [])).rows?.[0]?.r?.id;

// ---- the bucket ----
const p1 = pdf(orgA, oA);
ok('the customer can upload a PDF into their own order\'s folder', !(await upload(ua, 'aal1', p1)).err);
ok('not into another customer\'s folder', !!(await upload(ub, 'aal1', pdf(orgA, oA))).err);
ok('not under an order that is not theirs', !!(await upload(ua, 'aal1', pdf(orgA, uuid()))).err);
ok('only .pdf names are accepted, nothing else', !!(await upload(ua, 'aal1', `${orgA}/${oA}/${uuid()}.png`)).err && !!(await upload(ua, 'aal1', `${orgA}/${oA}/label.pdf`)).err);
ok('anonymous cannot upload', !!(await asAnon(`insert into storage.objects (bucket_id, name) values ('labels','${pdf(orgA, oA)}')`)).err);
ok('the customer and staff can read it, another customer cannot', (await as(ua, 'aal1', `select name from storage.objects where bucket_id='labels'`)).rows.length === 1 && (await as(support, 'aal2', `select name from storage.objects where bucket_id='labels'`)).rows.length === 1 && (await as(ub, 'aal1', `select name from storage.objects where bucket_id='labels'`)).rows.length === 0);
ok('the bucket is private, PDF only, 2 MB', (await one(`select public, file_size_limit, allowed_mime_types from storage.buckets where id='labels'`))[0].public === false && Number((await one(`select file_size_limit from storage.buckets where id='labels'`))[0].file_size_limit) === 2097152 && (await one(`select allowed_mime_types from storage.buckets where id='labels'`))[0].allowed_mime_types.join() === 'application/pdf');
// ---- attaching ----
ok('nobody but the service can attach a label: not customers, not staff', !!(await call(ua, 'aal1', 'select public.attach_own_label($1,$2,$3,$4,$5,$6::text[],$7,$8)', [orgA, oA, p1, 'l.pdf', 1000, [], null, ua])).err && !!(await call(admin, 'aal2', 'select public.attach_own_label($1,$2,$3,$4,$5,$6::text[],$7,$8)', [orgA, oA, p1, 'l.pdf', 1000, [], null, admin])).err);
ok('a label for an order of another customer is refused', /Order not found/.test((await attach(orgB, oA, p1, 'l.pdf', 1000, [], null)).err || ''));
ok('a path that does not belong to this order is refused', /Invalid label file/.test((await attach(orgA, oA, pdf(orgA, uuid()), 'l.pdf', 1000, [], null)).err || ''));
ok('a file that was never uploaded is refused', /was not uploaded/.test((await attach(orgA, oA, `${orgA}/${oA}/${uuid()}.pdf`, 'l.pdf', 1000, [], null)).err || ''));
ok('neither a file nor a tracking number is refused', /file, or at least a tracking number/.test((await attach(orgA, oA, null, null, null, [], null)).err || ''));
ok('a bad tracking number is refused', /tracking number looks wrong/.test((await attach(orgA, oA, null, null, null, ['x'], null)).err || '') && /tracking number looks wrong/.test((await attach(orgA, oA, null, null, null, ['bad;drop'], null)).err || ''));
ok('too many tracking numbers is refused', /At most 5/.test((await attach(orgA, oA, null, null, null, ['AAA111', 'AAA112', 'AAA113', 'AAA114', 'AAA115', 'AAA116'], null)).err || ''));
ok('a file size of zero or above 2 MB is refused', !!(await attach(orgA, oA, p1, 'l.pdf', 0, [], null)).err && !!(await attach(orgA, oA, p1, 'l.pdf', 3000000, [], null)).err);
const a1 = await attach(orgA, oA, p1, 'Allegro label.pdf', 48211, [' 6200 1234 ', 'JJD0001'], ' InPost ');
ok('the service attaches the label with file, tracking and carrier', !a1.err && !!a1.rows[0].r.id, JSON.stringify(a1));
const L1 = (await one('select * from public.own_labels where order_id=$1 and voided_at is null', [oA]))[0];
ok('it is stored cleaned up and the order knows its label source', L1.filename === 'Allegro label.pdf' && L1.tracking_numbers.join('|') === '6200 1234|JJD0001' && L1.carrier_name === 'InPost' && (await one('select label_source from public.orders where id=$1', [oA]))[0].label_source === 'own');
const p2 = pdf(orgA, oA); await putFile(p2);
const a2 = await attach(orgA, oA, p2, 'new.pdf', 1000, ['NEW12345'], null);
ok('a second label replaces the first, which is voided and its file path handed back for deletion', !a2.err && a2.rows[0].r.replaced_path === p1 && (await one('select count(*)::int n from public.own_labels where order_id=$1 and voided_at is null', [oA]))[0].n === 1 && (await one('select count(*)::int n from public.own_labels where order_id=$1', [oA]))[0].n === 2);
ok('tracking numbers alone are enough', !(await attach(orgA, oA, null, null, null, ['ONLY1234'], 'DPD')).err);
ok('the customer sees their own label, another customer does not', (await as(ua, 'aal1', 'select id from public.own_labels')).rows.length === 3 && (await as(ub, 'aal1', 'select id from public.own_labels')).rows.length === 0 && (await as(support, 'aal2', 'select id from public.own_labels')).rows.length === 3);
ok('nobody writes labels directly', !!(await call(ua, 'aal1', `delete from public.own_labels`)).err && !!(await call(admin, 'aal2', `update public.own_labels set voided_at = null`)).err);
// ---- the plan decides ----
await plan(orgA, { m2: 10, pkgs: { ret: true } });
ok('a customer whose plan has no fulfilment cannot attach labels', /does not include fulfilment/.test((await attach(orgA, oA, null, null, null, ['TRACK123'], null)).err || ''));
await plan(orgA, { m2: 10, pkgs: { ful: true } });
ok('on full fulfilment they can too (per order choice)', !(await attach(orgA, oA, null, null, null, ['TRACK124'], null)).err);
// ---- removing ----
ok('only the service can remove a label', !!(await call(ua, 'aal1', 'select public.remove_own_label($1,$2,$3)', [orgA, oA, ua])).err);
ok('removing voids it and clears the order\'s label source', !(await svc('select public.remove_own_label($1,$2,$3) r', [orgA, oA, ua])).err && (await one('select label_source from public.orders where id=$1', [oA]))[0].label_source === null && (await one('select count(*)::int n from public.own_labels where order_id=$1 and voided_at is null', [oA]))[0].n === 0);
ok('removing when there is none is harmless', (await svc('select public.remove_own_label($1,$2,$3) r', [orgA, oA, ua])).rows?.[0]?.r === null);
// ---- a 2ACE label excludes an own label, and the other way round is checked at purchase time ----
await attach(orgA, oA, null, null, null, ['TRACK200'], null);
// ---- ship_order ----
const pack = async (id) => { for (const a of await one('select id from public.allocations where order_id=$1', [id])) await W('select public.pick_line($1,$2)', [a.id, 'k-' + a.id]); return W('select public.pack_order($1,$2::jsonb)', [id, JSON.stringify([{ weight_g: 900, length_cm: 20, width_cm: 15, height_cm: 10 }])]); };
const sh = (u, aal, id) => call(u, aal, 'select public.ship_order($1) r', [id]);
ok('an order cannot be shipped before it is packed', /Only a packed order can be shipped/.test((await sh(wh, 'aal1', oA)).err || ''));
await pack(oA);
ok('customers and support cannot ship an order', !!(await sh(ua, 'aal1', oA)).err && !!(await sh(support, 'aal2', oA)).err);
ok('anonymous cannot', !!(await asAnon(`select public.ship_order('${oA}')`)).err);
const before = await packQty();
const s1 = await sh(wh, 'aal1', oA);
ok('warehouse ships a packed order that has the customer\'s own label', !s1.err && s1.rows[0].r.label === 'own' && s1.rows[0].r.replayed === false, JSON.stringify(s1));
ok('the order is shipped and its goods left the books', (await one('select status, shipped_at is not null as d from public.orders where id=$1', [oA]))[0].status === 'shipped' && await packQty() === before - 2 && (await one(`select count(*)::int n from public.stock_movements where reason='ship' and ref_id=$1`, [oA]))[0].n === 1 && (await allocOf(oA)).every((x) => x.status === 'shipped'));
ok('shipping twice changes nothing', (await sh(wh, 'aal1', oA)).rows?.[0]?.r?.replayed === true && (await one(`select count(*)::int n from public.stock_movements where reason='ship' and ref_id=$1`, [oA]))[0].n === 1);
ok('a shipped order cannot get a label any more', /so a label can no longer be added/.test((await attach(orgA, oA, null, null, null, ['LATE1234'], null)).err || '') && /can no longer be removed/.test((await svc('select public.remove_own_label($1,$2,$3)', [orgA, oA, ua])).err || ''));
ok('and no more files can be uploaded for it', !!(await upload(ua, 'aal1', pdf(orgA, oA))).err);
// no label, no shipping
const oC = (await order(ua, 'aal1', orgA, 'L-2', [{ product_id: S2, qty: 1 }])).rows[0].r.id; await pack(oC);
ok('a packed order with no label cannot be shipped, with a clear instruction', /no label yet/.test((await sh(wh, 'aal1', oC)).err || ''));
await attach(orgA, oC, null, null, null, ['OWN123456'], 'DPD');
ok('staff cannot buy a label for an order whose customer brought their own', /provided their own label/.test((await begin(wh, 'aal1', oC)).err || '') && (await one(`select count(*)::int n from public.shipments where order_id=$1`, [oC]))[0].n === 0);
await svc('select public.remove_own_label($1,$2,$3)', [orgA, oC, ua]);
// the staff buying flow still works and is unaffected
await db.exec(`update public.wms_settings set value='off'`);
await begin(wh, 'aal1', oC, { env: 'production', net: 10, gross: 12.3, markup: 30 });
const shp = (await one(`select id from public.shipments where order_id=$1 and status='buying'`, [oC]))[0];
ok('while a label is being bought the order cannot be shipped', /still being bought/.test((await sh(wh, 'aal1', oC)).err || ''));
await W('select public.finish_shipment($1,$2,$3)', [shp.id, '71000', ['TT1']]);
ok('finish_shipment still ships the order exactly as before', (await one('select status from public.orders where id=$1', [oC]))[0].status === 'shipped' && (await one(`select count(*)::int n from public.stock_movements where reason='ship' and ref_id=$1`, [oC]))[0].n === 1);
ok('ledger and stock levels still agree everywhere', (await one(`select count(*)::int n from (select org_id, product_id, location_id, lot, sum(qty) q from public.stock_movements group by 1,2,3,4) m full join public.stock_levels s using (org_id,product_id,location_id,lot) where coalesce(m.q,0) <> coalesce(s.on_hand,0)`))[0].n === 0 && (await one('select count(*)::int n from public.stock_levels where reserved > on_hand or reserved < 0'))[0].n === 0);
ok('own-label events are audited', (await one(`select count(*)::int n from public.audit_log where action in ('order.own_label','order.own_label_removed','order.ship')`))[0].n >= 5);
await db.exec('rollback');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

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
const lines = (a) => JSON.stringify(a);
const ship = { name: 'Jan Nowak', line1: 'Prosta 1', postal: '00-001', city: 'Warszawa', country: 'PL', email: 'jan@example.pl', phone: '+48600100200' };
const pr = async (u, org, sku, name) => (await call(u, 'aal1', 'select public.create_product($1,$2,$3) id', [org, sku, name])).rows?.[0]?.id;
const locs = async () => await one('select code, kind, active from public.locations order by code');
const assigned = async (org) => await one(`select l.code, l.kind from public.locations l join public.location_assignments a on a.location_id = l.id and a.released_at is null where a.org_id = $1 order by l.code`, [org]);
const stockOf = async (org, prod) => Number((await one('select coalesce(sum(on_hand),0)::int n from public.stock_levels sl join public.locations l on l.id = sl.location_id where org_id=$1 and product_id=$2 and l.kind in (\'bin\',\'pallet\')', [org, prod]))[0].n);
const book = async (org, prod, qty) => (await call(org === orgB ? ub : ua, 'aal1', `select public.book_inbound($1,'DHL',null,null,null,$2::jsonb) id`, [org, lines([{ product_id: prod, qty }])])).rows[0].id;

ok('setup: a brand new warehouse has NO locations at all', (await locs()).length === 0);
ok('and no customer has a bin', (await assigned(orgA)).length === 0);
ok('the setting defaults to on', (await one(`select public.wms_setting('auto_putaway') v`))[0].v === 'on');
const S1 = await pr(ua, orgA, 'MUG-BLUE', 'Blue mug'), S2 = await pr(ua, orgA, 'MUG-RED', 'Red mug'), SB = await pr(ub, orgB, 'B-ONE', 'B product');

// ---- receiving: goods are available straight away ----
const bk = await book(orgA, S1, 10);
const rc = await W(`select public.receive_line($1,$2,$3,'good','',null,null,'rcv-1') r`, [bk, S1, 10]);
ok('receiving good goods works with nothing set up beforehand', !rc.err && rc.rows?.[0]?.r?.condition === 'good', JSON.stringify(rc));
const bin = (await assigned(orgA))[0];
ok('the customer got their own bin automatically, named after them, assigned to them', bin && bin.kind === 'bin' && /^ORGA-01$|^[A-Z0-9]+-01$/.test(bin.code), JSON.stringify(bin));
ok('the answer says where the goods went', rc.rows[0].r.location === bin.code);
ok('the goods are available immediately: no put-away needed', await stockOf(orgA, S1) === 10 && (await one(`select coalesce(sum(on_hand),0)::int n from public.stock_levels sl join public.locations l on l.id=sl.location_id where l.kind='receiving'`))[0].n === 0);
ok('a second delivery reuses the same bin, no second bin appears', (await W(`select public.receive_line($1,$2,$3,'good','',null,null,'rcv-2') r`, [await book(orgA, S1, 5), S1, 5])).rows?.[0]?.r?.location === bin.code && (await assigned(orgA)).length === 1 && await stockOf(orgA, S1) === 15);
ok('another customer gets a different bin, never the same one', (await (async () => { const b2 = await book2(); return b2; })()) === true);
async function book2() {
  const bkB = (await call(ub, 'aal1', `select public.book_inbound($1,'DHL',null,null,null,$2::jsonb) id`, [orgB, lines([{ product_id: SB, qty: 3 }])])).rows[0].id;
  const r = await W(`select public.receive_line($1,$2,$3,'good','',null,null,'rcv-b') r`, [bkB, SB, 3]); const bb = (await assigned(orgB))[0];
  return !r.err && bb && bb.code !== bin.code && (await assigned(orgA)).length === 1;
}
// ---- damaged and unexpected goods still need a person ----
const bk3 = await book(orgA, S2, 4);
const dm = await W(`select public.receive_line($1,$2,$3,'damaged','',null,null,'rcv-d') r`, [bk3, S2, 2]);
ok('damaged goods go to quarantine, which is created automatically', !dm.err && dm.rows[0].r.location === 'QUARANTINE' && (await locs()).some((l) => l.code === 'QUARANTINE' && l.kind === 'quarantine'), JSON.stringify(dm));
ok('damaged goods are not available', await stockOf(orgA, S2) === 0);
const un = await W(`select public.receive_line($1,$2,$3,'good','',null,null,'rcv-u') r`, [bk3, SB, 1]);
ok('a product that is not this customer\'s is still refused', !!un.err);
// unexpected: a product of this customer that is not on the booking
const S3 = await pr(ua, orgA, 'MUG-GREEN', 'Green mug');
const ux = await W(`select public.receive_line($1,$2,$3,'good','',null,null,'rcv-x') r`, [bk3, S3, 2]);
ok('goods that were not on the delivery wait in the receiving area, created automatically', !ux.err && ux.rows[0].r.condition === 'unexpected' && ux.rows[0].r.location === 'RECEIVING' && await stockOf(orgA, S3) === 0);
// ---- an existing bin of the customer is preferred ----
const own = (await W('select public.create_location($1,$2) id', ['A-77', 'bin'])).rows[0].id; await W('select public.assign_location($1,$2)', [own, orgB]);
const bkB2 = (await call(ub, 'aal1', `select public.book_inbound($1,'DHL',null,null,null,$2::jsonb) id`, [orgB, lines([{ product_id: SB, qty: 2 }])])).rows[0].id;
ok('a bin assigned by hand is used before inventing one', (await W(`select public.receive_line($1,$2,$3,'good','',null,null,'rcv-b2') r`, [bkB2, SB, 2])).rows?.[0]?.r?.location === (await assigned(orgB)).map((x) => x.code).sort()[0]);
// ---- held orders fill themselves when goods arrive ----
const o1 = await call(ua, 'aal1', `select public.create_order($1,$2,$3::jsonb,null,$4::jsonb) r`, [orgA, 'H-1', JSON.stringify(ship), lines([{ product_id: S3, qty: 4 }])]);
ok('an order for goods that are not on the shelf is held', o1.rows?.[0]?.r?.status === 'held', JSON.stringify(o1.rows));
const bk4 = await book(orgA, S3, 6);
await W(`select public.receive_line($1,$2,$3,'good','',null,null,'rcv-s3') r`, [bk4, S3, 6]);
ok('receiving the goods reserves the waiting order by itself', (await one('select status from public.orders where id=$1', [o1.rows[0].r.id]))[0].status === 'allocated');
// ---- add stock in one step ----
const S4 = await pr(ua, orgA, 'MUG-GOLD', 'Gold mug');
ok('customers cannot add stock', !!(await call(ua, 'aal1', 'select public.add_stock($1,$2,$3)', [orgA, S4, 5])).err);
ok('support cannot add stock', !!(await call(support, 'aal2', 'select public.add_stock($1,$2,$3)', [orgA, S4, 5])).err);
ok('anonymous cannot', !!(await asAnon(`select public.add_stock('${orgA}','${S4}',5)`)).err);
for (const [label, q, re] of [['zero units', 0, /between 1 and 1,000,000/], ['a negative number', -3, /between 1 and 1,000,000/], ['too many', 1000001, /between 1 and 1,000,000/]]) ok('add stock refuses ' + label, re.test((await W('select public.add_stock($1,$2,$3)', [orgA, S4, q])).err || ''));
ok('add stock refuses a product of another customer', /not found for this customer/.test((await W('select public.add_stock($1,$2,$3)', [orgA, SB, 5])).err || ''));
const ad = await W(`select public.add_stock($1,$2,$3,'Opening stock','add-1') r`, [orgA, S4, 25]);
ok('warehouse adds stock in one step', !ad.err && ad.rows[0].r.qty === 25 && ad.rows[0].r.location === bin.code, JSON.stringify(ad));
ok('it is available at once', await stockOf(orgA, S4) === 25);
ok('it is in the ledger as an adjustment with the note', (await one(`select reason, note, qty from public.stock_movements where product_id=$1`, [S4]))[0].reason === 'adjust' && /Opening stock/.test((await one(`select note from public.stock_movements where product_id=$1`, [S4]))[0].note));
ok('a repeated click with the same key adds nothing more', !(await W(`select public.add_stock($1,$2,$3,'Opening stock','add-1')`, [orgA, S4, 25])).err && await stockOf(orgA, S4) === 25);
ok('add stock works without a note and says so in the ledger', !(await W('select public.add_stock($1,$2,$3)', [orgA, S4, 1])).err && (await one(`select count(*)::int n from public.stock_movements where product_id=$1 and note='Stock added by hand'`, [S4]))[0].n === 1);
ok('a switched-off product cannot receive stock', !(await W(`select public.update_product($1,'{"active":false}'::jsonb)`, [S4])).err && /switched off/.test((await W('select public.add_stock($1,$2,$3)', [orgA, S4, 1])).err || ''));
// ---- the whole journey, no manual setup: order, pick, pack ----
const S5 = await pr(ua, orgA, 'MUG-PINK', 'Pink mug'); await W('select public.add_stock($1,$2,$3)', [orgA, S5, 8]);
const o2 = await call(ua, 'aal1', `select public.create_order($1,$2,$3::jsonb,null,$4::jsonb) r`, [orgA, 'J-1', JSON.stringify(ship), lines([{ product_id: S5, qty: 3 }])]);
ok('an order is reserved from stock that was added in one step', o2.rows?.[0]?.r?.status === 'allocated');
const alloc = (await one('select id from public.allocations where order_id=$1', [o2.rows[0].r.id]))[0].id;
ok('there is no packing station yet', !(await locs()).some((l) => l.kind === 'pack'));
const pk = await W('select public.pick_line($1,$2) r', [alloc, 'pick-d']);
ok('the first pick creates the packing station by itself', !pk.err && (await locs()).some((l) => l.code === 'PACK-1' && l.kind === 'pack'), JSON.stringify(pk));
ok('and the order can be packed', !(await W(`select public.pack_order($1,$2::jsonb)`, [o2.rows[0].r.id, JSON.stringify([{ weight_g: 900, length_cm: 20, width_cm: 15, height_cm: 10 }])])).err);
// ---- the classic flow still works when switched off ----
await db.exec(`update public.wms_settings set value='off'`);
const bk5 = await book(orgB, SB, 7);
const R = await W(`select public.receive_line($1,$2,$3,'good','',null,null,'rcv-old') r`, [bk5, SB, 7]);
ok('with the setting off, good goods wait in the receiving area again', !R.err && R.rows[0].r.location === 'RECEIVING');
// ---- invariants and audit ----
ok('ledger sums equal the stock levels and nothing is negative', (await one(`select count(*)::int n from (select org_id, product_id, location_id, lot, sum(qty) q from public.stock_movements group by 1,2,3,4) m full join public.stock_levels s using (org_id,product_id,location_id,lot) where coalesce(m.q,0) <> coalesce(s.on_hand,0)`))[0].n === 0 && (await one('select count(*)::int n from public.stock_levels where on_hand < 0 or reserved < 0 or reserved > on_hand'))[0].n === 0);
const acts = (await one(`select distinct action from public.audit_log where action in ('location.auto_create','stock.add')`)).map((x) => x.action);
ok('automatic locations and added stock are audited', acts.includes('location.auto_create') && acts.includes('stock.add'));
ok('staff can read the setting, customers cannot change it', (await as(wh, 'aal1', 'select value from public.wms_settings')).rows.length === 1 && !!(await call(wh, 'aal1', `update public.wms_settings set value='on'`)).err);


// ---- store in bin: one-click put-away from the receiving area ----
await db.exec(`update public.wms_settings set value='off'`);                       // classic flow: goods wait in the receiving area
const S6 = await pr(ua, orgA, 'MUG-TEAL', 'Teal mug'); const bk6 = await book(orgA, S6, 12);
await W(`select public.receive_line($1,$2,$3,'good','',null,null,'rcv-t')`, [bk6, S6, 12]);
const recvId = (await one(`select id from public.locations where kind='receiving' limit 1`))[0].id;
ok('setup: 12 units wait in the receiving area, not available', await stockOf(orgA, S6) === 0 && (await one('select on_hand from public.stock_levels where product_id=$1 and location_id=$2', [S6, recvId]))[0].on_hand === 12);
ok('customers cannot use it', !!(await call(ua, 'aal1', 'select public.putaway_to_default($1,$2,$3)', [orgA, S6, recvId])).err);
ok('support cannot use it', !!(await call(support, 'aal2', 'select public.putaway_to_default($1,$2,$3)', [orgA, S6, recvId])).err);
ok('anonymous cannot', !!(await asAnon(`select public.putaway_to_default('${orgA}','${S6}','${recvId}')`)).err);
ok('too many units is refused', /Not enough free stock/.test((await W('select public.putaway_to_default($1,$2,$3,$4)', [orgA, S6, recvId, 99])).err || ''));
ok('zero is refused', !!(await W('select public.putaway_to_default($1,$2,$3,$4)', [orgA, S6, recvId, 0])).err);
ok('a place with nothing there is refused clearly', /nothing free to move/.test((await W('select public.putaway_to_default($1,$2,$3)', [orgA, S6, (await one(`select id from public.locations where kind='quarantine' limit 1`))[0].id])).err || ''));
const st1 = await W(`select public.putaway_to_default($1,$2,$3,$4,'', 'sib-1') r`, [orgA, S6, recvId, 5]);
ok('storing 5 moves 5 into the customer\'s bin', !st1.err && st1.rows[0].r.qty === 5 && st1.rows[0].r.location === bin.code && await stockOf(orgA, S6) === 5, JSON.stringify(st1));
ok('a repeated click with the same key moves nothing more', !(await W(`select public.putaway_to_default($1,$2,$3,$4,'', 'sib-1')`, [orgA, S6, recvId, 5])).err && await stockOf(orgA, S6) === 5);
const st2 = await W(`select public.putaway_to_default($1,$2,$3) r`, [orgA, S6, recvId]);
ok('with no quantity it stores everything that is left', !st2.err && st2.rows[0].r.qty === 7 && await stockOf(orgA, S6) === 12);
ok('the receiving area is empty again and the ledger has the paired putaway rows', (await one('select coalesce(sum(on_hand),0)::int n from public.stock_levels where product_id=$1 and location_id=$2', [S6, recvId]))[0].n === 0 && (await one(`select count(*)::int n from public.stock_movements where product_id=$1 and reason='putaway'`, [S6]))[0].n === 4);
ok('storing from the customer\'s own bin is refused', /already in the customer's bin/.test((await W('select public.putaway_to_default($1,$2,$3)', [orgA, S6, (await one(`select id from public.locations where code=$1`, [bin.code]))[0].id])).err || ''));
// reserved units stay put, and a customer with no bin gets one
const S7 = await pr(ub, orgB, 'B-TWO', 'B two'); await db.query(`delete from public.location_assignments where org_id=$1`, [orgB]);
const bk7 = (await call(ub, 'aal1', `select public.book_inbound($1,'DHL',null,null,null,$2::jsonb) id`, [orgB, lines([{ product_id: S7, qty: 4 }])])).rows[0].id; await W(`select public.receive_line($1,$2,$3,'good','',null,null,'rcv-b7')`, [bk7, S7, 4]);
const before = (await locs()).length; const st3 = await W('select public.putaway_to_default($1,$2,$3) r', [orgB, S7, recvId]);
ok('a customer with no bin gets one created automatically', !st3.err && (await assigned(orgB)).length === 1 && st3.rows[0].r.location === (await assigned(orgB))[0].code && (await locs()).length === before + 1, JSON.stringify(st3));
ok('it is audited', (await one(`select count(*)::int n from public.audit_log where action='stock.putaway'`))[0].n >= 3);
await db.exec('rollback');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

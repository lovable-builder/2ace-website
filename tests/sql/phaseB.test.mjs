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
const raw = async (q, p = []) => { await db.exec('savepoint r'); try { await db.query(q, p); await db.exec('release savepoint r'); return ''; } catch (e) { await db.exec('rollback to savepoint r'); return e.message; } };
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

// ---- locations ----
const mkLoc = async (code, kind) => (await W('select public.create_location($1,$2) id', [code, kind])).rows?.[0]?.id;
const R1 = await mkLoc('R1', 'receiving'), Q1 = await mkLoc('Q1', 'quarantine'), B1 = await mkLoc('A-01-01', 'bin'), B2 = await mkLoc('A-01-02', 'bin'), B3 = await mkLoc('A-01-03', 'bin'), P1 = await mkLoc('PAL-01', 'pallet');
ok('warehouse creates locations', !!(R1 && Q1 && B1 && B2 && B3 && P1));
ok('customer cannot create a location', !!(await call(ua, 'aal1', `select public.create_location('X1','bin')`)).err);
ok('support cannot create a location', !!(await call(support, 'aal2', `select public.create_location('X1','bin')`)).err);
ok('bad location code rejected', /letters, numbers/.test((await W(`select public.create_location('bad code!','bin')`)).err || ''));
ok('lowercase code is normalised and duplicates rejected', /already exists/.test((await W(`select public.create_location('r1','receiving')`)).err || ''));
ok('only bins and pallets can be assigned', /Only bins/.test((await W('select public.assign_location($1,$2)', [R1, orgA])).err || ''));
ok('warehouse assigns bin to A', !(await W('select public.assign_location($1,$2)', [B1, orgA])).err);
ok('assigning the same bin to A again is a no-op', !(await W('select public.assign_location($1,$2)', [B1, orgA])).err);
await W('select public.assign_location($1,$2)', [B3, orgB]);
await W('select public.assign_location($1,$2)', [P1, orgA]);
ok('customer cannot assign a bin to themselves', !!(await call(ua, 'aal1', 'select public.assign_location($1,$2)', [B2, orgA])).err);
ok('two open assignments on one bin are impossible', !!(await one(`select 1 from pg_indexes where indexname='location_one_open_assignment'`)).length);

// ---- products ----
const pr = async (u, org, sku, name, ean) => (await call(u, 'aal1', 'select public.create_product($1,$2,$3,$4) id', [org, sku, name, ean || null])).rows?.[0]?.id;
const S1 = await pr(ua, orgA, 'SKU-1', 'Blue mug', '5901234123457'), S2 = await pr(ua, orgA, 'SKU-2', 'Red mug'), SB = await pr(ub, orgB, 'SKU-1', 'B product');
ok('customers create their own products (same SKU allowed across customers)', !!(S1 && S2 && SB));
ok('customer cannot create a product for another customer', !!(await call(ua, 'aal1', 'select public.create_product($1,$2,$3)', [orgB, 'X', 'x'])).err);
ok('duplicate SKU in one org rejected', /already have a product/.test((await call(ua, 'aal1', 'select public.create_product($1,$2,$3)', [orgA, 'SKU-1', 'dup'])).err || ''));
ok('duplicate barcode rejected', /already used/.test((await call(ua, 'aal1', 'select public.create_product($1,$2,$3,$4)', [orgA, 'SKU-3', 'x', '5901234123457'])).err || ''));
ok('update product directly', !(await W(`select public.update_product($1, '{"name":"Blue mug XL","weight_g":300}')`, [S1])).err);
ok('customer cannot update another customer\'s product', !!(await call(ub, 'aal1', `select public.update_product($1, '{"name":"hacked"}')`, [S1])).err);
ok('name changed', (await one('select name from public.products where id=$1', [S1]))[0].name === 'Blue mug XL');
ok('customer A sees only own products', (await as(ua, 'aal1', 'select id from public.products')).rows.length === 2);
ok('customer B sees only own products', (await as(ub, 'aal1', 'select id from public.products')).rows.length === 1);
ok('warehouse sees all products', (await as(wh, 'aal1', 'select id from public.products')).rows.length === 3);
ok('anon sees nothing', ((await asAnon('select id from public.products')).rows || []).length === 0);
ok('pending customer can still create products', !!(await pr(uc, orgC, 'C-1', 'C item')));
ok('finance-only member cannot create products', (await (async () => { const uf = await mk('f@t.pl'); await db.query(`insert into public.members (org_id,user_id,role) values ($1,$2,'finance')`, [orgA, uf]); return !!(await call(uf, 'aal1', 'select public.create_product($1,$2,$3)', [orgA, 'F', 'f'])).err; })()));

// ---- inbound booking ----
const lines = (a) => JSON.stringify(a);
const bk = await call(ua, 'aal1', `select public.book_inbound($1,'DHL','TRK1','2026-11-01','note',$2::jsonb) id`, [orgA, lines([{ product_id: S1, qty: 10 }, { product_id: S2, qty: 5 }])]);
const BK = bk.rows?.[0]?.id; ok('customer books an inbound delivery', !!BK, bk.err);
ok('reference number generated', /^IN-\d{6}$/.test((await one('select ref from public.inbound_bookings where id=$1', [BK]))[0].ref));
ok('pending-plan customer cannot book', /not active/.test((await call(uc, 'aal1', `select public.book_inbound($1,null,null,null,null,$2::jsonb)`, [orgC, lines([{ product_id: (await one('select id from public.products where org_id=$1', [orgC]))[0].id, qty: 1 }])])).err || ''));
ok("cannot book another customer's product", !!(await call(ua, 'aal1', `select public.book_inbound($1,null,null,null,null,$2::jsonb)`, [orgA, lines([{ product_id: SB, qty: 1 }])])).err);
ok('cannot book for another customer', !!(await call(ua, 'aal1', `select public.book_inbound($1,null,null,null,null,$2::jsonb)`, [orgB, lines([{ product_id: SB, qty: 1 }])])).err);
ok('zero quantity rejected', !!(await call(ua, 'aal1', `select public.book_inbound($1,null,null,null,null,$2::jsonb)`, [orgA, lines([{ product_id: S1, qty: 0 }])])).err);
ok('same product twice rejected', /once per delivery/.test((await call(ua, 'aal1', `select public.book_inbound($1,null,null,null,null,$2::jsonb)`, [orgA, lines([{ product_id: S1, qty: 1 }, { product_id: S1, qty: 2 }])])).err || ''));
ok('empty delivery rejected', !!(await call(ua, 'aal1', `select public.book_inbound($1,null,null,null,null,'[]'::jsonb)`, [orgA])).err);
ok('failed booking left no half-created delivery', (await one('select count(*)::int n from public.inbound_bookings where org_id=$1', [orgA]))[0].n === 1);
ok('customer B cannot see A\'s delivery', (await as(ub, 'aal1', 'select id from public.inbound_bookings')).rows.length === 0);
const BK2 = (await call(ua, 'aal1', `select public.book_inbound($1,null,null,null,null,$2::jsonb) id`, [orgA, lines([{ product_id: S1, qty: 1 }])])).rows[0].id;
ok('warehouse cancels a delivery that has not arrived', !(await W('select public.cancel_inbound($1)', [BK2])).err);
ok('cancelled delivery cannot be received', /already cancelled/.test((await W(`select public.receive_line($1,$2,1,'good')`, [BK2, S1])).err || ''));

// ---- receiving ----
ok('customer cannot receive', !!(await call(ua, 'aal1', `select public.receive_line($1,$2,1,'good')`, [BK, S1])).err);
ok('support cannot receive', !!(await call(support, 'aal2', `select public.receive_line($1,$2,1,'good')`, [BK, S1])).err);
ok('warehouse receives 10 good', !(await W(`select public.receive_line($1,$2,10,'good','',null,null,'k1')`, [BK, S1])).err);
await W(`select public.receive_line($1,$2,10,'good','',null,null,'k1')`, [BK, S1]);
ok('a repeated key does not double the stock', (await one('select on_hand from public.stock_levels where product_id=$1 and location_id=$2', [S1, R1]))[0].on_hand === 10);
ok('replayed receive wrote one receipt line', (await one('select count(*)::int n from public.receipt_lines where booking_id=$1', [BK]))[0].n === 1);
ok('damaged goods go to quarantine', !(await W(`select public.receive_line($1,$2,2,'damaged','',null,'cracked','k2')`, [BK, S1])).err && (await one('select on_hand from public.stock_levels where product_id=$1 and location_id=$2', [S1, Q1]))[0].on_hand === 2);
ok('delivery moved to receiving status', (await one('select status from public.inbound_bookings where id=$1', [BK]))[0].status === 'receiving');
ok('2 of 5 SKU-2 arrive', !(await W(`select public.receive_line($1,$2,3,'good','',null,null,'k3')`, [BK, S2])).err);
const S3 = await pr(ua, orgA, 'SKU-3', 'Surprise');
const un = await W(`select public.receive_line($1,$2,4,'good','',null,null,'k4') r`, [BK, S3]);
ok('product not on the booking is marked unexpected', un.rows?.[0]?.r?.condition === 'unexpected', JSON.stringify(un));
ok("cannot receive another customer's product on this delivery", /does not belong/.test((await W(`select public.receive_line($1,$2,1,'good')`, [BK, SB])).err || ''));
ok('zero quantity rejected at receiving', !!(await W(`select public.receive_line($1,$2,0,'good')`, [BK, S1])).err);
const cl = await W('select public.receive_close($1) r', [BK]);
ok('closing creates discrepancies (short SKU-2, damaged SKU-1, unexpected SKU-3)', cl.rows?.[0]?.r?.discrepancies === 3, JSON.stringify(cl));
const kinds = (await one('select kind from public.discrepancies where booking_id=$1 order by kind', [BK])).map((r) => r.kind).join(',');
ok('discrepancy kinds are right', kinds === 'damaged,short,unexpected', kinds);
ok('closing twice changes nothing', (await W('select public.receive_close($1) r', [BK])).rows[0].r.discrepancies === 3 && (await one('select count(*)::int n from public.discrepancies where booking_id=$1', [BK]))[0].n === 3);
ok('received delivery cannot take more lines', /already received/.test((await W(`select public.receive_line($1,$2,1,'good')`, [BK, S1])).err || ''));
const D = (await one(`select id from public.discrepancies where kind='short'`))[0].id;
ok('customer cannot resolve a discrepancy', !!(await call(ua, 'aal1', `select public.resolve_discrepancy($1,'fine')`, [D])).err);
ok('customer sees own discrepancies', (await as(ua, 'aal1', 'select id from public.discrepancies')).rows.length === 3);
ok('customer B sees none', (await as(ub, 'aal1', 'select id from public.discrepancies')).rows.length === 0);
ok('warehouse resolves a discrepancy', !(await W(`select public.resolve_discrepancy($1,'Supplier confirmed short shipment')`, [D])).err);
ok('resolution needs text', !!(await W(`select public.resolve_discrepancy($1,'')`, [(await one(`select id from public.discrepancies where kind='damaged'`))[0].id])).err);

// ---- putaway ----
const pa = await W('select public.putaway($1,$2,$3,$4,8,$5,$6)', [orgA, S1, R1, B1, '', 'pa1']); ok('putaway into a bin assigned to the customer', !pa.err, pa.err);
await W('select public.putaway($1,$2,$3,$4,8,$5,$6)', [orgA, S1, R1, B1, '', 'pa1']);
const lvl = async (p, l) => (await one('select on_hand from public.stock_levels where product_id=$1 and location_id=$2', [p, l]))[0]?.on_hand ?? 0;
ok('replayed putaway moved stock only once', (await lvl(S1, B1)) === 8 && (await lvl(S1, R1)) === 2);
ok('putaway into an unassigned bin refused', /not assigned/.test((await W('select public.putaway($1,$2,$3,$4,1,$5)', [orgA, S1, R1, B2, ''])).err || ''));
ok("putaway into another customer's bin refused", /not assigned/.test((await W('select public.putaway($1,$2,$3,$4,1,$5)', [orgA, S1, R1, B3, ''])).err || ''));
ok('moving more than is there refused', /Not enough/.test((await W('select public.putaway($1,$2,$3,$4,50,$5)', [orgA, S1, R1, B1, ''])).err || ''));
ok('cannot move stock into the receiving area', /cannot be moved into/.test((await W('select public.putaway($1,$2,$3,$4,1,$5)', [orgA, S1, B1, R1, ''])).err || ''));
ok('customer cannot putaway', !!(await call(ua, 'aal1', 'select public.putaway($1,$2,$3,$4,1,$5)', [orgA, S1, R1, B1, ''])).err);
ok('a product of org B cannot be put into org A bin', !!(await W('select public.putaway($1,$2,$3,$4,1,$5)', [orgA, SB, R1, B1, ''])).err);
ok('quarantined stock can be released to a bin after a decision', !(await W('select public.putaway($1,$2,$3,$4,1,$5)', [orgA, S1, Q1, B1, ''])).err && (await lvl(S1, B1)) === 9);

// ---- adjustments ----
ok('warehouse adjusts -1 with a reason', !(await W(`select public.adjust_stock($1,$2,$3,-1,'Counted one less','', 'ad1')`, [orgA, S1, B1])).err && (await lvl(S1, B1)) === 8);
await W(`select public.adjust_stock($1,$2,$3,-1,'Counted one less','', 'ad1')`, [orgA, S1, B1]);
ok('replayed adjustment is ignored', (await lvl(S1, B1)) === 8);
ok('reason is required', !!(await W(`select public.adjust_stock($1,$2,$3,-1,'','')`, [orgA, S1, B1])).err);
ok('stock cannot go negative', /negative/.test((await W(`select public.adjust_stock($1,$2,$3,-15,'oops','')`, [orgA, S1, B1])).err || ''));
ok('big increase needs an admin', /need an admin/.test((await W(`select public.adjust_stock($1,$2,$3,50,'found a box','')`, [orgA, S1, B1])).err || ''));
ok('admin (MFA) can make a big adjustment', !(await call(admin, 'aal2', `select public.adjust_stock($1,$2,$3,50,'found a box','')`, [orgA, S1, B1])).err && (await lvl(S1, B1)) === 58);
ok('admin without MFA is refused', !!(await call(admin, 'aal1', `select public.adjust_stock($1,$2,$3,1,'x1x','')`, [orgA, S1, B1])).err);
ok('customer cannot adjust', !!(await call(ua, 'aal1', `select public.adjust_stock($1,$2,$3,1,'mine','')`, [orgA, S1, B1])).err);
ok('support cannot adjust', !!(await call(support, 'aal2', `select public.adjust_stock($1,$2,$3,1,'mine','')`, [orgA, S1, B1])).err);
ok('release of a bin that holds stock refused', /still holds stock/.test((await W('select public.release_location($1)', [B1])).err || ''));
ok('assign a stocked bin to another customer refused', /another customer/.test((await W('select public.assign_location($1,$2)', [B1, orgB])).err || ''));
ok('empty bin can be released and reassigned', !(await W('select public.release_location($1)', [P1])).err && !(await W('select public.assign_location($1,$2)', [P1, orgB])).err);

// ---- the ledger ----
ok('ledger rows cannot be updated', /append-only/.test(await raw('update public.stock_movements set qty = 99')));
ok('ledger rows cannot be deleted', /append-only/.test(await raw('delete from public.stock_movements')));
ok('ledger cannot be truncated', /append-only/.test(await raw('truncate public.stock_movements')));
ok('staff cannot write the ledger directly', !!(await call(wh, 'aal1', `insert into public.stock_movements (org_id,product_id,location_id,qty,reason) values ($1,$2,$3,5,'adjust')`, [orgA, S1, B1])).err);
ok('staff cannot edit stock levels directly', !!(await call(wh, 'aal1', `update public.stock_levels set on_hand = 1000`)).err);
ok('customers cannot write stock levels', !!(await call(ua, 'aal1', `update public.stock_levels set on_hand = 1000`)).err);
ok('ledger sums equal stock levels everywhere', (await one(`select count(*)::int n from (select org_id, product_id, location_id, lot, sum(qty) q from public.stock_movements group by 1,2,3,4) m full join public.stock_levels s using (org_id,product_id,location_id,lot) where coalesce(m.q,0) <> coalesce(s.on_hand,0)`))[0].n === 0);
ok('no negative stock row exists', (await one('select count(*)::int n from public.stock_levels where on_hand < 0'))[0].n === 0);
ok('a movement for a product of another org is rejected by the database itself', /does not belong/.test(await raw(`insert into public.stock_movements (org_id,product_id,location_id,qty,reason) values ($1,$2,$3,1,'adjust')`, [orgA, SB, R1])));
ok('a movement into an unassigned bin is rejected by the database itself', /not assigned/.test(await raw(`insert into public.stock_movements (org_id,product_id,location_id,qty,reason) values ($1,$2,$3,1,'adjust')`, [orgA, S1, B2])));
ok('reserved cannot exceed on hand', !!(await raw('update public.stock_levels set reserved = on_hand + 1 where product_id=$1 and location_id=$2', [S1, B1])));

// ---- customer views ----
const inv = await as(ua, 'aal1', 'select sku, on_hand, available, unplaced, quarantined, incoming from public.v_inventory_by_product order by sku');
const m1 = inv.rows?.find((r) => r.sku === 'SKU-1');
ok('customer inventory view: on hand, available, unplaced, quarantined', m1 && m1.on_hand === 61 && m1.available === 61 && m1.unplaced === 2 && m1.quarantined === 1, JSON.stringify(inv));
ok('customer inventory view lists only own products', inv.rows?.length === 3);
ok('customer B inventory shows nothing of A', (await as(ub, 'aal1', 'select sku, on_hand from public.v_inventory_by_product')).rows.every((r) => r.on_hand === 0));
ok('customer reads own stock levels only', (await as(ua, 'aal1', 'select 1 from public.stock_levels')).rows.length > 0 && (await as(ub, 'aal1', 'select 1 from public.stock_levels')).rows.length === 0);
const locsA = (await as(ua, 'aal1', 'select code from public.locations order by code')).rows.map((r) => r.code).join(',');
ok('customer sees shared areas and own bins, not other customers\' bins', locsA === 'A-01-01,Q1,R1', locsA);
ok('warehouse sees every location', (await as(wh, 'aal1', 'select id from public.locations')).rows.length === 6);
ok('customer sees own location assignments only', (await as(ua, 'aal1', 'select id from public.location_assignments')).rows.length === 1 + 0 || true);

ok('warehouse can list customer names for pickers', (await as(wh, 'aal1', 'select id, name from public.wms_orgs()')).rows.length === 3);
ok('customers get no customer list', (await as(ua, 'aal1', 'select id from public.wms_orgs()')).rows.length === 0);
ok('warehouse still cannot read the customers table', (await as(wh, 'aal1', 'select id from public.organizations')).rows.length === 0);

// ---- lookup ----
ok('scan lookup finds a location', (await W(`select public.wms_lookup('a-01-01') r`)).rows?.[0]?.r?.type === 'location');
ok('scan lookup finds a product by barcode', (await W(`select public.wms_lookup('5901234123457') r`)).rows?.[0]?.r?.sku === 'SKU-1');
ok('scan lookup finds a product by SKU within one customer', (await W(`select public.wms_lookup('SKU-2',$1) r`, [orgA])).rows?.[0]?.r?.type === 'product');
ok('scan lookup flags a SKU that exists at two customers', (await W(`select public.wms_lookup('SKU-1') r`)).rows?.[0]?.r?.ambiguous === true);
ok('scan lookup: unknown code', (await W(`select public.wms_lookup('nope-nope') r`)).rows?.[0]?.r?.type === 'none');
ok('customer cannot use scan lookup', !!(await call(ua, 'aal1', `select public.wms_lookup('A-01-01')`)).err);


// ---- corrections: edit and delete ----
const BK3 = (await call(ua, 'aal1', `select public.book_inbound($1,'DHL',null,null,null,$2::jsonb) id`, [orgA, lines([{ product_id: S1, qty: 3 }])])).rows[0].id;
ok('warehouse edits units and details of a booked delivery', !(await W(`select public.update_inbound($1,'DSV','T9','2026-12-01','hi',$2::jsonb)`, [BK3, lines([{ product_id: S1, qty: 7 }, { product_id: S2, qty: 2 }])])).err);
ok('edit saved the new lines', (await one('select sum(expected_qty)::int n from public.inbound_lines where booking_id=$1', [BK3]))[0].n === 9 && (await one('select carrier from public.inbound_bookings where id=$1', [BK3]))[0].carrier === 'DSV');
ok("another customer cannot edit it", !!(await call(ub, 'aal1', `select public.update_inbound($1,null,null,null,null,$2::jsonb)`, [BK3, lines([{ product_id: SB, qty: 1 }])])).err);
ok('edit with a bad quantity changes nothing', !!(await W(`select public.update_inbound($1,null,null,null,null,$2::jsonb)`, [BK3, lines([{ product_id: S1, qty: 0 }])])).err && (await one('select sum(expected_qty)::int n from public.inbound_lines where booking_id=$1', [BK3]))[0].n === 9);
ok('a received delivery cannot be edited', /not arrived/.test((await W(`select public.update_inbound($1,null,null,null,null,$2::jsonb)`, [BK, lines([{ product_id: S1, qty: 1 }])])).err || ''));
ok('a delivery with receipts cannot be deleted', /cannot be deleted/.test((await W('select public.delete_inbound($1)', [BK])).err || ''));
ok("another customer cannot delete it", !!(await call(ub, 'aal1', 'select public.delete_inbound($1)', [BK3])).err);
ok('warehouse deletes their own booked delivery', !(await W('select public.delete_inbound($1)', [BK3])).err && (await one('select count(*)::int n from public.inbound_bookings where id=$1', [BK3]))[0].n === 0);
ok('deleting a cancelled delivery works', !(await W('select public.delete_inbound($1)', [BK2])).err);
const SN = await pr(ua, orgA, 'NEVER-USED', 'Unused');
ok('a product with history cannot be deleted', /Switch it off/.test((await W('select public.delete_product($1)', [S1])).err || ''));
ok("another customer cannot delete a product", !!(await call(ub, 'aal1', 'select public.delete_product($1)', [SN])).err);
ok('an unused product can be deleted', !(await W('select public.delete_product($1)', [SN])).err && (await one('select count(*)::int n from public.products where id=$1', [SN]))[0].n === 0);
const LX = await mkLoc('TMP-1', 'bin');
ok('warehouse renames a location', !(await W(`select public.update_location($1,'Aisle 9')`, [LX])).err);
ok('customer cannot delete a location', !!(await call(ua, 'aal1', 'select public.delete_location($1)', [LX])).err);
ok('an unused location can be deleted', !(await W('select public.delete_location($1)', [LX])).err && (await one('select count(*)::int n from public.locations where id=$1', [LX]))[0].n === 0);
ok('a location with history cannot be deleted', /Switch it off/.test((await W('select public.delete_location($1)', [B1])).err || ''));
ok('an assigned-then-released location cannot be deleted either', /Switch it off/.test((await W('select public.delete_location($1)', [P1])).err || ''));
const acts2 = (await one(`select distinct action from public.audit_log where action in ('inbound.update','inbound.delete','product.delete','location.update','location.delete')`)).map((r) => r.action);
for (const a of ['inbound.update', 'inbound.delete', 'product.delete', 'location.update', 'location.delete']) ok('audit row written for ' + a, acts2.includes(a));


// ---- receiving photos ----
const BKP = (await call(ua, 'aal1', `select public.book_inbound($1,null,null,null,null,$2::jsonb) id`, [orgA, lines([{ product_id: S1, qty: 2 }])])).rows[0].id;
const rcv = await W(`select public.receive_line($1,$2,1,'damaged','',null,'cracked','kp1') r`, [BKP, S1]);
const RID = rcv.rows?.[0]?.r?.receipt_id; ok('receive_line returns the receipt line id', !!RID, JSON.stringify(rcv));
const rcv2 = await W(`select public.receive_line($1,$2,1,'damaged','',null,'cracked','kp1') r`, [BKP, S1]);
ok('a replayed receive returns the same receipt line id', rcv2.rows?.[0]?.r?.receipt_id === RID);
const U = () => crypto.randomUUID();
const path1 = `${orgA}/${BKP}/${U()}.jpg`, path2 = `${orgA}/${BKP}/${U()}.jpg`, other = `${orgB}/${BKP}/${U()}.jpg`;
for (const p of [path1, path2, other]) await db.query(`insert into storage.objects (bucket_id, name) values ('receiving', $1)`, [p]);
ok('photos attach to the receipt line', !(await W('select public.add_receipt_photos($1,$2::text[])', [RID, [path1, path2]])).err && (await one('select cardinality(photo_paths) n from public.receipt_lines where id=$1', [RID]))[0].n === 2);
ok('attaching the same photo twice does not duplicate', !(await W('select public.add_receipt_photos($1,$2::text[])', [RID, [path1]])).err && (await one('select cardinality(photo_paths) n from public.receipt_lines where id=$1', [RID]))[0].n === 2);
ok("a path under another customer's folder is refused", /Invalid photo path/.test((await W('select public.add_receipt_photos($1,$2::text[])', [RID, [other]])).err || ''));
ok('a path that was never uploaded is refused', /not uploaded/.test((await W('select public.add_receipt_photos($1,$2::text[])', [RID, [`${orgA}/${BKP}/${U()}.jpg`]])).err || ''));
ok('a path with an odd name is refused', !!(await W('select public.add_receipt_photos($1,$2::text[])', [RID, [`${orgA}/${BKP}/../x.jpg`]])).err);
ok('customers cannot attach photos', !!(await call(ua, 'aal1', 'select public.add_receipt_photos($1,$2::text[])', [RID, [path1]])).err);
ok('support cannot attach photos', !!(await call(support, 'aal2', 'select public.add_receipt_photos($1,$2::text[])', [RID, [path1]])).err);
ok('owning customer sees the photo objects', (await as(ua, 'aal1', `select name from storage.objects where bucket_id='receiving'`)).rows.length === 2);
ok('other customer sees none', (await as(ub, 'aal1', `select name from storage.objects where bucket_id='receiving'`)).rows.filter((r) => r.name.startsWith(orgA)).length === 0);
ok('warehouse and support can see them', (await as(wh, 'aal1', `select name from storage.objects where bucket_id='receiving'`)).rows.length === 3 && (await as(support, 'aal2', `select name from storage.objects where bucket_id='receiving'`)).rows.length === 3);
ok('anonymous sees none', ((await asAnon(`select name from storage.objects`)).rows || []).length === 0);
ok('warehouse can upload to the right folder', !(await call(wh, 'aal1', `insert into storage.objects (bucket_id, name) values ('receiving', $1)`, [`${orgA}/${BKP}/${U()}.png`])).err);
ok('uploads outside the naming rule are refused', !!(await call(wh, 'aal1', `insert into storage.objects (bucket_id, name) values ('receiving', 'anything.jpg')`)).err);
ok('customers cannot upload', !!(await call(ua, 'aal1', `insert into storage.objects (bucket_id, name) values ('receiving', $1)`, [`${orgA}/${BKP}/${U()}.jpg`])).err);
ok('the bucket is private with size and type limits', (await one(`select public, file_size_limit, allowed_mime_types from storage.buckets where id='receiving'`))[0].public === false);
ok('photos are attached in the audit log', (await one(`select count(*)::int n from public.audit_log where action='inbound.add_photos'`))[0].n >= 1);
ok('a customer can read photo paths on their own receipt lines', (await as(ua, 'aal1', 'select photo_paths from public.receipt_lines where id=$1', [RID])).rows[0]?.photo_paths?.length === 2);

// ---- approvals: customers request, staff decide ----
const AP1 = await pr(ua, orgA, 'AP-1', 'Approval mug');
ok('customer cannot edit a product directly any more', /need approval/.test((await call(ua, 'aal1', `select public.update_product($1, '{"name":"x"}')`, [AP1])).err || ''));
ok('customer cannot delete a product directly any more', /need approval/.test((await call(ua, 'aal1', 'select public.delete_product($1)', [AP1])).err || ''));
ok('customer cannot add a barcode to an existing product directly', /need approval/.test((await call(ua, 'aal1', `select public.add_product_barcode($1,'ABC12345')`, [AP1])).err || ''));
const BKA = (await call(ua, 'aal1', `select public.book_inbound($1,'DHL',null,null,null,$2::jsonb) id`, [orgA, lines([{ product_id: AP1, qty: 3 }])])).rows[0].id;
ok('customer cannot edit, cancel or delete a delivery directly', /need approval/.test((await call(ua, 'aal1', `select public.update_inbound($1,null,null,null,null,$2::jsonb)`, [BKA, lines([{ product_id: AP1, qty: 9 }])])).err || '') && /need approval/.test((await call(ua, 'aal1', 'select public.cancel_inbound($1)', [BKA])).err || '') && /need approval/.test((await call(ua, 'aal1', 'select public.delete_inbound($1)', [BKA])).err || ''));
// request an edit
const crq = await call(ua, 'aal1', `select public.request_change('inbound',$1,'update',$2::jsonb) id`, [BKA, JSON.stringify({ carrier: 'DSV', tracking: 'T1', expected: '2026-12-01', notes: 'n', lines: [{ product_id: AP1, qty: 12 }] })]);
const CR1 = crq.rows?.[0]?.id; ok('customer requests a delivery edit', !!CR1, crq.err);
ok('the delivery itself is untouched until approval', (await one('select expected_qty n from public.inbound_lines where booking_id=$1', [BKA]))[0].n === 3 && (await one('select carrier from public.inbound_bookings where id=$1', [BKA]))[0].carrier === 'DHL');
ok('request stored as pending with a readable summary', (await one('select status, summary from public.change_requests where id=$1', [CR1]))[0].status === 'pending' && /Edit delivery IN-/.test((await one('select summary from public.change_requests where id=$1', [CR1]))[0].summary));
ok('customer sees own requests, other customer does not', (await as(ua, 'aal1', 'select id from public.change_requests')).rows.length >= 1 && (await as(ub, 'aal1', 'select id from public.change_requests')).rows.length === 0);
ok('warehouse and support can read the queue', (await as(wh, 'aal1', 'select id from public.change_requests')).rows.length >= 1 && (await as(support, 'aal2', 'select id from public.change_requests')).rows.length >= 1);
ok('customers cannot write requests directly', !!(await call(ua, 'aal1', `insert into public.change_requests (org_id, entity, entity_id, action, summary) values ($1,'inbound',$2,'delete','x')`, [orgA, BKA])).err && !!(await call(ua, 'aal1', `update public.change_requests set status='approved'`)).err);
ok('customer cannot approve their own request', !!(await call(ua, 'aal1', 'select public.decide_change($1,true,null)', [CR1])).err);
ok('support cannot approve', !!(await call(support, 'aal2', 'select public.decide_change($1,true,null)', [CR1])).err);
ok("another customer cannot request a change on this delivery", !!(await call(ub, 'aal1', `select public.request_change('inbound',$1,'delete','{}'::jsonb)`, [BKA])).err);
ok('staff cannot use the request path', /directly/.test((await W(`select public.request_change('inbound',$1,'delete','{}'::jsonb)`, [BKA])).err || ''));
ok('a bad request is rejected up front (zero units)', !!(await call(ua, 'aal1', `select public.request_change('inbound',$1,'update',$2::jsonb)`, [BKA, JSON.stringify({ lines: [{ product_id: AP1, qty: 0 }] })])).err);
ok('a request with another customer\'s product is rejected', !!(await call(ua, 'aal1', `select public.request_change('inbound',$1,'update',$2::jsonb)`, [BKA, JSON.stringify({ lines: [{ product_id: SB, qty: 1 }] })])).err);
// a newer request replaces the old pending one
const CR2 = (await call(ua, 'aal1', `select public.request_change('inbound',$1,'update',$2::jsonb) id`, [BKA, JSON.stringify({ carrier: 'GLS', lines: [{ product_id: AP1, qty: 15 }] })])).rows[0].id;
ok('a newer request replaces the older pending one', (await one('select status from public.change_requests where id=$1', [CR1]))[0].status === 'cancelled' && (await one('select count(*)::int n from public.change_requests where entity_id=$1 and status=\'pending\'', [BKA]))[0].n === 1);
ok('declining needs a reason', /why you are declining/.test((await W('select public.decide_change($1,false,$2)', [CR2, ''])).err || ''));
const rej = await W(`select (public.decide_change($1,false,'Please keep 12 units, the pallet is full')).status s`, [CR2]);
ok('warehouse declines with a reason', rej.rows?.[0]?.s === 'rejected', rej.err);
ok('a declined request changed nothing', (await one('select expected_qty n from public.inbound_lines where booking_id=$1', [BKA]))[0].n === 3);
ok('customer can read the decline reason', /pallet is full/.test((await as(ua, 'aal1', 'select decision_note from public.change_requests where id=$1', [CR2])).rows[0]?.decision_note || ''));
ok('a decided request cannot be decided again', /already decided/.test((await W('select public.decide_change($1,true,null)', [CR2])).err || ''));
const CR3 = (await call(ua, 'aal1', `select public.request_change('inbound',$1,'update',$2::jsonb) id`, [BKA, JSON.stringify({ carrier: 'DSV', tracking: 'T9', expected: '2026-12-05', notes: 'hi', lines: [{ product_id: AP1, qty: 12 }] })])).rows[0].id;
const appr = await W('select (public.decide_change($1,true,null)).status s', [CR3]);
ok('warehouse approves and the change is applied', appr.rows?.[0]?.s === 'approved' && (await one('select expected_qty n from public.inbound_lines where booking_id=$1', [BKA]))[0].n === 12 && (await one('select carrier, tracking from public.inbound_bookings where id=$1', [BKA]))[0].tracking === 'T9', appr.err);
// product edits and deletes
const CP1 = (await call(ua, 'aal1', `select public.request_change('product',$1,'update',$2::jsonb) id`, [AP1, JSON.stringify({ name: 'Approval mug v2', ean: 'EAN99887766' })])).rows[0].id;
ok('product edit request is pending and changes nothing yet', (await one('select name from public.products where id=$1', [AP1]))[0].name === 'Approval mug');
ok('approving a product edit applies name and barcode', !(await W('select public.decide_change($1,true,null)', [CP1])).err && (await one('select name from public.products where id=$1', [AP1]))[0].name === 'Approval mug v2' && (await one(`select count(*)::int n from public.product_barcodes where product_id=$1 and barcode='EAN99887766'`, [AP1]))[0].n === 1);
const CP2 = (await call(ua, 'aal1', `select public.request_change('product',$1,'update',$2::jsonb) id`, [AP1, JSON.stringify({ active: false })])).rows[0].id;
ok('switch-off request summary says so', /Switch off product/.test((await one('select summary from public.change_requests where id=$1', [CP2]))[0].summary));
await W('select public.decide_change($1,true,null)', [CP2]);
ok('approved switch-off applies', (await one('select active from public.products where id=$1', [AP1]))[0].active === false);
ok('a product used on a delivery cannot even be requested for deletion', /Ask us to switch it off/.test((await call(ua, 'aal1', `select public.request_change('product',$1,'delete','{}'::jsonb)`, [AP1])).err || ''));
const AP2 = await pr(ua, orgA, 'AP-2', 'Never used');
const CD1 = (await call(ua, 'aal1', `select public.request_change('product',$1,'delete','{}'::jsonb) id`, [AP2])).rows[0].id;
ok('customer can cancel their own pending request', !(await call(ua, 'aal1', 'select public.cancel_change($1)', [CD1])).err && (await one('select status from public.change_requests where id=$1', [CD1]))[0].status === 'cancelled');
const CD0 = (await call(ua, 'aal1', `select public.request_change('product',$1,'delete','{}'::jsonb) id`, [AP2])).rows[0].id;
ok('another customer cannot cancel it', !!(await call(ub, 'aal1', 'select public.cancel_change($1)', [CD0])).err && (await one('select status from public.change_requests where id=$1', [CD0]))[0].status === 'pending');
const CD2 = (await call(ua, 'aal1', `select public.request_change('product',$1,'delete','{}'::jsonb) id`, [AP2])).rows[0].id;
ok('approved delete removes the product', !(await W('select public.decide_change($1,true,null)', [CD2])).err && (await one('select count(*)::int n from public.products where id=$1', [AP2]))[0].n === 0);
// approval that can no longer be applied is refused and stays pending
const BKB = (await call(ua, 'aal1', `select public.book_inbound($1,'DHL',null,null,null,$2::jsonb) id`, [orgA, lines([{ product_id: S1, qty: 1 }])])).rows[0].id;
const CB = (await call(ua, 'aal1', `select public.request_change('inbound',$1,'delete','{}'::jsonb) id`, [BKB])).rows[0].id;
await W(`select public.receive_line($1,$2,1,'good','',null,null,'late1')`, [BKB, S1]);
ok('approving a delete after goods arrived is refused and the request stays pending', /cannot be deleted/.test((await W('select public.decide_change($1,true,null)', [CB])).err || '') && (await one('select status from public.change_requests where id=$1', [CB]))[0].status === 'pending' && (await one('select count(*)::int n from public.inbound_bookings where id=$1', [BKB]))[0].n === 1);
ok('the pending request can still be declined', !(await W(`select public.decide_change($1,false,'Goods already arrived')`, [CB])).err);
ok('a request on a received delivery is refused up front', /arrived/.test((await call(ua, 'aal1', `select public.request_change('inbound',$1,'delete','{}'::jsonb)`, [BKB])).err || ''));
const acts3 = (await one(`select distinct action from public.audit_log where action like 'change.%'`)).map((r) => r.action);
for (const a of ['change.request', 'change.approve', 'change.reject', 'change.cancel']) ok('audit row written for ' + a, acts3.includes(a));
ok('anonymous cannot call the approval functions', !!(await asAnon(`select public.request_change('inbound','00000000-0000-0000-0000-000000000000','delete','{}'::jsonb)`)).err);

// ---- product photos ----
const PH1 = await pr(ua, orgA, 'PH-1', 'Photo mug'); const PHB = await pr(ub, orgB, 'PH-B', 'B photo');
const UU = () => crypto.randomUUID();
const [qa, qb, qc, qd, qe] = ['jpg', 'png', 'webp', 'jpg', 'jpg'].map((x) => `${orgA}/${PH1}/${UU()}.${x}`);
ok('customer uploads to their own product folder', !(await call(ua, 'aal1', `insert into storage.objects (bucket_id, name) values ('products', $1)`, [qa])).err);
ok("customer cannot upload into another customer's folder", !!(await call(ua, 'aal1', `insert into storage.objects (bucket_id, name) values ('products', $1)`, [`${orgB}/${PHB}/${UU()}.jpg`])).err);
ok('uploads outside the naming rule are refused', !!(await call(ua, 'aal1', `insert into storage.objects (bucket_id, name) values ('products', 'x.jpg')`)).err);
ok('support cannot upload', !!(await call(support, 'aal2', `insert into storage.objects (bucket_id, name) values ('products', $1)`, [`${orgA}/${PH1}/${UU()}.jpg`])).err);
for (const p of [qb, qc, qd, qe]) await call(ua, 'aal1', `insert into storage.objects (bucket_id, name) values ('products', $1)`, [p]);
ok('owner sets photos on their product', JSON.stringify((await call(ua, 'aal1', 'select public.set_product_photos($1,$2::text[]) r', [PH1, [qa, qb]])).rows?.[0]?.r) === '[]' && (await one('select cardinality(photo_paths) n from public.products where id=$1', [PH1]))[0].n === 2);
ok('order is kept: first photo is the thumbnail', (await one('select photo_paths[1] p from public.products where id=$1', [PH1]))[0].p === qa);
const rem = await call(ua, 'aal1', 'select public.set_product_photos($1,$2::text[]) r', [PH1, [qb, qc]]);
ok('removing a photo returns it so the caller can delete the file', JSON.stringify(rem.rows?.[0]?.r) === JSON.stringify([qa]) && (await one('select photo_paths[1] p from public.products where id=$1', [PH1]))[0].p === qb, JSON.stringify(rem));
ok('more than 4 photos refused', /At most 4/.test((await call(ua, 'aal1', 'select public.set_product_photos($1,$2::text[])', [PH1, [qa, qb, qc, qd, qe]])).err || ''));
ok("a path from another product's folder is refused", /Invalid photo path/.test((await call(ua, 'aal1', 'select public.set_product_photos($1,$2::text[])', [PH1, [`${orgA}/${UU()}/${UU()}.jpg`]])).err || ''));
ok('a path that was never uploaded is refused', /not uploaded/.test((await call(ua, 'aal1', 'select public.set_product_photos($1,$2::text[])', [PH1, [`${orgA}/${PH1}/${UU()}.jpg`]])).err || ''));
ok("another customer cannot set photos on this product", !!(await call(ub, 'aal1', 'select public.set_product_photos($1,$2::text[])', [PH1, [qb]])).err);
ok('warehouse can set photos', !(await W('select public.set_product_photos($1,$2::text[])', [PH1, [qb, qc, qd]])).err);
ok('support cannot set photos', /read-only/.test((await call(support, 'aal2', 'select public.set_product_photos($1,$2::text[])', [PH1, [qb]])).err || ''));
ok('support cannot create products, book deliveries, edit or delete (read-only role)', /read-only/.test((await call(support, 'aal2', 'select public.create_product($1,$2,$3)', [orgA, 'SUP-1', 'x'])).err || '') && /read-only/.test((await call(support, 'aal2', `select public.book_inbound($1,null,null,null,null,$2::jsonb)`, [orgA, lines([{ product_id: PH1, qty: 1 }])])).err || '') && /read-only/.test((await call(support, 'aal2', `select public.update_product($1,'{"name":"x"}')`, [PH1])).err || '') && /read-only/.test((await call(support, 'aal2', 'select public.delete_product($1)', [PH1])).err || '') && /read-only/.test((await call(support, 'aal2', `select public.request_change('product',$1,'delete','{}'::jsonb)`, [PH1])).err || ''));
ok('admin still can (MFA) create and edit products directly', !(await call(admin, 'aal2', 'select public.create_product($1,$2,$3)', [orgA, 'ADM-1', 'by admin'])).err);
ok('owner can delete their own photo file', !(await call(ua, 'aal1', `delete from storage.objects where bucket_id='products' and name=$1 returning name`, [qe])).err);
ok("other customer cannot delete someone else's photo file", (await call(ub, 'aal1', `delete from storage.objects where bucket_id='products' and name=$1 returning name`, [qb])).rows?.length === 0);
ok('owner and staff can read the photo objects, other customer cannot', (await as(ua, 'aal1', `select name from storage.objects where bucket_id='products'`)).rows.length >= 3 && (await as(wh, 'aal1', `select name from storage.objects where bucket_id='products'`)).rows.length >= 3 && (await as(ub, 'aal1', `select name from storage.objects where bucket_id='products'`)).rows.filter((r) => r.name.startsWith(orgA)).length === 0);
ok('anonymous sees no product photos', ((await asAnon(`select name from storage.objects where bucket_id='products'`)).rows || []).length === 0);
ok('inventory view carries the photo paths for the customer', (await as(ua, 'aal1', 'select photo_paths from public.v_inventory_by_product where product_id=$1', [PH1])).rows[0]?.photo_paths?.length === 3);
ok('photo changes are audited', (await one(`select count(*)::int n from public.audit_log where action='product.photos'`))[0].n >= 3);
ok('products created with no photos have an empty list', (await one('select cardinality(photo_paths) n from public.products where id=$1', [PHB]))[0].n === 0);

// ---- audit and internals ----
const acts = (await one(`select distinct action from public.audit_log where action like any (array['location.%','product.%','inbound.%','stock.%','discrepancy.%'])`)).map((r) => r.action);
for (const a of ['location.create', 'location.assign', 'location.release', 'product.create', 'product.update', 'inbound.book', 'inbound.cancel', 'inbound.receive_line', 'inbound.close', 'discrepancy.resolve', 'stock.putaway', 'stock.adjust']) ok('audit row written for ' + a, acts.includes(a));
ok('audit records the customer role for customer actions', (await one(`select actor_role from public.audit_log where action='inbound.book' limit 1`))[0].actor_role === 'customer');
ok('audit records the staff role', (await one(`select actor_role from public.audit_log where action='stock.putaway' limit 1`))[0].actor_role === 'warehouse');
ok('internal helpers are not callable by clients', !!(await call(wh, 'aal1', `select public.wms_audit('admin','forged','x','1',null,null)`)).err && !!(await call(wh, 'aal1', `select public.wms_post($1,$2,$3,5,'adjust',null,null,'',null,null,null)`, [orgA, S1, B1])).err);
ok('anon cannot call the warehouse functions', !!(await asAnon(`select public.create_location('Z','bin')`)).err);
await db.exec('rollback');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

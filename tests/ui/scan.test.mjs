import { ROOT } from '../lib/root.mjs';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>', { url: 'https://2ace.pl/scan' });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, confirm: () => true });
globalThis.crypto ??= (await import('node:crypto')).webcrypto; window.confirm = () => true;
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !x ? '' : '  -> ' + x)); };
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms)); const text = () => document.body.textContent.replace(/\s+/g, ' ');
const DB = { products: [{ id: 'p1', photo_paths: ['o1/p1/a.jpg'] }], staff_users: [{ user_id: 'u', role: 'warehouse', active: true }],
  inbound_bookings: [{ id: 'b1', org_id: 'o1', ref: 'IN-000001', status: 'receiving', expected_date: '2026-11-01', carrier: 'DHL', tracking: 'T1', inbound_lines: [{ expected_qty: 10 }] }],
  inbound_lines: [{ booking_id: 'b1', product_id: 'p1', expected_qty: 10, products: { sku: 'SKU-1', name: 'Blue mug' } }],
  receipt_lines: [{ booking_id: 'b1', product_id: 'p1', qty: 4, condition: 'good' }],
  stock_levels: [{ org_id: 'o1', product_id: 'p1', location_id: 'l1', lot: '', on_hand: 6, reserved: 0, locations: { code: 'R1', kind: 'receiving' } }] };
const mkQuery = (table) => { const f = []; let one = false; const q = new Proxy({}, { get(_, k) { if (k === 'then') return (res) => { const r = (DB[table] || []).filter((row) => f.every((fn) => fn(row))); return res({ data: one ? (r[0] ?? null) : r, error: null }); }; return (...a) => { if (k === 'eq') f.push((row) => row[a[0]] === a[1]); else if (k === 'in') f.push((row) => a[1].includes(row[a[0]])); else if (k === 'maybeSingle') one = true; return q; }; } }); return q; };
const rpcs = [];
const uploads = []; const fetches = []; globalThis.fetch = async (u, o) => { fetches.push([String(u), JSON.parse(o.body)]); return { ok: true }; };
const sb = { storage: { from: () => ({ createSignedUrl: async (p) => ({ data: { signedUrl: 'https://x/' + p } }), upload: async (p, b, o) => { uploads.push(p); return { error: null }; } }) }, auth: { getSession: async () => ({ data: { session: { user: { id: 'u' }, access_token: 'tok' } } }) }, from: mkQuery,
  rpc: async (n, a) => { rpcs.push([n, a]); const hook = (DB.__rpc || {})[n]; if (hook) { const r = hook(a); return r && r.__error ? { data: null, error: { message: r.__error } } : { data: r, error: null }; } if (n === 'wms_orgs') return { data: [{ id: 'o1', name: 'Acme' }], error: null };
    if (n === 'wms_lookup') { if (a.p_code === '590') return { data: { type: 'product', id: 'p1', org_id: 'o1', sku: 'SKU-1', name: 'Blue mug', ambiguous: false }, error: null }; if (a.p_code === 'A-01-01') return { data: { type: 'location', id: 'l2', code: 'A-01-01', kind: 'bin' }, error: null }; return { data: { type: 'none' }, error: null }; }
    if (n === 'receive_line') return { data: { condition: a.p_condition, receipt_id: 'rl1' }, error: null }; if (n === 'putaway' && a.p_to === 'bad') return { data: null, error: { message: 'not assigned' } };
    return { data: { discrepancies: DB.__disc ? 1 : 0 }, error: null }; } };
window.supabase = { createClient: () => sb }; window.__ANON__ = 'anon';
await import('file://' + ROOT + '/assets/admin/scan.js'); await tick();
const click = async (label) => { [...document.querySelectorAll('button')].find((b) => b.textContent.includes(label)).click(); await tick(); };
const scan = async (code) => { const i = document.querySelector('input.scan'); i.value = code; i.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' })); await tick(); };

ok('home shows Receive and Put away', /Receive/.test(text()) && /Put away/.test(text()));
await click('Receive'); ok('delivery list shows the open delivery with customer name', /IN-000001/.test(text()) && /Acme/.test(text()));
await click('IN-000001'); ok('delivery shows progress 4 / 10', /4 \/ 10 good/.test(text()));
await scan('nope'); ok('unknown barcode gives an error', /No product with that code/.test(text()));
await scan('590'); ok('the card shows the product photo so the right item is picked', !!document.querySelector('img.pimg[src="https://x/o1/p1/a.jpg"]'));
ok('known product opens the quantity card', /SKU-1/.test(text()) && !!document.querySelector('input.qty'));
document.querySelector('input.qty').value = '6'; await click('Good');
const rl = rpcs.find(([n]) => n === 'receive_line'); ok('Good posts qty 6 with a key against the right delivery', rl && rl[1].p_qty === 6 && rl[1].p_condition === 'good' && rl[1].p_booking === 'b1' && rl[1].p_key.length > 8, JSON.stringify(rl));
await scan('590'); { const f = document.querySelector('input[type=file]'); Object.defineProperty(f, 'files', { value: [new window.File(['x'], 'a.jpg', { type: 'image/jpeg' })] }); }
await click('Damaged'); await tick(120);
ok('damaged with a photo: uploaded to org/booking and attached', uploads.length === 1 && /^o1\/b1\/[0-9a-f-]{36}\.jpg$/.test(uploads[0]) && rpcs.some(([n, a]) => n === 'add_receipt_photos' && a.p_line === 'rl1'), JSON.stringify([uploads, rpcs.map((r) => r[0])]));
rpcs.length = 0; DB.__disc = true;
await click('Finish delivery'); ok('finishing calls receive_close', rpcs.some(([n]) => n === 'receive_close'));
ok('differences trigger the customer email through admin-api', fetches.some(([u, b]) => /functions\/v1\/admin-api$/.test(u) && b.action === 'discrepancy.notify' && b.booking_id === 'b1'), JSON.stringify(fetches));
await click('‹'); await click('Put away'); await scan('590'); ok('put away card shows the photo too', !!document.querySelector('img.pimg'));
ok('put away finds stock waiting in receiving', /6 waiting at R1/.test(text()), text().slice(0, 200));
await scan('nope'); ok('scanning a non-bin as destination is refused', /Scan the bin label/.test(text()));
await scan('A-01-01'); const pa = rpcs.find(([n]) => n === 'putaway');
ok('scanning the bin posts the move with a key', pa && pa[1].p_org === 'o1' && pa[1].p_from === 'l1' && pa[1].p_to === 'l2' && pa[1].p_qty === 6 && pa[1].p_key, JSON.stringify(pa));
ok('XSS-safe: nothing from data became markup', !document.querySelector('img'));


// ---------- pick and pack ----------
const toHome = async () => { for (let i = 0; i < 8 && !/Collect the items of an order/.test(text()); i++) { const b = document.querySelector('.back'); if (!b) break; b.click(); await tick(); } };
await toHome(); ok('home now has Pick and Pack tiles too', /Pick/.test(text()) && /Pack/.test(text()) && document.querySelectorAll('.tile').length === 4);
DB.orders = [
  { id: 'od1', org_id: 'o1', ref: 'ORD-000001', status: 'allocated', ship_name: 'Jan Nowak', ship_line1: 'Prosta 1', ship_postal: '00-001', ship_city: 'Warszawa', ship_country: 'PL', created_at: '2026-10-05T10:00:00Z', allocations: [{ status: 'reserved' }, { status: 'reserved' }] },
  { id: 'od2', org_id: 'o1', ref: 'ORD-000002', status: 'picking', ship_name: 'Anna', ship_line1: 'Str 5', ship_postal: '10115', ship_city: 'Berlin', ship_country: 'DE', created_at: '2026-10-05T11:00:00Z', allocations: [{ status: 'picked' }, { status: 'picked' }] },
  { id: 'od3', org_id: 'o1', ref: 'ORD-000003', status: 'held', ship_name: 'X', ship_line1: 'a', ship_postal: '1', ship_city: 'C', ship_country: 'PL', created_at: '2026-10-05T12:00:00Z', allocations: [] }];
DB.allocations = [
  { id: 'al2', order_id: 'od1', qty: 2, status: 'reserved', product_id: 'p2', location_id: 'lB', locations: { code: 'A-02-01' }, products: { sku: 'MUG-RED', name: 'Red mug', photo_paths: [] } },
  { id: 'al1', order_id: 'od1', qty: 4, status: 'reserved', product_id: 'p1', location_id: 'l2', locations: { code: 'A-01-01' }, products: { sku: 'MUG-BLUE', name: 'Blue mug', photo_paths: ['o1/p1/a.jpg'] } }];
DB.order_lines = [{ order_id: 'od2', product_id: 'p1', qty: 2, products: { sku: 'MUG-BLUE', name: 'Blue mug' } }, { order_id: 'od2', product_id: 'p2', qty: 1, products: { sku: 'MUG-RED', name: 'Red mug' } }];
DB.__rpc = { wms_lookup: (a) => { const m = { 'A-01-01': { type: 'location', id: 'l2', code: 'A-01-01', kind: 'bin' }, 'A-02-01': { type: 'location', id: 'lB', code: 'A-02-01', kind: 'bin' }, '590': { type: 'product', id: 'p1', org_id: 'o1', sku: 'MUG-BLUE', name: 'Blue mug', ambiguous: false }, '600': { type: 'product', id: 'p2', org_id: 'o1', sku: 'MUG-RED', name: 'Red mug', ambiguous: false }, '700': { type: 'product', id: 'p9', org_id: 'o1', sku: 'OTHER', name: 'Other', ambiguous: false } }; return m[a.p_code] || { type: 'none' }; },
  pick_line: () => ({ remaining: DB.__remaining ?? 1, replayed: false }), pack_order: (a) => ({ parcels: a.p_parcels.length, replayed: false }), report_pick_problem: () => null };
await click('Pick');
ok('the pick list shows orders with lines left to pick, and hides the rest', /ORD-000001/.test(text()) && /2 lines to pick/.test(text()) && !/ORD-000002/.test(text()) && !/ORD-000003/.test(text()), text().slice(0, 200));
await click('ORD-000001');
ok('lines are walked in bin order: the first stop is A-01-01 with its photo', /Go to A-01-01/.test(text()) && /MUG-BLUE/.test(text()) && /Pick\s*4/.test(text()) && !!document.querySelector('img.pimg'), text().slice(0, 200));
ok('the whole order is listed with what comes next', /A-02-01 · MUG-RED/.test(text()));
await scan('A-02-01'); ok('the wrong bin is refused and says where to go', /Wrong bin. This line is at A-01-01/.test(text()));
await scan('nonsense'); ok('a code that is not a bin is refused', /Scan the bin label/.test(text()));
await scan('A-01-01'); ok('the right bin moves on to scanning the product', /Scan the product/.test(text()));
await scan('600'); ok('the wrong product is refused, naming the one needed', /Wrong item. This line needs MUG-BLUE/.test(text()));
await scan('700'); ok('another product that is not on the line is refused too', /Wrong item/.test(text()));
await scan('590'); ok('the right product moves on to confirming the quantity', /Take 4 and confirm/.test(text()) && !!document.querySelector('button.big'));
rpcs.length = 0; await click('Picked 4');
const pl = rpcs.find(([n]) => n === 'pick_line'); ok('confirming picks that allocation with a repeat-safe key', pl && pl[1].p_allocation === 'al1' && typeof pl[1].p_key === 'string' && pl[1].p_key.length > 8, JSON.stringify(pl));
ok('after a pick the screen says how many remain', /Picked. 1 to go/.test(text()));
// the problem path
await click("Can't find it"); ok('"Can\'t find it" asks what is wrong and warns the order will stop', /What is wrong\?/.test(text()) && /goes on hold/.test(text()));
{ const t = document.querySelector('textarea'); t.value = 'Bin A-01-01 is empty'; rpcs.length = 0; await click('Stop this order'); }
const rp = rpcs.find(([n]) => n === 'report_pick_problem'); ok('the problem is reported with the note', rp && rp[1].p_order === 'od1' && rp[1].p_note === 'Bin A-01-01 is empty', JSON.stringify(rp));
ok('the order is stopped and the list returns', /Order stopped and put on hold/.test(text()) && /lines to pick|Nothing to pick/.test(text()));
// all picked -> pack
DB.allocations = DB.allocations.map((a) => ({ ...a, status: 'picked' })); DB.orders[0].allocations = [{ status: 'picked' }, { status: 'picked' }]; DB.orders[0].status = 'picking';
await toHome(); await click('Pick');
ok('an order with nothing left to pick is no longer on the pick list', /Nothing to pick right now/.test(text()));
await toHome(); await click('Pack');
ok('the pack list shows only picked orders', /ORD-000001/.test(text()) && /ORD-000002/.test(text()) && !/ORD-000003/.test(text()) && /Picked, ready to pack/.test(text()));
await click('ORD-000002');
ok('packing shows who it ships to and what to scan', /Berlin/.test(text()) && /MUG-BLUE/.test(text()) && /0 \/ 2 scanned/.test(text()) && /Scan every item/.test(text()));
await scan('700'); ok('an item not on the order is refused', /OTHER is not on this order/.test(text()));
await scan('590'); ok('a scan counts one unit', /1 \/ 2 scanned/.test(text()));
await scan('590'); await scan('590'); ok('scanning more than ordered is refused', /You already scanned all 2 of MUG-BLUE/.test(text()) && /2 \/ 2 scanned/.test(text()));
await click('+1 (no barcode)'); ok('an item without a barcode can be counted by tapping', /Everything is in/.test(text()), text().slice(0, 300));
ok('when everything is counted the parcel form appears', /Everything is in/.test(text()) && /Parcel 1/.test(text()) && document.querySelectorAll('input[type=number]').length === 4);
{ const f = [...document.querySelectorAll('input[type=number]')]; f[0].value = '1.8'; f[1].value = '30'; f[2].value = '20'; f[3].value = '15'; f.forEach((i) => i.dispatchEvent(new window.Event('input'))); }
await click('Add another parcel'); ok('a second parcel can be added', /Parcel 2/.test(text()));
{ const f = [...document.querySelectorAll('input[type=number]')]; f[4].value = '0.9'; f[5].value = '25.5'; f[6].value = '18'; f[7].value = '10'; f.forEach((i) => i.dispatchEvent(new window.Event('input'))); }
rpcs.length = 0; await click('Finish packing');
const po = rpcs.find(([n]) => n === 'pack_order');
ok('finishing sends the order and each parcel with weight in grams and sizes in cm', po && po[1].p_order === 'od2' && po[1].p_parcels.length === 2 && po[1].p_parcels[0].weight_g === 1800 && po[1].p_parcels[0].length_cm === 30 && po[1].p_parcels[1].weight_g === 900 && po[1].p_parcels[1].width_cm === 18 && po[1].p_parcels[1].length_cm === 25.5, JSON.stringify(po));
ok('the screen confirms the packing', /ORD-000002 packed in 2 parcels/.test(text()));
DB.__rpc.pack_order = () => ({ __error: 'Parcel 1: enter a weight between 1 g and 70 kg' });
await toHome(); await click('Pack'); await click('ORD-000002');
{ await scan('590'); await scan('590'); await scan('600'); const f = [...document.querySelectorAll('input[type=number]')]; f[0].value = '0'; f.forEach((i) => i.dispatchEvent(new window.Event('input'))); await click('Finish packing'); }
ok('a server refusal is shown and the screen stays on the parcel form', /enter a weight between 1 g and 70 kg/.test(text()) && /Parcel 1/.test(text()));

// ---------- receiving says where the goods went ----------
await toHome(); DB.__rpc = { receive_line: () => ({ condition: 'good', receipt_id: 'rl9', location: 'ACME-01' }) };
await click('Receive'); await click('IN-000001'); await scan('590'); document.querySelector('input.qty').value = '3'; await click('Good');
ok('receiving good goods says they are stored in the customer\'s bin and available now', /Stored in ACME-01. Available now/.test(text()), text().slice(0, 200));
DB.__rpc = { receive_line: () => ({ condition: 'unexpected', receipt_id: 'rl9', location: 'RECEIVING' }) };
await scan('590'); document.querySelector('input.qty').value = '1'; await click('Good');
ok('goods that were not on the delivery are still flagged', /NOT on the booking/.test(text()));

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

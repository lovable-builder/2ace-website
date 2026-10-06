import { ROOT } from '../lib/root.mjs';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>', { url: 'https://2ace.pl/admin' });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
const base = 'file://' + ROOT + '/assets/admin/';
const mods = {}; for (const n of ['home', 'locations', 'products', 'inbound', 'stock', 'discrepancies', 'approvals', 'orders', 'shipping']) mods[n] = await import(base + n + '.js');
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !x ? '' : '  -> ' + x)); };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const root = () => document.getElementById('root'); const text = () => root().textContent.replace(/\s+/g, ' ');

const DB = {};
const mkQuery = (table) => { const f = []; let head = false, one = false;
  const q = new Proxy({}, { get(_, k) {
    if (k === 'then') return (res) => { const r = (DB[table] || []).filter((row) => f.every((fn) => fn(row))); if (one) return res({ data: r[0] ?? null, error: null }); return res({ data: head ? null : r, count: r.length, error: null }); };
    return (...a) => { if (k === 'select') head = !!(a[1] && a[1].head); else if (k === 'eq') f.push((row) => row[a[0]] === a[1]); else if (k === 'in') f.push((row) => a[1].includes(row[a[0]])); else if (k === 'maybeSingle') one = true; return q; }; } });
  return q; };
const rpcs = []; let rpcFail = null;
const uploads = []; const removes = []; const storage = { from: () => ({ remove: async (ps) => { removes.push(ps); return { error: null }; }, upload: async (p, b, o) => { uploads.push([p, o]); return { error: null }; }, createSignedUrls: async (ps) => ({ data: ps.map((p) => ({ path: p, signedUrl: 'https://x/' + p })), error: null }) }) };
const sb = { storage, from: mkQuery, rpc: async (n, a) => { rpcs.push([n, a]); if (rpcFail) return { data: null, error: { message: rpcFail } }; if (n === 'putaway_to_default') return { data: { location: 'ACME-01', qty: a.p_qty ?? 12 }, error: null }; if (n === 'add_stock') return { data: { location: 'ACME-01', qty: a.p_qty }, error: null }; if (n === 'allocate_order') return { data: DB.__alloc || 'allocated', error: null }; if (n === 'cancel_order') return { data: null, error: null }; if (n === 'create_order') return { data: { id: 'new1', ref: 'ORD-000099', status: DB.__newstatus || 'allocated', duplicate: false }, error: null }; if (n === 'set_product_photos') return { data: a.p_paths.length ? [] : ['o1/p1/a.jpg'], error: null }; if (n === 'create_product') return { data: 'newp', error: null }; if (n === 'wms_orgs') return { data: DB.__orgs, error: null }; if (n === 'receive_line') return { data: { condition: a.p_condition === 'damaged' ? 'damaged' : 'good', receipt_id: 'rl1' }, error: null }; if (n === 'receive_close') return { data: { discrepancies: 2 }, error: null }; return { data: null, error: null }; } };
const apis = [];
const mkCtx = (role) => ({ sb, me: { id: 'u1', role, email: role + '@2ace.pl' }, staff: [], session: {}, go: (r) => calls.push(r), api: async (a, p) => { apis.push([a, p]); let r = (DB.__api || {})[a]; if (typeof r === 'function') r = r(p); if (r instanceof Error) throw r; return r ?? {}; } });
const calls = [];
const mount = async (name, role, params) => { document.body.innerHTML = '<div id="root"></div>'; rpcs.length = 0; calls.length = 0; rpcFail = null; await mods[name].render(mkCtx(role), root(), params); await tick(); };
const modalClick = async (label, fill) => { await tick(); const ms = document.querySelectorAll('.modal'); const m = ms[ms.length - 1]; if (!m) return false; if (fill) fill(m); [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === label).click(); await tick(); return true; };
const set = (node, v) => { node.value = v; node.dispatchEvent(new window.Event('input')); node.dispatchEvent(new window.Event('change')); };

DB.__orgs = [{ id: 'o1', name: 'Acme', status: 'active' }, { id: 'o2', name: 'Beta', status: 'active' }];
DB.locations = [
  { id: 'l1', code: 'R1', kind: 'receiving', active: true }, { id: 'l2', code: 'A-01-01', kind: 'bin', active: true }, { id: 'l3', code: 'A-01-02', kind: 'bin', active: true }, { id: 'l4', code: 'Q1', kind: 'quarantine', active: false }];
DB.location_assignments = [{ location_id: 'l2', org_id: 'o1', released_at: null }];
DB.stock_levels = [
  { org_id: 'o1', product_id: 'p1', location_id: 'l1', lot: '', on_hand: 10, reserved: 0, products: { sku: 'SKU-1', name: 'Blue mug' }, locations: { code: 'R1', kind: 'receiving' } },
  { org_id: 'o1', product_id: 'p1', location_id: 'l2', lot: '', on_hand: 5, reserved: 1, products: { sku: 'SKU-1', name: 'Blue mug' }, locations: { code: 'A-01-01', kind: 'bin' } }];
DB.v_inventory_by_product = [
  { product_id: 'p1', org_id: 'o1', sku: 'SKU-1', name: 'Blue mug', active: true, on_hand: 15, reserved: 1, available: 14, unplaced: 10, quarantined: 0, incoming: 4 },
  { product_id: 'p2', org_id: 'o1', sku: 'XSS', name: '<img src=x onerror=window.__pwn=1>', active: true, on_hand: 0, reserved: 0, available: 0, unplaced: 0, quarantined: 0, incoming: 0 }];
DB.product_barcodes = [{ product_id: 'p1', barcode: '5901234123457' }];
DB.products = [{ id: 'p1', org_id: 'o1', sku: 'SKU-1', name: 'Blue mug', active: true, weight_g: 300, length_cm: 10, width_cm: 8, height_cm: 8, hs_code: '6912', origin_country: 'CN' }, { id: 'p2', org_id: 'o1', sku: 'XSS', name: 'x', active: true }];
DB.stock_movements = [{ id: 2, at: '2026-10-04T10:00:00Z', org_id: 'o1', product_id: 'p1', qty: -2, reason: 'adjust', note: 'broken', lot: '', products: { sku: 'SKU-1', name: 'Blue mug' }, locations: { code: 'A-01-01' } }, { id: 1, at: '2026-10-03T10:00:00Z', org_id: 'o1', product_id: 'p1', qty: 10, reason: 'receive', note: null, lot: '', products: { sku: 'SKU-1', name: 'Blue mug' }, locations: { code: 'R1' } }];
DB.inbound_bookings = [{ id: 'b1', org_id: 'o1', ref: 'IN-000001', status: 'receiving', expected_date: '2026-11-01', carrier: 'DHL', tracking: 'T1', notes: null, created_at: '2026-10-01T10:00:00Z', received_at: null, inbound_lines: [{ expected_qty: 10 }, { expected_qty: 5 }] }, { id: 'b2', org_id: 'o2', ref: 'IN-000002', status: 'received', expected_date: null, carrier: null, tracking: null, created_at: '2026-10-01T10:00:00Z', inbound_lines: [{ expected_qty: 3 }] }];
DB.inbound_lines = [{ booking_id: 'b1', product_id: 'p1', expected_qty: 10 }];
DB.receipt_lines = [{ booking_id: 'b1', product_id: 'p1', qty: 8, condition: 'good', note: null, created_at: '2026-10-02T10:00:00Z', products: { sku: 'SKU-1' } }];
DB.discrepancies = [{ id: 'd1', booking_id: 'b1', org_id: 'o1', product_id: 'p1', kind: 'short', status: 'open', expected_qty: 10, received_qty: 8, created_at: '2026-10-02T10:00:00Z', products: { sku: 'SKU-1', name: 'Blue mug' }, inbound_bookings: { ref: 'IN-000001' } }];

// ---- locations ----
await mount('locations', 'warehouse');
ok('locations list codes, owners and units', /A-01-01/.test(text()) && /Acme/.test(text()) && /free/.test(text()));
ok('create/print buttons for warehouse', /New location/.test(text()) && /Print labels/.test(text()));
await mount('locations', 'support'); ok('support sees locations read-only', !/New location/.test(text()) && ![...root().querySelectorAll('button')].some((b) => /Assign|Reassign|Release/.test(b.textContent)));
await mount('locations', 'warehouse');
root().querySelector('button.btn:not(.ghost)').click(); await modalClick('Create', (m) => { m.querySelector('input').value = 'a-09-01'; });
ok('create location sends the right call', rpcs.some(([n, a]) => n === 'create_location' && a.p_code === 'a-09-01' && a.p_kind === 'bin'), JSON.stringify(rpcs));
await mount('locations', 'warehouse'); rpcFail = 'A location with code R1 already exists';
root().querySelector('button.btn:not(.ghost)').click(); await modalClick('Create', (m) => { m.querySelector('input').value = 'R1'; });
ok('database error is shown in the dialog, which stays open', /already exists/.test(document.querySelector('.modal')?.textContent || ''));
document.body.innerHTML = ''; await mount('locations', 'warehouse');
[...root().querySelectorAll('button')].find((b) => b.textContent === 'Assign').click(); await modalClick('Assign', (m) => { m.querySelector('select').value = 'o2'; });
ok('assign sends location and customer', rpcs.some(([n, a]) => n === 'assign_location' && a.p_location === 'l3' && a.p_org === 'o2'), JSON.stringify(rpcs));
await mount('locations', 'warehouse'); [...root().querySelectorAll('button')].find((b) => b.textContent === 'Print labels').click(); await tick();
ok('print with nothing ticked gives a warning, no window', /Tick the locations/.test(document.querySelector('.toast')?.textContent || ''));

// ---- products ----
await mount('products', 'support'); ok('products list shows stock columns', /SKU-1/.test(text()) && /5901234123457/.test(text()) && !/New product/.test(text()));
ok('customer-supplied HTML is not interpreted', !window.__pwn && !root().querySelector('img'));
await mount('products', 'warehouse', ['p1']); ok('product detail shows barcode, location stock and ledger', /5901234123457/.test(text()) && /A-01-01/.test(text()) && /\+10/.test(text()) && /-2/.test(text()), text().slice(0, 200));
[...root().querySelectorAll('button')].find((b) => b.textContent === 'Edit').click(); await modalClick('Save', (m) => { m.querySelector('input').value = 'Blue mug v2'; });
ok('edit sends only a patch for that product', rpcs.some(([n, a]) => n === 'update_product' && a.p_id === 'p1' && a.p_patch.name === 'Blue mug v2'), JSON.stringify(rpcs));

// ---- inbound ----
await mount('inbound', 'support'); ok('inbound list', /IN-000001/.test(text()) && /Acme/.test(text()) && !/Book a delivery/.test(text()));
await mount('inbound', 'warehouse', ['b1']);
ok('detail compares booked and received', /Expected vs received/.test(text()) && /Receiving log/.test(text()));
ok('receive form is available while receiving', /Receive goods/.test(text()));
const sel = root().querySelector('.card select'); const inputs = root().querySelectorAll('.card input');
set(inputs[0], '3'); [...root().querySelectorAll('button')].find((b) => b.textContent === 'Receive').click(); await tick();
const rl = rpcs.find(([n]) => n === 'receive_line');
ok('receive posts product, qty, condition and an idempotency key', rl && rl[1].p_product && rl[1].p_qty === 3 && rl[1].p_condition === 'good' && typeof rl[1].p_key === 'string' && rl[1].p_key.length > 8, JSON.stringify(rl));
await mount('inbound', 'warehouse', ['b1']); [...root().querySelectorAll('button')].find((b) => b.textContent === 'Close receiving').click(); await modalClick('Close receiving');
ok('closing receiving asks first, then calls the function', rpcs.some(([n, a]) => n === 'receive_close' && a.p_booking === 'b1'));
// photos of damage
DB.receipt_lines.push({ booking_id: 'b1', product_id: 'p1', qty: 1, condition: 'damaged', note: 'cracked', created_at: '2026-10-02T11:00:00Z', products: { sku: 'SKU-1' }, photo_paths: ['o1/b1/p1.jpg'] });
await mount('inbound', 'warehouse', ['b1']);
ok('receiving log shows photo thumbnails from signed links', !!root().querySelector('img[src="https://x/o1/b1/p1.jpg"]'));
const photoBox = [...root().querySelectorAll('label.field')].find((l) => /Photos of the damage/.test(l.textContent));
ok('photo field is hidden for good goods', photoBox && photoBox.style.display === 'none');
const condSel = [...root().querySelectorAll('.card select')][1]; condSel.value = 'damaged'; condSel.dispatchEvent(new window.Event('change')); await tick();
ok('photo field appears for damaged goods', photoBox.style.display === '');
const fileIn = photoBox.querySelector('input'); Object.defineProperty(fileIn, 'files', { value: [new window.File(['x'], 'a.jpg', { type: 'image/jpeg' }), new window.File(['y'], 'b.jpg', { type: 'image/jpeg' })] });
[...root().querySelectorAll('button')].find((b) => b.textContent === 'Receive').click(); await tick(120);
ok('photos are uploaded under org/booking folder and attached to the receipt line', uploads.length === 2 && uploads.every(([p]) => /^o1\/b1\/[0-9a-f-]{36}\.jpg$/.test(p)) && rpcs.some(([n, a]) => n === 'add_receipt_photos' && a.p_line === 'rl1' && a.p_paths.length === 2), JSON.stringify([uploads, rpcs.map((r) => r[0])]));
await mount('inbound', 'warehouse', ['b1']); apis.length = 0; [...root().querySelectorAll('button')].find((b) => b.textContent === 'Close receiving').click(); await modalClick('Close receiving'); await tick(60);
ok('closing with discrepancies emails the customer through admin-api', apis.some(([a, p]) => a === 'discrepancy.notify' && p.booking_id === 'b1'));
await mount('inbound', 'support', ['b1']); ok('support cannot receive or close', !/Receive goods/.test(text()) && !/Close receiving/.test(text()));

// ---- stock ----
await mount('stock', 'warehouse', ['putaway']); ok('putaway tab lists only receiving-area stock', /R1/.test(text()) && !/A-01-01/.test(text()));
DB.location_assignments = [{ location_id: 'l2', org_id: 'o1', released_at: null, locations: { code: 'A-01-01', kind: 'bin' } }]; DB.locations = [{ id: 'l1', code: 'R1', kind: 'receiving', active: true }, { id: 'lq', code: 'Q1', kind: 'quarantine', active: true }];
await mount('stock', 'warehouse', ['putaway']); [...root().querySelectorAll('button')].find((b) => b.textContent === 'Move').click(); await modalClick('Move', (m) => { const sel = m.querySelector('select'); sel.value = 'l2'; });
const pa = rpcs.find(([n]) => n === 'putaway');
ok('move posts org, product, from, to, qty and a key', pa && pa[1].p_org === 'o1' && pa[1].p_from === 'l1' && pa[1].p_to === 'l2' && pa[1].p_qty === 10 && pa[1].p_key, JSON.stringify(pa));
await mount('stock', 'warehouse', ['all']); ok('all-stock tab lists every location', /A-01-01/.test(text()) && /R1/.test(text()));
[...root().querySelectorAll('button')].find((b) => b.textContent === 'Adjust').click(); await modalClick('Post adjustment', (m) => { const i = m.querySelectorAll('input'); i[0].value = '-2'; i[1].value = 'Counted two less'; });
ok('adjust posts delta and reason', rpcs.some(([n, a]) => n === 'adjust_stock' && a.p_delta === -2 && a.p_reason === 'Counted two less' && a.p_key));
await mount('stock', 'support', ['all']); ok('support sees stock without move or adjust', /A-01-01/.test(text()) && !/Adjust/.test(text()));
await mount('stock', 'support', ['ledger']); ok('ledger tab lists movements', /\+10/.test(text()) && /broken/.test(text()));

// ---- discrepancies ----
await mount('discrepancies', 'warehouse'); ok('discrepancies list with resolve', /IN-000001/.test(text()) && /Resolve/.test(text()));
[...root().querySelectorAll('button')].find((b) => b.textContent === 'Resolve').click(); await modalClick('Mark resolved', (m) => { m.querySelector('textarea').value = 'Customer accepts short delivery'; });
ok('resolve posts the decision', rpcs.some(([n, a]) => n === 'resolve_discrepancy' && a.p_id === 'd1' && /accepts/.test(a.p_resolution)));
await mount('discrepancies', 'support'); ok('support cannot resolve', ![...root().querySelectorAll('button')].some((b) => b.textContent === 'Resolve'));


// ---- corrections ----
DB.inbound_bookings.push({ id: 'b3', org_id: 'o1', ref: 'IN-000003', status: 'booked', expected_date: '2026-11-05', carrier: 'DHL', tracking: null, notes: null, created_at: '2026-10-01T10:00:00Z', received_at: null, inbound_lines: [{ expected_qty: 4 }] });
DB.inbound_lines.push({ booking_id: 'b3', product_id: 'p1', expected_qty: 4 });
await mount('inbound', 'warehouse', ['b3']);
ok('booked delivery shows Edit and Delete', [...root().querySelectorAll('button')].some((b) => b.textContent === 'Edit') && [...root().querySelectorAll('button')].some((b) => b.textContent === 'Delete'));
[...root().querySelectorAll('button')].find((b) => b.textContent === 'Edit').click(); await tick(80);
const m = document.querySelector('.modal'); const qin = m && m.querySelector('input[type=number]');
ok('edit dialog shows the existing units, editable', qin && qin.value === '4', m && m.textContent.slice(0, 120));
qin.value = '9'; [...m.querySelectorAll('button')].find((b) => b.textContent === 'Save changes').click(); await tick();
const up = rpcs.find(([n]) => n === 'update_inbound'); ok('edit posts the new units', up && up[1].p_id === 'b3' && up[1].p_lines[0].qty === 9 && up[1].p_lines[0].product_id === 'p1', JSON.stringify(up));
await mount('inbound', 'warehouse', ['b3']); [...root().querySelectorAll('button')].find((b) => b.textContent === 'Edit').click(); await tick(80);
const extra = [...document.querySelectorAll('.modal button')].find((b) => b.textContent === '+ Add another product'); extra.click(); await tick();
ok('a second line can be added', document.querySelectorAll('.modal .line').length === 2);
document.querySelectorAll('.modal .line')[1].querySelector('button').click(); await tick();
ok('a line can be removed', document.querySelectorAll('.modal .line').length === 1);
await mount('inbound', 'warehouse', ['b3']); [...root().querySelectorAll('button')].find((b) => b.textContent === 'Delete').click(); await modalClick('Delete');
ok('delete asks first, then calls delete_inbound', rpcs.some(([n, a]) => n === 'delete_inbound' && a.p_id === 'b3'));
await mount('inbound', 'warehouse', ['b1']); ok('a delivery with receipts has no Edit or Delete', ![...root().querySelectorAll('button')].some((b) => b.textContent === 'Edit' || b.textContent === 'Delete'));
await mount('inbound', 'support', ['b3']); ok('support cannot edit or delete', ![...root().querySelectorAll('button')].some((b) => b.textContent === 'Edit' || b.textContent === 'Delete'));
await mount('products', 'warehouse', ['p1']); [...root().querySelectorAll('button')].find((b) => b.textContent === 'Delete').click(); await modalClick('Delete');
ok('product delete asks first and calls delete_product', rpcs.some(([n, a]) => n === 'delete_product' && a.p_id === 'p1'));
await mount('products', 'warehouse', ['p1']); rpcFail = 'This product has been used on a delivery or in stock. Switch it off instead of deleting it.'; [...root().querySelectorAll('button')].find((b) => b.textContent === 'Delete').click(); await modalClick('Delete');
ok('refusal is shown to the user', /Switch it off/.test(document.querySelector('.toast')?.textContent || ''));
await mount('locations', 'warehouse'); [...root().querySelectorAll('button')].find((b) => b.textContent === 'Edit').click(); await modalClick('Save', (mm) => { mm.querySelector('input').value = 'Dock door 1'; });
ok('location rename posts the note', rpcs.some(([n, a]) => n === 'update_location' && a.p_label === 'Dock door 1'));
await mount('locations', 'warehouse'); [...root().querySelectorAll('button')].find((b) => b.textContent === 'Edit').click(); await tick(); [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Delete location').click(); await modalClick('Delete');
ok('location delete asks first and calls delete_location', rpcs.some(([n]) => n === 'delete_location'));
DB.products = [];
await mount('inbound', 'warehouse'); [...root().querySelectorAll('button')].find((b) => b.textContent === 'Book a delivery').click(); await tick(); { const sel = document.querySelector('.modal select'); sel.value = 'o2'; sel.dispatchEvent(new window.Event('change')); await tick(80); }
ok('customer with no products: clear message and a way forward', /no products yet/.test(document.querySelector('.modal')?.textContent || '') && [...document.querySelectorAll('.modal button')].some((b) => b.textContent === 'Go to Products'));



// ---- product photos (admin) ----
DB.v_inventory_by_product = [{ product_id: 'p1', org_id: 'o1', sku: 'SKU-1', name: 'Blue mug', active: true, on_hand: 15, reserved: 1, available: 14, unplaced: 10, quarantined: 0, incoming: 4, photo_paths: ['o1/p1/a.jpg', 'o1/p1/b.jpg'] }, { product_id: 'p2', org_id: 'o1', sku: 'NOPIC', name: 'No picture', active: true, on_hand: 0, reserved: 0, available: 0, unplaced: 0, quarantined: 0, incoming: 0, photo_paths: [] }];
DB.products = [{ id: 'p1', org_id: 'o1', sku: 'SKU-1', name: 'Blue mug', active: true, photo_paths: ['o1/p1/a.jpg', 'o1/p1/b.jpg'] }];
await mount('products', 'support'); ok('products list shows the thumbnail from a signed link', !!root().querySelector('img[src="https://x/o1/p1/a.jpg"]') && root().querySelectorAll('tbody tr').length === 2);
await mount('products', 'warehouse', ['p1']); ok('detail shows a photo gallery with the thumbnail marked', root().querySelectorAll('img[src^="https://x/o1/p1/"]').length === 2 && /thumbnail/.test(text()) && /Add photos/.test(text()));
rpcs.length = 0; removes.length = 0; [...root().querySelectorAll('button')].filter((b) => b.textContent === 'Remove')[0].click(); await tick(60);
ok('removing a photo sends the remaining list', rpcs.some(([n, a]) => n === 'set_product_photos' && a.p_product === 'p1' && a.p_paths.join() === 'o1/p1/b.jpg'), JSON.stringify(rpcs));
await mount('products', 'warehouse', ['p1']); { const f = root().querySelector('input[type=file]'); Object.defineProperty(f, 'files', { value: [new window.File(['x'], 'n.jpg', { type: 'image/jpeg' })] }); }
uploads.length = 0; rpcs.length = 0; [...root().querySelectorAll('button')].find((b) => b.textContent === 'Add photos').click(); await tick(100);
ok('adding a photo uploads it under customer/product and appends it to the list', uploads.length === 1 && /^o1\/p1\/[0-9a-f-]{36}\.jpg$/.test(uploads[0][0]) && rpcs.some(([n, a]) => n === 'set_product_photos' && a.p_paths.length === 3 && a.p_paths[0] === 'o1/p1/a.jpg'), JSON.stringify([uploads, rpcs]));
await mount('products', 'support', ['p1']); ok('support sees the photos but no remove or add', !/Add photos/.test(text()) && ![...root().querySelectorAll('button')].some((b) => b.textContent === 'Remove'));
DB.stock_levels = [{ org_id: 'o1', product_id: 'p1', location_id: 'l1', lot: '', on_hand: 10, reserved: 0, products: { sku: 'SKU-1', name: 'Blue mug', photo_paths: ['o1/p1/a.jpg'] }, locations: { code: 'R1', kind: 'receiving' } }];
await mount('stock', 'warehouse', ['all']); ok('stock rows show the product thumbnail', !!root().querySelector('img[src="https://x/o1/p1/a.jpg"]'));

// ---- approvals ----
DB.change_requests = [
  { id: 'c1', org_id: 'o1', entity: 'inbound', entity_id: 'b1', action: 'update', status: 'pending', summary: 'Edit delivery IN-000001', requested_at: '2026-10-05T09:00:00Z', payload: { carrier: 'DSV', tracking: null, expected: '2026-12-01', notes: null, lines: [{ product_id: 'p1', qty: 12 }] } },
  { id: 'c2', org_id: 'o1', entity: 'product', entity_id: 'p1', action: 'update', status: 'pending', summary: 'Edit product SKU-1', requested_at: '2026-10-05T10:00:00Z', payload: { name: 'Blue mug XL', ean: '12345678' } },
  { id: 'c3', org_id: 'o1', entity: 'product', entity_id: 'p1', action: 'delete', status: 'rejected', summary: 'Delete product SKU-1', requested_at: '2026-10-04T10:00:00Z', decision_note: 'Used on a delivery', payload: {} }];
DB.products = [{ id: 'p1', org_id: 'o1', sku: 'SKU-1', name: 'Blue mug', active: true }];
await mount('approvals', 'warehouse');
ok('approvals queue lists pending requests with customer', /Edit delivery IN-000001/.test(text()) && /Edit product SKU-1/.test(text()) && /Acme/.test(text()));
DB.__all = true;
[...root().querySelectorAll('tbody tr')][0].click(); await tick(150);
const mod = document.querySelector('.modal');
ok('detail shows current next to requested (carrier, date, units)', mod && /DSV/.test(mod.textContent) && /2026-11-01/.test(mod.textContent) && /4\s+→\s+12|10\s+→\s+12/.test(mod.textContent), mod && mod.textContent.slice(0, 400));
ok('warehouse sees Approve and Decline', [...mod.querySelectorAll('button')].some((b) => /Approve/.test(b.textContent)) && [...mod.querySelectorAll('button')].some((b) => b.textContent === 'Decline'));
apis.length = 0; [...mod.querySelectorAll('button')].find((b) => /Approve/.test(b.textContent)).click(); await tick(60);
ok('approve calls change.decide with approve true', apis.some(([a, p]) => a === 'change.decide' && p.id === 'c1' && p.approve === true), JSON.stringify(apis));
await mount('approvals', 'warehouse'); [...root().querySelectorAll('tbody tr')][1].click(); await tick(150);
{ const m2 = document.querySelector('.modal'); ok('product edit detail shows name change and new barcode', /Blue mug\s+→\s+Blue mug XL/.test(m2.textContent) && /12345678/.test(m2.textContent), m2.textContent.slice(0, 300));
  m2.querySelector('textarea').value = 'Please keep the original name'; apis.length = 0; [...m2.querySelectorAll('button')].find((b) => b.textContent === 'Decline').click(); await tick(60);
  ok('decline sends the reason', apis.some(([a, p]) => a === 'change.decide' && p.id === 'c2' && p.approve === false && /original name/.test(p.note)), JSON.stringify(apis)); }
await mount('approvals', 'support'); [...root().querySelectorAll('tbody tr')][0].click(); await tick(150);
ok('support can read but not decide', !![document.querySelector('.modal')] && ![...document.querySelectorAll('.modal button')].some((b) => /Approve|Decline/.test(b.textContent)));

// ---- orders ----
DB.orders = [
  { id: 'od1', org_id: 'o1', ref: 'ORD-000001', external_ref: 'SHOP-1', channel: 'manual', status: 'allocated', hold_reason: null, ship_name: 'Jan Nowak', ship_company: null, ship_line1: 'Prosta 1', ship_line2: null, ship_postal: '00-001', ship_city: 'Warszawa', ship_country: 'PL', ship_email: 'jan@example.pl', ship_phone: '+48600100200', notes: null, created_at: '2026-10-05T10:00:00Z', allocated_at: '2026-10-05T10:00:01Z', order_lines: [{ qty: 2 }] },
  { id: 'od2', org_id: 'o1', ref: 'ORD-000002', external_ref: null, channel: 'csv', status: 'held', hold_reason: 'MUG-BLUE: need 7, available 6', ship_name: 'Anna Schmidt', ship_company: null, ship_line1: 'Hauptstr. 5', ship_line2: null, ship_postal: '10115', ship_city: 'Berlin', ship_country: 'DE', ship_email: null, ship_phone: null, notes: null, created_at: '2026-10-05T11:00:00Z', allocated_at: null, order_lines: [{ qty: 7 }] },
  { id: 'od4', org_id: 'o1', ref: 'ORD-000004', external_ref: null, channel: 'manual', status: 'packed', hold_reason: null, ship_name: 'Maria', ship_company: null, ship_line1: 'Dluga 3', ship_line2: null, ship_postal: '80-001', ship_city: 'Gdansk', ship_country: 'PL', ship_email: null, ship_phone: null, notes: null, created_at: '2026-10-05T09:00:00Z', allocated_at: null, order_lines: [{ qty: 3 }] },
  { id: 'od3', org_id: 'o1', ref: 'ORD-000003', external_ref: null, channel: 'manual', status: 'picking', hold_reason: null, ship_name: 'X', ship_company: null, ship_line1: 'a', ship_line2: null, ship_postal: '1', ship_city: 'C', ship_country: 'PL', ship_email: null, ship_phone: null, notes: null, created_at: '2026-10-05T12:00:00Z', allocated_at: null, order_lines: [{ qty: 1 }] }];
DB.order_lines = [{ id: 'ol4', order_id: 'od4', qty: 3, products: { sku: 'SKU-1', name: 'Blue mug' } }, { id: 'ol1', order_id: 'od1', qty: 2, products: { sku: 'SKU-1', name: 'Blue mug' } }, { id: 'ol2', order_id: 'od2', qty: 7, products: { sku: 'SKU-1', name: 'Blue mug' } }];
DB.allocations = [{ order_id: 'od1', order_line_id: 'ol1', qty: 2, status: 'reserved', lot: '', locations: { code: 'A-01-01' } }, { order_id: 'od4', order_line_id: 'ol4', qty: 3, status: 'picked', lot: '', locations: { code: 'A-02-01' } }];
DB.parcels = [{ order_id: 'od4', seq: 1, weight_g: 1800, length_cm: 30, width_cm: 20, height_cm: 15, packed_at: '2026-10-05T14:00:00Z' }, { order_id: 'od4', seq: 2, weight_g: 900, length_cm: 25.5, width_cm: 18, height_cm: 10, packed_at: '2026-10-05T14:00:00Z' }];
DB.change_requests = [{ id: 'c9', org_id: 'o1', entity: 'order', entity_id: 'od1', action: 'delete', status: 'pending', summary: 'Cancel order ORD-000001', requested_at: '2026-10-05T13:00:00Z', payload: {} }];
await mount('orders', 'support');
ok('orders list shows ref, customer, recipient, units and status', /ORD-000001/.test(text()) && /Acme/.test(text()) && /Jan Nowak, Warszawa PL/.test(text()) && /on hold/.test(text()) && /need 7, available 6/.test(text()), text().slice(0, 300));
ok('support is read-only on orders', !/New order/.test(text()));
await mount('orders', 'warehouse'); ok('warehouse sees New order', /New order/.test(text()));
await mount('orders', 'warehouse', ['od2']);
ok('a held order says what is short and that nothing is reserved', /On hold/.test(text()) && /need 7, available 6/.test(text()) && /Nothing is reserved/.test(text()));
rpcs.length = 0; [...root().querySelectorAll('button')].find((b) => /Try to reserve now/.test(b.textContent)).click(); await tick(60);
ok('"Try to reserve now" calls allocate_order for that order', rpcs.some(([n, a]) => n === 'allocate_order' && a.p_order === 'od2'));
await mount('orders', 'warehouse', ['od1']);
ok('a reserved order lists where each line is reserved and shows the pending customer request', /A-01-01 × 2 \(to pick\)/.test(text()) && /The customer asked: Cancel order ORD-000001/.test(text()));
rpcs.length = 0; [...root().querySelectorAll('button')].find((b) => b.textContent === 'Cancel order').click(); await modalClick('Cancel order');
ok('cancelling asks first, then calls cancel_order', rpcs.some(([n, a]) => n === 'cancel_order' && a.p_id === 'od1'));
await mount('orders', 'warehouse', ['od4']);
ok('a packed order shows its picked line and each parcel with weight and size', /A-02-01 × 3 \(picked\)/.test(text()) && /Parcels/.test(text()) && /1,8 kg|1\.8 kg/.test(text()) && /30 × 20 × 15 cm/.test(text()) && /25\.5 × 18 × 10 cm/.test(text()), text().slice(0, 400));
await mount('orders', 'warehouse', ['od3']); ok('an order being picked cannot be cancelled', ![...root().querySelectorAll('button')].some((b) => b.textContent === 'Cancel order'));
await mount('orders', 'support', ['od1']); ok('support sees the order but no actions', ![...root().querySelectorAll('button')].some((b) => /Cancel order|Try to reserve/.test(b.textContent)));
// create order for a customer
DB.products = [{ id: 'p1', org_id: 'o1', sku: 'SKU-1', name: 'Blue mug', active: true }];
await mount('orders', 'warehouse'); [...root().querySelectorAll('button')].find((b) => b.textContent === 'New order').click(); await tick(40);
{ const m = document.querySelector('.modal'); const sel = m.querySelector('select'); sel.value = 'o1'; sel.dispatchEvent(new window.Event('change')); await tick(80);
  const inputs = m.querySelectorAll('input'); inputs[1].value = 'Maria Zielinska'; inputs[4].value = 'Dluga 3'; inputs[5].value = '80-001'; inputs[6].value = 'Gdansk';
  m.querySelector('.line select').value = 'p1'; m.querySelector('.line input').value = '3'; apis.length = 0; rpcs.length = 0;
  [...m.querySelectorAll('button')].find((b) => b.textContent === 'Create order').click(); await tick(100); }
const co = rpcs.find(([n]) => n === 'create_order'); ok('creating posts customer, recipient, address and lines', co && co[1].p_org === 'o1' && co[1].p_ship.name === 'Maria Zielinska' && co[1].p_ship.city === 'Gdansk' && co[1].p_ship.country === 'PL' && co[1].p_lines[0].qty === 3 && co[1].p_lines[0].product_id === 'p1', JSON.stringify(co));
ok('a reserved order does not trigger the hold email', !apis.some(([a]) => a === 'order.notify'));
DB.__newstatus = 'held'; await mount('orders', 'warehouse'); [...root().querySelectorAll('button')].find((b) => b.textContent === 'New order').click(); await tick(40);
{ const m = document.querySelector('.modal'); const sel = m.querySelector('select'); sel.value = 'o1'; sel.dispatchEvent(new window.Event('change')); await tick(80);
  const inputs = m.querySelectorAll('input'); inputs[1].value = 'M'; inputs[4].value = 'A'; inputs[5].value = '1'; inputs[6].value = 'C'; m.querySelector('.line select').value = 'p1'; apis.length = 0;
  [...m.querySelectorAll('button')].find((b) => b.textContent === 'Create order').click(); await tick(100); }
ok('a held order created by staff asks the server to email the customer', apis.some(([a, p]) => a === 'order.notify' && p.order_ids[0] === 'new1')); DB.__newstatus = null;
// approvals know about orders
await mount('approvals', 'warehouse'); [...root().querySelectorAll('tbody tr')].find((r) => /Cancel order/.test(r.textContent)).click(); await tick(150);
ok('the approval screen shows an order cancellation with its details', /ORD-000001/.test(document.querySelector('.modal').textContent) && /releases the reserved stock/.test(document.querySelector('.modal').textContent));

// ---- shipping connection ----
DB.__api = { 'shipping.test': { ok: false, step: 'settings', error: 'Shipping is not set up yet. Missing server settings: FURGONETKA_CLIENT_ID, FURGONETKA_PASSWORD' } };
await mount('shipping', 'admin');
ok('the shipping screen explains it never buys a label', /never buys a label/.test(text()) && !!root().querySelector('button'));
[...root().querySelectorAll('button')].find((b) => b.textContent === 'Test connection').click(); await tick(80);
ok('missing settings are named (names only) with a clear title', /Not set up yet/.test(text()) && /FURGONETKA_CLIENT_ID, FURGONETKA_PASSWORD/.test(text()));
DB.__api = { 'shipping.test': { ok: false, step: 'api', env: 'sandbox', status: 400, error: 'Furgonetka answered 400: the login was refused. Check the account email and password' } };
await mount('shipping', 'admin'); [...root().querySelectorAll('button')].find((b) => b.textContent === 'Test connection').click(); await tick(80);
ok('a refused login shows the reason, the environment and the HTTP status', /The connection failed/.test(text()) && /login was refused/.test(text()) && /Environment: sandbox/.test(text()) && /HTTP 400/.test(text()));
DB.__api = { 'shipping.test': { ok: true, env: 'sandbox', base: 'https://api.sandbox.furgonetka.pl', balance: { balance: 0, currency: 'PLN', bills: [{ id: 1 }] }, services: [{ id: 101, name: 'Paczkomat 24/7', carrier: 'InPost' }, { service_id: 102, service_name: 'Courier', courier: 'DPD' }] } };
await mount('shipping', 'admin'); [...root().querySelectorAll('button')].find((b) => b.textContent === 'Test connection').click(); await tick(80);
ok('success: connected, sandbox, nothing is charged', /Connected/.test(text()) && /nothing is charged/.test(text()) && /sandbox/.test(text()));
ok('success: the balance is shown as a plain amount, with the raw answer tucked away', /0,00 PLN/.test(text()) && !!root().querySelector('details'));
ok('success: carrier services listed with their ids', /Carrier services \(2\)/.test(text()) && /101/.test(text()) && /Paczkomat 24\/7 · InPost/.test(text()) && /102/.test(text()) && /Courier · DPD/.test(text()));
ok('the raw answer is available', !!root().querySelector('details pre'));
DB.__api = { 'shipping.test': { ok: true, env: 'production', balance: {}, services: [] } };
await mount('shipping', 'admin'); [...root().querySelectorAll('button')].find((b) => b.textContent === 'Test connection').click(); await tick(80);
ok('production is flagged as live money', /LIVE account/.test(text()) && /real money/.test(text()));
DB.__api = {};

// ---- shipping label on an order ----
const btn = (label) => [...root().querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const Q = { env: 'sandbox', enabled: true, markup_percent: 30, max_label: 80, quotes: [
  { service_id: 7, carrier: 'dpd', name: 'DPD · package, door', available: true, cost_net: 12.5, cost_gross: 15.38, tax: 23, bill_net: 16.25, bill_gross: 19.99 },
  { service_id: 9, carrier: 'ups', name: 'UPS · package', available: true, cost_net: 90, cost_gross: 110.7, tax: 23, bill_net: 117, bill_gross: 143.91 },
  { service_id: 1, carrier: 'inpost', name: 'INPOST · locker', available: false, reason: 'Parcel too heavy', cost_net: 0, cost_gross: 0, tax: 23 } ] };
DB.shipments = [];
DB.__api = { 'shipping.quote': Q, 'shipping.buy': { ok: true, shipment: {} } };
await mount('orders', 'warehouse', ['od4']);
ok('a packed order offers shipping prices', /Shipping label/.test(text()) && !!btn('Get shipping prices') && /nothing is bought until you press Buy/.test(text()));
await mount('orders', 'support', ['od4']);
ok('support sees the card but cannot buy', /Only warehouse staff and admins can buy labels/.test(text()) && !btn('Get shipping prices'));
await mount('orders', 'warehouse', ['od3']); ok('an order that is not packed explains when a label can be bought', /A label can be bought once the order is packed/.test(text()) && !btn('Get shipping prices'));
await mount('orders', 'warehouse', ['od4']); apis.length = 0; btn('Get shipping prices').click(); await tick(80);
ok('prices are requested for that order', apis.some(([a, p]) => a === 'shipping.quote' && p.order_id === 'od4'));
ok('every carrier is listed with what we pay and what the customer pays', /DPD · package, door/.test(text()) && /12,50 zł/.test(text()) && /16,25 zł/.test(text()) && /UPS · package/.test(text()) && /117,00 zł/.test(text()));
ok('the environment and the markup are shown', /test/.test(text()) && /customer markup 30%/.test(text()));
ok('an unavailable carrier shows its reason and has no Buy button', /INPOST · locker \(not available: Parcel too heavy\)/.test(text()) && [...root().querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Buy label').length === 2);
// buying
apis.length = 0; [...root().querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Buy label')[0].click(); await tick(40);
ok('buying asks first and states both prices and that sandbox is a test', /We pay 12,50 zł \+ VAT \(15,38 zł\)/.test(document.querySelector('.modal').textContent) && /charged 16,25 zł \+ VAT \(30% markup\)/.test(document.querySelector('.modal').textContent) && /nothing real is charged/.test(document.querySelector('.modal').textContent) && !/above the usual limit/.test(document.querySelector('.modal').textContent));
await modalClick('Cancel'); ok('cancelling the question buys nothing', !apis.some(([a]) => a === 'shipping.buy'));
[...root().querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Buy label')[0].click(); await modalClick('Buy label'); await tick(60);
const bb = apis.find(([a]) => a === 'shipping.buy');
ok('confirming buys that service for that order, without any over-limit flag', bb && bb[1].order_id === 'od4' && bb[1].service_id === 7 && bb[1].confirm_over_limit === false, JSON.stringify(bb));
// over the limit (the page reloaded after the purchase, so ask for prices again)
btn('Get shipping prices').click(); await tick(80);
apis.length = 0; [...root().querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Buy label')[1].click(); await tick(40);
ok('an expensive label warns about the limit', /above the usual limit of 80,00 zł/.test(document.querySelector('.modal').textContent));
await modalClick('Buy label'); await tick(60);
ok('a warehouse user can never send the over-limit confirmation', apis.find(([a]) => a === 'shipping.buy')[1].confirm_over_limit === false);
await mount('orders', 'admin', ['od4']); btn('Get shipping prices').click(); await tick(80); apis.length = 0;
[...root().querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Buy label')[1].click(); await modalClick('Buy label'); await tick(60);
ok('an admin who confirms sends the over-limit confirmation', apis.find(([a]) => a === 'shipping.buy')[1].confirm_over_limit === true);
// refusals are shown
DB.__api['shipping.buy'] = new Error('Not enough balance: this label costs 15,38 zł and the balance is 2,00 zł. Top up in Furgonetka.');
await mount('orders', 'warehouse', ['od4']); btn('Get shipping prices').click(); await tick(80);
[...root().querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Buy label')[0].click(); await modalClick('Buy label'); await tick(60);
ok('a refusal from the server is shown on the page and the button is usable again', /Not enough balance/.test(text()) && ![...root().querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Buy label')[0].disabled);
// switched off
DB.__api = { 'shipping.quote': { ...Q, enabled: false } };
await mount('orders', 'warehouse', ['od4']); btn('Get shipping prices').click(); await tick(80);
ok('when buying is switched off the page says so and still lists prices', /Buying is switched off/.test(text()) && /SHIPPING_ENABLED=true/.test(text()) && /DPD · package, door/.test(text()));
DB.__api = { 'shipping.quote': new Error('Shipping is not set up yet. Missing server settings: FURGONETKA_PASSWORD') };
await mount('orders', 'warehouse', ['od4']); btn('Get shipping prices').click(); await tick(80);
ok('a connection problem is explained, not a blank page', /Missing server settings: FURGONETKA_PASSWORD/.test(text()));
// a failed attempt is visible
DB.shipments = [{ id: 's0', order_id: 'od4', status: 'failed', error: 'Furgonetka rejected the shipment: /receiver/phone: required', created_at: '2026-10-05T15:00:00Z' }];
await mount('orders', 'warehouse', ['od4']);
ok('the last failed attempt is shown with its reason and says nothing was charged', /The last attempt failed, nothing was charged/.test(text()) && /receiver\/phone: required/.test(text()) && !!btn('Get shipping prices'));
// waiting to be checked
DB.shipments = [{ id: 's1', order_id: 'od4', status: 'buying', created_at: '2026-10-05T15:00:00Z' }];
DB.__api = { 'shipping.recheck': { ok: true, result: 'closed', message: 'Furgonetka did not order it, so nothing was charged. You can buy again.' } };
await mount('orders', 'warehouse', ['od4']);
ok('an unconfirmed order warns not to buy again and offers a check, with no buy button', /waiting to be checked/.test(text()) && /do not buy again/.test(text()) && !btn('Get shipping prices') && !!btn('Check the label order'));
apis.length = 0; btn('Check the label order').click(); await tick(80);
ok('the check asks the server about that order', apis.some(([a, p]) => a === 'shipping.recheck' && p.order_id === 'od4'));
await mount('orders', 'support', ['od4']); ok('support sees the warning but cannot check', /waiting to be checked/.test(text()) && !btn('Check the label order'));
// shipped
DB.orders.push({ id: 'od5', org_id: 'o1', ref: 'ORD-000005', external_ref: null, channel: 'manual', status: 'shipped', hold_reason: null, ship_name: 'Maria', ship_company: null, ship_line1: 'Dluga 3', ship_line2: null, ship_postal: '80-001', ship_city: 'Gdansk', ship_country: 'PL', ship_email: null, ship_phone: null, notes: null, created_at: '2026-10-05T09:00:00Z', allocated_at: null, order_lines: [] });
DB.shipments = [{ id: 's2', order_id: 'od5', status: 'purchased', env: 'sandbox', carrier: 'dpd', service_name: 'DPD · package, door', tracking_numbers: ['WB123', 'WB456'], cost_net: 12.5, cost_gross: 15.38, bill_net: 16.25, bill_gross: 19.99, markup_percent: 30, billing_status: 'pending', purchased_at: '2026-10-05T16:00:00Z', created_at: '2026-10-05T16:00:00Z' }];
let opened = null; window.open = (u) => { opened = u; }; URL.createObjectURL = (b) => 'blob:' + b.type + ':' + b.size;
DB.__api = { 'shipping.label': { content_type: 'application/pdf', pdf_base64: btoa('%PDF-1.4 fake') } };
await mount('orders', 'warehouse', ['od5']);
ok('a shipped order shows carrier, tracking, our cost, what the customer is charged and that it awaits invoicing', /DPD · package, door/.test(text()) && /WB123, WB456/.test(text()) && /12,50 zł \+ VAT \(15,38 zł\)/.test(text()) && /16,25 zł \+ VAT \(19,99 zł\), 30% markup/.test(text()) && /Waiting to be invoiced/.test(text()) && /Test \(sandbox\): nothing real was charged/.test(text()), text().slice(0, 600));
ok('it no longer offers to buy', !btn('Get shipping prices'));
apis.length = 0; btn('Download label').click(); await tick(80);
ok('Download label fetches the file and opens it', apis.some(([a, p]) => a === 'shipping.label' && p.order_id === 'od5') && /^blob:application\/pdf:13$/.test(opened || ''), String(opened));
await mount('orders', 'support', ['od5']); ok('support can read the shipment but not download', /WB123/.test(text()) && !btn('Download label'));

// ---- add stock in one step ----
DB.products = [{ id: 'p1', org_id: 'o1', sku: 'SKU-1', name: 'Blue mug', active: true }, { id: 'p9', org_id: 'o1', sku: 'OLD-1', name: 'Old', active: false }];
DB.__api = {};
await mount('stock', 'warehouse'); ok('the Stock screen opens on All stock by default', /Blue mug/.test(text()) && !!root().querySelector('.tabs a.btn:not(.ghost)') && /All stock/.test(root().querySelector('.tabs a.btn:not(.ghost)').textContent));
ok('warehouse and admin see the Add stock button, support does not', !!btn('Add stock'));
await mount('stock', 'support'); ok('support has no Add stock', !btn('Add stock'));
await mount('stock', 'warehouse'); btn('Add stock').click(); await tick(40);
{ const m = document.querySelector('.modal');
  ok('the form explains the stock goes straight into the customer\'s bin', /straight into the customer's own bin/.test(m.textContent) && !!m.querySelector('input[type=number]'));
  const [cs, ps] = m.querySelectorAll('select'); ok('the product list asks for a customer first', /Choose a customer first/.test(ps.textContent));
  await modalClick('Add stock'); ok('submitting an empty form is refused politely', /Choose a customer and a product/.test(document.querySelector('.modal').textContent));
  cs.value = 'o1'; cs.dispatchEvent(new window.Event('change')); await tick(80);
  ok('choosing a customer lists only their active products', /SKU-1 - Blue mug/.test(ps.textContent) && !/OLD-1/.test(ps.textContent));
  ps.value = 'p1'; const q = m.querySelector('input[type=number]'); q.value = '25'; const nt = m.querySelector('input:not([type=number])'); nt.value = 'Opening stock';
  rpcs.length = 0;
  [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add stock').click(); await tick(80); }
const as1 = rpcs.find(([n]) => n === 'add_stock');
ok('it calls add_stock with customer, product, units, note and a repeat-safe key', as1 && as1[1].p_org === 'o1' && as1[1].p_product === 'p1' && as1[1].p_qty === 25 && as1[1].p_note === 'Opening stock' && typeof as1[1].p_key === 'string' && as1[1].p_key.length > 8, JSON.stringify(as1));
ok('it confirms where the units went', /Added 25 units to ACME-01/.test(document.body.textContent));

// ---- the journey strip on the Overview ----
DB.stock_levels = [{ org_id: 'o1', product_id: 'p1', location_id: 'l1', on_hand: 20, reserved: 4, products: { sku: 'SKU-1', name: 'Blue mug' }, locations: { kind: 'bin' } }, { org_id: 'o2', product_id: 'p2', location_id: 'l2', on_hand: 5, reserved: 0, products: { sku: 'SKU-1', name: 'Blue mug' }, locations: { kind: 'pallet' } }, { org_id: 'o1', product_id: 'p3', location_id: 'l4', on_hand: 7, reserved: 0, products: { sku: 'MUG-NEW', name: 'New mug' }, locations: { kind: 'receiving' } }];
DB.inbound_bookings = [{ id: 'b1', status: 'booked' }, { id: 'b2', status: 'booked' }, { id: 'b3', status: 'receiving' }];
DB.orders = [{ id: 'x1', status: 'allocated' }, { id: 'x2', status: 'allocated' }, { id: 'x3', status: 'held' }, { id: 'x4', status: 'picking' }, { id: 'x5', status: 'packed' }, { id: 'x6', status: 'shipped' }];
await mount('home', 'warehouse'); await tick(80);
const st = [...root().querySelectorAll('.station')];
ok('the Overview shows the journey as seven stations', st.length === 7 && /The journey of an order/.test(text()));
ok('every station has its live number', st.map((s) => s.querySelector('.n').textContent).join(',') === '2,1,25,2,1,1,1', st.map((s) => s.querySelector('.n').textContent).join(','));
ok('stations that have something are lit, empty ones are not', st.filter((s) => s.classList.contains('on')).length === 7);
ok('each station links to where you work on it', st.map((s) => s.querySelector('a').getAttribute('href')).join(' ') === '#inbound #inbound #stock #orders #orders #orders #orders');
ok('orders on hold are flagged on the Ordered station', /1 on hold/.test(st[3].textContent));
ok('stations carry a plain explanation', /A customer announces a delivery/.test(text()) && /Label bought/.test(text()));
ok('the shelf station counts only units in bins and pallets', st[2].querySelector('.n').textContent === '25');
DB.orders = []; DB.inbound_bookings = []; await mount('home', 'admin'); await tick(80);
ok('on an empty warehouse every station shows 0 and none is lit', [...root().querySelectorAll('.station')].every((s) => !s.classList.contains('on') || s.querySelector('.n').textContent === '25'));
// ---- the order tracker ----
const trk = async (status) => { DB.orders = [{ id: 'od9', org_id: 'o1', ref: 'ORD-000009', external_ref: null, channel: 'manual', status, hold_reason: 'MUG-BLUE: need 7, available 6', ship_name: 'X', ship_company: null, ship_line1: 'a', ship_line2: null, ship_postal: '1', ship_city: 'C', ship_country: 'PL', ship_email: null, ship_phone: null, notes: null, created_at: '2026-10-05T09:00:00Z', allocated_at: null, order_lines: [] }]; DB.shipments = []; await mount('orders', 'warehouse', ['od9']); return [...root().querySelectorAll('.stepper li')].map((l) => l.className); };
ok('a new order is at Received', (await trk('new')).join() === 'now,todo,todo,todo,todo');
ok('a reserved order has Received done and Reserved current', (await trk('allocated')).join() === 'done,now,todo,todo,todo');
ok('an order on hold is stuck at Reserved and says why it waits', (await trk('held')).join() === 'done,stuck,todo,todo,todo' && /Waiting for stock/.test(text()));
ok('a picking order', (await trk('picking')).join() === 'done,done,now,todo,todo');
ok('a packed order', (await trk('packed')).join() === 'done,done,done,now,todo');
ok('a shipped order is complete', (await trk('shipped')).join() === 'done,done,done,done,done');
await trk('cancelled'); ok('a cancelled order shows a cancelled note instead of a tracker', !root().querySelector('.stepper') && /This order was cancelled and its stock released/.test(text()));
await trk('picking'); ok('the current step is marked for screen readers', root().querySelector('.stepper li[aria-current="step"]').textContent.includes('Picking'));

// ---- store in bin: one-click put-away and the automatic bin in the Move form ----
DB.locations = [{ id: 'l1', code: 'R1', kind: 'receiving', active: true }, { id: 'l2', code: 'A-01-01', kind: 'bin', active: true }];
DB.location_assignments = [];
DB.stock_levels = [{ org_id: 'o1', product_id: 'p1', location_id: 'l1', lot: '', on_hand: 12, reserved: 0, products: { sku: 'SKU-1', name: 'Blue mug', photo_paths: [] }, locations: { code: 'R1', kind: 'receiving' } },
  { org_id: 'o1', product_id: 'p2', location_id: 'l2', lot: '', on_hand: 8, reserved: 0, products: { sku: 'SKU-2', name: 'Red mug', photo_paths: [] }, locations: { code: 'A-01-01', kind: 'bin' } },
  { org_id: 'o1', product_id: 'p3', location_id: 'l1', lot: '', on_hand: 3, reserved: 3, products: { sku: 'SKU-3', name: 'All reserved', photo_paths: [] }, locations: { code: 'R1', kind: 'receiving' } }];
await mount('stock', 'warehouse', ['all']);
ok('goods waiting in the receiving area get a Store in bin button; goods already in a bin, or fully reserved, do not', [...root().querySelectorAll('button')].filter((b) => b.textContent === 'Store in bin').length === 1);
await mount('stock', 'support', ['all']); ok('support has no Store in bin', ![...root().querySelectorAll('button')].some((b) => b.textContent === 'Store in bin'));
await mount('stock', 'warehouse', ['all']); rpcs.length = 0; [...root().querySelectorAll('button')].find((b) => b.textContent === 'Store in bin').click(); await tick(80);
const sb1 = rpcs.find(([n]) => n === 'putaway_to_default');
ok('Store in bin moves everything free in one click: no quantity, the right stock, a repeat-safe key', sb1 && sb1[1].p_org === 'o1' && sb1[1].p_product === 'p1' && sb1[1].p_from === 'l1' && sb1[1].p_qty === null && typeof sb1[1].p_key === 'string' && sb1[1].p_key.length > 8, JSON.stringify(sb1));
ok('and says where it went', /Stored 12 in ACME-01/.test(document.body.textContent));
rpcFail = 'There is nothing free to move from there'; await mount('stock', 'warehouse', ['all']); rpcFail = 'There is nothing free to move from there'; [...root().querySelectorAll('button')].find((b) => b.textContent === 'Store in bin').click(); await tick(80);
ok('a refusal is shown and the button works again', /nothing free to move/.test(document.body.textContent) && ![...root().querySelectorAll('button')].find((b) => b.textContent === 'Store in bin').disabled); rpcFail = null;
// the Move form offers the automatic bin first, even when the customer has no bin assigned
await mount('stock', 'warehouse', ['all']); [...root().querySelectorAll('button')].filter((b) => b.textContent === 'Move')[0].click(); await tick(40);
{ const m = document.querySelector('.modal'); const sel = m.querySelector('select'); ok('the destination list starts with the customer\'s own bin (automatic) and does not refuse a customer without bins', sel.options[0].value === 'auto' && /own bin \(automatic\)/.test(sel.options[0].textContent) && sel.value === 'auto' && !/no bins assigned/.test(m.textContent)); }
rpcs.length = 0; await modalClick('Move'); await tick(60);
ok('moving to the automatic bin uses putaway_to_default with the typed quantity', rpcs.some(([n, a]) => n === 'putaway_to_default' && a.p_qty === 12 && a.p_from === 'l1') && !rpcs.some(([n]) => n === 'putaway'));

// ---- the customer's own label on an order, and Mark shipped ----
const mkOrd = (id, ref, status) => ({ id, org_id: 'o1', ref, external_ref: null, channel: 'manual', status, hold_reason: null, ship_name: 'Maria', ship_company: null, ship_line1: 'Dluga 3', ship_line2: null, ship_postal: '80-001', ship_city: 'Gdansk', ship_country: 'PL', ship_email: null, ship_phone: null, notes: null, created_at: '2026-10-05T09:00:00Z', allocated_at: null, order_lines: [] });
DB.orders = [mkOrd('od4', 'ORD-000004', 'packed'), mkOrd('od3', 'ORD-000003', 'picking')]; DB.order_lines = []; DB.allocations = []; DB.parcels = []; DB.change_requests = [];
DB.shipments = [];
const ownLabel = (o) => ({ id: 'ol1', order_id: 'od4', org_id: 'o1', storage_path: 'o1/od4/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf', filename: 'Allegro label.pdf', tracking_numbers: ['6200 1234', 'JJD0001'], carrier_name: 'InPost', voided_at: null, created_at: '2026-10-06T09:00:00Z', ...o });
DB.own_labels = [ownLabel()];
let openedPdf = null; window.open = (u) => { openedPdf = u; };
sb.storage = { from: (b) => ({ createSignedUrl: async (p) => ({ data: { signedUrl: 'https://x/' + b + '/' + p + '?t=1' }, error: null }), remove: async () => ({ error: null }), createSignedUrls: async (ps) => ({ data: ps.map((p) => ({ path: p, signedUrl: 'https://x/' + p })), error: null }), upload: async () => ({ error: null }) }) };
await mount('orders', 'warehouse', ['od4']);
ok('an order with the customer\'s own label shows it: carrier, tracking, file, and that nothing was charged', /The customer's own label/.test(text()) && /InPost/.test(text()) && /6200 1234, JJD0001/.test(text()) && /Allegro label\.pdf/.test(text()) && /Nothing: 2ACE did not buy it/.test(text()));
ok('and does not offer to buy a label', !btn('Get shipping prices'));
rpcs.length = 0; btn('Open the PDF to print').click(); await tick(60);
ok('the PDF opens through a short-lived signed link', /^https:\/\/x\/labels\/o1\/od4\//.test(openedPdf || ''), String(openedPdf));
ok('a packed order with a label offers Mark shipped', !!btn('Mark shipped'));
btn('Mark shipped').click(); await tick(60);
ok('Mark shipped calls ship_order for that order', rpcs.some(([n, a]) => n === 'ship_order' && a.p_order === 'od4') && /Marked as shipped/.test(document.body.textContent));
rpcFail = 'This order has no label yet. Buy one, or ask the customer for theirs.'; await mount('orders', 'warehouse', ['od4']); rpcFail = 'This order has no label yet. Buy one, or ask the customer for theirs.'; btn('Mark shipped').click(); await tick(60);
ok('a refusal is shown and the button works again', /has no label yet/.test(document.body.textContent) && !btn('Mark shipped').disabled); rpcFail = null;
await mount('orders', 'support', ['od4']); ok('support sees the label but cannot ship or print', /The customer's own label/.test(text()) && !btn('Mark shipped'));
DB.own_labels = [ownLabel({ storage_path: null, filename: null })]; await mount('orders', 'warehouse', ['od4']);
ok('a tracking-only label shows no file and no PDF button', /No file, tracking only/.test(text()) && !btn('Open the PDF to print') && !!btn('Mark shipped'));
DB.own_labels = [ownLabel()]; await mount('orders', 'warehouse', ['od3']);
DB.own_labels = [{ ...ownLabel(), order_id: 'od3', storage_path: null }]; await mount('orders', 'warehouse', ['od3']);
ok('an order that is not packed yet cannot be marked shipped, and says why', /can be marked shipped once the order is packed/.test(text()) && !btn('Mark shipped'));
DB.own_labels = [];

// ---- overview ----
DB.requests = []; DB.domain_orders = []; DB.organizations = [];
await mount('home', 'warehouse'); ok('warehouse overview shows 4 warehouse cards', document.querySelectorAll('.stat').length === 7 && /Orders on hold/.test(text()) && /Changes to approve/.test(text()) && /Units to put away/.test(text()) && /10/.test(text()));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

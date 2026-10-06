const fs = require('fs');
global.window = { addEventListener(){}, removeEventListener(){}, scrollTo(){}, matchMedia: () => ({ matches: false }) };
global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
global.location = { search: '', pathname: '/platform', href: '' }; global.history = { pushState(){}, replaceState(){} };
class DCLogic { constructor(){ this.props = {}; } setState(u){ const n = typeof u === 'function' ? u(this.state) : u; this.state = Object.assign({}, this.state, n); } }
const Component = new Function('DCLogic', 'StreamableLogic', 'React', fs.readFileSync(require('path').join(__dirname, '..', '.cache', 'comp.js'), 'utf8') + '\nreturn Component;')(DCLogic, class {}, {});
const c = new Component(); let pass = 0, fail = 0; const ok = (n, x, e = '') => { x ? pass++ : fail++; console.log((x ? 'PASS ' : 'FAIL ') + n + (x ? '' : ' -> ' + e)); };
window.confirm = () => true; c.authSession = () => ({ access_token: 'tok', user: { id: 'u', email: 'a@b.pl' } });
const settle = () => new Promise((r) => setTimeout(r, 40));
const calls = []; let fail_ = null; let CHG = []; let ORDERS = [], HELDIDS = [], NEWORDER = {}, IMPORTRES = []; const rpcLog = []; const uploads = [], deletes = [], setCalls = []; let REMOVED = [], failUpload = false;
global.fetch = async (url, o) => { calls.push([url, o && typeof o.body === 'string' ? JSON.parse(o.body) : null, o && o.headers]);
  if (/storage\/v1\/object\/sign\/products/.test(url)) return { ok: true, json: async () => JSON.parse(o.body).paths.map((p) => ({ path: p, signedURL: '/object/sign/products/' + p + '?token=t' })) };
  if (/storage\/v1\/object\/products\//.test(url) && o.method === 'POST') { uploads.push(url); return { ok: !failUpload, json: async () => ({}) }; }
  if (/storage\/v1\/object\/products$/.test(url) && o.method === 'DELETE') { deletes.push(JSON.parse(o.body).prefixes); return { ok: true, json: async () => ({}) }; }
  if (/rpc\/set_product_photos/.test(url)) { setCalls.push(JSON.parse(o.body)); return { ok: true, json: async () => REMOVED }; }
  if (/rpc\/create_product/.test(url)) return fail_ ? { ok: false, json: async () => ({ message: fail_ }) } : { ok: true, json: async () => 'new-product-id' };
  if (/rest\/v1\/orders\?select=id&status=eq\.held/.test(url)) return { ok: true, json: async () => HELDIDS };
  if (/rest\/v1\/orders\?/.test(url)) return { ok: true, json: async () => ORDERS };
  if (/rpc\/create_order/.test(url)) { rpcLog.push(['create_order', JSON.parse(o.body)]); return fail_ ? { ok: false, json: async () => ({ message: fail_ }) } : { ok: true, json: async () => NEWORDER }; }
  if (/rpc\/import_orders/.test(url)) { rpcLog.push(['import_orders', JSON.parse(o.body)]); return fail_ ? { ok: false, json: async () => ({ message: fail_ }) } : { ok: true, json: async () => IMPORTRES }; }
  if (/change-request/.test(url)) return fail_ ? { ok: false, json: async () => ({ error: fail_ }) } : { ok: true, json: async () => ({ ok: true }) };
  if (/change_requests/.test(url)) return { ok: true, json: async () => CHG };
  if (/rpc\//.test(url)) return fail_ ? { ok: false, json: async () => ({ message: fail_ }) } : { ok: true, json: async () => 'new-id' };
  if (/v_inventory/.test(url)) return { ok: true, json: async () => [{ product_id: 'p1', photo_paths: ['o1/p1/a.jpg', 'o1/p1/b.jpg'], sku: 'SKU-1', name: 'Blue mug', active: true, on_hand: 10, available: 9, unplaced: 2, quarantined: 1, incoming: 5 }, { product_id: 'p2', sku: 'SKU-2', name: 'Red', active: true, on_hand: 0, available: 0, unplaced: 0, quarantined: 0, incoming: 0 }] };
  if (/object\/sign\/receiving/.test(url)) return { ok: true, json: async () => JSON.parse(o.body).paths.map((p) => ({ path: p, signedURL: '/object/sign/receiving/' + p + '?token=t' })) };
  if (/discrepancies/.test(url)) return { ok: true, json: async () => [{ booking_id: 'b1', kind: 'short', expected_qty: 10, received_qty: 8, products: { sku: 'SKU-1' } }, { booking_id: 'b1', kind: 'damaged', expected_qty: 0, received_qty: 2, products: { sku: 'SKU-1' } }] };
  if (/receipt_lines/.test(url)) return { ok: true, json: async () => [{ booking_id: 'b1', photo_paths: ['o1/b1/aaa.jpg', 'o1/b1/bbb.jpg'] }] };
  if (/product_barcodes/.test(url)) return { ok: true, json: async () => [{ product_id: 'p1', barcode: '590' }] };
  if (/inbound_bookings/.test(url)) return { ok: true, json: async () => [{ id: 'b1', ref: 'IN-000001', status: 'booked', expected_date: '2026-11-01', carrier: 'DHL', tracking: 'T', inbound_lines: [{ expected_qty: 5, products: { sku: 'SKU-1', name: 'Blue mug' } }] }] };
  return { ok: true, json: async () => [] }; };
(async () => {
  c.state = Object.assign({}, c.state, { view: 'dash', tab: 'inventory', orgId: 'o1', activated: true, userEmail: 'a@b.pl' });
  await c.whLoad(); let v = c.renderVals();
  ok('inventory rows for products with stock or incoming only', v.invRows.length === 1 && v.invRows[0].onHand === '10' && v.invRows[0].awaiting === '3' && v.invRows[0].incoming === '5', JSON.stringify(v.invRows));
  ok('reads use the user token (row-level security does the filtering)', calls.every(([u, b, h]) => h.Authorization === 'Bearer tok'));
  ok('product rows show barcode and stock', c.renderVals().pdRows[0].code === '590' && c.renderVals().pdRows[1].code === 'No barcode');
  ok('booking list shows status, units and items', v.inRows[0].status === 'Booked' && v.inRows[0].units === '5 units' && /SKU-1 × 5/.test(v.inRows[0].items), JSON.stringify(v.inRows));
  c.state = Object.assign({}, c.state, { pdSku: 'NEW-1', pdName: 'New thing', pdEan: '123456' }); calls.length = 0; await c.pdSubmit(); await settle();
  const r1 = calls.find(([u]) => /rpc\/create_product/.test(u));
  ok('create product posts org, sku, name, ean', r1 && r1[1].p_org === 'o1' && r1[1].p_sku === 'NEW-1' && r1[1].p_ean === '123456', JSON.stringify(r1));
  ok('form closes and list reloads after success', c.state.pdOpen === false && calls.some(([u]) => /v_inventory/.test(u)) && c.state.whNote === 'Product added.');
  fail_ = 'You already have a product with SKU NEW-1'; c.state = Object.assign({}, c.state, { pdSku: 'NEW-1', pdName: 'x', pdOpen: true }); await c.pdSubmit(); await settle();
  ok('database error is shown to the customer', c.state.pdErr === fail_ && c.state.pdBusy === false && c.state.pdOpen === true);
  fail_ = null; c.state = Object.assign({}, c.state, { pdSku: '', pdName: '' }); calls.length = 0; await c.pdSubmit(); await settle(); ok('empty SKU blocked client-side, no request', c.state.pdErr && !calls.length);
  // inbound
  c.state = Object.assign({}, c.state, { inPick: 'p1', inQty: '4' }); c.inAddLine(); c.state = Object.assign({}, c.state, { inPick: 'p1', inQty: '2' }); c.inAddLine();
  ok('adding the same product twice is refused', c.state.inLines.length === 1 && /already on this delivery/.test(c.state.inErr));
  c.state = Object.assign({}, c.state, { inPick: '', inQty: '2' }); c.inAddLine(); ok('no product chosen is refused', /Choose a product/.test(c.state.inErr));
  c.state = Object.assign({}, c.state, { inPick: 'p2', inQty: '0' }); c.inAddLine(); ok('zero quantity refused', /at least 1/.test(c.state.inErr));
  c.state = Object.assign({}, c.state, { inPick: 'p2', inQty: '7', inCarrier: 'DSV', inDate: '2026-12-01' }); c.inAddLine();
  v = c.renderVals(); ok('lines listed with remove buttons', v.inLineRows.length === 2 && /SKU-1/.test(v.inLineRows[0].label));
  v.inLineRows[0].remove(); ok('a line can be removed', c.state.inLines.length === 1 && c.state.inLines[0].pid === 'p2');
  c.state = Object.assign({}, c.state, { inLines: [{ pid: 'p1', qty: 4 }, { pid: 'p2', qty: 7 }], inOpen: true }); calls.length = 0; await c.inSubmit(); await settle();
  const r2 = calls.find(([u]) => /rpc\/book_inbound/.test(u));
  ok('book posts org, date, carrier and every line', r2 && r2[1].p_org === 'o1' && r2[1].p_expected === '2026-12-01' && r2[1].p_carrier === 'DSV' && r2[1].p_lines.length === 2 && r2[1].p_lines[1].qty === 7, JSON.stringify(r2));
  ok('form resets after booking', c.state.inOpen === false && c.state.inLines.length === 0 && /Delivery booked/.test(c.state.whNote));
  fail_ = 'Your plan is not active yet'; c.state = Object.assign({}, c.state, { inLines: [{ pid: 'p1', qty: 1 }], inOpen: true }); await c.inSubmit(); await settle(); ok('inactive plan error is shown', c.state.inErr === fail_ && c.state.inLines.length === 1);
  fail_ = null; c.state = Object.assign({}, c.state, { inLines: [] }); await c.inSubmit(); await settle(); ok('empty delivery blocked', /at least one product/.test(c.state.inErr));
  c.state = Object.assign({}, c.state, { tab: 'overview', whInv: [], whBook: [], activated: true }); let steps = c.renderVals().startSteps;
  ok('checklist: products and inbound not done when empty', steps.filter((x) => x.dot === '✓').length === 1);
  c.state = Object.assign({}, c.state, { whInv: [{ product_id: 'p1' }], whBook: [{ id: 'b' }] }); steps = c.renderVals().startSteps; ok('checklist ticks products and inbound when they exist', steps.filter((x) => x.dot === '✓').length === 3);
  // ---- customer sees differences and photos ----
  await c.whLoad(); const ib = c.renderVals().inRows[0];
  ok('delivery row lists the differences found', ib.issuesDisplay === 'block' && /SKU-1: 8 of 10 arrived/.test(ib.issues) && /2 damaged/.test(ib.issues), ib.issues);
  ok('photos arrive as signed links, only for slots that exist', /object\/sign\/receiving\/o1\/b1\/aaa\.jpg\?token=t$/.test(ib.ph1) && ib.ph1d === 'inline' && ib.ph2d === 'inline' && ib.ph3d === 'none' && ib.ph4d === 'none', JSON.stringify([ib.ph1, ib.ph3d]));
  // ---- orders ----
  ORDERS = [
    { id: 'o1', ref: 'ORD-000001', external_ref: 'SHOP-1', status: 'allocated', hold_reason: null, ship_name: 'Jan Nowak', ship_city: 'Warszawa', ship_country: 'PL', created_at: '2026-10-05T10:00:00Z', order_lines: [{ qty: 2, products: { sku: 'MUG-BLUE' } }] },
    { id: 'o2', ref: 'ORD-000002', external_ref: null, status: 'held', hold_reason: 'MUG-BLUE: need 7, available 6', ship_name: 'Anna Schmidt', ship_city: 'Berlin', ship_country: 'DE', created_at: '2026-10-05T11:00:00Z', order_lines: [{ qty: 7, products: { sku: 'MUG-BLUE' } }] },
    { id: 'o3', ref: 'ORD-000003', external_ref: null, status: 'picking', hold_reason: null, ship_name: 'X', ship_city: 'Y', ship_country: 'PL', created_at: '2026-10-05T12:00:00Z', order_lines: [] },
  ];
  c.state = Object.assign({}, c.state, { tab: 'orders', orderRowsX: 0, whChanges: {} }); await c.whLoad();
  let vo = c.renderVals();
  ok('orders list shows reference, recipient and plain status', vo.orderRows.length === 3 && vo.orderRows[0].status === 'Reserved, waiting to be picked' && /Your reference SHOP-1/.test(vo.orderRows[0].their) && /Jan Nowak, Warszawa PL/.test(vo.orderRows[0].who) && /MUG-BLUE × 2/.test(vo.orderRows[0].items));
  ok('a held order explains the shortage', vo.orderRows[1].status === 'On hold, not enough stock' && vo.orderRows[1].reasonDisplay === 'block' && /need 7, available 6/.test(vo.orderRows[1].reason) && vo.orderRows[1].color === '#8A5A10');
  ok('an order with no correction request shows no correction banner', vo.orderRows.every((r) => r.askDisplay === 'none' && r.ask === ''));
  ORDERS[0].details_request_note = 'The recipient phone must be a Polish number with 9 digits.'; ORDERS[2].details_request_note = 'old note on a picking order'; await c.whLoad(); vo = c.renderVals();
  ok('a correction request is shown to the customer on that order, so they know what to fix', vo.orderRows[0].askDisplay === 'block' && /9 digits/.test(vo.orderRows[0].ask) && vo.orderRows[1].askDisplay === 'none');
  ORDERS[0].status = 'shipped'; await c.whLoad(); vo = c.renderVals(); ok('the banner disappears once the order has shipped', vo.orderRows[0].askDisplay === 'none'); ORDERS[0].status = 'allocated'; delete ORDERS[0].details_request_note; delete ORDERS[2].details_request_note; await c.whLoad(); vo = c.renderVals();
  ok('cancellation can be requested only before picking starts', vo.orderRows[0].cancelDisplay === 'inline-block' && vo.orderRows[1].cancelDisplay === 'inline-block' && vo.orderRows[2].cancelDisplay === 'none');
  c.state = Object.assign({}, c.state, { whChanges: { o1: { id: 'c1', status: 'pending', summary: 'Cancel order ORD-000001' } } }); vo = c.renderVals();
  ok('a pending cancellation is shown and hides the button', vo.orderRows[0].pendDisplay === 'block' && vo.orderRows[0].cancelDisplay === 'none');
  c.state = Object.assign({}, c.state, { whChanges: {} });
  calls.length = 0; await c.oCancel(ORDERS[0]); await settle();
  const rqo = calls.find(([u]) => /change-request/.test(u)); ok('cancelling sends a cancellation request, not a cancel', rqo && rqo[1].entity === 'order' && rqo[1].kind === 'delete' && rqo[1].id === 'o1' && /approve/.test(c.state.whNote) && !calls.some(([u]) => /rpc\/cancel_order/.test(u)));
  // a new order
  c.state = Object.assign({}, c.state, { activated: true, orderId: 'x', whInv: [{ product_id: 'p1', sku: 'MUG-BLUE', name: 'Blue mug', active: true, available: 6, on_hand: 6, unplaced: 0, quarantined: 0, incoming: 0 }], oOpen: true, oLines: [], oName: '', oLine1: '', oPostal: '', oCity: '', oCountry: 'PL' });
  ok('product choices show how many are available', c.renderVals().oPickOpts[1].label === 'MUG-BLUE - Blue mug (6 available)');
  await c.oSubmit(); ok('an order with no products is refused client-side', /Add at least one product/.test(c.state.oErr));
  c.state = Object.assign({}, c.state, { oPick: 'p1', oQty: '0' }); c.oAddLine(); ok('zero quantity refused', /at least 1/.test(c.state.oErr));
  c.state = Object.assign({}, c.state, { oPick: 'p1', oQty: '3' }); c.oAddLine(); c.state = Object.assign({}, c.state, { oPick: 'p1', oQty: '1' }); c.oAddLine(); ok('the same product twice is refused', c.state.oLines.length === 1 && /already on this order/.test(c.state.oErr));
  c.state = Object.assign({}, c.state, { oRef: 'SHOP-2000', oName: 'Jan Nowak', oLine1: 'Prosta 1', oPostal: '00-001', oCity: 'Warszawa', oCountry: 'PL' });
  rpcLog.length = 0; calls.length = 0; NEWORDER = { id: 'n1', ref: 'ORD-000010', status: 'allocated', duplicate: false }; await c.oSubmit(); await settle();
  const co = rpcLog.find(([n]) => n === 'create_order');
  ok('placing an order posts recipient, address and lines', co && co[1].p_org === 'o1' && co[1].p_external_ref === 'SHOP-2000' && co[1].p_ship.name === 'Jan Nowak' && co[1].p_ship.country === 'PL' && co[1].p_lines[0].qty === 3 && co[1].p_channel === 'manual', JSON.stringify(co));
  ok('reserved order: confirmation says stock is reserved, no email call', /received and stock reserved/.test(c.state.whNote) && !calls.some(([u, b]) => /change-request/.test(u) && b && b.action === 'order_notify'));
  c.state = Object.assign({}, c.state, { oOpen: true, oLines: [{ pid: 'p1', qty: 9 }] }); NEWORDER = { id: 'n2', ref: 'ORD-000011', status: 'held', duplicate: false }; calls.length = 0; await c.oSubmit(); await settle();
  ok('a held order tells the customer and asks the server to email', /on hold: not enough stock/.test(c.state.whNote) && calls.some(([u, b]) => /change-request/.test(u) && b.action === 'order_notify' && b.order_ids[0] === 'n2'));
  c.state = Object.assign({}, c.state, { oOpen: true, oLines: [{ pid: 'p1', qty: 1 }] }); NEWORDER = { id: 'n1', ref: 'ORD-000010', status: 'allocated', duplicate: true }; await c.oSubmit(); await settle();
  ok('the same order number again says it already exists', /already have an order with that reference/.test(c.state.whNote));
  c.state = Object.assign({}, c.state, { oOpen: true, oLines: [{ pid: 'p1', qty: 1 }] }); fail_ = 'The recipient postal code is required'; await c.oSubmit(); await settle(); fail_ = null;
  ok('a database refusal is shown on the form', /postal code is required/.test(c.state.oErr) && c.state.oBusy === false);
  // CSV
  const csv = 'order_ref,name,phone,address,postal,city,country,sku,qty\nA1,"Nowak, Jan",608180946,Prosta 1,00-001,Warszawa,PL,MUG-BLUE,2\nA1,"Nowak, Jan",608180946,Prosta 1,00-001,Warszawa,PL,MUG-RED,1\nA2,Anna,030123456,"Str ""Main"" 5",10115,Berlin,DE,MUG-BLUE,4\n';
  let od = c.csvToOrders(csv);
  ok('csv rows with the same order_ref become one order with several lines', od.length === 2 && od[0].lines.length === 2 && od[0].external_ref === 'A1' && od[1].lines[0].qty === 4);
  ok('quoted commas and quotes inside fields are kept', od[0].ship.name === 'Nowak, Jan' && od[1].ship.line1 === 'Str "Main" 5');
  od = c.csvToOrders(csv.replace(/,/g, ';').replace('"Nowak; Jan"', 'Nowak Jan').replace(/"Nowak; Jan"/g, 'Nowak Jan').replace('"Str ""Main"" 5"', 'Main 5'));
  ok('semicolon files (Excel in Poland) work too', od.length === 2 && od[0].ship.city === 'Warszawa');
  ok('a Windows byte-order mark and CRLF line ends are handled', c.csvToOrders('﻿' + csv.replace(/\n/g, '\r\n')).length === 2);
  ok('repeated SKU rows on one order are added together', c.csvToOrders('order_ref,name,phone,address,postal,city,country,sku,qty\nB,N,1,A,1,C,PL,X,2\nB,N,1,A,1,C,PL,X,3\n')[0].lines[0].qty === 5);
  let msg = ''; try { c.csvToOrders('order_ref,name\nA,B\n'); } catch (e) { msg = e.message; } ok('missing columns are named', /Missing columns: phone, address, postal, city, country, sku, qty/.test(msg), msg);
  msg = ''; try { c.csvToOrders('order_ref,name,phone,address,postal,city,country,sku,qty\n,N,1,A,1,C,PL,X,2\n'); } catch (e) { msg = e.message; } ok('a row without order_ref is refused with its row number', /Row 2 has no order_ref/.test(msg), msg);
  msg = ''; try { c.csvToOrders('order_ref\n'); } catch (e) { msg = e.message; } ok('a file with only a header is refused', /no rows/.test(msg));
  await c.csvPick({ size: 100, text: async () => csv }); ok('picking a file shows how many orders are ready', c.state.csvOrders.length === 2 && /2 orders with 3 lines/.test(c.state.csvInfo), c.state.csvInfo);
  await c.csvPick({ size: 5000000, text: async () => csv }); ok('a file over 2 MB is refused', /too big/.test(c.state.csvErr) && c.state.csvOrders === null);
  await c.csvPick({ size: 10, text: async () => 'nonsense' }); ok('a bad file shows the reason and nothing to import', c.state.csvOrders === null && !!c.state.csvErr);
  await c.csvPick({ size: 100, text: async () => csv }); rpcLog.length = 0; calls.length = 0; HELDIDS = [{ id: 'h1' }];
  IMPORTRES = [{ external_ref: 'A1', ok: true, ref: 'ORD-000020', status: 'allocated', duplicate: false }, { external_ref: 'A2', ok: true, ref: 'ORD-000021', status: 'held', duplicate: false }, { external_ref: 'A3', ok: false, error: 'Unknown SKU GHOST' }, { external_ref: 'A4', ok: true, ref: 'ORD-000005', status: 'allocated', duplicate: true }];
  await c.csvImport(); await settle();
  const im = rpcLog.find(([n]) => n === 'import_orders'); ok('import posts the grouped orders for the customer', im && im[1].p_org === 'o1' && im[1].p_orders.length === 2 && im[1].p_orders[0].lines[0].sku === 'MUG-BLUE');
  vo = c.renderVals(); ok('every order gets its own result line', vo.csvResultShow && vo.csvRows.length === 4 && /reserved/.test(vo.csvRows[0].text) && /on hold/.test(vo.csvRows[1].text) && /Unknown SKU GHOST/.test(vo.csvRows[2].text) && /Already imported as ORD-000005/.test(vo.csvRows[3].text) && vo.csvRows[2].color === '#B4442E');
  ok('held imports trigger the customer email once', calls.some(([u, b]) => /change-request/.test(u) && b && b.action === 'order_notify' && b.order_ids[0] === 'h1'));
  ok('the template download has the expected columns', decodeURIComponent(vo.csvTemplate).includes('order_ref,name,company,email,phone,address,address2,postal,city,country,sku,qty,notes'));
  ok('orders tab no longer shows the old empty-state', vo.tabOrders === true);
  // ---- product photos ----
  c.state = Object.assign({}, c.state, { orgId: 'o1', tab: 'products', whInv: [], whPhotoUrls: {} }); await c.whLoad();
  let vp = c.renderVals();
  ok('product row shows the first photo as a signed thumbnail', /object\/sign\/products\/o1\/p1\/a\.jpg\?token=t$/.test(vp.pdRows[0].thumb) && vp.pdRows[0].thumbDisplay === 'block', vp.pdRows[0].thumb);
  ok('a product without photos shows no broken image', vp.pdRows[1].thumbDisplay === 'none' && vp.pdRows[1].thumb === 'data:,');
  ok('inventory rows carry the thumbnail too', c.state.tab && c.renderVals().invRows.length >= 0);
  c.state = Object.assign({}, c.state, { tab: 'inventory' }); const iv = c.renderVals().invRows[0]; ok('inventory row has a thumbnail', iv && /object\/sign\/products/.test(iv.thumb) && iv.thumbDisplay === 'block', JSON.stringify(iv));
  c.state = Object.assign({}, c.state, { tab: 'products', pdSku: 'NEW-9', pdName: 'Photo thing', pdEan: '', pdOpen: true }); c.pdNewFiles = [new Blob(['x'], { type: 'image/jpeg' }), new Blob(['y'], { type: 'image/png' })];
  uploads.length = 0; setCalls.length = 0; await c.pdSubmit(); await settle();
  ok('creating with photos uploads each to org/product folder and sets the list', uploads.length === 2 && uploads.every((u) => /\/storage\/v1\/object\/products\/o1\/new-product-id\/[0-9a-f-]{36}\.(jpg|png)$/.test(u)) && setCalls.length === 1 && setCalls[0].p_product === 'new-product-id' && setCalls[0].p_paths.length === 2, JSON.stringify([uploads, setCalls]));
  ok('note says the product was added', c.state.whNote === 'Product added.' && c.pdNewFiles === null);
  c.state = Object.assign({}, c.state, { pdSku: 'NEW-8', pdName: 'Photo fail', pdOpen: true }); c.pdNewFiles = [new Blob(['x'], { type: 'image/jpeg' })]; failUpload = true; await c.pdSubmit(); await settle(); failUpload = false;
  ok('a failed photo upload does not lose the product, and says so', /Product added, but the photos did not upload/.test(c.state.whNote));
  // edit panel photos
  c.renderVals().pdRows[0].onEdit(); let ve = c.renderVals();
  ok('edit panel lists current photos with remove buttons', ve.pdPhotoRows.length === 2 && ve.pdPhotoRows[0].first === 'inline' && ve.pdPhotoRows[1].first === 'none');
  uploads.length = 0; setCalls.length = 0; await c.pdAddPhotos([new Blob(['x'], { type: 'image/jpeg' }), new Blob(['y'], { type: 'image/jpeg' }), new Blob(['z'], { type: 'image/jpeg' })]); await settle();
  ok('adding photos is capped at 4 in total and keeps the existing ones first', uploads.length === 2 && setCalls[0].p_paths.length === 4 && setCalls[0].p_paths[0] === 'o1/p1/a.jpg', JSON.stringify(setCalls));
  c.state = Object.assign({}, c.state, { whInv: c.state.whInv.map((p) => (p.product_id === 'p1' ? Object.assign({}, p, { photo_paths: ['o1/p1/a.jpg', 'o1/p1/b.jpg', 'o1/p1/c.jpg', 'o1/p1/d.jpg'] }) : p)) });
  uploads.length = 0; await c.pdAddPhotos([new Blob(['x'], { type: 'image/jpeg' })]); await settle(); ok('a fifth photo is refused with no upload', uploads.length === 0 && /At most 4/.test(c.state.pdErr)); c.state.pdErr = '';
  deletes.length = 0; setCalls.length = 0; REMOVED = ['o1/p1/b.jpg']; await c.pdRemovePhoto('o1/p1/b.jpg'); await settle();
  ok('removing a photo updates the list and deletes the file the database says dropped out', setCalls[0].p_paths.join() === 'o1/p1/a.jpg,o1/p1/c.jpg,o1/p1/d.jpg' && deletes.length === 1 && deletes[0][0] === 'o1/p1/b.jpg', JSON.stringify([setCalls, deletes])); REMOVED = [];
  // ---- customer edit and delete are REQUESTS that staff approve ----
  fail_ = null; const bk = { id: 'b9', ref: 'IN-000009', status: 'booked', expected_date: '2026-11-01', carrier: 'DHL', tracking: 'T', notes: 'n', inbound_lines: [{ product_id: 'p1', expected_qty: 5, products: { sku: 'SKU-1', name: 'Blue mug' } }] };
  const inv1 = [{ product_id: 'p1', sku: 'SKU-1', name: 'Blue mug', active: true, on_hand: 0, available: 0, unplaced: 0, quarantined: 0, incoming: 5 }];
  c.state = Object.assign({}, c.state, { view: 'dash', tab: 'inbound', whBook: [bk, Object.assign({}, bk, { id: 'b8', status: 'received' }), Object.assign({}, bk, { id: 'b7', status: 'cancelled' })], whInv: inv1, inLines: [], inOpen: false, whChanges: {} });
  let rows = c.renderVals().inRows;
  ok('booked row: request edit/delete shown; received: none; cancelled: delete only', rows[0].canEditDisplay === 'inline-block' && rows[0].canDeleteDisplay === 'inline-block' && rows[1].canEditDisplay === 'none' && rows[1].canDeleteDisplay === 'none' && rows[2].canEditDisplay === 'none' && rows[2].canDeleteDisplay === 'inline-block');
  rows[0].onEdit(); ok('edit loads the delivery into the form, titled as a request', c.state.inOpen && c.state.inEditId === 'b9' && c.state.inLines[0].qty === 5 && /Request a change/.test(c.renderVals().inFormTitle) && /approve/.test(c.renderVals().inFormNote));
  ok('save button says Send for approval', c.renderVals().inSaveLabel === 'Send for approval');
  c.state = Object.assign({}, c.state, { inLines: [{ pid: 'p1', qty: 12 }] }); calls.length = 0; await c.inSubmit(); await settle();
  const rq = calls.find(([u]) => /change-request/.test(u));
  ok('saving sends a change request, and never calls update_inbound or book_inbound', rq && rq[1].action === 'request' && rq[1].entity === 'inbound' && rq[1].kind === 'update' && rq[1].id === 'b9' && rq[1].payload.lines[0].qty === 12 && rq[1].payload.notes === 'n' && !calls.some(([u]) => /rpc\/(update_inbound|book_inbound)/.test(u)), JSON.stringify(rq));
  ok('customer is told it needs approval', /approval/.test(c.state.whNote) && c.state.inOpen === false && c.state.inEditId === '');
  calls.length = 0; await c.inDelete(bk); await settle(); const rd = calls.find(([u]) => /change-request/.test(u));
  ok('delete sends a deletion request, not a delete', rd && rd[1].kind === 'delete' && rd[1].entity === 'inbound' && !calls.some(([u]) => /rpc\/delete_inbound/.test(u)) && /approve/.test(c.state.whNote));
  fail_ = 'This delivery has arrived and can no longer be changed'; await c.inDelete(bk); await settle(); ok('refusal is shown', /can no longer be changed/.test(c.state.whErr)); fail_ = null; c.state.whErr = '';
  // pending + declined display
  c.state = Object.assign({}, c.state, { whBook: [bk, Object.assign({}, bk, { id: 'b8', status: 'received' }), Object.assign({}, bk, { id: 'b7', status: 'cancelled' })], whChanges: { b9: { id: 'c1', status: 'pending', summary: 'Edit delivery IN-000009' }, b7: { id: 'c2', status: 'rejected', decision_note: 'Pallet is full' } } });
  rows = c.renderVals().inRows;
  ok('a delivery with a pending request shows it and hides edit/delete', rows[0].pendDisplay === 'block' && /Edit delivery IN-000009/.test(rows[0].pendText) && rows[0].canEditDisplay === 'none' && rows[0].canDeleteDisplay === 'none');
  ok('a declined request shows its reason, and the buttons come back', rows[2].rejDisplay === 'block' && /Pallet is full/.test(rows[2].rejText) && rows[2].canDeleteDisplay === 'inline-block');
  calls.length = 0; rows[0].onCancelReq(); await new Promise((r) => setTimeout(r, 20)); const rc = calls.find(([u]) => /change-request/.test(u));
  ok('cancel request sends the cancel action with the request id', rc && rc[1].action === 'cancel' && rc[1].id === 'c1');
  CHG = [{ id: 'c1', entity_id: 'b9', summary: 'Edit delivery IN-000009', status: 'pending', decision_note: null }, { id: 'c0', entity_id: 'b9', summary: 'old', status: 'rejected', decision_note: 'older' }, { id: 'c3', entity_id: 'b8', summary: 'x', status: 'approved' }];
  await c.whLoad(); ok('loading keeps only the newest pending or declined request per item', c.state.whChanges.b9.status === 'pending' && c.state.whChanges.b9.id === 'c1' && c.state.whChanges.b8.status === 'done'); CHG = [];
  // products
  c.state = Object.assign({}, c.state, { tab: 'products', whInv: [{ product_id: 'p1', sku: 'SKU-1', name: 'Blue mug', active: true, on_hand: 0, available: 0, unplaced: 0, quarantined: 0, incoming: 0 }], whChanges: {} });
  c.renderVals().pdRows[0].onEdit(); let v2 = c.renderVals(); ok('product edit panel is a request', v2.pdEditForm && v2.pdEditSku === 'SKU-1' && v2.pdEditName === 'Blue mug' && v2.pdSwitchLabel === 'Request switch off' && v2.pdBusyLabel === 'Send for approval');
  c.state = Object.assign({}, c.state, { pdEditName: 'Blue mug XL', pdEditEan: '123456' }); calls.length = 0; await c.pdEditSave(); await settle();
  const rp = calls.find(([u]) => /change-request/.test(u));
  ok('product save sends one request with name and barcode, and writes nothing directly', rp && rp[1].entity === 'product' && rp[1].kind === 'update' && rp[1].payload.name === 'Blue mug XL' && rp[1].payload.ean === '123456' && !calls.some(([u]) => /rpc\//.test(u)) && c.state.pdEditId === '' && /approval/.test(c.state.whNote));
  c.renderVals().pdRows[0].onEdit(); calls.length = 0; await c.pdSwitch(); await settle(); ok('switch off is a request with active=false', calls.some(([u, b]) => /change-request/.test(u) && b.payload.active === false));
  c.renderVals().pdRows[0].onEdit(); calls.length = 0; fail_ = 'This product has been used on a delivery or in stock. Ask us to switch it off instead of deleting it.'; await c.pdDelete(); await settle();
  ok('product delete refusal is shown in the edit panel', c.renderVals().pdErrShow2 && /switch it off/.test(c.renderVals().pdErrText2) && c.state.pdEditId === 'p1');
  fail_ = null; calls.length = 0; await c.pdDelete(); await settle(); ok('product delete is a deletion request', calls.some(([u, b]) => /change-request/.test(u) && b.kind === 'delete') && c.state.pdEditId === '' && /approve/.test(c.state.whNote));
  c.state = Object.assign({}, c.state, { whChanges: { p1: { id: 'c9', status: 'pending', summary: 'Edit product SKU-1' } } }); const pr0 = c.renderVals().pdRows[0];
  ok('a product with a pending request shows it and hides the edit button', pr0.pendDisplay === 'block' && pr0.editDisplay === 'none' && /Edit product SKU-1/.test(pr0.pendText));
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();

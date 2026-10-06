import { JSDOM, VirtualConsole } from 'jsdom';
// The real customer dashboard in a simulated browser: the "Shipping" panel of an order (the customer's own label).
const vc = new VirtualConsole(); const errs = []; vc.on('jsdomError', (e) => errs.push(e.message.slice(0, 200))); vc.on('error', (m) => errs.push(String(m).slice(0, 200)));
let pass = 0, fail = 0; const ok = (n, x, e = '') => { x ? pass++ : fail++; console.log((x ? 'PASS ' : 'FAIL ') + n + (x ? '' : ' -> ' + e)); };
const tok = JSON.stringify({ access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'a@b.pl' } });
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const orders = [
  { id: 'a1', ref: 'ORD-000001', status: 'allocated', label_source: null, ship_name: 'Jan', ship_city: 'Warszawa', ship_country: 'PL', created_at: '2026-10-05T10:00:00Z', order_lines: [{ qty: 2, products: { sku: 'MUG', name: 'Mug' } }] },
  { id: 'a2', ref: 'ORD-000002', status: 'shipped', label_source: null, ship_name: 'Ola', ship_city: 'Gdansk', ship_country: 'PL', created_at: '2026-10-05T11:00:00Z', order_lines: [] },
  { id: 'a3', ref: 'ORD-000003', status: 'cancelled', label_source: null, ship_name: 'Ewa', ship_city: 'Lodz', ship_country: 'PL', created_at: '2026-10-05T12:00:00Z', order_lines: [] },
  { id: 'a4', ref: 'ORD-000004', status: 'packed', label_source: 'own', ship_name: 'Pia', ship_city: 'Krakow', ship_country: 'PL', created_at: '2026-10-05T13:00:00Z', order_lines: [] }];
const run = async (behaviour) => {
  const calls = []; let uploaded = [];
  const dom = await JSDOM.fromURL('http://localhost:8000/platform?view=dash', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.localStorage.setItem('sb-hvbcmilcjragrcezwzlo-auth-token', tok); w.scrollTo = () => {};
      w.fetch = async (url, o = {}) => { const u = String(url); const j = (d, status = 200) => ({ ok: status < 400, status, json: async () => d });
        if (/customer-shipping/.test(u)) { const b = JSON.parse(o.body); calls.push(b); return behaviour(b, j); }
        if (/storage\/v1\/object\/labels\//.test(u)) { uploaded.push({ url: u, type: o.headers['Content-Type'], size: o.body && o.body.size }); return j({}, behaviour.uploadStatus || 200); }
        if (/members\?/.test(u)) return j([{ org_id: 'o1', role: 'owner', organizations: { name: 'Acme', country: 'PL', status: 'active', domain_orders: [] } }]);
        if (/orders\?/.test(u)) return j(orders); return j([]); } } });
  await wait(1800); return { dom, calls, uploaded };
};
const info = { order: { id: 'a1', ref: 'ORD-000001', status: 'allocated' }, label_source: null, own_label: null };
let label = null;
const normal = (mode) => (b, j) => {
  if (b.action === 'capabilities') return j({ mode, can_prepare: true, own_label: mode !== 'storage', buy_label: false });
  if (b.action === 'status') return j({ ...info, order: { ...info.order, id: b.order_id }, label_source: label ? 'own' : null, own_label: label });
  if (b.action === 'own_label.attach') { label = { filename: b.filename, has_file: !!b.path, path: b.path, tracking_numbers: String(b.tracking || '').split(',').map((x) => x.trim()).filter(Boolean), carrier: b.carrier, added_at: '2026-10-06T10:00:00Z' }; return j({ ok: true }); }
  if (b.action === 'own_label.remove') { label = null; return j({ ok: true }); }
  return j({ error: 'Unknown' }, 400);
};
const openOrders = async (dom) => { const d = dom.window.document; const nav = [...d.querySelectorAll('button, a')].find((b) => b.textContent.trim().startsWith('Orders')); nav.click(); await wait(500); return d; };
const btn = (d, t) => [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === t);
const pickFile = (dom, input, file) => { Object.defineProperty(input, 'files', { value: [file], configurable: true }); input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
const pdf = (dom, name = 'label.pdf', size = 100) => new dom.window.File([new Uint8Array(size)], name, { type: 'application/pdf' });

let { dom, calls, uploaded } = await run(normal('payg')); let d = await openOrders(dom);
const shipBtns = [...d.querySelectorAll('button')].filter((b) => /^Shipping/.test(b.textContent.trim()));
ok('open orders get a Shipping button; shipped and cancelled orders do not', shipBtns.length === 2 && shipBtns.every((b) => b.style.display !== 'none') || [...d.querySelectorAll('button')].filter((b) => /^Shipping/.test(b.textContent.trim()) && b.style.display !== 'none').length === 2, String(shipBtns.length));
ok('an order that already has an own label says so on the button', [...d.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Shipping (own label added)'));
btn(d, 'Shipping').click(); await wait(500);
ok('opening the panel asks the server what this customer can do and for the order\'s state', calls.some((c) => c.action === 'capabilities') && calls.some((c) => c.action === 'status' && c.order_id === 'a1'));
ok('on fulfilment as you go the panel explains it and offers the own-label form', /How is this order shipped\?/.test(d.body.textContent) && /you prepare the label yourself/.test(d.body.textContent) && /I provide my own label/.test(d.body.textContent) && !!d.querySelector('input[aria-label="Label PDF"]'));
ok('it says there is no charge from 2ACE for an own label', /no shipping charge from us/.test(d.body.textContent));
// saving nothing, a wrong file, a huge file
btn(d, 'Save the label').click(); await wait(100); ok('saving with nothing is refused politely', /Add the label file, or at least a tracking number/.test(d.body.textContent) && !calls.some((c) => c.action === 'own_label.attach'));
pickFile(dom, d.querySelector('input[aria-label="Label PDF"]'), new dom.window.File(['x'], 'photo.png', { type: 'image/png' })); btn(d, 'Save the label').click(); await wait(100);
ok('a file that is not a PDF is refused in the browser', /must be a PDF file/.test(d.body.textContent) && uploaded.length === 0);
pickFile(dom, d.querySelector('input[aria-label="Label PDF"]'), pdf(dom, 'big.pdf', 3 * 1024 * 1024)); btn(d, 'Save the label').click(); await wait(100);
ok('a file over 2 MB is refused in the browser', /at most 2 MB/.test(d.body.textContent) && uploaded.length === 0);
// the real thing
pickFile(dom, d.querySelector('input[aria-label="Label PDF"]'), pdf(dom, 'Allegro label.pdf', 4000));
const set = (el, v) => { el.value = v; el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
set(d.querySelector('input[aria-label="Carrier"]'), 'InPost'); set(d.querySelector('input[aria-label="Tracking numbers"]'), '6200 1234, JJD0001'); await wait(100);
btn(d, 'Save the label').click(); await wait(600);
ok('the PDF goes into the customer\'s own folder for that order, as application/pdf', uploaded.length === 1 && /storage\/v1\/object\/labels\/o1\/a1\/[0-9a-f-]{36}\.pdf$/.test(uploaded[0].url) && uploaded[0].type === 'application/pdf' && uploaded[0].size === 4000, JSON.stringify(uploaded));
const at = calls.find((c) => c.action === 'own_label.attach');
ok('then the server is told the path, file name, carrier and tracking', at && at.order_id === 'a1' && /^o1\/a1\/[0-9a-f-]{36}\.pdf$/.test(at.path) && at.filename === 'Allegro label.pdf' && at.carrier === 'InPost' && at.tracking === '6200 1234, JJD0001', JSON.stringify(at));
ok('the customer sees it was saved and what is on file', /Saved\. We will print this label/.test(d.body.textContent) && /Current label: Allegro label\.pdf · InPost · 6200 1234, JJD0001/.test(d.body.textContent));
ok('the button now offers to replace it, and the order row says it has a label', !!btn(d, 'Replace the label') && [...d.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Shipping (own label added)' || b.textContent.trim() === 'Hide shipping'));
// tracking only
const before = uploaded.length; set(d.querySelector('input[aria-label="Tracking numbers"]'), 'AAA111'); btn(d, 'Replace the label').click(); await wait(500);
ok('tracking numbers alone need no upload', uploaded.length === before && calls.filter((c) => c.action === 'own_label.attach').slice(-1)[0].path === null);
// remove
btn(d, 'Remove').click(); await wait(500);
ok('removing the label tells the server and updates the panel', calls.some((c) => c.action === 'own_label.remove' && c.order_id === 'a1') && /Label removed/.test(d.body.textContent) && !!btn(d, 'Save the label'));
// closing
btn(d, 'Hide shipping').click(); await wait(200); const heading = () => [...d.querySelectorAll('span')].find((x) => x.textContent === 'How is this order shipped?');
ok('the panel closes again', heading().parentElement.style.display === 'none');
ok('no errors while rendering', errs.length === 0, errs.slice(0, 3).join(' | ')); dom.window.close();

// full fulfilment: same form, different words
label = null; ({ dom, calls, uploaded } = await run(normal('full'))); d = await openOrders(dom); btn(d, 'Shipping').click(); await wait(500);
ok('on full fulfilment it says we buy the label at packing, and the customer can still add their own', /we choose the carrier and buy the label when your order is packed/.test(d.body.textContent) && !!d.querySelector('input[aria-label="Label PDF"]')); dom.window.close();
// storage only: no form
({ dom, calls, uploaded } = await run(normal('storage'))); d = await openOrders(dom); btn(d, 'Shipping').click(); await wait(500);
const own = [...d.querySelectorAll('strong')].find((x) => x.textContent === 'I provide my own label.').parentElement.parentElement;
ok('a plan without fulfilment is told so and gets no upload form', /does not include fulfilment/.test(d.body.textContent) && own.style.display === 'none', own.style.display); dom.window.close();
// refusals from the server are shown
const refusing = (b, j) => (b.action === 'own_label.attach' ? j({ error: 'This order is shipped, so a label can no longer be added' }, 400) : normal('payg')(b, j));
({ dom, calls, uploaded } = await run(refusing)); d = await openOrders(dom); btn(d, 'Shipping').click(); await wait(500);
set(d.querySelector('input[aria-label="Tracking numbers"]'), 'AAA111'); btn(d, 'Save the label').click(); await wait(500);
ok('a refusal from the server is shown on the panel', /so a label can no longer be added/.test(d.body.textContent) && !!btn(d, 'Save the label')); dom.window.close();
// the function is not deployed yet
const missing = (b, j) => j({}, 404);
({ dom, calls, uploaded } = await run(missing)); d = await openOrders(dom); btn(d, 'Shipping').click(); await wait(500);
ok('if the shipping function is not deployed the customer gets a plain message, not a broken page', /Shipping tools are not available yet/.test(d.body.textContent));
ok('still no errors', errs.length === 0, errs.slice(0, 3).join(' | ')); dom.window.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

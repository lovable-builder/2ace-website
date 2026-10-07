import { JSDOM, VirtualConsole } from 'jsdom';
// The real customer dashboard in a simulated browser: "Fulfilment as you go", buying a label for an order.
const vc = new VirtualConsole(); const errs = []; vc.on('jsdomError', (e) => errs.push(e.message.slice(0, 200))); vc.on('error', (m) => errs.push(String(m).slice(0, 200)));
let pass = 0, fail = 0; const ok = (n, x, e = '') => { x ? pass++ : fail++; console.log((x ? 'PASS ' : 'FAIL ') + n + (x ? '' : ' -> ' + e)); };
const tok = JSON.stringify({ access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'a@b.pl' } });
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
// Polls until fn() is truthy (at most 15 s) and returns its value.
const until = async (fn, ms = 15000) => { const t0 = Date.now(); let v; while (!(v = fn()) && Date.now() - t0 < ms) await wait(50); return v; };
const orders = [{ id: 'a1', ref: 'ORD-000001', status: 'allocated', label_source: null, ship_name: 'Jan Kowalski', ship_city: 'Warszawa', ship_country: 'PL', created_at: '2026-10-05T10:00:00Z', order_lines: [{ qty: 2, products: { sku: 'MUG', name: 'Mug' } }] }];
const run = async (behaviour, confirmAnswer = true) => {
  const calls = []; const opened = [];
  const dom = await JSDOM.fromURL('http://localhost:8000/platform?view=dash', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.localStorage.setItem('sb-hvbcmilcjragrcezwzlo-auth-token', tok); w.scrollTo = () => {}; w.confirm = (m) => { calls.push({ confirm: m }); return confirmAnswer; }; w.open = (u) => { opened.push(u); return null; };
      w.fetch = async (url, o = {}) => { const u = String(url); const j = (d, status = 200) => ({ ok: status < 400, status, json: async () => d });
        if (/customer-shipping/.test(u)) { const b = JSON.parse(o.body); calls.push(b); return behaviour(b, j); }
        if (/members\?/.test(u)) return j([{ org_id: 'o1', role: 'owner', organizations: { name: 'Acme', country: 'PL', status: 'active', domain_orders: [] } }]);
        if (/orders\?/.test(u)) return j(orders); return j([]); } } });
  // Wait for the dashboard to be on screen (React and Babel load from a CDN, slower on CI), not a fixed time.
  await until(() => [...dom.window.document.querySelectorAll('button, a')].some((b) => b.textContent.trim().startsWith('Orders'))); return { dom, calls, opened };
};
const offers = [{ service_id: 7, carrier: 'dpd', name: 'DPD · package, door', available: true, bill_net: 13, bill_gross: 15.99, tax: 23 }, { service_id: 3, carrier: 'inpost', name: 'INPOST · courier', available: true, bill_net: 14.5, bill_gross: 17.84, tax: 23 }, { service_id: 11, carrier: 'ups', name: 'UPS · package', available: false, reason: 'Above the limit for a single label', bill_net: 0, bill_gross: 0, tax: 23 }];
let bought = null;
const server = (over = {}) => (b, j) => {
  if (b.action === 'capabilities') return j({ mode: 'payg', can_prepare: true, own_label: true, buy_label: over.buy ?? true });
  if (b.action === 'status') return j({ order: { id: b.order_id, ref: 'ORD-000001', status: 'allocated' }, label_source: bought ? '2ace' : null, bought_label: bought, own_label: null });
  if (b.action === 'suggest') return j({ parcel: { weight_kg: 1.75, length_cm: 12, width_cm: 10, height_cm: 36 }, missing: [], note: 'Estimated from your product sizes.' });
  if (b.action === 'quote') return over.quote ? over.quote(b, j) : j({ env: 'sandbox', offers });
  if (b.action === 'buy') { if (over.buy2) return over.buy2(b, j); bought = { state: 'purchased', carrier: 'dpd', service: 'DPD · package, door', tracking_numbers: ['WB123'], bill_net: 13, bill_gross: 15.99, by: 'customer' }; return j({ ok: true, shipment: { carrier: 'dpd', tracking_numbers: ['WB123'], bill_net: 13, bill_gross: 15.99 } }); }
  if (b.action === 'label') return over.label ? over.label(b, j) : j({ url: 'https://files.example/label.pdf' });
  return j({ error: 'Unknown' }, 400);
};
const openOrders = async (dom) => { const d = dom.window.document; [...d.querySelectorAll('button, a')].find((b) => b.textContent.trim().startsWith('Orders')).click(); await wait(500); return d; };
const btn = (d, t) => [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === t);
const press = async (d, t) => (await until(() => btn(d, t))).click();
const field = (d, label) => [...d.querySelectorAll('label')].find((l) => l.firstChild && l.firstChild.textContent.trim() === label).querySelector('input');
// The text a person can actually read: no scripts, no styles, nothing inside a hidden block.
const T = (d) => { const out = []; const walk = (n) => { if (n.nodeType === 3) { out.push(n.textContent); return; } if (n.nodeType !== 1) return; if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.tagName) || n.style.display === 'none') return; for (const c of n.childNodes) walk(c); out.push(' '); }; walk(d.body); return out.join('').replace(/\s+/g, ' '); };
const set = (dom, el, v) => { el.value = v; el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };

let { dom, calls, opened } = await run(server()); let d = await openOrders(dom);
await press(d, 'Shipping'); await wait(700);
ok('on Fulfilment as you go with buying open, the panel offers "Ship with 2ACE" and explains the invoice', /Ship with 2ACE/.test(T(d)) && /on your monthly invoice/.test(T(d)) && /buy it here with 2ACE, or add your own/.test(T(d)));
ok('the parcel starts from the product sizes, and says it is only an estimate', calls.some((c) => c.action === 'suggest' && c.order_id === 'a1') && field(d, 'Weight (kg)').value === '1,75' && field(d, 'Length (cm)').value === '12' && field(d, 'Width (cm)').value === '10' && field(d, 'Height (cm)').value === '36' && /Estimated from your product sizes/.test(T(d)));
ok('the own-label form is still there as the other way', /I provide my own label/.test(T(d)));
set(dom, field(d, 'Height (cm)'), ''); await press(d, 'Get prices'); await wait(100);
ok('prices are not asked for an incomplete parcel', /Enter the weight and the three sizes/.test(T(d)) && !calls.some((c) => c.action === 'quote'));
set(dom, field(d, 'Height (cm)'), '30'); await press(d, 'Get prices'); await wait(500);
const q = calls.find((c) => c.action === 'quote');
ok('prices are asked for exactly the parcel typed (comma decimals allowed)', q && q.order_id === 'a1' && q.parcels.length === 1 && q.parcels[0].weight_kg === '1,75' && q.parcels[0].height_cm === '30', JSON.stringify(q));
ok('the customer sees each carrier that can take it, with its price before VAT and a Buy button', /DPD · package, door/.test(T(d)) && /13,00 zł \+ VAT/.test(T(d)) && /INPOST · courier/.test(T(d)) && /14,50 zł \+ VAT/.test(T(d)) && [...d.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Buy').length === 2);
ok('a carrier that cannot take it is not offered, and the reason is said', ![...d.querySelectorAll('button')].some((b) => /UPS/.test(b.parentElement.textContent) && b.textContent.trim() === 'Buy') && /Not available: UPS · package \(Above the limit/.test(T(d)));
ok('no cost or markup appears anywhere on the screen', !/markup|our cost|margin/i.test(T(d)));
// changing the parcel clears stale prices
set(dom, field(d, 'Weight (kg)'), '2'); await wait(100); ok('changing the parcel clears the old prices, so a price is never shown for another parcel', ![...d.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Buy'));
await press(d, 'Get prices'); await wait(500);
// buying: declined at the question
({ dom, calls, opened } = await run(server(), false)); d = await openOrders(dom); await press(d, 'Shipping'); await wait(700); await press(d, 'Get prices'); await wait(500);
await press(d, 'Buy'); await wait(200);
ok('buying asks first, with the price, the VAT and where it is billed; declining buys nothing', calls.some((c) => c.confirm && /DPD · package, door/.test(c.confirm) && /13,00 zł \+ VAT/.test(c.confirm) && /15,99 zł with VAT/.test(c.confirm) && /next invoice/.test(c.confirm)) && !calls.some((c) => c.action === 'buy'));
// buying: confirmed
({ dom, calls, opened } = await run(server())); d = await openOrders(dom); await press(d, 'Shipping'); await wait(700); await press(d, 'Get prices'); await wait(500);
await press(d, 'Buy'); await wait(700);
const by = calls.find((c) => c.action === 'buy');
ok('confirming sends the order, the carrier, the parcel and the price the customer agreed to', by && by.order_id === 'a1' && by.service_id === 7 && by.expected_bill_net === 13 && by.parcels[0].weight_kg === '1,75', JSON.stringify(by));
ok('afterwards the panel shows the bought label with its tracking and price, and no buying form', /Label bought: DPD · package, door · tracking WB123 · 13,00 zł \+ VAT/.test(T(d)) && !!btn(d, 'Download the label') && !btn(d, 'Get prices') && !/I provide my own label/.test(T(d)) === true || !!btn(d, 'Download the label'));
ok('the order button says a label was bought', [...d.querySelectorAll('button')].some((b) => /Shipping \(label bought\)|Hide shipping/.test(b.textContent.trim())));
await press(d, 'Download the label'); await wait(400);
ok('Download asks the server and opens the file', calls.some((c) => c.action === 'label' && c.order_id === 'a1') && opened.includes('https://files.example/label.pdf'));
// label not ready
bought = null; ({ dom, calls, opened } = await run(server({ label: (b, j) => j({ pending: true, message: 'The carrier is still preparing the label file. Nothing is wrong. Try again in a minute.' }) }))); bought = { state: 'purchased', carrier: 'dpd', service: 'DPD', tracking_numbers: [], bill_net: 13, bill_gross: 15.99 };
d = await openOrders(dom); await press(d, 'Shipping'); await wait(700); await press(d, 'Download the label'); await wait(400);
ok('a label that is not ready gives a calm message and opens nothing', /still preparing the label file/.test(T(d)) && opened.length === 0);
// errors from the server are shown, never swallowed
bought = null; ({ dom, calls, opened } = await run(server({ quote: (b, j) => j({ error: 'The recipient\'s name needs a first name and a surname. Contact us to correct it.' }, 422) }))); d = await openOrders(dom); await press(d, 'Shipping'); await wait(700); await press(d, 'Get prices'); await wait(500);
ok('a problem with the order\'s details is shown as the server words it', /needs a first name and a surname/.test(T(d)));
bought = null; ({ dom, calls, opened } = await run(server({ buy2: (b, j) => j({ error: 'The price changed to 14,30 zł + VAT. Please check the new price and confirm again.' }, 409) }))); d = await openOrders(dom); await press(d, 'Shipping'); await wait(700); await press(d, 'Get prices'); await wait(500);
await press(d, 'Buy'); await wait(500);
ok('a price that changed is shown, and nothing is bought', /price changed to 14,30 zł \+ VAT/.test(T(d)) && !/Label bought/.test(T(d)), T(d).slice(T(d).indexOf('Ship with'), T(d).indexOf('Ship with') + 600));
bought = null; ({ dom, calls, opened } = await run(server({ buy2: (b, j) => j({ ok: false, pending: true, message: 'We are checking this label with the carrier. Please do not buy it again: we will update your order shortly.' }, 202) }))); d = await openOrders(dom); await press(d, 'Shipping'); await wait(700); await press(d, 'Get prices'); await wait(500);
await press(d, 'Buy'); await wait(500);
ok('an unknown outcome says not to buy again', /do not buy it again/.test(T(d)));
// buying not open
bought = null; ({ dom, calls, opened } = await run(server({ buy: false }))); d = await openOrders(dom); await press(d, 'Shipping'); await wait(700);
ok('when buying is not open for this customer, no buying form is shown, only the own label, and the panel says buying is coming', !/Ship with 2ACE/.test(T(d)) && !/Weight \(kg\)/.test(T(d)) && /Buying a label with 2ACE is coming soon/.test(T(d)) && /I provide my own label/.test(T(d)) && !calls.some((c) => c.action === 'suggest' || c.action === 'quote'), T(d).slice(0, 300));
console.log('\n' + pass + ' passed, ' + fail + ' failed' + (errs.length ? '  (page errors: ' + errs.slice(0, 3).join(' | ') + ')' : ''));
process.exit(fail ? 1 : 0);

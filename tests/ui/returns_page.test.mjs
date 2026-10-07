import { JSDOM, VirtualConsole } from 'jsdom';
// The real customer dashboard in a simulated browser: the Returns tab (announce a return, issue the return label, follow it, see the charges).
const vc = new VirtualConsole(); const errs = []; vc.on('jsdomError', (e) => errs.push(e.message.slice(0, 200))); vc.on('error', (m) => errs.push(String(m).slice(0, 200)));
let pass = 0, fail = 0; const ok = (n, x, e = '') => { x ? pass++ : fail++; console.log((x ? 'PASS ' : 'FAIL ') + n + (x ? '' : ' -> ' + e)); };
const tok = JSON.stringify({ access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'a@b.pl' } });
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const orders = [{ id: 'o1', ref: 'ORD-000001', status: 'shipped', label_source: null, ship_name: 'Anna Nowak', ship_line1: 'Lipowa 5', ship_line2: '2', ship_postal: '31-000', ship_city: 'Krakow', ship_country: 'PL', ship_phone: '600100200', ship_email: 'anna@x.pl', created_at: '2026-10-05T10:00:00Z', order_lines: [{ qty: 3, product_id: 'p1', products: { sku: 'MUG', name: 'Blue mug' } }, { qty: 1, product_id: 'p2', products: { sku: 'CAP', name: 'Red cap' } }] },
  { id: 'o2', ref: 'ORD-000002', status: 'allocated', label_source: null, ship_name: 'Jan', ship_line1: 'x', ship_postal: '00-001', ship_city: 'Warszawa', ship_country: 'PL', created_at: '2026-10-05T11:00:00Z', order_lines: [] }];
const run = async (S, confirmAnswer = true) => {
  const calls = [], opened = [];
  const dom = await JSDOM.fromURL('http://localhost:8000/platform?view=dash&tab=returns', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.localStorage.setItem('sb-hvbcmilcjragrcezwzlo-auth-token', tok); w.scrollTo = () => {}; w.confirm = (m) => { calls.push({ confirm: m }); return confirmAnswer; }; w.open = (u) => { opened.push(u); return null; };
      w.fetch = async (url, o = {}) => { const u = String(url); const j = (d, status = 200) => ({ ok: status < 400, status, json: async () => d });
        if (/customer-shipping/.test(u)) { const b = JSON.parse(o.body); calls.push(b); return S.cs(b, j); }
        if (/rpc\/create_return/.test(u)) { const b = JSON.parse(o.body); calls.push({ rpc: 'create_return', ...b }); return S.create ? S.create(b, j) : j({ id: 'r9', ref: 'RET-000009', fee_mode: 'payg' }); }
        if (/rpc\/cancel_return/.test(u)) { calls.push({ rpc: 'cancel_return', ...JSON.parse(o.body) }); return j(null); }
        if (/rpc\/my_charges/.test(u)) return j(S.charges || []);
        if (/rpc\/handling_tariff/.test(u)) return j({ tiers: [{ size_class: 'XS', handling_net: 3.2, return_net: 4.8 }, { size_class: 'XL', handling_net: 12.9, return_net: 19.35 }], extra_parcel: 0.6, return_extra_parcel: 0.9 });
        if (/members\?/.test(u)) return j([{ org_id: 'o1', role: 'owner', organizations: { name: 'Acme', country: 'PL', status: 'active', domain_orders: [] } }]);
        if (/returns\?/.test(u)) return j(S.returns || []);
        if (/orders\?/.test(u)) return j(orders); return j([]); } } });
  await wait(1800); return { dom, calls, opened };
};
const T = (d) => { const out = []; const walk = (n) => { if (n.nodeType === 3) { out.push(n.textContent); return; } if (n.nodeType !== 1) return; if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.tagName) || n.style.display === 'none') return; for (const c of n.childNodes) walk(c); out.push(' '); }; walk(d.body); return out.join('').replace(/\s+/g, ' '); };
const shown = (n) => { for (let x = n; x && x.nodeType === 1; x = x.parentElement) if (x.style.display === 'none') return false; return true; };
const btn = (d, t) => [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === t && shown(b));
const lab = (d, text) => [...d.querySelectorAll('label')].find((l) => l.firstChild && l.firstChild.textContent.trim().startsWith(text));
const inp = (d, text) => lab(d, text).querySelector('input,select');
const pickOpt = (dom, sel, v) => { if (![...sel.options].some((o) => o.value === v)) { const o = dom.window.document.createElement('option'); o.value = v; sel.append(o); } sel.value = v; sel.dispatchEvent(new dom.window.Event('change', { bubbles: true })); sel.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
const set = (dom, el, v) => { el.value = v; el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); el.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
const offers = [{ service_id: 7, carrier: 'dpd', name: 'DPD · package, door', available: true, bill_net: 13, bill_gross: 15.99, tax: 23 }, { service_id: 3, carrier: 'inpost', name: 'INPOST · courier', available: true, bill_net: 14.5, bill_gross: 17.84, tax: 23 }, { service_id: 11, carrier: 'ups', name: 'UPS', available: false, reason: 'x', bill_net: 0, bill_gross: 0, tax: 23 }];
let label = null;
const cs = (over = {}) => (b, j) => {
  if (b.action === 'capabilities') return j({ mode: 'storage', can_prepare: true, own_label: false, buy_label: false, buy_return_label: over.canBuy ?? true });
  if (b.action === 'return.status') return j({ return: { id: b.return_id, ref: 'RET-000001', status: label ? 'label_issued' : 'announced' }, label });
  if (b.action === 'return.quote') return over.quote ? over.quote(b, j) : j({ env: 'sandbox', offers });
  if (b.action === 'return.buy') { if (over.buy) return over.buy(b, j); label = { state: 'purchased', carrier: 'dpd', service: 'DPD · package, door', tracking_numbers: ['WB5'], bill_net: 13, bill_gross: 15.99 }; return j({ ok: true, shipment: {} }); }
  if (b.action === 'return.label') return over.label ? over.label(b, j) : j({ url: 'https://files.example/ret.pdf' });
  return j({ error: 'Unknown' }, 400);
};
const openTab = async (dom) => { const d = dom.window.document; [...d.querySelectorAll('button, a')].find((b) => b.textContent.trim().startsWith('Returns')).click(); await wait(500); return d; };

// ---- nothing yet ----
let { dom, calls } = await run({ cs: cs() }); let d = await openTab(dom);
ok('the Returns tab opens a real screen (not the old "coming soon" card) with an honest empty state', /Returns/.test(T(d)) && /No returns yet/.test(T(d)) && !btn(d, 'Back to overview') && !!btn(d, 'New return'), T(d).slice(0, 300));
ok('it explains that returns are pay as you go, with the real return prices from the tariff', /Returns are pay as you go: 4,80 zł to 19,35 zł per return, by the size of the parcel, on your monthly invoice/.test(T(d)), T(d).slice(0, 500));
// ---- announce ----
btn(d, 'New return').click(); await wait(300); ok('the form asks which order the goods came from', /The order the goods came from/.test(T(d)) && !!inp(d, 'The order the goods came from'));
btn(d, 'Announce the return').click(); await wait(100); ok('announcing with no order is refused politely', /Choose the order the goods are coming back from/.test(T(d)) && !calls.some((c) => c.rpc === 'create_return'));
pickOpt(dom, inp(d, 'The order the goods came from'), 'o1'); await wait(150);
ok('choosing the order fills in the buyer from it (street and number together) and lists its products', inp(d, 'First name and surname').value === 'Anna Nowak' && inp(d, 'Phone, required').value === '600100200' && inp(d, 'Street and number').value === 'Lipowa 5 2' && inp(d, 'Postal code').value === '31-000' && inp(d, 'City').value === 'Krakow' && /Blue mug \(ordered 3\)/.test(T(d)) && /Red cap \(ordered 1\)/.test(T(d)));
btn(d, 'Announce the return').click(); await wait(100); ok('announcing with no quantities is refused politely', /Enter how many of each product are coming back/.test(T(d)) && !calls.some((c) => c.rpc === 'create_return'));
{ const qs = [...d.querySelectorAll('input[aria-label="Units coming back"]')]; set(dom, qs[0], '2'); set(dom, inp(d, 'Why is it coming back?'), 'Too small'); }
btn(d, 'Announce the return').click(); await wait(500);
const cr = calls.find((c) => c.rpc === 'create_return');
ok('announcing sends the company, the order, the buyer, the reason and only the lines with a quantity', cr && cr.p_order === 'o1' && cr.p_buyer.name === 'Anna Nowak' && cr.p_buyer.phone === '600100200' && cr.p_buyer.line1 === 'Lipowa 5 2' && cr.p_buyer.postal === '31-000' && cr.p_buyer.country === 'PL' && cr.p_reason === 'Too small' && JSON.stringify(cr.p_lines) === '[{"product_id":"p1","qty":2}]', JSON.stringify(cr));
ok('the customer is told the reference', /Return RET-000009 announced/.test(T(d)));
// a refusal from the database is shown in the form
({ dom, calls } = await run({ cs: cs(), create: (b, j) => j({ message: 'The recipient phone must be a Polish number with 9 digits, for example 608 180 946' }, 400) })); d = await openTab(dom);
btn(d, 'New return').click(); await wait(100); pickOpt(dom, inp(d, 'The order the goods came from'), 'o1'); await wait(150); set(dom, [...d.querySelectorAll('input[aria-label="Units coming back"]')][0], '1'); btn(d, 'Announce the return').click(); await wait(400);
ok('a refusal from the database is shown in the form, in its words', /Polish number with 9 digits/.test(T(d)));

// ---- a return: issue the label ----
const ret = { id: 'r1', ref: 'RET-000001', status: 'announced', fee_mode: 'payg', reason: 'Too small', order_id: 'o1', created_at: '2026-10-06T09:00:00Z', buyer_name: 'Anna Nowak', buyer_city: 'Krakow', return_lines: [{ qty: 2, received_qty: null, grade: null, note: null, products: { sku: 'MUG', name: 'Blue mug' } }] };
label = null; ({ dom, calls } = await run({ cs: cs(), returns: [ret] })); d = await openTab(dom);
ok('a return is listed with its status, buyer and items', /RET-000001/.test(T(d)) && /Announced\. Issue the label, or wait for the parcel\./.test(T(d)) && /Anna Nowak, Krakow/.test(T(d)) && /MUG × 2/.test(T(d)));
btn(d, 'Issue the return label').click(); await wait(600);
ok('opening the label panel asks the server about this return and what the customer may do', calls.some((c) => c.action === 'capabilities') && calls.some((c) => c.action === 'return.status' && c.return_id === 'r1') && /Issue the return label\./.test(T(d)) && /delivers to our warehouse/.test(T(d)));
set(dom, inp(d, 'Weight (kg)'), '0,9'); set(dom, inp(d, 'Length (cm)'), '30'); set(dom, inp(d, 'Width (cm)'), '20'); btn(d, 'Get prices').click(); await wait(100);
ok('prices are not asked for an incomplete parcel', /Enter the weight and the three sizes/.test(T(d)) && !calls.some((c) => c.action === 'return.quote'));
set(dom, inp(d, 'Height (cm)'), '10'); btn(d, 'Get prices').click(); await wait(500);
ok('prices are asked for exactly that parcel, and each carrier is listed with its price and a Buy button', calls.some((c) => c.action === 'return.quote' && c.return_id === 'r1' && c.parcels[0].weight_kg === '0,9' && c.parcels[0].height_cm === '10') && /DPD · package, door/.test(T(d)) && /13,00 zł \+ VAT/.test(T(d)) && /Not available: UPS \(x\)/.test(T(d)) && [...d.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Buy' && shown(b)).length === 2 && !/markup|margin/i.test(T(d)));
[...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Buy' && shown(b)).click(); await wait(700);
const by = calls.find((c) => c.action === 'return.buy');
ok('buying asks first with the price, VAT and invoice, then sends the return, the carrier, the parcel and the agreed price', calls.some((c) => c.confirm && /DPD · package, door return label/.test(c.confirm) && /13,00 zł \+ VAT/.test(c.confirm) && /next invoice/.test(c.confirm)) && by && by.return_id === 'r1' && by.service_id === 7 && by.expected_bill_net === 13, JSON.stringify(by));
ok('afterwards the panel shows the bought return label with tracking and price, and no buying form', /Return label bought: DPD · package, door · tracking WB5 · 13,00 zł \+ VAT/.test(T(d)) && !!btn(d, 'Download the label') && !btn(d, 'Get prices'), T(d).slice(0, 400));
btn(d, 'Download the label').click(); await wait(400); ok('Download asks the server and opens the file', calls.some((c) => c.action === 'return.label' && c.return_id === 'r1'));
// declined, errors, not open
label = null; ({ dom, calls } = await run({ cs: cs() , returns: [ret] }, false)); d = await openTab(dom); btn(d, 'Issue the return label').click(); await wait(600); ['Weight (kg)', 'Length (cm)', 'Width (cm)', 'Height (cm)'].forEach((l, i) => set(dom, inp(d, l), ['1', '30', '20', '10'][i])); btn(d, 'Get prices').click(); await wait(500);
[...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Buy' && shown(b)).click(); await wait(300); ok('declining the question buys nothing', calls.some((c) => c.confirm) && !calls.some((c) => c.action === 'return.buy'));
label = null; ({ dom, calls } = await run({ cs: cs({ buy: (b, j) => j({ error: 'The price changed to 14,30 zł + VAT. Please check the new price and confirm again.' }, 409) }), returns: [ret] })); d = await openTab(dom); btn(d, 'Issue the return label').click(); await wait(600); ['Weight (kg)', 'Length (cm)', 'Width (cm)', 'Height (cm)'].forEach((l, i) => set(dom, inp(d, l), ['1', '30', '20', '10'][i])); btn(d, 'Get prices').click(); await wait(500);
[...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Buy' && shown(b)).click(); await wait(500); ok('a price that changed is shown and nothing is bought', /price changed to 14,30 zł \+ VAT/.test(T(d)) && !/Return label bought/.test(T(d)));
label = null; ({ dom, calls } = await run({ cs: cs({ canBuy: false }), returns: [ret] })); d = await openTab(dom); btn(d, 'Issue the return label').click(); await wait(600);
ok('when return labels are not open for this customer the panel says so and offers no form', /Return labels are not open for your account yet/.test(T(d)) && !btn(d, 'Get prices') && !/Weight \(kg\)/.test(T(d)));
// cancel
label = null; ({ dom, calls } = await run({ cs: cs(), returns: [ret] })); d = await openTab(dom); btn(d, 'Cancel').click(); await wait(500);
ok('cancelling asks, then cancels that return', calls.some((c) => c.confirm && /Cancel return RET-000001/.test(c.confirm)) && calls.some((c) => c.rpc === 'cancel_return' && c.p_return === 'r1'));
// a return that is on its way and one that is done
const done = { ...ret, id: 'r2', ref: 'RET-000002', status: 'graded', return_lines: [{ qty: 2, received_qty: 1, grade: 'A', note: null, products: { sku: 'MUG', name: 'Blue mug' } }, { qty: 1, received_qty: 1, grade: 'B', note: 'dented', products: { sku: 'CAP', name: 'Red cap' } }] };
const way = { ...ret, id: 'r3', ref: 'RET-000003', status: 'label_issued' };
({ dom, calls } = await run({ cs: cs(), returns: [done, way], charges: [{ at: '2026-10-06T10:00:00Z', kind: 'return_handling', net: 6.3, tax_percent: 23, status: 'pending', size_class: 'S', order_ref: null, return_ref: 'RET-000002', note: null }, { at: '2026-10-06T09:00:00Z', kind: 'return_label', net: 13, tax_percent: 23, status: 'test', size_class: null, order_ref: null, return_ref: 'RET-000003', note: null }, { at: '2026-10-05T09:00:00Z', kind: 'credit', net: -50, tax_percent: 23, status: 'queued', size_class: null, order_ref: null, return_ref: null, note: 'Monthly ceiling on handling fees' }] })); d = await openTab(dom);
ok('a graded return shows what came back and where it went, and that the fee is on the next invoice', /MUG: 1 back on your shelf/.test(T(d)) && /CAP: 1 set aside \(damaged, not sellable\): dented/.test(T(d)) && /A handling fee for this return is on your next invoice/.test(T(d)) && /Done/.test(T(d)));
ok('a return on its way says so and offers the label, not cancelling', /Label issued, on its way to us/.test(T(d)) && !!btn(d, 'Return label'));
ok('the charges are listed with what, which return, the price before VAT and where it is on the invoice', /Usage charges on your account/.test(T(d)) && /Return handling fee \(class S\) · RET-000002/.test(T(d)) && /6,30 zł \+ VAT/.test(T(d)) && /On your next invoice/.test(T(d)) && /Return label · RET-000003/.test(T(d)) && /Test, not billed/.test(T(d)) && /Credit: Monthly ceiling on handling fees/.test(T(d)) && /-50,00 zł \+ VAT/.test(T(d)), T(d).slice(-700));
ok('no cost, markup or margin anywhere on the screen', !/markup|our cost|margin/i.test(T(d)));
console.log('\n' + pass + ' passed, ' + fail + ' failed' + (errs.length ? '  (page errors: ' + errs.slice(0, 3).join(' | ') + ')' : ''));
process.exit(fail ? 1 : 0);

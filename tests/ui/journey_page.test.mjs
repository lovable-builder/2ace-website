import { JSDOM, VirtualConsole } from 'jsdom';
const vc = new VirtualConsole(); const errs = []; vc.on('jsdomError', (e) => errs.push(e.message.slice(0, 200))); vc.on('error', (m) => errs.push(String(m).slice(0, 200)));
let pass = 0, fail = 0; const ok = (n, x, e = '') => { x ? pass++ : fail++; console.log((x ? 'PASS ' : 'FAIL ') + n + (x ? '' : ' -> ' + e)); };
const tok = JSON.stringify({ access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'a@b.pl' } });
const now = new Date().toISOString(), old = new Date(Date.now() - 40 * 864e5).toISOString();
const run = async (data) => {
  const dom = await JSDOM.fromURL('http://localhost:8000/platform?view=dash', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.localStorage.setItem('sb-hvbcmilcjragrcezwzlo-auth-token', tok); w.scrollTo = () => {};
      w.fetch = async (url) => { const u = String(url); const j = (d) => ({ ok: true, json: async () => d });
        if (/members\?/.test(u)) return j([{ org_id: 'o1', role: 'owner', organizations: { name: 'Acme', country: 'PL', status: 'active', domain_orders: [] } }]);
        if (/v_inventory/.test(u)) return j(data.inv); if (/inbound_bookings/.test(u)) return j(data.book); if (/orders\?/.test(u)) return j(data.orders);
        return j([]); } } });
  await new Promise((r) => setTimeout(r, 1800)); return dom;
};
let dom = await run({ inv: [{ product_id: 'p1', sku: 'S1', name: 'Mug', active: true, on_hand: 20, available: 16, unplaced: 0, quarantined: 0, incoming: 0 }], book: [{ id: 'b1', ref: 'IN-1', status: 'booked', inbound_lines: [] }, { id: 'b2', ref: 'IN-2', status: 'receiving', inbound_lines: [] }],
  orders: [{ id: 'o1', ref: 'ORD-1', status: 'allocated', order_lines: [] }, { id: 'o2', ref: 'ORD-2', status: 'held', hold_reason: 'x', order_lines: [] }, { id: 'o3', ref: 'ORD-3', status: 'picking', order_lines: [] }, { id: 'o4', ref: 'ORD-4', status: 'shipped', shipped_at: now, order_lines: [] }, { id: 'o5', ref: 'ORD-5', status: 'shipped', shipped_at: old, order_lines: [] }] });
let d = dom.window.document; const st = [...d.querySelectorAll('button.jy-st')];
ok('the real Overview shows the journey card', /Where your goods are/.test(d.body.textContent) && st.length === 7, String(st.length));
ok('with the customer\'s live numbers', st.map((b) => b.querySelector('.jy-n').textContent).join(',') === '1,1,16,1,1,0,1', st.map((b) => b.querySelector('.jy-n').textContent).join(','));
ok('stations with something are lit, empty ones are not', st.map((b) => (b.className.includes(' on') ? 1 : 0)).join('') === '1111101', st.map((b) => b.className).join('|'));
ok('the held order is flagged on Ordered and explained', /1 on hold/.test(st[3].textContent) && /1 order is on hold/.test(d.body.textContent));
ok('the titles and plain explanations are there', /On your shelf/.test(d.body.textContent) && /Boxed, waiting for the courier/.test(d.body.textContent));
ok('connectors are drawn between stations, not after the last', st.slice(0, 6).every((b) => b.querySelector('.jy-hop').style.display === 'block') && st[6].querySelector('.jy-hop').style.display === 'none');
st[0].click(); await new Promise((r) => setTimeout(r, 400));
ok('tapping Booked opens the Inbound tab', /IN-1/.test(d.body.textContent) || /Book a delivery/.test(d.body.textContent));
ok('no errors while rendering', errs.length === 0, errs.slice(0, 3).join(' | '));
dom.window.close();
dom = await run({ inv: [], book: [], orders: [] }); d = dom.window.document;
ok('with nothing yet it shows zeros and tells the customer how to start', /Where your goods are/.test(d.body.textContent) && [...d.querySelectorAll('.jy-n')].every((n) => n.textContent === '0') && /Start by adding your products/.test(d.body.textContent), d.body.textContent.slice(0, 200));
ok('still no errors', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

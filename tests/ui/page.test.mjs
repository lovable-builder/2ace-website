import { JSDOM, VirtualConsole } from 'jsdom';
const vc = new VirtualConsole(); const errs = []; vc.on('jsdomError', (e) => errs.push(e.message.slice(0, 200))); vc.on('error', (m) => errs.push(String(m).slice(0, 200)));
const tok = JSON.stringify({ access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'a@b.pl' } });
const dom = await JSDOM.fromURL('http://localhost:8000/platform?view=dash', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w) { w.localStorage.setItem('sb-hvbcmilcjragrcezwzlo-auth-token', tok); w.scrollTo = () => {};
    w.fetch = async (url) => { const u = String(url); const j = (d) => ({ ok: true, json: async () => d });
      if (/members\?/.test(u)) return j([{ org_id: 'o1', role: 'owner', organizations: { name: 'Acme', country: 'PL', status: 'active', domain_orders: [] } }]);
      if (/v_inventory/.test(u)) return j([{ product_id: 'p1', sku: 'SKU-1', name: 'Blue mug', active: true, on_hand: 0, available: 0, unplaced: 0, quarantined: 0, incoming: 0 }]);
      return j([]); }; } });
const w = dom.window, d = w.document; const tick = (ms = 400) => new Promise((r) => setTimeout(r, ms));
await tick(1500);
console.log('title/body ok:', d.body.textContent.includes('Overview'), '| errors:', errs.length, errs.slice(0, 3));
const nav = [...d.querySelectorAll('button, a')].find((b) => b.textContent.trim().startsWith('Inbound'));
console.log('inbound nav found:', !!nav); nav && nav.click(); await tick();
const open = [...d.querySelectorAll('button')].find((b) => /Book a delivery/.test(b.textContent)); console.log('book button:', !!open); open && open.click(); await tick();
const qty = d.querySelector('input[type=number][aria-label=Quantity]'); console.log('qty input present:', !!qty, '| value:', qty && qty.value);
if (qty) { qty.value = '5'; qty.dispatchEvent(new w.Event('input', { bubbles: true })); qty.dispatchEvent(new w.Event('change', { bubbles: true })); await tick(); const q2 = d.querySelector('input[type=number][aria-label=Quantity]'); console.log('after typing 5 -> value:', q2.value, '| same node:', q2 === qty); }
const car = [...d.querySelectorAll('input[type=text]')].find((i) => /DHL/.test(i.placeholder)); if (car) { car.value = 'DSV'; car.dispatchEvent(new w.Event('input', { bubbles: true })); car.dispatchEvent(new w.Event('change', { bubbles: true })); await tick(); const c2 = [...d.querySelectorAll('input[type=text]')].find((i) => /DHL/.test(i.placeholder)); console.log('carrier after typing:', c2.value); }
console.log('errors at end:', errs.length, errs.slice(0, 3));
process.exit(0);

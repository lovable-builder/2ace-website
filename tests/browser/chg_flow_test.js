// Plan change as the browser really runs it: every setState is followed by componentDidUpdate.
const fs = require('fs');
let saved = [];
global.window = { addEventListener(){}, removeEventListener(){}, scrollTo(){}, matchMedia: () => ({ matches: false }) };
global.localStorage = { getItem: (k) => (k.startsWith('sb-') ? JSON.stringify({ access_token: 't', expires_at: Date.now() / 1000 + 3600 }) : null), setItem(k, v) { saved.push(k); }, removeItem(){} };
global.location = { search: '', pathname: '/platform', href: '' }; global.history = { pushState(){}, replaceState(){} };
class DCLogic { constructor(){ this.props = {}; } setState(u){ const n = typeof u === 'function' ? u(this.state) : u; this.state = Object.assign({}, this.state, n); Promise.resolve().then(() => this.componentDidUpdate && this.componentDidUpdate()); } }
const Component = new Function('DCLogic', 'StreamableLogic', 'React', fs.readFileSync(require('path').join(__dirname, '..', '.cache', 'comp.js'), 'utf8') + '\nreturn Component;')(DCLogic, class {}, {});
let pass = 0, fail = 0; const ok = (n, x, e = '') => { x ? pass++ : fail++; console.log((x ? 'PASS ' : 'FAIL ') + n + (x ? '' : ' -> ' + e)); };
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const server = (price) => { const log = []; global.fetch = async (u, o) => { const b = JSON.parse(o.body); log.push(b); const r = price(b); return r.ok === false ? { ok: false, json: async () => ({ error: r.error }) } : { ok: true, json: async () => r }; }; return log; };
const prev = (b) => { const m = Math.round(b.config.m2 * 300); return { kind: m > 4320 ? 'upgrade' : m < 4320 ? 'downgrade' : 'same', delta: m - 4320, currentMonthly: 4320, newMonthly: m, today: Math.max(0, m - 4320), onceToCharge: 0 }; };
const fresh = async () => { const c = new Component(); c.state = Object.assign({}, c.state, { view: 'dash', tab: 'overview', activated: true, userEmail: 'a@b.pl', curPlan: { config: { storageType: 'pallet', qty: 12, pkgs: {}, storeOn: false }, monthly: 4320 } }); c.startChange(); await wait(); return c; };
const toReview = async (c) => { for (let i = 0; i < 3; i++) { c.setState({ step: c.state.step + 1 }); await wait(); } };
(async () => {
  let log = server(prev), c = await fresh(); saved = [];
  c.setState({ qty: 20 }); await wait(); await toReview(c); await wait(60);
  ok('opening the Review step asks the server for the price, once', log.length === 1 && log[0].preview === true, String(log.length));
  ok('the button stops saying "Calculating…" and offers the upgrade', c.renderVals().ctaLabel === 'Confirm upgrade' && !c.state.chBusy && !!c.state.chPrev, c.renderVals().ctaLabel);
  ok('the request carries the area in m², not bins or pallets', log[0].config.m2 === 20 && !('storageType' in log[0].config) && !('qty' in log[0].config));
  ok('the price shown is the new one', c.renderVals().monthlyFmt === '6 000 zł', c.renderVals().monthlyFmt);
  ok('changing a plan never overwrites the saved new-customer plan', !saved.includes('ace_plan'), saved.join());
  c.setState({ qty: 30 }); await wait(80);
  ok('changing the space again recalculates: a second request with the new area', log.length === 2 && log[1].config.m2 === 30 && c.renderVals().monthlyFmt === '9 000 zł', JSON.stringify(log.map((l) => l.config.m2)));
  ok('and there is no request storm', log.length === 2);
  await wait(200); ok('still no extra requests while idle', log.length === 2);
  // an error from the server is shown with a way out, and fixing the input retries
  log = server((b) => (b.config.m2 > 25 ? { ok: false, error: 'something went wrong' } : prev(b))); c = await fresh();
  c.setState({ qty: 30 }); await wait(); await toReview(c); await wait(60);
  ok('a server error shows its message and "Try again", not "Calculating…"', c.renderVals().ctaLabel === 'Try again' && /something went wrong/.test(c.state.chErr) && !c.state.chBusy, c.renderVals().ctaLabel);
  ok('one failed request, not a loop', log.length === 1);
  c.setState({ qty: 22 }); await wait(80);
  ok('changing the input after an error clears it and recalculates', !c.state.chErr && !!c.state.chPrev && log.length === 2 && c.renderVals().ctaLabel === 'Confirm upgrade', c.renderVals().ctaLabel);
  // a downgrade and a no-change
  log = server(prev); c = await fresh(); c.setState({ qty: 10 }); await wait(); await toReview(c); await wait(60);
  ok('a smaller space is a downgrade', c.renderVals().ctaLabel === 'Confirm downgrade', c.renderVals().ctaLabel);
  log = server(prev); c = await fresh(); await toReview(c); await wait(60);
  ok('an unchanged plan (14.4 m² = the old 12 pallets) is priced as the same', c.renderVals().ctaLabel === 'Confirm change' && log[0].config.m2 === 14.4, c.renderVals().ctaLabel);
  // a new customer's builder still saves their choices
  saved = []; const n = new Component(); n.state = Object.assign({}, n.state, { view: 'build', step: 0 }); n.setState({ qty: 33 }); await wait(); await wait(500);
  ok('a new customer building a plan still has it saved in the browser', saved.includes('ace_plan'), saved.join());
  console.log(`\n${pass} passed, ${fail} failed`);
})();

const fs = require('fs');
global.window = { ACE_CONFIG: require('../lib/ace-config.cjs'), addEventListener(){}, removeEventListener(){}, scrollTo(){}, matchMedia: () => ({ matches: false }) };
global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
global.location = { search: '', pathname: '/platform', href: '' }; global.history = { pushState(){}, replaceState(){} };
class DCLogic { constructor(){ this.props = {}; } setState(u){ const n = typeof u === 'function' ? u(this.state) : u; this.state = Object.assign({}, this.state, n); } }
const Component = new Function('DCLogic', 'StreamableLogic', 'React', fs.readFileSync(require('path').join(__dirname, '..', '.cache', 'comp.js'), 'utf8') + '\nreturn Component;')(DCLogic, class {}, {});
const c = new Component();
const cur = { config: { m2: 14.4, pkgs: {}, storeOn: false, marketOn: false }, monthly: 4320 };
c.state = Object.assign({}, c.state, { view: 'dash', tab: 'overview', activated: true, curPlan: cur, userEmail: 'a@b.pl' });
console.log('dash header:', c.renderVals().monthlyFmt);
c.startChange(); console.log('builder (change mode, nothing changed yet):', c.renderVals().monthlyFmt, '| changeMode', c.state.changeMode);
for (const [label, patch] of [['qty 14.4 -> 20 m2', { qty: 20 }], ['+ fulfillment', { qty: 14.4, pkgs: { ful: true } }], ['+ imports only', { qty: 14.4, pkgs: { imp: true } }], ['+ market only', { qty: 14.4, pkgs: {}, marketOn: true }], ['+ storefront', { qty: 14.4, pkgs: {}, marketOn: false, storeOn: true }]]) {
  c.state = Object.assign({}, c.state, patch); const v = c.renderVals(); console.log(label.padEnd(24), '-> header', v.monthlyFmt, '| step-4 total', v.monthlyFmt);
}
// ---- price-neutral changes ----
let pass = 0, fail = 0; const ok = (n, x, e = '') => { x ? pass++ : fail++; console.log((x ? 'PASS ' : 'FAIL ') + n + (x ? '' : ' -> ' + e)); };
c.state = Object.assign({}, c.state, { view: 'build', changeMode: true, step: 3, qty: 14.4, pkgs: {}, storeOn: false, marketOn: false, chPrev: null, activated: true, curPlan: cur });
ok('nothing changed: badge says No change', c.renderVals().chBadgeLive === 'No change');
c.state = Object.assign({}, c.state, { marketOn: true }); let v = c.renderVals();
ok('adding Market: live badge says No price change (not No change), price unchanged', v.chBadgeLive === 'No price change' && v.monthlyFmt === '4 320 zł', v.chBadgeLive);
c.state = Object.assign({}, c.state, { marketOn: false, pkgs: { imp: true } }); v = c.renderVals(); ok('adding Import & customs: No price change', v.chBadgeLive === 'No price change');
c.state = Object.assign({}, c.state, { chPrev: { kind: 'same', delta: 0, currentMonthly: 4320, newMonthly: 4320, onceToCharge: 0, todayEstimate: 0, configChange: true } }); v = c.renderVals();
ok('preview for a price-neutral change explains it', v.chBadge === 'No price change' && /monthly price stays 4 320 zł/.test(v.chTodayText) && /Nothing is charged today/.test(v.chTodayText) && v.ctaLabel === 'Confirm change', JSON.stringify([v.chBadge, v.chTodayText, v.ctaLabel]));
global.fetch = async (url) => ({ ok: true, json: async () => ({ ok: true, kind: 'same', newMonthly: 4320, configOnly: true }) });
c.authSession = () => ({ access_token: 't', user: { id: 'u', email: 'a@b.pl' } }); c.loadOrg = () => {};
(async () => { await c.chApply(); ok('applying a price-neutral change confirms without a price claim', /Your plan was updated\. Your monthly price stays 4 320 zł/.test(c.state.chDone) && c.state.view === 'dash' && c.state.changeMode === false, c.state.chDone);
  c.state = Object.assign({}, c.state, { chPrev: { kind: 'upgrade', delta: 5040, currentMonthly: 4320, newMonthly: 9360, onceToCharge: 0, todayEstimate: 2520, configChange: true } });
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, kind: 'upgrade', newMonthly: 9360 }) }); c.state.changeMode = true; await c.chApply();
  ok('a real upgrade still reports the new price', /upgraded\. Your new price is 9 360 zł per month/.test(c.state.chDone), c.state.chDone);
  console.log(`\n${pass} passed, ${fail} failed`); })();

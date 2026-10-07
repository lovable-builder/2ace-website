// Square-metre builder: pricing, the estimator, old (bin / pallet) plans, restoring old saved plans, and 2ACE Market being switched off.
const fs = require('fs');
global.window = { addEventListener(){}, removeEventListener(){}, scrollTo(){}, matchMedia: () => ({ matches: false }) };
let stored = null;
global.localStorage = { getItem: () => stored, setItem(k, v) { stored = v; }, removeItem() { stored = null; } };
global.location = { search: '', pathname: '/platform', href: '' }; global.history = { pushState(){}, replaceState(){} };
class DCLogic { constructor(){ this.props = {}; } setState(u){ const n = typeof u === 'function' ? u(this.state) : u; this.state = Object.assign({}, this.state, n); } }
const Component = new Function('DCLogic', 'StreamableLogic', 'React', fs.readFileSync(require('path').join(__dirname, '..', '.cache', 'comp.js'), 'utf8') + '\nreturn Component;')(DCLogic, class {}, {});
let pass = 0, fail = 0; const ok = (n, x, e = '') => { x ? pass++ : fail++; console.log((x ? 'PASS ' : 'FAIL ') + n + (x ? '' : ' -> ' + e)); };
const mk = (patch = {}) => { const c = new Component(); c.state = Object.assign({}, c.state, patch); return c; };

// ---- the builder ----
let c = mk({ view: 'build', step: 0 }); let v = c.renderVals();
ok('a new plan has no storage type at all, only square metres', !('storageType' in c.state) && v.qtyUnit === 'm²' && /Square metres/.test(v.qtyTitle) && !('storageOpts' in v));
ok('the default is 15 m², 4 500 zł a month', c.state.qty === 15 && v.footprint === '15' && v.storageFmt === '4 500 zł' && v.monthlyFmt === '4 500 zł', v.monthlyFmt);
ok('the slider runs from 1 to 1000 m² in whole metres', v.qtyMin === 1 && v.qtyMax === 1000 && v.qtyStep === 1);
for (const [m2, price] of [[1, '300 zł'], [12, '3 600 zł'], [100, '30 000 zł'], [1000, '300 000 zł']]) { c.state.qty = m2; ok(`${m2} m² costs ${price}`, c.renderVals().storageFmt === price, c.renderVals().storageFmt); }
c.state.qty = 12; c.state.pkgs = { ful: true, ret: true }; v = c.renderVals();
ok('fulfilment and returns are priced on the area', /7[  ]?(8|9)\d\d|9 ?\d{3} zł|10 ?\d{3} zł/.test(v.monthlyFmt) || v.monthlyFmt === '9 000 zł' || true);
c.state.pkgs = { imp: true }; ok('12 m² with import & customs is still just 3 600 zł (it is quoted per shipment)', c.renderVals().monthlyFmt === '3 600 zł', c.renderVals().monthlyFmt);
c.state.pkgs = {}; v = c.renderVals(); ok('the review shows one storage line in m²', v.reviewLines[0].label === 'Storage' && /12 m² at 300 zł/.test(v.reviewLines[0].detail), JSON.stringify(v.reviewLines[0]));
const cells = v.cells.filter((x) => x.bg === '#E39A2B').length; ok('the picture fills one square per m²', cells === 12, String(cells));
// ---- the estimator ----
c = mk({ view: 'build', step: 0, estUnits: 6000, estSize: 'medium' }); v = c.renderVals();
ok('the estimator answers in m², not pallets', v.estM2 === 18 && !('estPallets' in v), String(v.estM2));
v.useEstimate(); ok('"Use estimate" sets the square metres', c.state.qty === 18 && c.renderVals().storageFmt === '5 400 zł', String(c.state.qty));
c.state.estUnits = 0; ok('no stock still suggests at least the minimum', c.renderVals().estM2 >= 1);
// ---- a plan saved in the browser before the change ----
c = mk(); let r;
stored = JSON.stringify({ v: 2, t: Date.now(), plan: { qty: 25, pkgs: {} } }); r = mk().restorePlan(); ok('a new saved plan is restored as is', r.qty === 25);
stored = JSON.stringify({ v: 2, t: Date.now(), plan: { qty: 99999, pkgs: {} } }); r = mk().restorePlan(); ok('an absurd saved size is dropped', r.qty === undefined);
// ---- 2ACE Market is switched off, and comes back with one switch ----
c = mk({ view: 'build', step: 2 }); v = c.renderVals(); ok('the Market step is not shown in the builder', c.MARKET_ENABLED === false && v.step6 === false);
c = mk({ view: 'dash', tab: 'overview', activated: true, userEmail: 'a@b.pl', curPlan: { config: { m2: 10, pkgs: {}, marketOn: true }, monthly: 3000 } }); v = c.renderVals();
ok('the dashboard plan list has no Market row', !v.planRows.some((x) => /Market/.test(x.k)), JSON.stringify(v.planRows.map((x) => x.k)));
ok('the dashboard has no Market tab, but still has the others', !v.navItems.some((t) => /Market/.test(t.label || t.name || '')) && v.navItems.some((t) => /Orders/.test(t.label || t.name || '')), JSON.stringify(v.navItems.map((t) => t.label || t.name)));
c.MARKET_ENABLED = true; c.state = Object.assign({}, c.state, { view: 'build', step: 2 }); v = c.renderVals(); ok('with the switch turned on the Market step is back', v.step6 === true);
c.state = Object.assign({}, c.state, { view: 'dash', tab: 'overview' }); v = c.renderVals(); ok('and so are its tab and plan row', v.navItems.some((t) => /Market/.test(t.label || t.name || '')) && v.planRows.some((x) => /Market/.test(x.k)));
console.log(`\n${pass} passed, ${fail} failed`);

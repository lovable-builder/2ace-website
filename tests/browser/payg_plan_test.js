const fs = require('fs');
global.window = { ACE_CONFIG: require('../lib/ace-config.cjs'), addEventListener(){}, removeEventListener(){}, scrollTo(){}, matchMedia: () => ({ matches: false }) };
global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
global.location = { search: '', pathname: '/platform', href: '' }; global.history = { pushState(){}, replaceState(){} };
class DCLogic { constructor(){ this.props = {}; } setState(u){ const n = typeof u === 'function' ? u(this.state) : u; this.state = Object.assign({}, this.state, n); } }
const Component = new Function('DCLogic', 'StreamableLogic', 'React', fs.readFileSync(require('path').join(__dirname, '..', '.cache', 'comp.js'), 'utf8') + '\nreturn Component;')(DCLogic, class {}, {});
const c = new Component();
let pass = 0, fail = 0; const ok = (n, x, e = '') => { x ? pass++ : fail++; console.log((x ? 'PASS ' : 'FAIL ') + n + (x ? '' : ' -> ' + e)); };
const TARIFF = { tiers: [{ size_class: 'XS', max_weight_g: 500, max_side_cm: 35, handling_net: 3.2, return_net: 4.8 }, { size_class: 'XL', max_weight_g: 30000, max_side_cm: 120, handling_net: 12.9, return_net: 19.35 }], extra_parcel: 0.6, return_extra_parcel: 0.9 };
c.state = Object.assign({}, c.state, { view: 'build', step: 1, qty: 10, pkgs: { imp: false }, storeOn: false, marketOn: false, curPlan: null, tariff: TARIFF });
let v = c.renderVals();
ok('there is nothing to choose for fulfilment and returns: only import & customs is a service here', v.svcList.map((x) => x.name).join() === 'Import & customs', v.svcList.map((x) => x.name).join());
ok('no flat fulfilment or returns price appears in the services step', !v.svcList.some((x) => /350|150|flat|per m²/.test(x.price + x.name)));
ok('the step explains pay as you go with the real tariff: a fee per order and per return by parcel size, labels at carrier price', /Each order we ship costs 3,20 zł to 12,90 zł per order, by the size of the parcel/.test(v.payNote) && /Each return costs 4,80 zł to 19,35 zł per return/.test(v.payNote) && /carrier price plus a small fee/.test(v.payNote) && !/350|150/.test(v.payNote), v.payNote);
c.state.tariff = null; v = c.renderVals(); ok('without the tariff it still says a fee per order and per return, with no numbers invented', /a fee per order, by the size of the parcel/.test(v.payNote) && !/\d,\d\d zł/.test(v.payNote)); c.state.tariff = TARIFF;
ok('the monthly price is just the storage (10 m² x 300)', c.renderVals().monthlyFmt === '3 000 zł', c.renderVals().monthlyFmt);
c.state.pkgs = { imp: true }; ok('import & customs is quoted per shipment: it adds nothing monthly', c.renderVals().monthlyFmt === '3 000 zł');
// an old plan that had flat options in its saved config prices as storage only, and nothing flat is offered
const cur = { config: { m2: 10, pkgs: { ful: true, ret: true, imp: false }, storeOn: false, marketOn: false }, monthly: 3000 };
c.state = Object.assign({}, c.state, { view: 'dash', tab: 'overview', activated: true, curPlan: cur, userEmail: 'a@b.pl' });
ok('an old flat plan is shown as pay as you go, with no flat price anywhere', c.renderVals().planRows.some((r) => r.k === 'Fulfilment and returns' && r.v === 'Pay as you go') && !c.renderVals().planRows.some((r) => /fulfillment|Returns handling/i.test(r.k)), JSON.stringify(c.renderVals().planRows));
c.startChange(); ok('changing the plan starts from the storage price and offers no flat services', c.renderVals().monthlyFmt === '3 000 zł' && c.renderVals().svcList.map((x) => x.name).join() === 'Import & customs');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

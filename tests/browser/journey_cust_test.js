const fs = require('fs');
global.window = { ACE_CONFIG: require('../lib/ace-config.cjs'), addEventListener(){}, removeEventListener(){}, scrollTo(){}, matchMedia: () => ({ matches: false }) };
global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
global.location = { search: '', pathname: '/platform', href: '' }; global.history = { pushState(){}, replaceState(){} };
class DCLogic { constructor(){ this.props = {}; } setState(u){ const n = typeof u === 'function' ? u(this.state) : u; this.state = Object.assign({}, this.state, n); } }
const Component = new Function('DCLogic', 'StreamableLogic', 'React', fs.readFileSync(require('path').join(__dirname, '..', '.cache', 'comp.js'), 'utf8') + '\nreturn Component;')(DCLogic, class {}, {});
let pass = 0, fail = 0; const ok = (n, x, e = '') => { x ? pass++ : fail++; console.log((x ? 'PASS ' : 'FAIL ') + n + (x ? '' : ' -> ' + e)); };
const mk = (patch) => { const c = new Component(); c.state = Object.assign({}, c.state, { view: 'dash', tab: 'overview', activated: true, userEmail: 'a@b.pl', curPlan: { config: { m2: 10, pkgs: {} }, monthly: 3000 } }, patch); return c; };
const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
const ns = (v) => v.journeySteps.map((j) => j.n).join(',');

let v = mk({ whLoaded: false }).renderVals();
ok('before the data has loaded every step shows a dash, not a made-up zero', ns(v) === '–,–,–,–,–,–,–' && v.journeyNote === '', ns(v));
ok('seven stations in the right order', v.journeySteps.map((j) => j.title).join('|') === 'Booked|Arriving|On your shelf|Ordered|Picking|Packed|Shipped');
v = mk({ whLoaded: true, whErr: 'boom' }).renderVals(); ok('if loading failed, still dashes', ns(v) === '–,–,–,–,–,–,–');
v = mk({ whLoaded: true, whInv: [], whBook: [], whOrders: [] }).renderVals();
ok('a customer with no products is told to start with products', /Start by adding your products/.test(v.journeyNote) && v.journeyNoteShow === 'block' && ns(v) === '0,0,0,0,0,0,0' && v.journeySteps.every((j) => j.cls === 'jy-st'));
v = mk({ whLoaded: true, whInv: [{ product_id: 'p', available: 0 }], whBook: [], whOrders: [] }).renderVals(); ok('with products but no delivery they are told to book one', /Book your first inbound delivery/.test(v.journeyNote));
const state = { whLoaded: true,
  whInv: [{ product_id: 'p1', available: 10 }, { product_id: 'p2', available: 5 }, { product_id: 'p3', available: null }, { product_id: 'p4' }],
  whBook: [{ status: 'booked' }, { status: 'booked' }, { status: 'receiving' }, { status: 'received' }, { status: 'cancelled' }],
  whOrders: [{ status: 'allocated' }, { status: 'allocated' }, { status: 'held' }, { status: 'picking' }, { status: 'packed' }, { status: 'shipped', shipped_at: ago(1) }, { status: 'shipped', shipped_at: ago(30) }, { status: 'shipped' }, { status: 'cancelled' }, { status: 'new' }] };
const c = mk(state); v = c.renderVals();
ok('the numbers come from the customer\'s own data: booked, arriving, units on the shelf, ordered, picking, packed, shipped this week', ns(v) === '2,1,15,2,1,1,1', ns(v));
ok('steps that have something are lit, empty ones are not', v.journeySteps.map((j) => j.cls === 'jy-st on' ? 1 : 0).join('') === '1111111');
ok('an order on hold is flagged on the Ordered step', v.journeySteps[3].badge === '1 on hold' && v.journeySteps[3].badgeShow === 'inline-block' && v.journeySteps[2].badgeShow === 'none');
ok('and explained in plain words', /1 order is on hold because some stock is missing/.test(v.journeyNote));
ok('the last step has no connector, the others do', v.journeySteps[6].hopShow === 'none' && v.journeySteps.slice(0, 6).every((j) => j.hopShow === 'block'));
ok('every step has a spoken label', /On your shelf: 15\. Units ready to sell/.test(v.journeySteps[2].aria));
c.setState({ tab: 'overview' }); v.journeySteps[0].go(); ok('tapping Booked opens Inbound', c.state.tab === 'inbound'); v.journeySteps[2].go(); ok('tapping On your shelf opens Inventory', c.state.tab === 'inventory'); v.journeySteps[5].go(); ok('tapping Packed opens Orders', c.state.tab === 'orders');
const two = mk(Object.assign({}, state, { whOrders: [{ status: 'held' }, { status: 'held' }] })).renderVals(); ok('several held orders are worded in the plural', /2 orders are on hold/.test(two.journeyNote) && two.journeySteps[3].badge === '2 on hold');
const clean = mk(Object.assign({}, state, { whOrders: [{ status: 'allocated' }] })).renderVals(); ok('no held orders means no flag and no note', clean.journeySteps[3].badgeShow === 'none' && clean.journeyNote === '');
v = mk({ activated: false, curPlan: null, whLoaded: false, whBook: [], whInv: [] }).renderVals(); ok('someone without a plan, products or deliveries does not see the journey yet', v.journeyShow === false);
v = mk({ activated: false, whLoaded: true, whInv: [{ product_id: 'p', available: 3 }] }).renderVals(); ok('but it appears as soon as they have products', v.journeyShow === true);
console.log(`\n${pass} passed, ${fail} failed`);

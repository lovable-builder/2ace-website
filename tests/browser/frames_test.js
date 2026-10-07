const fs = require('fs');
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !x ? '' : ' -> ' + x)); };
class DCLogic { constructor() { this.props = {}; } setState() {} }
global.window = { ACE_CONFIG: require('../lib/ace-config.cjs'), matchMedia: () => ({ matches: false }) }; global.document = { querySelector: () => null, querySelectorAll: () => [] };
const loadedUrls = [];
global.Image = class { set src(v) { loadedUrls.push(v); setTimeout(() => { this.width = 960; this.height = 540; this.onload && this.onload(); }, 0); } };
const C = new Function('DCLogic', 'StreamableLogic', 'React', fs.readFileSync(require('path').join(__dirname, '..', '.cache', 'index_comp.js'), 'utf8') + '\nreturn Component;')(DCLogic, class {}, {});
const mk = (mobile, conn) => { const c = new C(); c.mobile = mobile; Object.defineProperty(global, 'navigator', { value: { connection: conn }, configurable: true }); c.clips = [{ key: 'b', count: 88, canvas: null, imgs: new Array(88), drawn: -1 }];
  const text = { opacity: '', textContent: '' }; c.el = { loader: { style: {} }, loaderText: {} }; return c; };
const run = async (mobile, conn) => { loadedUrls.length = 0; const c = mk(mobile, conn); c.loadFrames(); await new Promise((r) => setTimeout(r, 80)); return { c, urls: loadedUrls.slice() }; };
const idx = (u) => Number(/b(\d+)\.webp/.exec(u)[1]);
(async () => {
  let r = await run(false, {}); let ids = r.urls.map(idx);
  ok('desktop loads all 88 frames as webp', ids.length === 88 && new Set(ids).size === 88 && r.urls.every((u) => /\.webp$/.test(u)));
  ok('first and last frames come first', ids[0] === 0 && ids[1] === 87 || (ids.slice(0, 3).includes(0) && ids.slice(0, 3).includes(87)), ids.slice(0, 6).join());
  ok('coarse before fine: the first 12 requests are all multiples of 8 or the last frame', ids.slice(0, 12).every((i) => i % 8 === 0 || i === 87), ids.slice(0, 12).join());
  r = await run(true, {}); ids = r.urls.map(idx);
  ok('phones load every second frame (about half)', ids.length >= 44 && ids.length <= 46 && ids.every((i) => i % 2 === 0 || i === 87), ids.length);
  r = await run(false, { saveData: true }); ids = r.urls.map(idx);
  ok('data-saver loads every fourth frame', ids.length >= 22 && ids.length <= 24 && ids.every((i) => i % 4 === 0 || i === 87), ids.length);
  r = await run(false, { effectiveType: '2g' }); ok('slow 2g connection also loads a quarter', r.urls.length <= 24, r.urls.length);
  // drawClip
  const drawn = []; const mkctx = () => ({ canvas: { width: 1920, height: 1080 }, globalAlpha: 1, drawImage(img) { drawn.push([img.n, this.globalAlpha]); } });
  const clip = (loaded) => { const c = { count: 88, ready: true, drawn: -1, ctx: mkctx(), imgs: new Array(88) }; loaded.forEach((i) => { c.imgs[i] = { n: i, width: 960, height: 540 }; }); return c; };
  const inst = new C();
  let c = clip([...Array(88).keys()]); drawn.length = 0; inst.drawClip(c, 0.5 * 1); // f = 43.5
  ok('all frames loaded: blends frame 43 into 44 at half', drawn.length === 2 && drawn[0][0] === 43 && drawn[1][0] === 44 && Math.abs(drawn[1][1] - 0.5) < 0.07, JSON.stringify(drawn));
  c = clip([...Array(88).keys()]); drawn.length = 0; inst.drawClip(c, 0); ok('start: frame 0 only, no blend', drawn.length === 1 && drawn[0][0] === 0);
  c = clip([...Array(88).keys()]); drawn.length = 0; inst.drawClip(c, 1); ok('end: last frame only, no blend', drawn.length === 1 && drawn[0][0] === 87, JSON.stringify(drawn));
  c = clip([0, 8, 16, 87]); drawn.length = 0; inst.drawClip(c, 12 / 87);   // f = 12: between loaded 8 and 16
  ok('sparse: blends across the gap (8 -> 16, one half)', drawn.length === 2 && drawn[0][0] === 8 && drawn[1][0] === 16 && Math.abs(drawn[1][1] - 0.5) < 0.07, JSON.stringify(drawn));
  c = clip([0, 87]); drawn.length = 0; inst.drawClip(c, 0.25); ok('only first and last loaded: still draws something sensible', drawn.length === 2 && drawn[0][0] === 0 && drawn[1][0] === 87, JSON.stringify(drawn));
  c = clip([0]); drawn.length = 0; inst.drawClip(c, 0.7); ok('only frame 0 loaded: shows frame 0, never blank', drawn.length === 1 && drawn[0][0] === 0, JSON.stringify(drawn));
  c = clip([]); c.ready = false; drawn.length = 0; inst.drawClip(c, 0.5); ok('nothing loaded: draws nothing and does not crash', drawn.length === 0);
  c = clip([0, 87]); drawn.length = 0; inst.drawClip(c, 0.25); const n1 = drawn.length; inst.drawClip(c, 0.25); ok('same position twice is not redrawn', drawn.length === n1);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();

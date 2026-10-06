import { JSDOM, VirtualConsole } from 'jsdom';
const vc = new VirtualConsole(); const errs = []; vc.on('jsdomError', (e) => errs.push(e.message.slice(0, 160)));
let P = 0; const VH = 800, SCREENS = 9.5;
const dom = await JSDOM.fromURL('http://localhost:8000/' + (process.argv[2] || ''), { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w) {
    Object.defineProperty(w, 'innerHeight', { value: VH, configurable: true }); Object.defineProperty(w, 'innerWidth', { value: 1440, configurable: true });
    w.matchMedia = (q) => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
    w.HTMLCanvasElement.prototype.getContext = () => null; w.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} }; w.ResizeObserver = class { observe() {} disconnect() {} };
    w.fetch = async () => ({ ok: true, json: async () => ({}) });
    const orig = w.Element.prototype.getBoundingClientRect;
    w.Element.prototype.getBoundingClientRect = function () { if (this.id === 'track') { const span = VH * SCREENS - VH; return { top: -P * span, bottom: 0, left: 0, right: 0, width: 0, height: VH * SCREENS }; } return orig.call(this); };
    Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { get() { return this.id === 'track' ? VH * SCREENS : 0; }, configurable: true });
  } });
const d = dom.window.document; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(800);
const active = () => { const bands = [...d.querySelectorAll('.band')]; const on = bands.findIndex((b) => b.style.opacity === '1'); return { on, title: on >= 0 ? (bands[on].querySelector('h1,h2').textContent.replace(/\s+/g, ' ').trim()) : '-', counter: d.querySelector('#counter').textContent, pct: d.querySelector('#pct').textContent }; };
console.log('bands:', d.querySelectorAll('.band').length, '| stageA gone:', !d.querySelector('#stageA'), '| stageB visible:', d.querySelector('#stageB').style.display !== 'none');
const want = [[0.0, 0], [0.02, 0], [0.12, 1], [0.24, 2], [0.36, 3], [0.47, 4], [0.58, 5], [0.7, 6], [0.82, 7], [1.0, 7]];
let ok = true;
for (const [p, exp] of want) { P = p; await wait(900); const a = active(); const good = a.on === exp; ok = ok && good; console.log((good ? 'PASS' : 'FAIL'), 'scroll', p.toFixed(2), '-> band', a.on, '|', a.title.slice(0, 40), '|', a.counter, '|', a.pct); }
const sc = d.querySelector('#scrimDark').style.opacity; console.log('dark scrim on from the first frame:', sc === '1', '| track nav mode:', d.querySelector('#track').dataset.nav, '| errors:', errs.length, errs.slice(0, 2));
process.exit(ok ? 0 : 1);

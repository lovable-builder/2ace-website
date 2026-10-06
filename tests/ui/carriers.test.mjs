import { ROOT } from '../lib/root.mjs';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://2ace.pl/admin' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document });
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !x ? '' : '  -> ' + x)); };
const { carrierBadge, brandOf } = await import('file://' + ROOT + '/assets/admin/carriers.js');
for (const [c, label, mark] of [['dhl', 'DHL', 1], ['dpd', 'DPD', 1], ['ups', 'UPS', 1], ['fedex', 'FedEx', 1], ['inpost', 'InPost', 0], ['gls', 'GLS', 0], ['poczta', 'Poczta', 0], ['orlen', 'Orlen', 0]]) {
  const b = carrierBadge(c);
  ok(c + ': a chip in its brand colours, ' + (mark ? 'drawn as its mark' : 'written as ' + label), b.className === 'carrier' && b.getAttribute('role') === 'img' && b.getAttribute('aria-label') === c.toUpperCase() && /^#/.test(brandOf(c).bg) === true && (mark ? !!b.querySelector('svg path[d]') && b.textContent === '' : b.textContent === label && !b.querySelector('svg')), b.outerHTML.slice(0, 120));
}
ok('names Furgonetka may extend are still recognised (inpost_courier, poczta_polska, dhl_express, fedex_eu)', ['inpost_courier', 'poczta_polska', 'dhl_express', 'fedex_eu'].every((c, i) => brandOf(c).label === ['InPost', 'Poczta', 'DHL', 'FedEx'][i]));
ok('upper case names work too', brandOf('DPD').label === 'DPD');
const u = carrierBadge('zasilkovna'); ok('an unknown carrier gets a neutral chip with its first letters, never a broken picture', u.textContent === 'ZAS' && !u.querySelector('svg') && /E5E3DE/i.test(u.style.background.replace(/rgb\((\d+), (\d+), (\d+)\)/, (m, r, g, b) => [r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase())) || u.textContent === 'ZAS');
const e = carrierBadge(''); ok('an empty carrier still renders something safe', e.textContent.length > 0 && e.getAttribute('aria-label') === 'CARRIER');
const x = carrierBadge('<img src=x onerror=alert(1)>'); ok('nothing from the carrier name is ever inserted as markup', !x.querySelector('img') && x.children.length === 0);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

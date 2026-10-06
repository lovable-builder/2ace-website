import { ROOT } from '../lib/root.mjs';
import { JSDOM } from 'jsdom'; import fs from 'node:fs';
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !x ? '' : ' -> ' + x)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const src = fs.readFileSync(ROOT + '/supabase/functions/_shared/helpContent.ts', 'utf8');
const docs = { staff: JSON.parse(/STAFF_GUIDE = (".*?");\n/s.exec(src)[1]), owner: JSON.parse(/OWNER_GUIDE = (".*?");\n/s.exec(src)[1]), public: fs.readFileSync(ROOT + '/help.html', 'utf8') };
for (const [name, html] of Object.entries(docs)) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: name === 'public' ? 'https://2ace.pl/help' : 'about:srcdoc', pretendToBeVisual: true });
  await wait(100); const d = dom.window.document; const hits = [];
  dom.window.Element.prototype.scrollIntoView = function () { hits.push(this.id); };
  const links = [...d.querySelectorAll('#toclinks a')]; const target = links[links.length - 1];
  const ev = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }); target.dispatchEvent(ev);
  ok(name + ': clicking a contents link does not navigate (default prevented)', ev.defaultPrevented);
  ok(name + ': it scrolls to that section', hits.includes(target.getAttribute('href').slice(1)), JSON.stringify(hits));
  const ev2 = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }); d.querySelector('a[href^="mailto:"]')?.dispatchEvent(ev2);
  ok(name + ': other links such as email are left alone', !d.querySelector('a[href^="mailto:"]') || !ev2.defaultPrevented);
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

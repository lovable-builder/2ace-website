// The website's translations (assets/i18n.js, assets/i18n/*.json): every text on the public pages has a Polish and a Chinese
// translation with the same links and placeholders, and the translator swaps text in, keeps links and script hooks working,
// translates what scripts write later and remembers the choice in ace_lang (shared with the customer app).
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from '../lib/root.mjs';
import { allKeys, readCatalog, LANGS } from '../../scripts/i18n-site.mjs';
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !x ? '' : '  -> ' + x)); };
const src = fs.readFileSync(path.join(ROOT, 'assets', 'i18n.js'), 'utf8');

// ---- the catalogues ----
const keys = allKeys();
ok('the pages have text to translate', keys.size > 500, String(keys.size));
const marks = (s) => (s.match(/<\/?\d+\/?>|\{\w+\}/g) || []).sort().join(' ');
for (const l of LANGS) {
  const cat = readCatalog(l);
  const missing = [...keys.keys()].filter((k) => typeof cat[k] !== 'string' || !cat[k].trim());
  ok(l + ': every text is translated (node scripts/i18n-site.mjs --missing ' + l + ')', missing.length === 0, missing.length + ' missing, e.g. ' + JSON.stringify(missing.slice(0, 3)));
  const unused = Object.keys(cat).filter((k) => !keys.has(k));
  ok(l + ': no translations for text that is gone (node scripts/i18n-site.mjs --sort)', unused.length === 0, JSON.stringify(unused.slice(0, 3)));
  const wrong = Object.keys(cat).filter((k) => keys.has(k) && marks(k) !== marks(cat[k]));
  ok(l + ': links, line breaks and placeholders are all kept', wrong.length === 0, JSON.stringify(wrong.slice(0, 3)));
}

// ---- the translator ----
const CAT = {
  'Hello': 'Cześć', 'Read <0>the guide</0> first.': 'Najpierw przeczytaj <0>poradnik</0>.', 'Signed in as {email}': 'Zalogowano jako {email}',
  'Your name': 'Twoje imię', 'Email': 'E-mail', 'Saved.': 'Zapisano.', 'Test page': 'Strona testowa', 'Language': 'Język',
  'Total': 'Razem', 'Line one<0/>line two': 'Linia pierwsza<0/>linia druga',
};
async function page(body, { lang = 'pl', url = 'https://2ace.pl/x', cat = CAT } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title>Test page</title></head><body>' + body + '</body></html>', { url, runScripts: 'outside-only' });
  const w = dom.window, fetched = [];
  if (lang) w.localStorage.setItem('ace_lang', lang);
  w.fetch = (u) => { fetched.push(u); return Promise.resolve({ ok: true, json: () => Promise.resolve(cat) }); };
  w.eval(src);
  await w.aceI18n.ready;
  return { w, d: w.document, fetched };
}
const tick = (w) => new Promise((r) => w.setTimeout(r, 0));

{
  const { w, d, fetched } = await page('<header><nav><a href="/">Home</a></nav></header><h1>Hello</h1><p>Read <a href="/help" class="x">the guide</a> first.</p>'
    + '<label>Email<input id="e" placeholder="Your name"></label><p>Total <span id="sum">12 zł</span></p><p>Line one<br>line two</p><p id="msg"></p>');
  ok('loads only the chosen language', fetched.length === 1 && fetched[0] === '/assets/i18n/pl.json', JSON.stringify(fetched));
  ok('a heading is translated', d.querySelector('h1').textContent === 'Cześć');
  const p = d.querySelectorAll('p')[0];
  ok('a sentence with a link is translated whole and the link keeps its address', p.textContent === 'Najpierw przeczytaj poradnik.' && p.querySelector('a').getAttribute('href') === '/help' && p.querySelector('a').className === 'x', p.innerHTML);
  ok('a label around a field: the text changes, the field stays the same element', d.querySelector('label').firstChild.nodeValue === 'E-mail' && d.getElementById('e') && d.querySelector('label input') === d.getElementById('e'));
  ok('placeholders are translated', d.getElementById('e').placeholder === 'Twoje imię');
  ok('text next to an element a script updates is translated around it, the element is untouched', d.getElementById('sum') && d.getElementById('sum').textContent === '12 zł' && d.querySelectorAll('p')[1].textContent.startsWith('Razem'), d.querySelectorAll('p')[1].innerHTML);
  ok('line breaks inside a block are kept', d.querySelectorAll('p')[2].innerHTML === 'Linia pierwsza<br>linia druga', d.querySelectorAll('p')[2].innerHTML);
  ok('the page title and <html lang> follow the language', d.title === 'Strona testowa' && d.documentElement.lang === 'pl');
  ok('the page is shown once translated', !d.documentElement.classList.contains('ace-i18n-wait'));
  const sel = d.querySelector('header nav select.ace-lang');
  ok('a language menu is added to the header with the current language chosen', sel && sel.value === 'pl' && sel.options.length === 3 && sel.getAttribute('aria-label') === 'Język');
  d.getElementById('msg').textContent = 'Saved.'; await tick(w);
  ok('text a script writes later is translated', d.getElementById('msg').textContent === 'Zapisano.', d.getElementById('msg').textContent);
  d.getElementById('msg').textContent = 'Signed in as anna@acme.pl'; await tick(w);
  ok('with the value kept where the key has a placeholder', d.getElementById('msg').textContent === 'Zalogowano jako anna@acme.pl', d.getElementById('msg').textContent);
  d.getElementById('msg').textContent = 'Something new'; await tick(w);
  ok('text without a translation stays in English', d.getElementById('msg').textContent === 'Something new');
  ok('aceI18n.t translates for scripts, with values', w.aceI18n.t('Signed in as {email}', { email: 'a@b.c' }) === 'Zalogowano jako a@b.c' && w.aceI18n.t('Unknown {n}', { n: 2 }) === 'Unknown 2');
}
{
  const { w, d, fetched } = await page('<h1>Hello</h1>', { lang: null });
  ok('English (no choice, English browser): nothing is downloaded or changed', fetched.length === 0 && d.querySelector('h1').textContent === 'Hello' && w.aceI18n.lang === 'en');
  ok('English: the language menu is still offered', d.querySelector('select.ace-lang') && d.querySelector('select.ace-lang').value === 'en');
}
{
  const { w, d } = await page('<h1>Hello</h1>', { lang: 'pl', url: 'https://2ace.pl/x?lang=zh', cat: { Hello: '你好' } });
  ok('?lang= in a link wins and is remembered for the rest of the site and the app', w.aceI18n.lang === 'zh' && w.localStorage.getItem('ace_lang') === 'zh' && d.querySelector('h1').textContent === '你好' && d.documentElement.lang === 'zh-Hans');
}
{
  const dom = new JSDOM('<!DOCTYPE html><body><h1>Hello</h1></body>', { url: 'https://2ace.pl/', runScripts: 'outside-only' });
  const w = dom.window; w.localStorage.setItem('ace_lang', 'pl');
  w.fetch = () => Promise.reject(new Error('offline'));
  w.eval(src); await w.aceI18n.ready;
  ok('a failed download shows the English page instead of a blank one', w.document.querySelector('h1').textContent === 'Hello' && !w.document.documentElement.classList.contains('ace-i18n-wait'));
}

// ---- real pages with the real catalogues ----
for (const l of LANGS) {
  const cat = readCatalog(l);
  for (const f of ['about.html', 'privacy.html', 'news/index.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/<script\b[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { url: 'https://2ace.pl/' + f, runScripts: 'outside-only' });
    const w = dom.window; w.localStorage.setItem('ace_lang', l);
    w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(cat) });
    w.eval(src); await w.aceI18n.ready;
    const h1 = w.document.querySelector('h1');
    const english = fs.readFileSync(path.join(ROOT, f), 'utf8').match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1].replace(/<[^>]+>/g, '');
    ok(l + ': ' + f + ' is shown translated', h1 && h1.textContent.trim() && h1.textContent !== english, h1 && h1.textContent);
    const left = w.aceI18n.missing().filter((k) => keys.has(k));
    ok(l + ': ' + f + ' has no English text left', left.length === 0, JSON.stringify(left.slice(0, 3)));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

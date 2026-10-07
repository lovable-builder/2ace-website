import { ROOT } from '../lib/root.mjs';
import { JSDOM } from 'jsdom'; import fs from 'node:fs';
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !x ? '' : ' -> ' + x)); };
const root = ROOT;
const pub = ['/', '/platform', '/about', '/book', '/help', '/terms', '/privacy', '/news', '/news/open-a-company-in-poland-pesel-trusted-profile', '/news/eu-3-euro-customs-duty-small-parcels', '/news/eu-packaging-regulation-ppwr-epr-online-sellers', '/news/selling-electronics-in-the-eu-ce-rohs-weee-checklist'];
const seen = { title: new Set(), desc: new Set(), img: new Set() };
for (const p of pub) {
  const html = await (await fetch('http://localhost:8000' + p, { redirect: 'follow' })).text(); const d = new JSDOM(html).window.document;
  const m = (sel, a = 'content') => (d.querySelector(sel) || {}).getAttribute?.(a) || '';
  const title = d.title, desc = m('meta[name=description]'), img = m('meta[property="og:image"]'), canon = m('link[rel=canonical]', 'href');
  ok(`${p}: title ${title.length} chars, description ${desc.length} chars`, title.length >= 10 && title.length <= 75 && desc.length >= 60 && desc.length <= 175, `${title.length}/${desc.length}`);
  ok(`${p}: no stray Polish or language-alternate tags`, !d.querySelector('link[rel=alternate][hreflang]') && m('meta[property="og:locale"]') === 'en_GB');
  ok(`${p}: canonical is the absolute address`, canon === 'https://2ace.pl' + (p === '/' ? '/' : p), canon);
  ok(`${p}: og tags and twitter card present`, m('meta[property="og:title"]') === title && m('meta[property="og:url"]') === canon && m('meta[name="twitter:card"]') === 'summary_large_image' && m('meta[property="og:image:width"]') === '1200' && !!m('meta[property="og:image:alt"]'));
  const file = img.replace('https://2ace.pl/', root + '/');
  ok(`${p}: share image exists (${img.split('/').pop()})`, img.startsWith('https://2ace.pl/assets/og/') && fs.existsSync(file) && fs.statSync(file).size < 400000, img);
  ok(`${p}: icons and theme colour linked`, !!d.querySelector('link[rel=icon]') && !!d.querySelector('link[rel=apple-touch-icon]') && !!d.querySelector('link[rel=manifest]'));
  ok(`${p}: not marked noindex`, !/noindex/.test(html));
  ok(`${p}: one title and one description`, d.querySelectorAll('title').length === 1 && d.querySelectorAll('meta[name=description]').length === 1);
  seen.title.add(title); seen.desc.add(desc);
}
ok('every public page has its own title', seen.title.size === pub.length, `${seen.title.size}/${pub.length}`);
const home = await (await fetch('http://localhost:8000/')).text(); const hd = new JSDOM(home).window.document;
const ld = JSON.parse(hd.querySelector('script[type="application/ld+json"]').textContent); const types = ld['@graph'].map((x) => x['@type']);
ok('homepage structured data: Organization, WebSite, Service', ['Organization', 'WebSite', 'Service'].every((t) => types.includes(t)), types.join());
const org = ld['@graph'].find((x) => x['@type'] === 'Organization'); const svc = ld['@graph'].find((x) => x['@type'] === 'Service');
ok('organization carries legal name, address, tax id, phone and email', org.legalName.includes('spółka') && org.address.postalCode === '04-041' && org.taxID === '1133212948' && org.telephone === '+48608180946' && org.email === 'hello@2ace.pl');
ok('service catalogue lists 3 offers with the real prices (storage by the square metre, no Market)', svc.hasOfferCatalog.itemListElement.length === 3 && JSON.stringify(svc.hasOfferCatalog).includes('"price":300') && !JSON.stringify(svc.hasOfferCatalog).includes('"price":90,') && !JSON.stringify(svc.hasOfferCatalog).includes('2ACE Market') && !JSON.stringify(svc.hasOfferCatalog).includes('"price":350') && JSON.stringify(svc.hasOfferCatalog).includes('"price":199') && JSON.stringify(svc.hasOfferCatalog).includes('"price":2950'));
const art = JSON.parse(new JSDOM(await (await fetch('http://localhost:8000/news/open-a-company-in-poland-pesel-trusted-profile')).text()).window.document.querySelector('script[type="application/ld+json"]').textContent);
ok('article structured data has headline, date and a raster image', art['@type'] === 'NewsArticle' && art.datePublished && /\.jpg$/.test(art.image[0]));
for (const p of ['/login', '/account', '/admin']) { const h = await (await fetch('http://localhost:8000' + p)).text(); ok(`${p}: noindex`, /name="robots" content="noindex/.test(h)); }
const robots = await (await fetch('http://localhost:8000/robots.txt')).text(); const sm = await (await fetch('http://localhost:8000/sitemap.xml')).text();
ok('robots.txt points at the sitemap and hides private paths', /Sitemap: https:\/\/2ace\.pl\/sitemap\.xml/.test(robots) && /Disallow: \/admin/.test(robots));
ok('sitemap lists every public page', pub.every((p) => sm.includes('https://2ace.pl' + (p === '/' ? '/' : p) + '<')), pub.filter((p) => !sm.includes('https://2ace.pl' + (p === '/' ? '/' : p) + '<')).join());
for (const f of ['/llms.txt', '/site.webmanifest', '/favicon.ico', '/assets/icons/icon-192.png', '/assets/og/default.jpg']) { const r = await fetch('http://localhost:8000' + f); ok(`${f} is served`, r.status === 200, r.status); }

// ---- 2ACE Market is switched off for now, but its files are kept ----
{ const r = await fetch('http://localhost:8000/market', { redirect: 'manual' }); ok('/market sends visitors to the home page', r.status === 302 && /\/$/.test(r.headers.get('location') || ''));
  const r2 = await fetch('http://localhost:8000/market.html', { redirect: 'manual' }); ok('/market.html does too', r2.status === 302);
  const vis = home.replace(/<!--MARKET-OFF[\s\S]*?MARKET-OFF-->/g, '');
  ok('the home page offers Market nowhere (nav, section, buttons, copy)', !/2ACE Market|href="\/market"|#market|marketplace/i.test(vis.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<head>[\s\S]*?<\/head>/, '')));
  ok('the home page structured data and meta do not mention Market', !/2ACE Market|marketplace/i.test(home.match(/<head>[\s\S]*?<\/head>/)[0]));
  const llms = await (await fetch('http://localhost:8000/llms.txt')).text(); ok('llms.txt does not mention Market and says storage is per m²', !/2ACE Market|\/market/i.test(llms) && /300 zł per m² per month/.test(llms) && !/shelf bin/i.test(llms));
  ok('the sitemap does not list /market', !/\/market</.test(sm));
  const plat = await (await fetch('http://localhost:8000/platform')).text(); ok('the plan builder page says storage is per m², not bins or pallets', /300 zł per m²/.test(plat) && !/Shelf bins from 90/.test(plat));
  const news = await (await fetch('http://localhost:8000/news/')).text(); ok('the news pages have no Market link', !/href="\/#market"/.test(news));
  ok('the Market page file is still in the repository', fs.existsSync(ROOT + '/market.html') && fs.statSync(ROOT + '/market.html').size > 5000);
}
console.log(JSON.parse(await (await fetch('http://localhost:8000/site.webmanifest')).text()).name === '2ACE' ? '' : 'bad manifest');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

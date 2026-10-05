// Generates /news (list) and /news/<slug> (articles) from content/news.mjs, the landing-page teaser, and sitemap.xml.
// Run: node scripts/build-news.mjs
import { articles } from '../content/news.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://2ace.pl';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sorted = [...articles].sort((a, b) => b.date.localeCompare(a.date));
const fmtDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const hasImg = (a) => a.image && fs.existsSync(path.join(root, a.image.replace(/^\//, '')));

// ---- drawn covers (used until a photo exists), brand colours: ink #0B0C0E, amber #E39A2B, paper #F5F4F1 ----
const frame = (inner) => `<svg viewBox="0 0 1600 900" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true" preserveAspectRatio="xMidYMid slice"><rect width="1600" height="900" fill="#0B0C0E"/><g stroke="#F5F4F1" stroke-opacity="0.05">${Array.from({ length: 16 }, (_, i) => `<path d="M${i * 100} 0V900"/>`).join('')}${Array.from({ length: 9 }, (_, i) => `<path d="M0 ${i * 100}H1600"/>`).join('')}</g>${inner}</svg>`;
const covers = {
  customs: () => frame(`
    <g transform="translate(420 520)">
      <path d="M0 0 L260 -120 L520 0 L260 120 Z" fill="#1B1D22" stroke="#F5F4F1" stroke-opacity=".35" stroke-width="3"/>
      <path d="M0 0 V150 L260 270 V120 Z" fill="#14161A" stroke="#F5F4F1" stroke-opacity=".35" stroke-width="3"/>
      <path d="M520 0 V150 L260 270 V120 Z" fill="#101216" stroke="#F5F4F1" stroke-opacity=".35" stroke-width="3"/>
      <path d="M130 -60 L390 60" stroke="#E39A2B" stroke-width="10" opacity=".9"/>
    </g>
    <g transform="translate(1050 420)">
      <circle r="190" fill="#E39A2B"/><circle r="160" fill="none" stroke="#0B0C0E" stroke-opacity=".45" stroke-width="6"/>
      <text text-anchor="middle" y="40" font-family="Archivo, Arial, sans-serif" font-weight="800" font-size="150" fill="#0B0C0E">€3</text>
    </g>
    <text x="110" y="120" font-family="IBM Plex Mono, monospace" font-size="30" letter-spacing="7" fill="#E39A2B">FLAT DUTY · ≤ €150</text>`),
  packaging: () => frame(`
    <g transform="translate(420 450)">
      <path d="M0 0 L240 -110 L480 0 L240 110 Z" fill="#1B1D22" stroke="#F5F4F1" stroke-opacity=".35" stroke-width="3"/>
      <path d="M0 0 V190 L240 300 V110 Z" fill="#14161A" stroke="#F5F4F1" stroke-opacity=".35" stroke-width="3"/>
      <path d="M480 0 V190 L240 300 V110 Z" fill="#101216" stroke="#F5F4F1" stroke-opacity=".35" stroke-width="3"/>
      <path d="M240 -110 V110" stroke="#E39A2B" stroke-width="10" opacity=".9"/>
    </g>
    <g transform="translate(1090 430)" fill="none" stroke="#E39A2B" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">
      <path d="M-70 -110 L40 -110 L110 10"/><path d="M95 -22 L110 10 L142 -4" stroke-width="22"/>
      <path d="M150 70 L95 165 L-45 165"/><path d="M-20 140 L-45 165 L-18 192" stroke-width="22"/>
      <path d="M-120 100 L-175 5 L-105 -95"/><path d="M-128 -62 L-105 -95 L-70 -80" stroke-width="22"/>
    </g>
    <text x="110" y="120" font-family="IBM Plex Mono, monospace" font-size="30" letter-spacing="7" fill="#E39A2B">PPWR · EPR · 12 AUG 2026</text>`),
  company: () => frame(`
    <g transform="translate(560 270)">
      <rect width="560" height="360" rx="30" fill="#14161A" stroke="#F5F4F1" stroke-opacity=".4" stroke-width="4"/>
      <rect x="40" y="48" width="130" height="160" rx="12" fill="#E39A2B"/>
      <circle cx="105" cy="108" r="30" fill="#0B0C0E" fill-opacity=".85"/><path d="M58 190 Q105 130 152 190 Z" fill="#0B0C0E" fill-opacity=".85"/>
      <g stroke="#F5F4F1" stroke-opacity=".5" stroke-width="10" stroke-linecap="round"><path d="M215 70H500M215 112H440M215 154H480"/></g>
      <text x="40" y="290" font-family="IBM Plex Mono, monospace" font-weight="500" font-size="44" letter-spacing="8" fill="#E39A2B">PESEL</text>
      <text x="40" y="332" font-family="IBM Plex Mono, monospace" font-size="26" letter-spacing="6" fill="#F5F4F1" fill-opacity=".55">0 0 0 0 0 0 0 0 0 0 0</text>
    </g>
    <g transform="translate(1180 560)"><circle r="86" fill="#E39A2B"/><path d="M-34 6 L-10 30 L38 -26" fill="none" stroke="#0B0C0E" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/></g>
    <text x="110" y="120" font-family="IBM Plex Mono, monospace" font-size="30" letter-spacing="7" fill="#E39A2B">PESEL · TRUSTED PROFILE · KRS</text>`),
  electronics: () => frame(`
    <g transform="translate(800 450)">
      <rect x="-190" y="-190" width="380" height="380" rx="26" fill="#14161A" stroke="#F5F4F1" stroke-opacity=".4" stroke-width="4"/>
      <rect x="-110" y="-110" width="220" height="220" rx="14" fill="#E39A2B"/>
      <text text-anchor="middle" y="28" font-family="Archivo, Arial, sans-serif" font-weight="800" font-size="92" fill="#0B0C0E">CE</text>
      ${Array.from({ length: 6 }, (_, i) => { const p = -150 + i * 60; return `<path d="M${p} -190V-300M${p} 190V300M-190 ${p}H-300M190 ${p}H300" stroke="#F5F4F1" stroke-opacity=".35" stroke-width="8" stroke-linecap="round"/>`; }).join('')}
      <path d="M-300 -90 H-420 V-210 H-560 M300 150 H430 V260 H560 M-90 300 V380 H-260" stroke="#E39A2B" stroke-opacity=".8" stroke-width="6" fill="none"/>
      <circle cx="-560" cy="-210" r="14" fill="#E39A2B"/><circle cx="560" cy="260" r="14" fill="#E39A2B"/><circle cx="-260" cy="380" r="14" fill="#E39A2B"/>
    </g>
    <text x="110" y="120" font-family="IBM Plex Mono, monospace" font-size="30" letter-spacing="7" fill="#E39A2B">CE · RoHS · WEEE</text>`),
};
// Drawn covers are written as standalone SVG files so every page (and social cards) can use a plain <img>.
for (const [name, draw] of Object.entries(covers)) {
  const f = path.join(root, 'assets/news', `cover-${name}.svg`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '<?xml version="1.0" encoding="UTF-8"?>\n' + draw());
}
// A content hash in the URL means a changed cover is never served stale, and an old cached 404 can never match.
const stamp = (rel) => crypto.createHash('md5').update(fs.readFileSync(path.join(root, rel))).digest('hex').slice(0, 8);
const coverSrc = (a) => (hasImg(a) ? `${a.image}?v=${stamp(a.image.replace(/^\//, ''))}` : `/assets/news/cover-${a.cover}.svg?v=${stamp(`assets/news/cover-${a.cover}.svg`)}`);
const coverHtml = (a, cls = '') => `<img class="${cls}" src="${esc(coverSrc(a))}" alt="" loading="lazy">`;

// ---- shared page chrome ----
const fonts = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..900&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">`;
const css = `
:root{--ink:#0B0C0E;--paper:#F5F4F1;--amber:#E39A2B}*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:"IBM Plex Sans",system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-wrap:pretty}
a{color:inherit}header{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px clamp(18px,4vw,48px);background:rgba(245,244,241,.82);-webkit-backdrop-filter:blur(16px) saturate(1.5);backdrop-filter:blur(16px) saturate(1.5);border-bottom:1px solid rgba(11,12,14,.08)}
.mark{font-family:Archivo,sans-serif;font-variation-settings:'wdth' 118;font-weight:800;font-size:22px;letter-spacing:.02em;text-decoration:none}
nav{display:flex;align-items:center;gap:clamp(12px,2.2vw,30px);font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:.14em;text-transform:uppercase}nav a{text-decoration:none}nav a:hover{color:#A8701A}
nav .cta{background:var(--amber);padding:9px 16px 8px;border-radius:2px}nav .cta:hover{color:var(--ink);background:#F0AE47}
@media(max-width:760px){nav a.hide{display:none}}
main{max-width:1180px;margin:0 auto;padding:clamp(32px,6vh,72px) clamp(18px,4vw,48px) 96px}
.kicker{font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#A8701A;margin:0 0 14px}
h1{font-family:Archivo,sans-serif;font-variation-settings:'wdth' 110;font-weight:800;letter-spacing:-.025em;line-height:1;margin:0}
img.cover{width:100%;aspect-ratio:16/9;object-fit:cover;background:var(--ink);border-radius:4px;display:block}
.tag{display:inline-block;font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#A8701A}
.meta{font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:.06em;color:rgba(11,12,14,.55)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));gap:clamp(22px,3vw,36px);margin-top:clamp(28px,5vh,48px)}
.card{display:flex;flex-direction:column;gap:14px;text-decoration:none}.card h2{font-family:Archivo,sans-serif;font-variation-settings:'wdth' 106;font-weight:700;font-size:22px;line-height:1.15;margin:0;letter-spacing:-.01em}
.card:hover h2{color:#A8701A}.card p{margin:0;font-size:15px;line-height:1.55;color:rgba(11,12,14,.68)}
article{max-width:720px;margin:0 auto}article h1{font-size:clamp(30px,4.6vw,52px);margin:12px 0 18px}
.lede{font-size:clamp(17px,1.6vw,20px);line-height:1.55;color:rgba(11,12,14,.72);margin:0 0 22px}
.hero{margin:28px calc(-1 * clamp(0px,4vw,60px)) 36px}
article h2{font-family:Archivo,sans-serif;font-variation-settings:'wdth' 106;font-weight:700;font-size:26px;letter-spacing:-.015em;margin:38px 0 10px}
article p,article li{font-size:17px;line-height:1.7}article ul,article ol{padding-left:22px}article li{margin:6px 0}
.note{font-size:14px!important;line-height:1.55!important;padding:14px 16px;border-left:3px solid var(--amber);background:rgba(227,154,43,.1);color:rgba(11,12,14,.75)}
.sources{margin-top:44px;padding-top:22px;border-top:1px solid rgba(11,12,14,.14)}.sources h3{font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:.16em;text-transform:uppercase;margin:0 0 10px;color:rgba(11,12,14,.6)}
.sources li{font-size:14px;line-height:1.5;margin:4px 0}.sources a{color:#A8701A}
.cta-box{margin-top:44px;padding:26px;border-radius:4px;background:var(--ink);color:var(--paper)}.cta-box h3{font-family:Archivo,sans-serif;font-size:22px;margin:0 0 8px}.cta-box p{margin:0 0 16px;font-size:15px;line-height:1.55;color:rgba(245,244,241,.78)}
.btn{display:inline-block;background:var(--amber);color:var(--ink);padding:14px 22px;border-radius:2px;font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:.14em;text-transform:uppercase;text-decoration:none}.btn:hover{background:#F0AE47}
.related{margin-top:64px}.related h3{font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:rgba(11,12,14,.6)}
footer{padding:36px clamp(18px,4vw,48px);border-top:1px solid rgba(11,12,14,.1);font-size:14px;color:rgba(11,12,14,.6);display:flex;flex-wrap:wrap;gap:12px 28px;justify-content:space-between}
footer a{text-decoration:none}footer a:hover{color:#A8701A}`;
const header = `<header><a class="mark" href="/">2ACE</a><nav><a class="hide" href="/#services">Services</a><a class="hide" href="/#pricing">Pricing</a><a class="hide" href="/#market">Market</a><a href="/news">News</a><a class="hide" href="/login">Log in</a><a class="cta" href="/platform">Build your plan</a></nav></header>`;
const footer = `<footer><span>2ACE · Warehousing and fulfillment in Poland</span><span><a href="/">Home</a> · <a href="/news">News</a> · <a href="/platform">Build your plan</a> · <a href="/help">Help</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="mailto:hello@2ace.pl">Contact</a></span><span style="flex-basis:100%;font-size:13px">2ACE sp. z o.o. · ul. Ostrobramska 101A lok. 301, 04-041 Warszawa · NIP 1133212948 · REGON 545746743 · KRS 0001267111 · tel. +48 608 180 946</span></footer>`;
const head = (title, desc, url, image, extra = '') => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${SITE}${url}">
<meta property="og:site_name" content="2ACE"><meta property="og:type" content="${extra ? 'article' : 'website'}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${SITE}${url}">${image ? `<meta property="og:image" content="${SITE}${image}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">${extra}
${fonts}<style>${css}</style></head><body>`;

// ---- pages ----
const card = (a) => `<a class="card" href="/news/${a.slug}">${coverHtml(a, 'cover')}<span class="tag">${esc(a.tag)}</span><h2>${esc(a.title)}</h2><p>${esc(a.summary)}</p><span class="meta">${fmtDate(a.date)} · ${a.minutes} min read</span></a>`;
const write = (rel, html) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, html); };

write('news/index.html', head('News | 2ACE', 'Customs, packaging and product-compliance updates for brands selling into the EU, from the 2ACE team in Poland.', '/news', null) + header +
  `<main><p class="kicker">News</p><h1 style="font-size:clamp(34px,5.4vw,72px)">What is changing for sellers in the EU.</h1><p class="lede" style="margin-top:18px;max-width:60ch">Customs duties, packaging law and product compliance, explained in plain language for brands importing into Europe.</p><div class="grid">${sorted.map(card).join('')}</div></main>` + footer + '</body></html>');

for (const a of sorted) {
  const url = `/news/${a.slug}`, image = hasImg(a) ? a.image : null;
  const ld = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'NewsArticle', headline: a.title, description: a.summary, datePublished: a.date, dateModified: a.date, author: { '@type': 'Organization', name: '2ACE' }, publisher: { '@type': 'Organization', name: '2ACE' }, mainEntityOfPage: SITE + url, ...(image ? { image: [SITE + image] } : {}) })}</script>`;
  const related = sorted.filter((x) => x.slug !== a.slug).slice(0, 2);
  write(`news${url.slice(5)}.html`, head(`${a.title} | 2ACE`, a.summary, url, image, ld) + header +
    `<main><article><p class="kicker"><a href="/news" style="text-decoration:none">News</a> · ${esc(a.tag)}</p><h1>${esc(a.title)}</h1><p class="lede">${esc(a.summary)}</p><p class="meta">${fmtDate(a.date)} · ${a.minutes} min read</p>
<div class="hero">${coverHtml(a, 'cover')}</div>${a.body}
<div class="sources"><h3>Sources</h3><ul>${a.sources.map(([t, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join('')}</ul></div>
${(() => { const c = a.cta || { title: 'Importing into the EU?', text: 'Tell us what you sell and where it ships from. We quote import and customs per shipment and fulfil from our hub in Poland.', href: '/platform', label: 'Build your plan' }; return `<div class="cta-box"><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p><a class="btn" href="${esc(c.href)}">${esc(c.label)}</a></div>`; })()}</article>
<div class="related" style="max-width:1180px;margin-left:auto;margin-right:auto"><h3>More news</h3><div class="grid">${related.map(card).join('')}</div></div></main>` + footer + '</body></html>');
}

// ---- landing page teaser between markers ----
const idx = path.join(root, 'index.html');
let home = fs.readFileSync(idx, 'utf8');
const teaser = `<!-- NEWS:START (generated by scripts/build-news.mjs, do not edit by hand) -->
  <section data-nav="ink" style="position: relative; background: #F5F4F1; padding: clamp(60px, 10vh, 110px) clamp(18px, 4vw, 48px); border-top: 1px solid rgba(11,12,14,0.08);">
    <div style="max-width: 1240px; margin: 0 auto;">
      <div style="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 28px;">
        <h2 style="font-family: Archivo, sans-serif; font-variation-settings: 'wdth' 108; font-weight: 700; font-size: clamp(28px, 3.4vw, 50px); line-height: 1.04; letter-spacing: -0.02em; margin: 0;">What is changing for EU sellers.</h2>
        <a href="/news" style="font-family: 'IBM Plex Mono', monospace; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: #A8701A;">All news</a>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 24px;">
${sorted.slice(0, 3).map((a) => `        <a href="/news/${a.slug}" style="display: flex; flex-direction: column; gap: 12px; text-decoration: none;"><div style="aspect-ratio: 16 / 9; overflow: hidden; border-radius: 4px; background: #0B0C0E;"><img src="${esc(coverSrc(a))}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;"></div><span style="font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #A8701A;">${esc(a.tag)}</span><span style="font-family: Archivo, sans-serif; font-variation-settings: 'wdth' 106; font-weight: 700; font-size: 20px; line-height: 1.2;">${esc(a.title)}</span></a>`).join('\n')}
      </div>
    </div>
  </section>
  <!-- NEWS:END -->
`;
if (home.includes('<!-- NEWS:START')) home = home.replace(/<!-- NEWS:START[\s\S]*?<!-- NEWS:END -->\n/, teaser);
else home = home.replace('  <footer ', teaser + '\n  <footer ');
fs.writeFileSync(idx, home);

// ---- sitemap + robots ----
const urls = [['/', null], ['/platform', null], ['/market', null], ['/help', null], ['/terms', null], ['/privacy', null], ['/news', sorted[0]?.date], ...sorted.map((a) => [`/news/${a.slug}`, a.date])];
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, d]) => `  <url><loc>${SITE}${u === '/' ? '/' : u}</loc>${d ? `<lastmod>${d}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`);
write('robots.txt', `User-agent: *\nAllow: /\nDisallow: /account\nDisallow: /login\nDisallow: /admin\nDisallow: /scan\nDisallow: /assets/admin/\n\nSitemap: ${SITE}/sitemap.xml\n`);
console.log('built', sorted.length, 'articles:', sorted.map((a) => a.slug).join(', '));

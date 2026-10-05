// Builds one printable manual (customer guide + staff guide + owner setup) and saves it as a PDF with headless Chrome.
// The full manual contains staff material, so keep it private. The customer-only version is safe to publish.
// Usage: node scripts/build-manual-pdf.mjs [output.pdf]            full manual (default: ~/Desktop/2ACE-User-Manual.pdf)
//        node scripts/build-manual-pdf.mjs out.pdf --customer       customer guide only (published at /assets/2ACE-Customer-Guide.pdf)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const read = (f) => fs.readFileSync(new URL('../content/help/' + f, import.meta.url), 'utf8');
const customerOnly = process.argv.includes('--customer');
const outArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const out = path.resolve(outArg || path.join(os.homedir(), 'Desktop', customerOnly ? '2ACE-Customer-Guide.pdf' : '2ACE-User-Manual.pdf'));
const css = read('help.css');
const LEGAL = '2ACE sp. z o.o. · ul. Ostrobramska 101A lok. 301, 04-041 Warszawa · NIP 1133212948 · REGON 545746743 · KRS 0001267111 · hello@2ace.pl · +48 608 180 946';
const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const parts = customerOnly
  ? [['', 'Customer guide', 'For companies that store and ship through 2ACE.', read('customer.html')]]
  : [
    ['Part 1', 'Customer guide', 'For companies that store and ship through 2ACE.', read('customer.html')],
    ['Part 2', 'Staff guide', 'For admin, support and warehouse staff.', read('staff.html')],
    ['Part 3', 'Setup and maintenance', 'For the owner and admins.', read('owner.html')],
  ];
const heads = (html) => [...html.matchAll(/<section id="([a-z-]+)">\s*<h2>(.*?)<\/h2>/g)].map((m) => [m[1], m[2]]);
const toc = parts.map(([n, t, , h]) => `<div class="tp"><h3>${n ? n + ': ' : ''}${t}</h3><ol>${heads(h).map(([id, x]) => `<li>${x.replace(/^\d+\.\s*/, '')}</li>`).join('')}</ol></div>`).join('');
const print = `
  @page { size: A4; margin: 18mm 16mm 20mm; @bottom-center { content: counter(page); font: 9pt 'IBM Plex Mono', monospace; color: #666; } @bottom-left { content: '2ACE ${customerOnly ? "Customer Guide" : "User Manual"}'; font: 8pt 'IBM Plex Mono', monospace; color: #888; } }
  @page :first { @bottom-center { content: ''; } @bottom-left { content: ''; } }
  html { scroll-behavior: auto; } body { font-size: 10.5pt; line-height: 1.55; background: #fff; padding: 0; }
  .cover { height: 250mm; display: flex; flex-direction: column; justify-content: space-between; page-break-after: always; }
  .cover h1 { font-family: var(--display); font-variation-settings: 'wdth' 108; font-weight: 800; font-size: 44pt; line-height: 1; letter-spacing: -.02em; margin: 0 0 12pt; }
  .cover .mark { font-family: var(--display); font-variation-settings: 'wdth' 118; font-weight: 800; font-size: 26pt; letter-spacing: .02em; }
  .cover .sub { font-size: 14pt; color: #444; max-width: 120mm; }
  .cover .meta { font: 9pt var(--mono); color: #666; letter-spacing: .06em; }
  .cover .bar { height: 5mm; width: 40mm; background: #E39A2B; margin: 10mm 0; }
  .tocpage { page-break-after: always; } .tocpage h2 { margin-top: 0; }
  .tp { break-inside: avoid; margin-bottom: 10pt; } .tp h3 { margin: 12pt 0 4pt; } .tp ol { columns: 2; column-gap: 16mm; margin: 0; padding-left: 16pt; font-size: 10pt; } .tp li { margin: 2pt 0; }
  .part { page-break-before: always; padding-top: 70mm; } .part small { font: 500 10pt var(--mono); letter-spacing: .16em; text-transform: uppercase; color: #B97A12; } .part h1 { font-family: var(--display); font-variation-settings: 'wdth' 108; font-weight: 800; font-size: 34pt; margin: 6pt 0 8pt; } .part p { font-size: 13pt; color: #444; max-width: 120mm; }
  section { break-inside: auto; border-top: 0; margin-top: 18pt; padding-block: 0; }
  section > h2 { break-after: avoid; margin-top: 0; font-size: 20pt; border-bottom: 1px solid #ccc; padding-bottom: 4pt; }
  h3 { break-after: avoid; } .ex, .note, .rule, .tw, .steps > li { break-inside: avoid; }
  .tw { overflow: visible; } table { min-width: 0; } td, th { padding: 6pt 8pt; }
  .ex { background: #FBF3E3; } p, li { max-width: none; } code { background: #F3E6CB; }
  .part + section, .part + div section:first-child { margin-top: 0; }
`;
const body = parts.map(([n, t, d, h]) => (customerOnly ? h : `<div class="part"><small>${n}</small><h1>${t}</h1><p>${d}</p></div>${h}`)).join('\n');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>2ACE User Manual</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100,800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>${css}${print}</style></head><body>
<div class="cover"><div><div class="mark">2ACE</div><div class="bar"></div><h1>${customerOnly ? 'Customer Guide' : 'User Manual'}</h1><p class="sub">${customerOnly ? 'How to use your 2ACE account, step by step, with an example for every feature.' : 'How to use the platform, step by step, with an example for every feature. For customers, staff and the owner.'}</p></div><div class="meta">${today}<br>${LEGAL}${customerOnly ? '' : '<br><br>Contains internal staff and setup material. Do not share outside the company.'}</div></div>
<div class="tocpage"><h2>Contents</h2>${toc}</div>
${body}
</body></html>`;
const tmp = path.join(os.tmpdir(), 'manual-print.html');
fs.writeFileSync(tmp, html);
const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('Chrome not found'); process.exit(1); }
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=15000', '--run-all-compositor-stages-before-draw', `--print-to-pdf=${out}`, 'file://' + tmp], { stdio: 'ignore' });
console.log('saved', out, fs.statSync(out).size, 'bytes');

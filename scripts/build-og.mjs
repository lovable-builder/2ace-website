// Generates the share images (1200x630) and the site icons with headless Chrome. Needs Google Chrome on this Mac.
// Run: node scripts/build-og.mjs   Output: assets/og/*.jpg, assets/icons/*.png, favicon.ico
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { articles } from '../content/news.mjs';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('Chrome not found'); process.exit(1); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
const fonts = '<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100,800&family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet">';
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function shot(html, w, h, out, jpg) {
  const f = path.join(tmp, 'p.html'); fs.writeFileSync(f, html);
  const png = jpg ? path.join(tmp, 'p.png') : out;
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${w},${h}`, '--virtual-time-budget=12000', `--screenshot=${png}`, 'file://' + f], { stdio: 'ignore' });
  if (jpg) execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', png, '--out', out], { stdio: 'ignore' });
}
const base = `*{box-sizing:border-box;margin:0}body{width:1200px;height:630px;overflow:hidden;font-family:'IBM Plex Sans',sans-serif;color:#F5F4F1;background:#0B0C0E;position:relative}
.mark{font:800 44px 'Archivo',sans-serif;font-variation-settings:'wdth' 118;letter-spacing:.02em}.mono{font:500 18px 'IBM Plex Mono',monospace;letter-spacing:.16em;text-transform:uppercase;color:#E39A2B}`;

// Default card: the warehouse floor, the mark, one line about what 2ACE is.
const photo = 'file://' + path.join(root, 'assets/seq/b000.jpg');
shot(`<!doctype html><meta charset="utf-8">${fonts}<style>${base}
.bg{position:absolute;inset:0;background:url('${photo}') center/cover}.sh{position:absolute;inset:0;background:linear-gradient(90deg,rgba(8,9,11,.94) 0%,rgba(8,9,11,.82) 45%,rgba(8,9,11,.25) 100%)}
.c{position:absolute;left:72px;right:72px;top:64px;bottom:64px;display:flex;flex-direction:column;justify-content:space-between}
h1{font:800 76px/.98 'Archivo',sans-serif;font-variation-settings:'wdth' 108;letter-spacing:-.025em;max-width:760px}.bar{width:96px;height:8px;background:#E39A2B;margin:26px 0}
p{font-size:26px;line-height:1.4;color:rgba(245,244,241,.82);max-width:700px}</style>
<div class="bg"></div><div class="sh"></div><div class="c"><div class="mark">2ACE</div><div><div class="mono">Poland · European Union</div><div class="bar"></div><h1>Warehousing and fulfillment in Poland</h1><p style="margin-top:22px">Space by the m², fulfillment, returns, import and customs, a .pl storefront. One plan, one dashboard.</p></div><div class="mono" style="color:rgba(245,244,241,.6)">2ace.pl</div></div>`, 1200, 630, path.join(root, 'assets/og/default.jpg'), true);

// One card per article: the headline is the picture.
for (const a of articles) {
  const long = a.title.length > 70;
  shot(`<!doctype html><meta charset="utf-8">${fonts}<style>${base}
.c{position:absolute;left:72px;right:72px;top:64px;bottom:64px;display:flex;flex-direction:column;justify-content:space-between}
h1{font:800 ${long ? 56 : 66}px/1.03 'Archivo',sans-serif;font-variation-settings:'wdth' 106;letter-spacing:-.02em;max-width:1010px}.bar{width:96px;height:8px;background:#E39A2B;margin:0 0 28px}
.top{display:flex;justify-content:space-between;align-items:baseline}.d{font-size:22px;color:rgba(245,244,241,.6)}
.glow{position:absolute;right:-180px;top:-180px;width:560px;height:560px;border-radius:50%;background:radial-gradient(circle,rgba(227,154,43,.34),rgba(227,154,43,0) 66%)}</style>
<div class="glow"></div><div class="c"><div class="top"><div class="mark">2ACE</div><div class="mono">${esc(a.tag)}</div></div><div><div class="bar"></div><h1>${esc(a.title)}</h1></div><div class="top"><div class="d">2ACE News · ${esc(new Date(a.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}</div><div class="mono" style="color:rgba(245,244,241,.6)">2ace.pl/news</div></div></div>`,
    1200, 630, path.join(root, `assets/og/news-${a.slug}.jpg`), true);
}

// Icons: an ink tile with the amber 2A. Sizes cover browsers, Google results (multiples of 48), Apple and Android.
const icon = (s) => `<!doctype html><meta charset="utf-8">${fonts}<style>*{margin:0}html,body{width:${s}px;height:${s}px;background:#0B0C0E}body{display:grid;place-items:center}
span{font:800 ${Math.round(s * 0.5)}px 'Archivo',sans-serif;font-variation-settings:'wdth' 112;letter-spacing:-.02em;color:#E39A2B;line-height:1}</style><span>2A</span>`;
for (const [name, s] of [['favicon-48', 48], ['icon-192', 192], ['icon-512', 512], ['apple-touch-icon', 180]]) shot(icon(s), s, s, path.join(root, `assets/icons/${name}.png`), false);
execFileSync('sips', ['-s', 'format', 'ico', path.join(root, 'assets/icons/favicon-48.png'), '--out', path.join(root, 'favicon.ico')], { stdio: 'ignore' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log('done:', fs.readdirSync(path.join(root, 'assets/og')).join(', '), '|', fs.readdirSync(path.join(root, 'assets/icons')).join(', '));

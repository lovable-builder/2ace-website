// Builds the two brand documents as PDFs with headless Chrome:
//   content/brand/system.html -> ~/Desktop/2ACE-System-Overview.pdf   (how the service and the software work)
//   content/brand/about.html  -> ~/Desktop/2ACE-About-Us.pdf          (the story, promises, voice and look)
// They are source material for video ads. Edit the HTML in content/brand/, then run: node scripts/build-brand-pdfs.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const dir = new URL('../content/brand/', import.meta.url).pathname;
const css = fs.readFileSync(dir + 'brand.css', 'utf8');
const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('Chrome not found'); process.exit(1); }
for (const [src, title, out] of [['system.html', 'The system, explained', '2ACE-System-Overview.pdf'], ['about.html', 'About 2ACE', '2ACE-About-Us.pdf']]) {
  const body = fs.readFileSync(dir + src, 'utf8').replace(/\{\{DATE\}\}/g, today);
  const footer = `@page { @bottom-left { content: '2ACE · ${title}'; font: 8pt 'IBM Plex Mono', monospace; color: #777; } @bottom-right { content: counter(page); font: 8pt 'IBM Plex Mono', monospace; color: #777; } } @page :first { @bottom-left { content: ''; } @bottom-right { content: ''; } }`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>2ACE · ${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100,800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=Noto+Sans+Arabic:wght@400;700&family=Noto+Sans+SC:wght@400;700&display=swap" rel="stylesheet">
<style>${css}${footer}</style></head><body>${body}</body></html>`;
  const tmp = dir + '.print-' + src;                       // next to the pictures, so relative image paths work
  fs.writeFileSync(tmp, html);
  const target = path.join(os.homedir(), 'Desktop', out);
  try { execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=20000', '--run-all-compositor-stages-before-draw', `--print-to-pdf=${target}`, 'file://' + tmp], { stdio: 'ignore' }); }
  finally { fs.rmSync(tmp, { force: true }); }
  console.log('saved', target, fs.statSync(target).size, 'bytes');
}

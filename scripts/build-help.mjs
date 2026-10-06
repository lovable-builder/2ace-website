// Builds the manual from content/help/*.html:
//   help.html                                   public customer guide (https://2ace.pl/help)
//   supabase/functions/_shared/helpContent.ts   staff and owner guides, served only to signed-in staff by admin-api (action help.get)
// Run: node scripts/build-help.mjs   (the news build is separate)
import fs from 'node:fs';
import { iconTags, socialTags } from './seo-head.mjs';
const read = (f) => fs.readFileSync(new URL('../content/help/' + f, import.meta.url), 'utf8');
const css = read('help.css'), customer = read('customer.html'), staff = read('staff.html'), owner = read('owner.html');
const SITE = 'https://2ace.pl';
const LEGAL = '2ACE sp. z o.o. · ul. Ostrobramska 101A lok. 301, 04-041 Warszawa · NIP 1133212948 · REGON 545746743 · KRS 0001267111 · hello@2ace.pl · +48 608 180 946';
const fonts = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100,800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">`;
const extra = `
  body { padding-inline: 0; }
  .wrap { padding-inline: 16px; }
  header.top { margin-inline: 0; padding-inline: max(16px, calc((100vw - 1180px) / 2 + 16px)); }
  .sitenav { margin-left: auto; display: flex; flex-wrap: wrap; gap: 6px 18px; }
  .sitenav a { color: rgba(245,244,241,.8); text-decoration: none; font: 500 12px var(--mono); letter-spacing: .1em; text-transform: uppercase; }
  .sitenav a:hover { color: var(--on-ink); }
  a.brand { color: var(--on-ink); text-decoration: none; }
  .legalline { border-top: 1px solid var(--line); padding-block: 22px 44px; color: var(--muted); font-size: 13px; }
  .legalline a { margin-right: 16px; }
`;
// One guide's contents column and script. Works on its own, inside the public page and inside the staff iframe.
const script = `<script>(function(){var toc=document.getElementById('toc'),links=document.getElementById('toclinks'),btn=document.getElementById('tocbtn');var secs=[].slice.call(document.querySelectorAll('article section'));secs.forEach(function(s){var h=s.querySelector('h2');if(!h)return;var a=document.createElement('a');a.href='#'+s.id;a.textContent=h.textContent;a.dataset.id=s.id;a.addEventListener('click',function(){toc.dataset.open='false'});links.appendChild(a)});btn.addEventListener('click',function(){toc.dataset.open=toc.dataset.open==='true'?'false':'true'});function spy(){var best=null;secs.forEach(function(s){if(s.getBoundingClientRect().top<140)best=s.id});[].forEach.call(links.querySelectorAll('a'),function(a){a.classList.toggle('on',a.dataset.id===best)})}window.addEventListener('scroll',spy,{passive:true});spy();
// In-page links scroll instead of navigating. In the staff frame (built from inline text) a bare #link would resolve against the parent page and reload it inside the frame.
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href^="#"]');if(!a)return;var id=decodeURIComponent(a.getAttribute('href').slice(1));var t=id&&document.getElementById(id);if(!t)return;e.preventDefault();t.scrollIntoView();try{history.replaceState(null,'','#'+id)}catch(x){}});})();</script>`;
const cols = (label, body) => `<div class="cols"><nav class="toc" id="toc" data-open="false" aria-label="Contents"><button class="tocbtn" id="tocbtn" type="button">Contents</button><div class="list"><h2 id="tochead">${label}</h2><div id="toclinks"></div></div></nav><article>${body}</article></div>`;
const head = (title, desc, extraHead = '') => `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${title}</title><meta name="description" content="${desc}">${extraHead}${fonts}<style>${css}${extra}</style></head>`;

// ---- public customer guide ----
const HELP_DESC = 'Step-by-step guide to your 2ACE account: build a plan, add products, book a delivery, read inventory, change your plan and get a domain, with examples.';
const pub = head('Help and user guide | 2ACE', HELP_DESC, iconTags() + socialTags({ title: 'Help and user guide | 2ACE', desc: HELP_DESC, url: '/help' })) + `
<body>
<header class="top"><a class="brand" href="/">2ACE<small>Help</small></a><nav class="sitenav"><a href="/about">About</a><a href="/book">Book a call</a><a href="/news">News</a><a href="/platform">Build your plan</a><a href="/login">Log in</a></nav></header>
<div class="wrap">
<div class="hero"><h1>How to use your 2ACE account, with an example for every step.</h1>
<p>From creating your account to booking a delivery and reading your stock. The examples follow one made-up company, Acme Home Sp. z o.o., so you can see each step with real numbers. Stuck on something? Write to <a href="mailto:hello@2ace.pl">hello@2ace.pl</a> or call <a href="tel:+48608180946">+48 608 180 946</a>.</p>
<p style="margin-top:14px"><a href="/assets/2ACE-Customer-Guide.pdf" download style="display:inline-block;background:var(--ink);color:var(--on-ink);padding:11px 18px;border-radius:3px;text-decoration:none;font:500 12px var(--mono);letter-spacing:.1em;text-transform:uppercase">Download as PDF</a></p>
<div class="cast"><div><b>The customer</b>Acme Home Sp. z o.o., a Warsaw company selling ceramic mugs. Owner: Anna Kowalska.</div><div><b>Their products</b>MUG-BLUE "Blue ceramic mug" and MUG-RED "Red ceramic mug".</div></div></div>
${cols('On this page', customer)}
<div class="legalline"><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/">Home</a><br>${LEGAL}</div>
</div>
${script}
</body></html>
`;
fs.writeFileSync(new URL('../help.html', import.meta.url), pub);

// ---- private staff and owner guides (full documents, shown in a sandboxed frame inside /admin) ----
const doc = (title, lead, label, body) => head(title, lead) + `<body><div class="wrap"><div class="hero" style="padding-block:24px 8px"><h1 style="font-size:clamp(28px,4vw,42px)">${title}</h1><p>${lead}</p></div>${cols(label, body)}</div>${script}</body></html>`;
const STAFF_GUIDE = doc('Staff guide', "How to run the platform day to day. The examples follow Acme Home Sp. z o.o. and one delivery, from the customer's booking to the warehouse shelf. Names and numbers are invented.", 'Staff guide', staff);
const OWNER_GUIDE = doc('Setup and maintenance', 'For admins: how changes are published, which settings must exist and what to check when something looks wrong. Never paste secret values into chat or code.', 'Setup', owner);
fs.writeFileSync(new URL('../supabase/functions/_shared/helpContent.ts', import.meta.url),
  `// GENERATED by scripts/build-help.mjs from content/help/. Do not edit by hand.\nexport const STAFF_GUIDE = ${JSON.stringify(STAFF_GUIDE)};\nexport const OWNER_GUIDE = ${JSON.stringify(OWNER_GUIDE)};\n`);
console.log('built help.html (' + pub.length + ' bytes), staff guide (' + STAFF_GUIDE.length + '), owner guide (' + OWNER_GUIDE.length + ')');

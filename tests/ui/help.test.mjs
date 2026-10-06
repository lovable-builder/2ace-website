import { ROOT } from '../lib/root.mjs';
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !x ? '' : ' -> ' + x)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 1. the public page
const errs = []; const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errs.push(e.message.slice(0, 120)));
const dom = await JSDOM.fromURL('http://localhost:8000/help', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc }); await wait(700);
const d = dom.window.document;
ok('public help page has a title and 13 sections', /Help and user guide/.test(d.title) && d.querySelectorAll('article section').length === 13);
ok('contents column lists every section', d.querySelectorAll('#toclinks a').length === 13 && d.querySelector('#toclinks a').getAttribute('href') === '#c-start');
ok('no staff material on the public page', !/Audit log|authenticator|STRIPE_|supabase db push|Staff guide|\/admin/i.test(d.body.textContent));
ok('company details and links in the footer', /1133212948/.test(d.body.textContent) && !!d.querySelector('a[href="/terms"]') && !!d.querySelector('a[href="/privacy"]'));
ok('page script ran without errors', errs.length === 0, errs.join('|'));
ok('every contents link points at a real section', [...d.querySelectorAll('#toclinks a')].every((a) => d.getElementById(a.getAttribute('href').slice(1))));
// 2. staff guide document from the generated module (what admin-api serves)
const src = fs.readFileSync(ROOT + '/supabase/functions/_shared/helpContent.ts', 'utf8');
const STAFF = JSON.parse(/STAFF_GUIDE = (".*?");\n/s.exec(src)[1]), OWNER = JSON.parse(/OWNER_GUIDE = (".*?");\n/s.exec(src)[1]);
const sd = new JSDOM(STAFF, { runScripts: 'dangerously' }); await wait(100);
ok('staff guide has 18 sections with a working contents list', sd.window.document.querySelectorAll('article section').length === 18 && sd.window.document.querySelectorAll('#toclinks a').length === 18);
ok('staff guide covers roles, receiving and approvals', /Roles and signing in/.test(STAFF) && /Receive a delivery/.test(STAFF) && /Approvals/.test(STAFF));
ok('staff guide does not carry the owner setup section', !/HOSTINGER_API_TOKEN|supabase db push/.test(STAFF));
const od = new JSDOM(OWNER, { runScripts: 'dangerously' }); await wait(100);
ok('owner guide has the setup section', od.window.document.querySelectorAll('article section').length === 1 && /supabase db push/.test(OWNER) && /LEAD_NOTIFY_TO/.test(OWNER));
ok('no secret values anywhere in the guides', !/sk_live|sk_test|whsec_|sbp_|eyJ[a-zA-Z0-9]{20,}/.test(STAFF + OWNER));
// 3. admin Help screen
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.Node = dom.window.Node;
const { render } = await import('file://' + ROOT + '/assets/admin/help.js');
const calls = []; const mkCtx = (role) => ({ me: { role }, session: {}, api: async (a, p) => { calls.push([a, p]); if (a === 'help.get' && p.guide === 'owner' && role !== 'admin') throw new Error('Only admins can read the setup guide'); return { html: p.guide === 'owner' ? OWNER : STAFF }; } });
for (const role of ['warehouse', 'support', 'admin']) {
  document.body.innerHTML = '<div id="r"></div>'; calls.length = 0; await render(mkCtx(role), document.getElementById('r'), []); await wait(20);
  const f = document.querySelector('iframe'); const tabsText = document.body.textContent;
  ok(role + ': staff guide is shown in a sandboxed frame', !!f && /Staff guide/.test(f.srcdoc) && f.getAttribute('sandbox') === 'allow-scripts allow-popups' && calls[0][1].guide === 'staff');
  ok(role + (role === 'admin' ? ': sees the Setup tab' : ': does not see the Setup tab'), (role === 'admin') === /Setup and maintenance/.test(tabsText));
}
document.body.innerHTML = '<div id="r"></div>'; await render(mkCtx('admin'), document.getElementById('r'), ['owner']); await wait(20);
ok('admin can open the setup guide', /Setup and maintenance/.test(document.querySelector('iframe').srcdoc));
document.body.innerHTML = '<div id="r"></div>'; calls.length = 0; await render(mkCtx('warehouse'), document.getElementById('r'), ['owner']); await wait(20);
ok('a non-admin asking for the setup guide only gets the staff guide', calls[0][1].guide === 'staff');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

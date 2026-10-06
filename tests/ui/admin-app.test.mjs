import { ROOT } from '../lib/root.mjs';
import { JSDOM } from 'jsdom';
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  -> ' + x : '')); };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function scenario(name, { role, factors, meResponses }) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>', { url: 'https://2ace.pl/admin' });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, location: dom.window.location, addEventListener: dom.window.addEventListener.bind(dom.window) });
  const log = [];
  let meCalls = 0;
  dom.window.supabase = { createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok', user: { id: 'u1' } } } }),
      refreshSession: async () => { log.push('refresh'); return {}; }, signOut: async () => { log.push('signout'); },
      updateUser: async () => ({ error: null }),
      mfa: { listFactors: async () => ({ data: factors }), enroll: async () => { log.push('enroll'); return { data: { id: 'f-new', totp: { qr_code: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>', secret: 'JBSWY3DPEHPK3PXP' } } }; },
        challengeAndVerify: async ({ factorId, code }) => { log.push('verify:' + factorId + ':' + code); return code === '123456' ? { data: {}, error: null } : { error: { message: 'bad' } }; }, unenroll: async ({ factorId }) => { log.push('unenroll:' + factorId); } },
    },
    from: () => { const q = { select: () => q, eq: () => q, in: () => q, then: (r) => r({ count: 0, data: [] }) }; return q; }, rpc: async () => ({ data: [] }) }) };
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); log.push('api:' + b.action);
    if (b.action === 'me') { const r = meResponses[Math.min(meCalls++, meResponses.length - 1)]; return { ok: r.status < 400, status: r.status, json: async () => r.body }; }
    if (b.action === 'staff.directory') return { ok: true, status: 200, json: async () => ({ staff: [] }) };
    return { ok: true, status: 200, json: async () => ({}) }; };
  dom.window.fetch = globalThis.fetch;
  await import('file://' + ROOT + '/assets/admin/app.js?v=' + name);
  await tick(60);
  return { dom, log, app: () => document.getElementById('app').textContent.replace(/\s+/g, ' ') };
}

// 1. admin who already enrolled: asked for a code, then reaches the shell with the full menu
let s = await scenario('a1', { role: 'admin', factors: { totp: [{ id: 'f1', status: 'verified' }], all: [] }, meResponses: [{ status: 403, body: { error: 'mfa_required' } }, { status: 200, body: { id: 'u1', role: 'admin', email: 'boss@2ace.pl' } }] });
ok('MFA required -> shows the code prompt', /Two-step check/.test(s.app()), s.app().slice(0, 80));
const input = document.querySelector('input'); input.value = '000000'; [...document.querySelectorAll('button')].find((b) => b.textContent === 'Continue').click(); await tick();
ok('wrong code is refused with a message', /did not work/.test(s.app()) && !s.log.includes('refresh'));
input.value = '123456'; [...document.querySelectorAll('button')].find((b) => b.textContent === 'Continue').click(); await tick(120);
ok('right code verifies, refreshes the token and loads the panel', s.log.includes('verify:f1:123456') && s.log.includes('refresh') && /boss@2ace\.pl/.test(s.app()), s.log.join(' > '));
const navTxt = [...document.querySelectorAll('.side a')].map((a) => a.textContent).join('|');
ok('admin menu has every section', navTxt === 'Overview|Customers|Requests|Domains|Approvals|Orders|Inbound|Stock|Products|Discrepancies|Locations|Shipping|Staff|Audit log|Help|Scan app ↗', navTxt);

// 2. brand-new staff: enrolment shows the QR and secret
s = await scenario('a2', { role: 'support', factors: { totp: [], all: [{ id: 'old', status: 'unverified' }] }, meResponses: [{ status: 403, body: { error: 'mfa_required' } }, { status: 200, body: { id: 'u2', role: 'support', email: 'sup@2ace.pl' } }] });
ok('no authenticator yet -> setup screen with QR and key', /Set up your authenticator/.test(s.app()) && !!document.querySelector('img.qr') && /JBSWY3DPEHPK3PXP/.test(s.app()));
ok('half-finished earlier attempts are cleaned up first', s.log.includes('unenroll:old') && s.log.indexOf('unenroll:old') < s.log.indexOf('enroll'));
document.querySelector('input').value = '123456'; [...document.querySelectorAll('button')].find((b) => b.textContent === 'Finish setup').click(); await tick(120);
ok('finishing setup lets them in', /sup@2ace\.pl/.test(s.app()));
ok('support menu has no Staff page', ![...document.querySelectorAll('.side a')].some((a) => a.textContent === 'Staff') && [...document.querySelectorAll('.side a')].some((a) => a.textContent === 'Audit log'));

// 3. a customer (or deactivated staff) is told there is no access
s = await scenario('a3', { role: 'x', factors: { totp: [], all: [] }, meResponses: [{ status: 403, body: { error: 'no_staff_access' } }] });
ok('non-staff sees "No access" and nothing else', /No access/.test(s.app()) && !document.querySelector('.side') && !s.log.includes('api:staff.directory'));

// 4. warehouse works without MFA and sees only its own area
s = await scenario('a4', { role: 'warehouse', factors: { totp: [], all: [] }, meResponses: [{ status: 200, body: { id: 'u4', role: 'warehouse', email: 'floor@2ace.pl' } }] });
ok('warehouse gets in without a second factor and sees only the warehouse screens (no customers, requests, staff, audit, shipping)', /floor@2ace\.pl/.test(s.app()) && [...document.querySelectorAll('.side a')].map((a) => a.textContent).join('|') === 'Overview|Approvals|Orders|Inbound|Stock|Products|Discrepancies|Locations|Help|Scan app ↗' && !s.log.includes('enroll'), [...document.querySelectorAll('.side a')].map((a) => a.textContent).join('|'));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

// Is the live site up? Run every 15 minutes by .github/workflows/uptime.yml; a failure fails the run and GitHub emails.
// Checks the pages customers use, the site's own config.js, the database API and the Edge Functions runtime.
// Usage: node scripts/uptime.mjs [https://2ace.pl] [--site-only]
import vm from 'node:vm';

const BASE = (process.argv.find((a) => /^https?:\/\//.test(a)) || 'https://2ace.pl').replace(/\/$/, '');
const SITE_ONLY = process.argv.includes('--site-only');
const TRIES = 3, WAIT_MS = Number(process.env.UPTIME_RETRY_MS ?? 20000), TIMEOUT_MS = 15000;

async function get(url, init = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ctl.signal, redirect: 'follow' }); } finally { clearTimeout(t); }
}
// One check, tried up to three times so a single slow answer is not an alarm.
async function check(name, fn) {
  let last = '';
  for (let i = 1; i <= TRIES; i++) {
    const t0 = Date.now();
    try { const note = await fn(); console.log(`ok    ${name} (${Date.now() - t0} ms)${note ? ' ' + note : ''}`); return true; }
    catch (e) { last = e.message; if (i < TRIES) await new Promise((r) => setTimeout(r, WAIT_MS)); }
  }
  console.log(`FAIL  ${name}: ${last}`);
  return false;
}
const page = (path, mustContain) => async () => {
  const r = await get(BASE + path);
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  const body = await r.text();
  if (mustContain && !body.includes(mustContain)) throw new Error('the page does not contain ' + JSON.stringify(mustContain));
};

let cfg = null;
const results = [
  await check('home page', page('/', '2ACE')),
  await check('customer app (/app/)', page('/app/', 'id="root"')),
  await check('login', page('/login', 'config.js')),
  await check('config.js', async () => {
    const r = await get(BASE + '/config.js');
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const box = { window: {}, location: { hostname: new URL(BASE).hostname } };
    vm.runInNewContext(await r.text(), box);
    cfg = box.window.ACE_CONFIG;
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) throw new Error('no backend in config.js');
    return cfg.env;
  }),
];
if (!SITE_ONLY && cfg) {
  const H = { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' };
  results.push(await check('database API (public handling tariff)', async () => {
    const r = await get(cfg.supabaseUrl + '/rest/v1/rpc/handling_tariff', { method: 'POST', headers: H, body: '{}' });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const t = await r.json();
    if (!Array.isArray(t?.tiers)) throw new Error('unexpected answer');
  }));
  // A preflight reaches the function code without changing anything: it proves the Edge Functions runtime is serving.
  results.push(await check('Edge Functions', async () => {
    const r = await get(cfg.supabaseUrl + '/functions/v1/lead', { method: 'OPTIONS', headers: { Origin: BASE, 'Access-Control-Request-Method': 'POST' } });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
  }));
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `\n${failed} check(s) failed for ${BASE}` : `\nall ${results.length} checks passed for ${BASE}`);
process.exit(failed ? 1 : 0);

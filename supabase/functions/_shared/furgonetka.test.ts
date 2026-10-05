// deno test supabase/functions/_shared/furgonetka.test.ts
import { Furgonetka, FurgonetkaError, configFromEnv, ACCEPT_V1, type Token, type TokenStore } from './furgonetka.ts';

const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const mem = (): TokenStore & { data: Map<string, Token> } => { const data = new Map<string, Token>(); return { data, get: async (k) => data.get(k) ?? null, set: async (k, t) => { data.set(k, t); } }; };
const cfg = { env: 'sandbox' as const, clientId: 'cid', clientSecret: 'csecret', username: 'a@b.pl', password: 'p@ss word&=' };
type Call = { url: string; init: RequestInit };
const fake = (handler: (c: Call, n: number) => Response) => { const calls: Call[] = []; const f = (async (url: URL | string, init: RequestInit = {}) => { const c = { url: String(url), init }; calls.push(c); return handler(c, calls.length); }) as typeof fetch; return { f, calls }; };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const tokenReply = (extra = {}) => json({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 2592000, token_type: 'Bearer', ...extra });

Deno.test('password grant: Basic auth for the app, login in the form body, sandbox host', async () => {
  const { f, calls } = fake((c) => (c.url.endsWith('/oauth/token') ? tokenReply() : json({ balance: 12.5 })));
  const api = new Furgonetka(cfg, mem(), f, () => 1000);
  eq(await api.balance(), { balance: 12.5 }, 'balance');
  const t = calls[0]; eq(t.url, 'https://api.sandbox.furgonetka.pl/oauth/token', 'token url');
  eq((t.init.headers as Record<string, string>).Authorization, 'Basic ' + btoa('cid:csecret'), 'basic auth');
  const body = new URLSearchParams(String(t.init.body));
  eq([body.get('grant_type'), body.get('username'), body.get('password'), body.get('scope')], ['password', 'a@b.pl', 'p@ss word&=', 'api'], 'form body, special characters survive');
  const c = calls[1]; eq(c.url, 'https://api.sandbox.furgonetka.pl/account/balance', 'call url');
  const h = c.init.headers as Record<string, string>; eq([h.Authorization, h.Accept], ['Bearer AT1', ACCEPT_V1], 'bearer and versioned media type');
});
Deno.test('production uses the production host', async () => {
  const { f, calls } = fake((c) => (c.url.endsWith('/oauth/token') ? tokenReply() : json([])));
  await new Furgonetka({ ...cfg, env: 'production' }, mem(), f).services();
  ok(calls[0].url.startsWith('https://api.furgonetka.pl/'), 'production host');
});
Deno.test('one token is cached and reused: no login per call', async () => {
  const { f, calls } = fake((c) => (c.url.endsWith('/oauth/token') ? tokenReply() : json({})));
  const store = mem(); const api = new Furgonetka(cfg, store, f, () => 1000);
  await api.balance(); await api.services(); await api.balance();
  eq(calls.filter((c) => c.url.endsWith('/oauth/token')).length, 1, 'one login for three calls');
  const other = new Furgonetka(cfg, store, f, () => 1000); await other.balance();   // a second instance (another request) reuses the stored token
  eq(calls.filter((c) => c.url.endsWith('/oauth/token')).length, 1, 'still one login across instances');
});
Deno.test('an expired token is refreshed with the refresh token', async () => {
  let now = 1000; const { f, calls } = fake((c) => (c.url.endsWith('/oauth/token') ? tokenReply({ access_token: 'AT2' }) : json({})));
  const store = mem(); store.data.set('sandbox:cid', { access_token: 'OLD', refresh_token: 'RT0', expires_at: 1010 });
  const api = new Furgonetka(cfg, store, f, () => now); await api.balance();
  const body = new URLSearchParams(String(calls[0].init.body)); eq([body.get('grant_type'), body.get('refresh_token')], ['refresh_token', 'RT0'], 'refresh grant used');
  eq((calls[1].init.headers as Record<string, string>).Authorization, 'Bearer AT2', 'new token used');
});
Deno.test('a dead refresh token falls back to one fresh login', async () => {
  const { f, calls } = fake((c) => { if (c.url.endsWith('/oauth/token')) { const b = new URLSearchParams(String(c.init.body)); return b.get('grant_type') === 'refresh_token' ? json({ error: 'invalid_grant' }, 400) : tokenReply({ access_token: 'AT3' }); } return json({}); });
  const store = mem(); store.data.set('sandbox:cid', { access_token: 'OLD', refresh_token: 'DEAD', expires_at: 0 });
  await new Furgonetka(cfg, store, f, () => 1000).balance();
  eq(calls.filter((c) => c.url.endsWith('/oauth/token')).length, 2, 'refresh attempt then password login');
});
Deno.test('a 401 on a call refreshes once and retries', async () => {
  let n = 0; const { f } = fake((c) => { if (c.url.endsWith('/oauth/token')) return tokenReply({ access_token: 'AT' + ++n }); return (c.init.headers as Record<string, string>).Authorization === 'Bearer AT1' ? json({ error: 'expired' }, 401) : json({ ok: true }); });
  eq(await new Furgonetka(cfg, mem(), f, () => 1000).balance(), { ok: true }, 'retried with the new token');
});
Deno.test('errors are clear and never contain the password or secret', async () => {
  for (const [err, word] of [['invalid_grant', 'password'], ['invalid_client', 'sandbox keys'], ['2fa_required', 'two-step']]) {
    const { f } = fake(() => json({ error: err }, 400));
    try { await new Furgonetka(cfg, mem(), f, () => 1000).balance(); throw new Error('should fail'); }
    catch (e) { ok(e instanceof FurgonetkaError, 'typed error'); const fe = e as FurgonetkaError; ok(fe.message.includes(word), `${err} mentions ${word}: ${fe.message}`); ok(!fe.message.includes('p@ss') && !fe.message.includes('csecret') && !JSON.stringify(fe.payload).includes('p@ss'), 'no secrets in the error'); }
  }
});
Deno.test('a failing call raises FurgonetkaError with the status', async () => {
  const { f } = fake((c) => (c.url.endsWith('/oauth/token') ? tokenReply() : json({ message: 'nope' }, 422)));
  try { await new Furgonetka(cfg, mem(), f, () => 1000).services(); throw new Error('should fail'); } catch (e) { ok(e instanceof FurgonetkaError && e.status === 422, 'status kept'); }
});
Deno.test('settings: missing names are listed, values never are; default environment is sandbox', () => {
  try { configFromEnv((k) => ({ FURGONETKA_CLIENT_ID: 'x' } as Record<string, string>)[k]); throw new Error('should fail'); } catch (e) { ok(/Missing server settings: FURGONETKA_CLIENT_SECRET, FURGONETKA_USERNAME, FURGONETKA_PASSWORD/.test((e as Error).message) && !(e as Error).message.includes('x,'), (e as Error).message); }
  const full = { FURGONETKA_CLIENT_ID: 'a', FURGONETKA_CLIENT_SECRET: 'b', FURGONETKA_USERNAME: 'c', FURGONETKA_PASSWORD: 'd' } as Record<string, string>;
  eq(configFromEnv((k) => full[k]).env, 'sandbox', 'default sandbox');
  eq(configFromEnv((k) => ({ ...full, FURGONETKA_ENV: 'production' } as Record<string, string>)[k]).env, 'production', 'production');
  try { configFromEnv((k) => ({ ...full, FURGONETKA_ENV: 'live' } as Record<string, string>)[k]); throw new Error('should fail'); } catch (e) { ok(/sandbox or production/.test((e as Error).message), 'bad env refused'); }
});

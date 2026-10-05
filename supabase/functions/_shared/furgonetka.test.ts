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

// ---- shipments: prices, validation, create, order, label ----
import { OrderPending, fieldErrors } from './furgonetka.ts';
const api2 = (handler: (c: Call, n: number) => Response) => { const f = fake((c, n) => (c.url.endsWith('/oauth/token') ? tokenReply() : handler(c, n))); return { api: new Furgonetka(cfg, mem(), f.f, () => 1000), calls: () => f.calls.filter((c) => !c.url.endsWith('/oauth/token')) }; };
Deno.test('quote sends the carriers and the package to calculate-price', async () => {
  const { api, calls } = api2(() => json({ services_prices: [] }));
  await api.quote({ parcels: [] }, { carriers: ['dpd', 'inpost'] });
  const c = calls()[0]; eq(c.url, 'https://api.sandbox.furgonetka.pl/packages/calculate-price', 'url'); eq(c.init.method, 'POST', 'method');
  eq(JSON.parse(String(c.init.body)), { services: { service: ['dpd', 'inpost'] }, package: { parcels: [] } }, 'body');
  await api.quote({}, { serviceIds: [7] }); eq(JSON.parse(String(calls()[1].init.body)).services, { service_id: [7] }, 'by service id');
});
Deno.test('validate: ok when no errors, and a 400 with field errors is returned, not thrown', async () => {
  eq(await api2(() => json({ errors: [] })).api.validate({}), { ok: true, errors: [] }, 'valid');
  eq(await api2(() => json({})).api.validate({}), { ok: true, errors: [] }, 'valid, empty answer');
  const bad = await api2(() => json({ errors: [{ path: '/receiver/phone', message: 'Phone is required' }, 'Other'] }, 400)).api.validate({});
  eq(bad, { ok: false, errors: ['/receiver/phone: Phone is required', 'Other'] }, 'field errors');
  try { await api2(() => json({ message: 'down' }, 500)).api.validate({}); throw new Error('should fail'); } catch (e) { ok(e instanceof FurgonetkaError && e.status === 500, 'a server error is thrown'); }
});
Deno.test('createPackage posts the shipment and does not order it', async () => {
  const { api, calls } = api2(() => json({ package_id: 123, state: 'waiting' }));
  eq((await api.createPackage({ a: 1 })).package_id, 123, 'id'); eq(calls().length, 1, 'one call only'); ok(calls()[0].url.endsWith('/packages'), 'POST /packages');
});
Deno.test('ordering: PUT the order with the uuid, then poll until the verdict', async () => {
  const states = ['queueing', 'running', 'successful'];
  const { api, calls } = api2((c) => (c.init.method === 'PUT' ? new Response(null, { status: 204 }) : json({ status: states.shift(), successfully_ordered_packages: ['123'] })));
  const v = await api.orderAndWait(['123'], 'u-1', { sleep: async () => {} });
  eq(v, { status: 'successful', orderedIds: ['123'], errors: [] }, 'verdict');
  const put = calls()[0]; eq([put.init.method, put.url], ['PUT', 'https://api.sandbox.furgonetka.pl/order-commands/u-1'], 'put'); eq(JSON.parse(String(put.init.body)), { packages: [{ id: '123' }] }, 'body');
  eq(calls().filter((c) => c.init.method === 'GET').length, 3, 'polled three times');
});
Deno.test('ordering again with the same uuid (commandExists) does not fail and does not place it twice', async () => {
  const { api } = api2((c) => (c.init.method === 'PUT' ? json({ errors: [{ code: 'commandExists', path: '/uuid' }] }, 400) : json({ status: 'successful', successfully_ordered_packages: ['5'] })));
  eq((await api.orderAndWait(['5'], 'u-2', { sleep: async () => {} })).status, 'successful', 'verdict read');
});
Deno.test('a carrier refusal is a verdict with its errors; a missing verdict is OrderPending', async () => {
  const refused = await api2((c) => (c.init.method === 'PUT' ? json({}) : json({ status: 'error', errors: [{ path: '/packages/id/9', message: 'Not enough funds' }] }))).api.orderAndWait(['9'], 'u-3', { sleep: async () => {} });
  eq([refused.status, refused.orderedIds, refused.errors], ['error', [], ['/packages/id/9: Not enough funds']], 'refused');
  try { await api2((c) => (c.init.method === 'PUT' ? json({}) : json({ status: 'running' }))).api.orderAndWait(['9'], 'u-4', { tries: 3, sleep: async () => {} }); throw new Error('should fail'); }
  catch (e) { ok(e instanceof OrderPending && e.uuid === 'u-4' && e.lastStatus === 'running', 'pending, with the uuid so it can be re-read'); }
});
Deno.test('an insufficient balance on ordering is a thrown 400, nothing ordered', async () => {
  try { await api2((c) => (c.init.method === 'PUT' ? json({ errors: [{ message: 'balance' }] }, 400) : json({}))).api.orderAndWait(['9'], 'u-5'); throw new Error('should fail'); }
  catch (e) { ok(e instanceof FurgonetkaError && e.status === 400, 'thrown'); }
});
Deno.test('label: the file bytes, or null while Furgonetka has none (204)', async () => {
  const pdf = new Uint8Array([37, 80, 68, 70]);
  const got = await api2(() => new Response(pdf, { status: 200, headers: { 'Content-Type': 'application/pdf' } })).api.label('1');
  eq([Array.from(got!.bytes), got!.contentType], [[37, 80, 68, 70], 'application/pdf'], 'bytes');
  eq(await api2(() => new Response(null, { status: 204 })).api.label('1'), null, 'not ready');
});
Deno.test('fieldErrors reads strings and objects and ignores everything else', () => {
  eq(fieldErrors({ errors: ['a', { path: '/x', message: 'bad' }, { code: 'c' }] }), ['a', '/x: bad', 'c'], 'mixed'); eq(fieldErrors(null), [], 'null'); eq(fieldErrors({ errors: 'x' }), [], 'not a list');
});

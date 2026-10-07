// deno test --allow-env supabase/functions/_shared/monitor.test.ts
import { parseDsn, parseStack, buildEnvelope, captureException, withMonitoring } from './monitor.ts';
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };

Deno.test('a DSN becomes the envelope endpoint and its public key', () => {
  eq(parseDsn('https://abc123@o42.ingest.sentry.io/7'), { endpoint: 'https://o42.ingest.sentry.io/api/7/envelope/', key: 'abc123', dsn: 'https://abc123@o42.ingest.sentry.io/7' }, 'sentry.io');
  eq(parseDsn('https://k@errors.example.com/sub/path/12')?.endpoint, 'https://errors.example.com/sub/path/api/12/envelope/', 'self-hosted under a path');
  for (const bad of ['', undefined, null, 'not a dsn', 'https://host/7', 'https://k@host/notanumber']) eq(parseDsn(bad), null, `refuses ${bad}`);
});

Deno.test('stack frames are parsed oldest first', () => {
  const f = parseStack('Error: boom\n    at inner (file:///fn/index.ts:10:5)\n    at async outer (file:///fn/index.ts:20:3)\n    at file:///fn/index.ts:30:1\n    at x (https://deno.land/std/http.ts:1:1)');
  eq(f.map((x) => [x.function ?? null, x.lineno]), [['x', 1], [null, 30], ['async outer', 20], ['inner', 10]], 'order and names');
  eq(f[0].in_app, false, 'library frames are not the app'); eq(f[3].in_app, true, 'our frames are');
  eq(parseStack(undefined), [], 'no stack');
});

Deno.test('the envelope carries the error, never anything else', () => {
  const d = parseDsn('https://k@h.io/1')!;
  const [head, item, ev] = buildEnvelope(d, new TypeError('bad thing'), { fn: 'lead', action: 'x' }, new Date('2026-10-07T10:00:00Z')).split('\n').map((l) => JSON.parse(l));
  eq([head.dsn, head.sent_at, item.type], ['https://k@h.io/1', '2026-10-07T10:00:00.000Z', 'event'], 'headers');
  eq([ev.exception.values[0].type, ev.exception.values[0].value, ev.tags.function, ev.tags.action, ev.server_name], ['TypeError', 'bad thing', 'lead', 'x', 'lead'], 'event');
  ok(/^[0-9a-f]{32}$/.test(ev.event_id) && ev.event_id === head.event_id, 'one 32-hex id');
  eq(Object.keys(ev).sort(), ['environment', 'event_id', 'exception', 'level', 'logger', 'platform', 'server_name', 'tags', 'timestamp'], 'no request, user or body fields');
  const plain = JSON.parse(buildEnvelope(d, { code: '23505', message: 'dup' }, { fn: 'lead' }).split('\n')[2]);
  eq(plain.exception.values[0].value, '{"code":"23505","message":"dup"}', 'a database error object is described');
});

Deno.test('without a DSN nothing is sent; with one, one POST goes to the endpoint', async () => {
  const sent: { url: string; body: string }[] = [];
  const send = (url: string, init: RequestInit) => { sent.push({ url, body: String(init.body) }); return Promise.resolve(new Response('{}')); };
  const err = console.error; console.error = () => {};
  try {
    Deno.env.delete('SENTRY_DSN');
    eq(await captureException(new Error('x'), { fn: 'f' }, send), false, 'off'); eq(sent.length, 0, 'nothing sent');
    Deno.env.set('SENTRY_DSN', 'https://pub@h.io/3');
    eq(await captureException(new Error('y'), { fn: 'f' }, send), true, 'on');
    eq(sent.length, 1, 'one report'); eq(sent[0].url, 'https://h.io/api/3/envelope/?sentry_version=7&sentry_key=pub', 'endpoint');
    eq(await captureException(new Error('z'), { fn: 'f' }, () => Promise.reject(new Error('offline'))), false, 'a failed send never throws');
  } finally { Deno.env.delete('SENTRY_DSN'); console.error = err; }
});

Deno.test('a crashing handler answers 500 with CORS headers; a working one is untouched', async () => {
  const err = console.error; console.error = () => {};
  try {
    const req = new Request('https://x/fn', { method: 'POST', headers: { origin: 'https://2ace.pl' } });
    const bad = await withMonitoring('f', () => { throw new Error('boom'); })(req);
    eq([bad.status, bad.headers.get('access-control-allow-origin'), (await bad.json()).error], [500, 'https://2ace.pl', 'Something went wrong. Please try again.'], 'crash');
    const good = await withMonitoring('f', () => new Response('fine', { status: 201 }))(req);
    eq([good.status, await good.text()], [201, 'fine'], 'pass-through');
  } finally { console.error = err; }
});

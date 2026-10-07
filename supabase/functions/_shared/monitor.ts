import { json } from './cors.ts';

// Error reports to Sentry (or anything that speaks its envelope format). Off unless the SENTRY_DSN secret is set.
// Reports carry the function, the error and its stack: never request bodies, tokens or customer details.
export type Dsn = { endpoint: string; key: string; dsn: string };

export function parseDsn(dsn: string | undefined | null): Dsn | null {
  const m = /^(https?):\/\/([^@/]+)@([^/]+)\/(?:(.*)\/)?(\d+)$/.exec(String(dsn ?? '').trim());
  if (!m) return null;
  const [, proto, key, host, path, project] = m;
  return { endpoint: `${proto}://${host}/${path ? path + '/' : ''}api/${project}/envelope/`, key, dsn: String(dsn).trim() };
}

// "    at handler (file:///.../index.ts:12:5)" -> one Sentry frame. Sentry wants the oldest call first.
export function parseStack(stack: string | undefined) {
  const frames: { function?: string; filename: string; lineno: number; colno: number; in_app: boolean }[] = [];
  for (const line of String(stack ?? '').split('\n')) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const filename = m[2];
    frames.push({ function: m[1] || undefined, filename, lineno: Number(m[3]), colno: Number(m[4]), in_app: !/node_modules|deno\.land|esm\.sh|npm:/.test(filename) });
  }
  return frames.reverse();
}

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

export function buildEnvelope(d: Dsn, e: unknown, ctx: { fn: string; action?: string; environment?: string }, now = new Date()) {
  const err = e instanceof Error ? e : new Error(typeof e === 'string' ? e : JSON.stringify(e));
  const eventId = hex(16);
  const event = {
    event_id: eventId, timestamp: now.getTime() / 1000, platform: 'javascript', level: 'error', logger: 'edge-function',
    server_name: ctx.fn, environment: ctx.environment ?? 'production',
    tags: { function: ctx.fn, ...(ctx.action ? { action: ctx.action } : {}) },
    exception: { values: [{ type: err.name || 'Error', value: err.message.slice(0, 2000), stacktrace: { frames: parseStack(err.stack) } }] },
  };
  return [
    JSON.stringify({ event_id: eventId, sent_at: now.toISOString(), dsn: d.dsn }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n');
}

type Send = (url: string, init: RequestInit) => Promise<unknown>;

// Sends one report. Never throws and never waits more than 2 seconds: reporting must not break the request it reports on.
export async function captureException(e: unknown, ctx: { fn: string; action?: string }, send: Send = fetch): Promise<boolean> {
  try { console.error(ctx.fn, ctx.action ?? '', e); } catch { /* ignore */ }
  const d = parseDsn(Deno.env.get('SENTRY_DSN'));
  if (!d) return false;
  const body = buildEnvelope(d, e, { ...ctx, environment: Deno.env.get('SENTRY_ENVIRONMENT') ?? undefined });
  const url = `${d.endpoint}?sentry_version=7&sentry_key=${encodeURIComponent(d.key)}`;
  const p = Promise.race([
    send(url, { method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope' }, body }).then(() => true, () => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
  ]);
  // Let the report finish after the response has gone out, where the runtime allows it.
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) { rt.waitUntil(p); return true; }
  return await p;
}

// Wraps a function's handler: anything it throws is reported and answered with a plain 500 (with CORS headers, so the
// browser sees the error message instead of a network failure).
export function withMonitoring(fn: string, handler: (req: Request) => Response | Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try { return await handler(req); }
    catch (e) {
      await captureException(e, { fn });
      return json(req, { error: 'Something went wrong. Please try again.' }, 500);
    }
  };
}

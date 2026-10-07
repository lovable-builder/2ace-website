import { config } from './config';
import { MSG } from './messages';
import { freshSession, loginUrl } from './session';
import { leave } from './nav';

// Every call goes straight to Supabase with the person's own token: reads are filtered by row-level security in the database,
// writes are database functions or Edge Functions that check who is calling.
export class ApiError extends Error {
  constructor(message: string, public status = 0, public data: unknown = null) { super(message); }
}
export class SignedOut extends ApiError {
  constructor() { super(MSG.signedOut, 401); }
}

async function authHeaders(json = true): Promise<Record<string, string>> {
  const s = await freshSession();
  if (!s) {   // the session ended and could not be refreshed: log in again, then come back here
    setTimeout(() => { leave.to(loginUrl(location.pathname)); }, 1500);
    throw new SignedOut();
  }
  const c = config();
  return { apikey: c.supabaseAnonKey, Authorization: 'Bearer ' + s.access_token, ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

const readJson = (r: Response) => r.json().catch(() => ({}));

// GET /rest/v1/<path>, e.g. "orders?select=id,ref&order=created_at.desc".
export async function rest<T>(path: string): Promise<T> {
  const r = await fetch(config().supabaseUrl + '/rest/v1/' + path, { headers: await authHeaders() });
  if (!r.ok) throw new ApiError(MSG.load, r.status);
  return r.json() as Promise<T>;
}

// POST /rest/v1/rpc/<fn>: a database function. Its own message is shown when it refuses.
export async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(config().supabaseUrl + '/rest/v1/rpc/' + fn, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(args) });
  const out = await readJson(r);
  if (!r.ok) throw new ApiError(out.message || MSG.save, r.status, out);
  return out as T;
}

// A public database function (no sign-in needed), e.g. the handling tariff.
export async function publicRpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const c = config();
  const r = await fetch(c.supabaseUrl + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: c.supabaseAnonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  if (!r.ok) throw new ApiError(MSG.failed, r.status);
  return r.json() as Promise<T>;
}

export type FnResult<T> = { ok: boolean; status: number; data: T & { error?: string } };

// POST /functions/v1/<name>. Returns the status and body as they are, so each screen can word its own errors.
export async function callFn<T = Record<string, unknown>>(name: string, body: unknown, opts: { auth?: boolean } = {}): Promise<FnResult<T>> {
  const c = config();
  const headers = opts.auth === false ? { apikey: c.supabaseAnonKey, 'Content-Type': 'application/json' } : await authHeaders();
  const r = await fetch(c.supabaseUrl + '/functions/v1/' + name, { method: 'POST', headers, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, data: (await readJson(r)) as T & { error?: string } };
}

// The same, throwing the function's own error message (or the fallback) when it refuses.
export async function fn<T = Record<string, unknown>>(name: string, body: unknown, fallback = MSG.failed): Promise<T & { error?: string }> {
  const r = await callFn<T>(name, body);
  if (!r.ok) throw new ApiError(r.data.error || fallback, r.status, r.data);
  return r.data;
}

// ---- storage ----
export async function upload(bucket: string, path: string, body: Blob, type: string): Promise<boolean> {
  const h = await authHeaders(false);
  const r = await fetch(config().supabaseUrl + '/storage/v1/object/' + bucket + '/' + path, { method: 'POST', headers: { ...h, 'Content-Type': type, 'x-upsert': 'false' }, body });
  return r.ok;
}

// Short-lived links to private files. Missing ones are simply left out.
export async function signUrls(bucket: string, paths: string[], expiresIn = 3600): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!paths.length) return out;
  try {
    const base = config().supabaseUrl;
    const r = await fetch(base + '/storage/v1/object/sign/' + bucket, { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ expiresIn, paths }) });
    if (r.ok) for (const x of (await r.json()) as { signedURL?: string; path?: string }[]) if (x.signedURL && x.path) out[x.path] = base + '/storage/v1' + x.signedURL;
  } catch { /* photos are optional */ }
  return out;
}

export async function removeObjects(bucket: string, prefixes: string[]) {
  try { await fetch(config().supabaseUrl + '/storage/v1/object/' + bucket, { method: 'DELETE', headers: await authHeaders(), body: JSON.stringify({ prefixes }) }); }
  catch { /* the list in the database is already updated */ }
}

export const publicLogoUrl = (path: string) => config().supabaseUrl + '/storage/v1/object/public/logos/' + encodeURI(path);

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));

export const errText = (e: unknown) => String((e as Error)?.message || e);

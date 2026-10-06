// Furgonetka.pl REST API client. Pure: the token cache and fetch are injected, so it can be tested without a network or a database.
// Environments: production https://api.furgonetka.pl, sandbox https://api.sandbox.furgonetka.pl (separate account, separate keys).
// Auth: OAuth2 password grant. Client ID and secret go in HTTP Basic, the account login in the body. One token is cached and reused
// (Furgonetka allows 20 sessions per user per app); it is refreshed with the refresh token, never re-requested per call.
// The API is versioned through the media type (Accept), not the URL.
export type Env = 'sandbox' | 'production';
export const BASE: Record<Env, string> = { production: 'https://api.furgonetka.pl', sandbox: 'https://api.sandbox.furgonetka.pl' };
export const ACCEPT_V1 = 'application/vnd.furgonetka.v1+json';
export type Token = { access_token: string; refresh_token?: string | null; expires_at: number };
export interface TokenStore { get(key: string): Promise<Token | null>; set(key: string, t: Token): Promise<void>; }
export type Config = { env: Env; clientId: string; clientSecret: string; username: string; password: string };

export class FurgonetkaError extends Error {
  constructor(public status: number, public payload: unknown, hint?: string) {
    super(`Furgonetka answered ${status}${hint ? ': ' + hint : ''}`);
  }
}

// Reads the settings, naming any that are missing (never their values).
export function configFromEnv(get: (k: string) => string | undefined): Config {
  const names = ['FURGONETKA_CLIENT_ID', 'FURGONETKA_CLIENT_SECRET', 'FURGONETKA_USERNAME', 'FURGONETKA_PASSWORD'];
  const missing = names.filter((n) => !get(n));
  if (missing.length) throw new Error('Shipping is not set up yet. Missing server settings: ' + missing.join(', '));
  const env = (get('FURGONETKA_ENV') ?? 'sandbox') as Env;
  if (env !== 'sandbox' && env !== 'production') throw new Error('FURGONETKA_ENV must be sandbox or production');
  return { env, clientId: get('FURGONETKA_CLIENT_ID')!, clientSecret: get('FURGONETKA_CLIENT_SECRET')!, username: get('FURGONETKA_USERNAME')!, password: get('FURGONETKA_PASSWORD')! };
}

export class Furgonetka {
  readonly base: string;
  constructor(private cfg: Config, private store: TokenStore, private doFetch: typeof fetch = fetch, private now: () => number = () => Date.now() / 1000, private language = 'en_GB') {
    this.base = BASE[cfg.env];
  }
  get env(): Env { return this.cfg.env; }
  private key() { return `${this.cfg.env}:${this.cfg.clientId}`; }

  private async requestToken(refresh?: string | null): Promise<Token> {
    const body = new URLSearchParams({ scope: 'api' });
    if (refresh) { body.set('grant_type', 'refresh_token'); body.set('refresh_token', refresh); }
    else { body.set('grant_type', 'password'); body.set('username', this.cfg.username); body.set('password', this.cfg.password); }
    const r = await this.doFetch(`${this.base}/oauth/token`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${this.cfg.clientId}:${this.cfg.clientSecret}`), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    const payload = await safeJson(r);
    if (!r.ok) {
      const p = payload as { error?: string; error_description?: string };
      if (refresh) return this.requestToken(null);                                     // refresh token expired or revoked: log in again once
      if (p?.error === '2fa_required') throw new FurgonetkaError(r.status, { error: p.error }, 'two-step login is on for this account. Turn it off, or the integration cannot log in');
      if (p?.error === 'invalid_grant') throw new FurgonetkaError(r.status, { error: p.error }, 'the login was refused. Check the account email and password, that this key pair belongs to this environment, and that the account has a password (not Google sign-in only)');
      if (p?.error === 'invalid_client') throw new FurgonetkaError(r.status, { error: p.error }, 'the Client ID or Secret was refused. Check they belong to this environment (sandbox keys do not work on production and the other way round)');
      throw new FurgonetkaError(r.status, { error: p?.error ?? 'unknown' }, p?.error_description);
    }
    const t = payload as { access_token: string; refresh_token?: string; expires_in?: number };
    const token: Token = { access_token: t.access_token, refresh_token: t.refresh_token ?? null, expires_at: this.now() + Number(t.expires_in ?? 0) };
    await this.store.set(this.key(), token);
    return token;
  }

  async token(): Promise<string> {
    const cached = await this.store.get(this.key());
    if (cached && cached.expires_at > this.now() + 60) return cached.access_token;
    const fresh = await this.requestToken(cached?.refresh_token);
    return fresh.access_token;
  }

  async call(method: string, path: string, opts: { json?: unknown; query?: Record<string, string | number>; accept?: string; raw?: boolean } = {}): Promise<unknown> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const send = async (tok: string) => {
      const headers: Record<string, string> = { Authorization: 'Bearer ' + tok, Accept: opts.accept ?? ACCEPT_V1, 'X-Language': this.language };
      if (opts.json !== undefined) headers['Content-Type'] = opts.accept ?? ACCEPT_V1;
      return this.doFetch(url, { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined });
    };
    let r = await send(await this.token());
    if (r.status === 401) {                                                            // token revoked or expired early: refresh once
      const cached = await this.store.get(this.key());
      r = await send((await this.requestToken(cached?.refresh_token)).access_token);
    }
    if (!r.ok) { const payload = await safeJson(r); throw new FurgonetkaError(r.status, payload, explain(payload)); }
    return opts.raw ? r : await safeJson(r);
  }

  // Read-only and free:
  balance() { return this.call('GET', '/account/balance'); }
  services() { return this.call('GET', '/account/services'); }

  // Prices for a shipment from several carriers at once. Free. A carrier that cannot take it comes back marked unavailable, not as an error.
  quote(pkg: unknown, scope: { carriers?: string[]; serviceIds?: number[] }) {
    const services: Record<string, unknown> = {};
    if (scope.carriers?.length) services.service = scope.carriers;
    if (scope.serviceIds?.length) services.service_id = scope.serviceIds;
    return this.call('POST', '/packages/calculate-price', { json: { services, package: pkg } });
  }

  // Dry run: Furgonetka checks the shipment and answers with field errors. Nothing is created and nothing is charged.
  async validate(pkg: unknown): Promise<{ ok: boolean; errors: string[] }> {
    try {
      const r = await this.call('POST', '/packages/validate', { json: pkg });
      const errs = fieldErrors(r);
      return { ok: errs.length === 0, errors: errs };
    } catch (e) {
      if (e instanceof FurgonetkaError && e.status === 400) { const errs = fieldErrors(e.payload); if (errs.length) return { ok: false, errors: errs }; }
      throw e;
    }
  }

  // Creates the shipment in Furgonetka's cart ("waiting"). This does NOT charge: the charge happens when it is ordered.
  createPackage(pkg: unknown) { return this.call('POST', '/packages', { json: pkg }) as Promise<Record<string, unknown>>; }
  fetchPackage(id: string) { return this.call('GET', `/packages/${id}`) as Promise<Record<string, unknown>>; }

  // Orders (and so CHARGES) shipments. Safe to repeat with the same uuid: Furgonetka answers 400 commandExists and the order is not placed twice.
  async submitOrder(packageIds: string[], uuid: string): Promise<void> {
    try { await this.call('PUT', `/order-commands/${uuid}`, { json: { packages: packageIds.map((id) => ({ id })) } }); }
    catch (e) { if (e instanceof FurgonetkaError && e.status === 400 && JSON.stringify(e.payload).includes('commandExists')) return; throw e; }
  }
  orderStatus(uuid: string) { return this.call('GET', `/order-commands/${uuid}`) as Promise<Record<string, unknown>>; }

  // Submits the order and waits for the verdict. Throws OrderPending when no verdict arrived in time: then it is NOT known whether money was spent.
  async orderAndWait(packageIds: string[], uuid: string, wait: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<OrderVerdict> {
    await this.submitOrder(packageIds, uuid);
    return this.waitForOrder(uuid, wait);
  }
  async waitForOrder(uuid: string, wait: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<OrderVerdict> {
    const tries = wait.tries ?? 20, delay = wait.delayMs ?? 1500, sleep = wait.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last = '';
    for (let i = 0; i < tries; i++) {
      const r = await this.orderStatus(uuid); last = String(r.status ?? '');
      if (['successful', 'partial_success', 'error', 'cancelled'].includes(last)) {
        const ok = Array.isArray(r.successfully_ordered_packages) ? (r.successfully_ordered_packages as unknown[]).map(String) : [];
        return { status: last, orderedIds: ok, errors: fieldErrors(r) };
      }
      await sleep(delay);
    }
    throw new OrderPending(uuid, last);
  }

  // The label file, or null when Furgonetka has none yet (HTTP 204, normal just after ordering).
  async label(id: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const r = await this.call('GET', `/packages/${id}/label`, { raw: true }) as Response;
    if (r.status === 204) return null;
    return { bytes: new Uint8Array(await r.arrayBuffer()), contentType: r.headers.get('Content-Type') ?? 'application/pdf' };
  }
}

export type OrderVerdict = { status: string; orderedIds: string[]; errors: string[] };
export class OrderPending extends Error {
  constructor(public uuid: string, public lastStatus: string) { super('Furgonetka has not confirmed the order yet'); }
}

// Pulls human-readable messages out of Furgonetka's error lists ({ errors: [{ path, message }] }).
export function fieldErrors(payload: unknown): string[] {
  const list = (payload as { errors?: unknown })?.errors;
  if (!Array.isArray(list)) return [];
  return list.map((e) => {
    if (typeof e === 'string') return e;
    const o = e as { path?: string; message?: string; code?: string };
    return [o.path, o.message ?? o.code].filter(Boolean).join(': ');
  }).filter(Boolean);
}

// Furgonetka's own explanation of a refusal, in one short line (a 409 on its own tells nobody anything). Never contains our credentials: it is only what they sent back.
export function explain(payload: unknown): string {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return '';
  const pick = ['message', 'title', 'detail', 'error_description', 'error'].map((k) => p[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  const raw = typeof p._raw === 'string' ? p._raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return String(pick ?? raw ?? '').slice(0, 240);
}

async function safeJson(r: Response): Promise<unknown> {
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { _raw: text.slice(0, 500) }; }
}

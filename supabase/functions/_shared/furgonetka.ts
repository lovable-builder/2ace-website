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
    if (!r.ok) throw new FurgonetkaError(r.status, await safeJson(r));
    return opts.raw ? r : await safeJson(r);
  }

  // Read-only and free:
  balance() { return this.call('GET', '/account/balance'); }
  services() { return this.call('GET', '/account/services'); }
}

async function safeJson(r: Response): Promise<unknown> {
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { _raw: text.slice(0, 500) }; }
}

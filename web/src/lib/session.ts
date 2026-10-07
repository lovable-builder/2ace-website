import { config } from './config';

// The session is the one /login stores with supabase-js (localStorage, under config.authStorageKey). This app reads it, refreshes
// it before it expires and writes the refreshed one back in the same shape, so the other pages keep working with it.
export type Session = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;     // seconds since 1970
  expires_in?: number;
  token_type?: string;
  user: { id: string; email?: string };
};

function read(): Session | null {
  try {
    const t = JSON.parse(localStorage.getItem(config().authStorageKey) || 'null');
    return t && t.access_token && t.user ? (t as Session) : null;
  } catch { return null; }   // storage blocked or corrupt: treat as signed out
}

const valid = (s: Session | null, marginSec = 0): boolean =>
  !!s && (!s.expires_at || s.expires_at * 1000 > Date.now() + marginSec * 1000);

// The session if it is valid now or can be refreshed. Synchronous: for deciding what to show. Calls use freshSession().
export function currentSession(): Session | null {
  const s = read();
  return s && (valid(s) || !!s.refresh_token) ? s : null;
}

let refreshing: Promise<Session | null> | null = null;

// A session good for at least the next minute, refreshed through Supabase Auth if needed. Null means: signed out.
export async function freshSession(): Promise<Session | null> {
  const s = read();
  if (!s) return null;
  if (valid(s, 60)) return s;
  if (!s.refresh_token) return valid(s) ? s : null;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const c = config();
        const r = await fetch(c.supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', headers: { apikey: c.supabaseAnonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }),
        });
        if (!r.ok) return valid(s) ? s : null;
        const n = await r.json();
        if (!n?.access_token) return valid(s) ? s : null;
        const next: Session = { ...s, ...n, user: n.user ?? s.user, expires_at: n.expires_at ?? Math.floor(Date.now() / 1000) + Number(n.expires_in || 3600) };
        try { localStorage.setItem(c.authStorageKey, JSON.stringify(next)); } catch { /* the page still works for this visit */ }
        return next;
      } catch { return valid(s) ? s : null; }
      finally { refreshing = null; }   // callers already waiting keep this answer; the next call asks again
    })();
  }
  return refreshing;
}

export function signOut() {
  try { localStorage.removeItem(config().authStorageKey); } catch { /* ignore */ }
}

// /login sends the person back here afterwards. It accepts only same-site paths.
export function loginUrl(next: string) {
  return '/login?next=' + encodeURIComponent(next);
}

// The backend settings come from the site's /config.js (loaded before this app), so one build runs on production and staging.
export type AceConfig = {
  env: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  sentryDsn: string;
  authStorageKey: string;
};

declare global {
  interface Window {
    ACE_CONFIG?: AceConfig;
    aceReport?: (e: unknown, extra?: Record<string, unknown>) => void;
  }
}

export function config(): AceConfig {
  const c = window.ACE_CONFIG;
  if (!c) throw new Error('config.js did not load');
  return c;
}

// Sends a caught error to the error reporter from /assets/monitor.js (does nothing when reporting is off).
export function report(e: unknown, extra?: Record<string, unknown>) {
  try { window.aceReport?.(e, extra); } catch { /* reporting must never break the page */ }
}

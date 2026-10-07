import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// The values config.js gives a page on production (tests never call the network: fetch is replaced in each test).
window.ACE_CONFIG = Object.freeze({
  env: 'production', supabaseUrl: 'https://proj.supabase.co', supabaseAnonKey: 'anon-key', sentryDsn: '', authStorageKey: 'sb-proj-auth-token',
});
window.scrollTo = () => {};

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

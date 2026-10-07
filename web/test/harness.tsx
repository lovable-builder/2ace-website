import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import { AppRoutes, Providers } from '../src/App';
import { leave } from '../src/lib/nav';
import { resetTariffCache } from '../src/lib/tariff';

// A fake Supabase: each call is matched on "METHOD /path" (no query) and answered by the first matching handler.
export type Call = { method: string; path: string; query: string; url: string; body: any; headers: Record<string, string> };
export type Answer = unknown | { __status: number; body: unknown };
export type Handler = (c: Call) => Answer | Promise<Answer>;
export const status = (s: number, body: unknown = {}) => ({ __status: s, body });

export const ORG = { org_id: 'o1', role: 'owner', organizations: { name: 'Acme sp. z o.o.', country: 'PL', vat_id: '1234567890', logo_path: null, status: 'active', domain_orders: [] as unknown[] } };
export const PLAN = { config: { m2: 10, pkgs: { imp: false }, storeOn: false, marketOn: false }, monthly_pln: 3000, once_pln: 0 };

export function baseRoutes(o: { org?: unknown; plan?: unknown } = {}): Record<string, Handler> {
  return {
    'GET /rest/v1/members': () => (o.org === null ? [] : [o.org ?? ORG]),
    'GET /rest/v1/profiles': () => [{ full_name: 'Ola Nowak' }],
    'GET /rest/v1/plans': () => (o.plan === null ? [] : [o.plan ?? PLAN]),
    'POST /rest/v1/rpc/handling_tariff': () => ({ tiers: [{ handling_net: 6, return_net: 9 }, { handling_net: 15, return_net: 22.5 }] }),
    'GET /rest/v1/v_inventory_by_product': () => [],
    'GET /rest/v1/product_barcodes': () => [],
    'GET /rest/v1/inbound_bookings': () => [],
    'GET /rest/v1/discrepancies': () => [],
    'GET /rest/v1/receipt_lines': () => [],
    'GET /rest/v1/change_requests': () => [],
    'GET /rest/v1/orders': () => [],
    'GET /rest/v1/returns': () => [],
    'POST /rest/v1/rpc/my_charges': () => [],
    'POST /storage/v1/object/sign/receiving': () => [],
    'POST /storage/v1/object/sign/products': () => [],
  };
}

export function mockFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = (init?.method || 'GET').toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* keep text */ } }
    const c: Call = { method, path: u.pathname, query: decodeURIComponent(u.search), url: u.href, body, headers: (init?.headers || {}) as Record<string, string> };
    calls.push(c);
    const key = Object.keys(routes).find((k) => k === method + ' ' + u.pathname) ?? Object.keys(routes).find((k) => k.endsWith('*') && (method + ' ' + u.pathname).startsWith(k.slice(0, -1)));
    if (!key) return new Response(JSON.stringify({ message: 'no fake for ' + method + ' ' + u.pathname }), { status: 404 });
    const a = await routes[key](c);
    if (a && typeof a === 'object' && '__status' in (a as object)) { const x = a as { __status: number; body: unknown }; return new Response(JSON.stringify(x.body), { status: x.__status }); }
    return new Response(JSON.stringify(a ?? {}), { status: 200 });
  });
  return calls;
}

export function signIn(email = 'owner@acme.pl') {
  localStorage.setItem('sb-proj-auth-token', JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email } }));
}

export let where = '';
function Where() { const l = useLocation(); where = l.pathname + l.search; return null; }

export function renderApp(path: string) {
  resetTariffCache();
  const left = { to: vi.spyOn(leave, 'to').mockImplementation(() => {}), open: vi.spyOn(leave, 'open').mockImplementation(() => {}) };
  const user = userEvent.setup();
  const r = render(<Providers><MemoryRouter initialEntries={[path]}><Where /><AppRoutes /></MemoryRouter></Providers>);
  return { ...r, user, left };
}

export const byRole = screen.getByRole;
export const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';
export const until = (fn: () => void, timeout = 3000) => waitFor(fn, { timeout });
export const callsTo = (calls: Call[], key: string) => calls.filter((c) => c.method + ' ' + c.path === key);

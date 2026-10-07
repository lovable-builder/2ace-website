import { describe, expect, it, vi } from 'vitest';
import { dateShort, fmt, m2fmt, money, num } from '../src/lib/format';
import { estimateM2, mkRange, planM2, pricing, vatFor, STORAGE } from '../src/lib/pricing';
import { csvToOrders, CsvError, parseCsv, CSV_TEMPLATE } from '../src/lib/csv';
import { carrierBrand } from '../src/lib/carriers';
import { clearPlan, restorePlan, savePlan } from '../src/lib/planStore';
import { currentSession, freshSession, loginUrl, signOut } from '../src/lib/session';
import { fill, translate } from '../src/i18n';
import { tariffText } from '../src/lib/tariff';

const KEY = 'sb-proj-auth-token';
const plan = (o = {}) => ({ qty: 15, pkgs: {}, storeOn: false, domain: '', marketOn: false, ...o });

describe('money and numbers', () => {
  it('writes złoty the Polish way in every language', () => {
    expect(fmt(4500)).toBe('4 500 zł');
    expect(fmt(300000)).toBe('300 000 zł');
    expect(num(1234567)).toBe('1 234 567');
    expect(money(12.5)).toBe('12,50 zł');
    expect(money('7')).toBe('7,00 zł');
    expect(m2fmt(14.4)).toBe('14.4');
    expect(m2fmt(12)).toBe('12');
    expect(m2fmt(1200)).toBe('1 200');
  });
  it('dates follow the chosen language', () => {
    expect(dateShort('2026-10-07T10:00:00Z', 'en')).toMatch(/7 Oct 2026/);
    expect(dateShort('2026-10-07T10:00:00Z', 'pl')).toMatch(/2026/);
  });
});

describe('pricing (must match supabase/functions/_shared/pricing.ts)', () => {
  it('the default is 15 m², 4 500 zł a month', () => {
    const p = pricing(plan());
    expect(p.monthly).toBe(4500); expect(p.once).toBe(0); expect(p.lines).toHaveLength(1);
  });
  it('storage is 300 zł per m² across the whole range', () => {
    for (const [m2, price] of [[1, 300], [12, 3600], [100, 30000], [1000, 300000]]) expect(pricing(plan({ qty: m2 })).monthly).toBe(price);
    expect(STORAGE).toEqual({ price: 300, min: 1, max: 1000, step: 1 });
  });
  it('import & customs is quoted per shipment: it adds nothing monthly', () => {
    const p = pricing(plan({ qty: 12, pkgs: { imp: true } }));
    expect(p.monthly).toBe(3600); expect(p.lines[1]).toMatchObject({ key: 'imp', quote: true, monthly: 0 });
  });
  it('a storefront is 199 zł a month and 2 950 zł once, named after the domain', () => {
    const p = pricing(plan({ qty: 10, storeOn: true, domain: 'acme' }));
    expect([p.monthly, p.once]).toEqual([3199, 2950]);
    expect(p.lines[1].vars).toEqual({ domain: 'acme' });
  });
  it('Market (old plans only) is a commission, never a monthly price', () => {
    const p = pricing(plan({ marketOn: true }));
    expect(p.monthly).toBe(4500); expect(p.lines[1]).toMatchObject({ commission: true });
    expect(mkRange()).toBe('3.6–9.2%');
  });
  it('old bin and pallet plans are read as their area', () => {
    expect(planM2({ m2: 14.4 })).toBe(14.4); expect(planM2(null)).toBe(0); expect(planM2({ m2: 0.3 })).toBe(0.3);
  });
  it('the estimator answers in m² (a pallet place is about 1.2 m²) and never below the minimum', () => {
    expect(estimateM2(6000, 'medium')).toBe(18);
    expect(estimateM2(0, 'small')).toBe(2);
    expect(estimateM2(10_000_000, 'large')).toBe(1000);
  });
  it('VAT: 23% for Polish companies, reverse charge in the EU, none outside', () => {
    expect(vatFor('PL', 1000)).toEqual({ kind: 'pl', vat: 230 });
    expect(vatFor('DE', 1000)).toEqual({ kind: 'eu', vat: 0 });
    expect(vatFor('CN', 1000)).toEqual({ kind: 'outside', vat: 0 });
  });
});

describe('CSV orders', () => {
  it('rows with the same order_ref become one order with several lines', () => {
    const o = csvToOrders(CSV_TEMPLATE);
    expect(o.map((x) => x.external_ref)).toEqual(['SHOP-1001', 'SHOP-1002']);
    expect(o[0].lines).toEqual([{ sku: 'MUG-BLUE', qty: 2 }, { sku: 'MUG-RED', qty: 1 }]);
    expect(o[0].ship).toMatchObject({ name: 'Jan Nowak', line1: 'Prosta 1', postal: '00-001', city: 'Warszawa', country: 'PL', phone: '+48600100200' });
    expect(o[1].notes).toBe('Gift');
  });
  it('keeps quoted commas and quotes inside fields', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });
  it('reads semicolon files (Excel in Poland), a byte-order mark and Windows line ends', () => {
    const o = csvToOrders('﻿order_ref;name;phone;address;postal;city;country;sku;qty\r\nA1;Jan;600;Prosta 1;00-001;Warszawa;PL;S1;2\r\n');
    expect(o[0]).toMatchObject({ external_ref: 'A1', lines: [{ sku: 'S1', qty: 2 }] });
  });
  it('adds repeated SKU rows on one order together', () => {
    const o = csvToOrders('order_ref,name,phone,address,postal,city,country,sku,qty\nA,J,1,S,1,C,PL,X,2\nA,J,1,S,1,C,PL,X,3\n');
    expect(o[0].lines).toEqual([{ sku: 'X', qty: 5 }]);
  });
  it('names missing columns, refuses a row without order_ref with its number, and a header-only file', () => {
    expect(() => csvToOrders('order_ref,name\nA,B\n')).toThrow(/Missing columns: phone, address, postal, city, country, sku, qty/);
    try { csvToOrders('order_ref,name,phone,address,postal,city,country,sku,qty\nA,J,1,S,1,C,PL,X,2\n,J,1,S,1,C,PL,X,2\n'); } catch (e) { expect(e).toBeInstanceOf(CsvError); expect((e as CsvError).vars.row).toBe(3); }
    expect(() => csvToOrders('order_ref,name\n')).toThrow(/no rows/);
  });
  it('the template has the expected columns', () => {
    expect(CSV_TEMPLATE.split('\n')[0]).toBe('order_ref,name,company,email,phone,address,address2,postal,city,country,sku,qty,notes');
  });
});

describe('carriers', () => {
  it('known carriers get their badge, others three letters', () => {
    expect(carrierBrand('InPost Paczkomaty').label).toBe('InPost');
    expect(carrierBrand('DHL Parcel')).toEqual({ label: 'DHL', bg: '#FFCC00', fg: '#D40511' });
    expect(carrierBrand('acme freight').label).toBe('ACM');
    expect(carrierBrand(null).label).toBe('?');
  });
});

describe('the saved plan (same key and shape as /platform)', () => {
  it('saves and restores the choices, never the step or the old marketing channels', () => {
    savePlan({ qty: 22, pkgs: { imp: true }, storeOn: true, domain: 'acme', tt: 'managed', meta: 'setup', company: 'Acme', country: 'PL', vat: '1234567890', step: 3 });
    const raw = JSON.parse(localStorage.getItem('ace_plan')!);
    expect(raw.v).toBe(2); expect(raw.plan.qty).toBe(22);
    expect(restorePlan(1000)).toEqual({ qty: 22, pkgs: { imp: true }, storeOn: true, domain: 'acme', company: 'Acme', country: 'PL', vat: '1234567890' });
  });
  it('reads a plan saved by /platform', () => {
    localStorage.setItem('ace_plan', JSON.stringify({ v: 2, t: Date.now(), plan: { qty: 9, orders: 1500, pkgs: {}, storeOn: false, domain: '', tt: 'off', meta: 'off', marketOn: false, company: 'X', country: 'DE', vat: '', step: 2 } }));
    expect(restorePlan(1000)).toMatchObject({ qty: 9, company: 'X', country: 'DE' });
  });
  it('drops an absurd size, and forgets a plan older than a day', () => {
    savePlan({ qty: 5000 }); expect(restorePlan(1000).qty).toBeUndefined();
    localStorage.setItem('ace_plan', JSON.stringify({ v: 2, t: Date.now() - 25 * 3600e3, plan: { qty: 9 } }));
    expect(restorePlan(1000)).toEqual({}); expect(localStorage.getItem('ace_plan')).toBeNull();
    savePlan({ qty: 3 }); clearPlan(); expect(restorePlan(1000)).toEqual({});
  });
});

describe('the session /login stores', () => {
  const store = (s: object) => localStorage.setItem(KEY, JSON.stringify(s));
  const now = () => Math.floor(Date.now() / 1000);
  it('is read from the shared key; a broken or missing one means signed out', () => {
    expect(currentSession()).toBeNull();
    localStorage.setItem(KEY, '{broken'); expect(currentSession()).toBeNull();
    store({ access_token: 'a', expires_at: now() + 3600, user: { id: 'u' } }); expect(currentSession()?.access_token).toBe('a');
    signOut(); expect(localStorage.getItem(KEY)).toBeNull();
  });
  it('an expired session without a refresh token is signed out', async () => {
    store({ access_token: 'a', expires_at: now() - 10, user: { id: 'u' } });
    expect(currentSession()).toBeNull(); expect(await freshSession()).toBeNull();
  });
  it('a session about to expire is refreshed once and written back in the same shape', async () => {
    store({ access_token: 'old', refresh_token: 'r1', expires_at: now() + 30, user: { id: 'u', email: 'a@b.pl' } });
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_in: 3600, user: { id: 'u', email: 'a@b.pl' } })));
    const [a, b] = await Promise.all([freshSession(), freshSession()]);
    expect(a?.access_token).toBe('new'); expect(b?.access_token).toBe('new');
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe('https://proj.supabase.co/auth/v1/token?grant_type=refresh_token');
    expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toEqual({ refresh_token: 'r1' });
    const saved = JSON.parse(localStorage.getItem(KEY)!);
    expect(saved).toMatchObject({ access_token: 'new', refresh_token: 'r2', user: { email: 'a@b.pl' } }); expect(saved.expires_at).toBeGreaterThan(now() + 3000);
  });
  it('an expired session that cannot be refreshed is signed out', async () => {
    store({ access_token: 'old', refresh_token: 'r1', expires_at: now() - 10, user: { id: 'u' } });
    expect(currentSession()).not.toBeNull();          // still shown as signed in: it may be refreshable
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 400 }));
    expect(await freshSession()).toBeNull();
  });
  it('login links carry where to come back to', () => {
    expect(loginUrl('/app/dashboard/orders')).toBe('/login?next=%2Fapp%2Fdashboard%2Forders');
  });
});

describe('translations', () => {
  it('fills placeholders and falls back to English', () => {
    expect(fill('Order {ref} received', { ref: 'O-1' })).toBe('Order O-1 received');
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    expect(translate('pl', 'A sentence nobody translated')).toBe('A sentence nobody translated');
  });
  it('the tariff sentence uses the real numbers, or none when they are not known', () => {
    const t = (k: string, v?: Record<string, string | number>) => fill(k, v);
    expect(tariffText({ tiers: [{ handling_net: 6, return_net: 9 }, { handling_net: 15, return_net: 22.5 }] }, 'order', t)).toBe('6,00 zł to 15,00 zł per order, by the size of the parcel');
    expect(tariffText({ tiers: [{ handling_net: 6, return_net: 9 }, { handling_net: 15, return_net: 22.5 }] }, 'return', t)).toBe('9,00 zł to 22,50 zł per return, by the size of the parcel');
    expect(tariffText(null, 'order', t)).toBe('a fee per order, by the size of the parcel');
  });
});

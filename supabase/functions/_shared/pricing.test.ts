// deno test supabase/functions/_shared/pricing.test.ts
import { priceConfig, storageM2, comparePlans, fmtM2, PRICE_PER_M2, type PlanConfig } from './pricing.ts';
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const bad = (c: unknown, re: RegExp, m: string) => { try { priceConfig(c as PlanConfig); } catch (e) { ok(re.test((e as Error).message), `${m}: ${(e as Error).message}`); return; } throw new Error(m + ': should have thrown'); };

Deno.test('storage is 300 zł per m²', () => {
  eq(PRICE_PER_M2, 300, 'rate'); const p = priceConfig({ m2: 12, pkgs: {} });
  eq([p.lines[0].label, p.lines[0].monthly, p.monthly, p.once], ['Storage (12 m²)', 3600, 3600, 0], 'twelve square metres');
  eq(priceConfig({ m2: 1, pkgs: {} }).monthly, 300, 'one m²'); eq(priceConfig({ m2: 2000, pkgs: {} }).monthly, 600000, 'the largest');
});
Deno.test('the other services are unchanged', () => {
  const p = priceConfig({ m2: 10, pkgs: {}, storeOn: true, tt: 'managed', meta: 'setup' });
  eq(p.lines.map((l) => [l.label, l.monthly, l.once]), [['Storage (10 m²)', 3000, 0], ['Storefront hosting and care', 199, 2950], ['TikTok Shop managed', 1890, 1690], ['Meta Business setup', 0, 1190]], 'lines');
  eq([p.monthly, p.once], [5089, 5830], 'totals');
});
Deno.test('2ACE Market is accepted in old configs and bills nothing', () => { eq(priceConfig({ m2: 5, pkgs: {}, marketOn: true }), priceConfig({ m2: 5, pkgs: {} }), 'no line, no charge'); });
Deno.test('new plans below 1 m², above 2000 m² or not numbers are refused', () => {
  bad({ m2: 0.5, pkgs: {} }, /invalid m2/, 'half a metre'); bad({ m2: 0, pkgs: {} }, /invalid m2/, 'zero'); bad({ m2: -4, pkgs: {} }, /invalid m2/, 'negative'); bad({ m2: 2001, pkgs: {} }, /invalid m2/, 'too big');
  bad({ m2: 'ten', pkgs: {} }, /invalid m2/, 'text'); bad({ m2: NaN, pkgs: {} }, /invalid m2/, 'NaN'); bad({ pkgs: {} }, /invalid m2/, 'nothing given');
});
Deno.test('decimals are kept to one place, and areas format without a trailing .0', () => {
  eq(storageM2({ m2: 7.46, pkgs: {} }), 7.5, 'rounded to one decimal'); eq(priceConfig({ m2: 7.46, pkgs: {} }).monthly, 2250, '7.5 m² costs 2250'); eq([fmtM2(12), fmtM2(14.4), fmtM2(0.9)], ['12', '14.4', '0.9'], 'format');
});
Deno.test('fulfilment and returns are not part of the plan price: only storage (and the storefront) is a fixed monthly price', () => {
  const base = priceConfig({ m2: 10, pkgs: {} });
  if (base.monthly !== 3000 || base.lines.length !== 1) throw new Error('storage only: ' + JSON.stringify(base));
  const store = priceConfig({ m2: 10, pkgs: {}, storeOn: true }); if (store.monthly !== 3199 || store.once !== 2950) throw new Error('storefront still priced: ' + JSON.stringify(store));
});

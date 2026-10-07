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
Deno.test('an old plan costs EXACTLY what it always did', () => {
  for (const [type, qty, old] of [['shelf', 1, 90], ['shelf', 40, 3600], ['shelf', 2000, 180000], ['pallet', 1, 360], ['pallet', 12, 4320], ['pallet', 1000, 360000], ['shelf', 3, 270]] as const) {
    const p = priceConfig({ storageType: type, qty, pkgs: {} }); eq(p.monthly, old, `${qty} ${type}`);
  }
  eq(priceConfig({ storageType: 'pallet', qty: 12, pkgs: {} }).lines[0].label, 'Storage (14.4 m²)', 'shown as its area');
  eq(priceConfig({ storageType: 'shelf', qty: 3, pkgs: {} }).lines[0].label, 'Storage (0.9 m²)', 'a small old plan keeps its area');
});
Deno.test('fulfilment and returns are charged on the area, as before', () => {
  const nu = priceConfig({ m2: 14.4, pkgs: { ful: true, ret: true } }), old = priceConfig({ storageType: 'pallet', qty: 12, pkgs: { ful: true, ret: true } });
  eq(nu.lines.map((l) => [l.label, l.monthly]), [['Storage (14.4 m²)', 4320], ['Fulfillment', 5040], ['Returns handling', 2160]], 'new');
  eq(nu, old, 'a new plan of the same area equals the old pallet plan');
});
Deno.test('the other services are unchanged', () => {
  const p = priceConfig({ m2: 10, pkgs: {}, storeOn: true, tt: 'managed', meta: 'setup' });
  eq(p.lines.map((l) => [l.label, l.monthly, l.once]), [['Storage (10 m²)', 3000, 0], ['Storefront hosting and care', 199, 2950], ['TikTok Shop managed', 1890, 1690], ['Meta Business setup', 0, 1190]], 'lines');
  eq([p.monthly, p.once], [5089, 5830], 'totals');
});
Deno.test('2ACE Market is accepted in old configs and bills nothing', () => { eq(priceConfig({ m2: 5, pkgs: {}, marketOn: true }), priceConfig({ m2: 5, pkgs: {} }), 'no line, no charge'); });
Deno.test('new plans below 1 m², above 2000 m² or not numbers are refused', () => {
  bad({ m2: 0.5, pkgs: {} }, /invalid m2/, 'half a metre'); bad({ m2: 0, pkgs: {} }, /invalid m2/, 'zero'); bad({ m2: -4, pkgs: {} }, /invalid m2/, 'negative'); bad({ m2: 2001, pkgs: {} }, /invalid m2/, 'too big');
  bad({ m2: 'ten', pkgs: {} }, /invalid m2/, 'text'); bad({ m2: NaN, pkgs: {} }, /invalid m2/, 'NaN'); bad({ pkgs: {} }, /invalid storageType/, 'nothing given');
});
Deno.test('old-format limits still hold', () => {
  bad({ storageType: 'pallet', qty: 1001, pkgs: {} }, /invalid qty/, 'too many pallets'); bad({ storageType: 'shelf', qty: 0, pkgs: {} }, /invalid qty/, 'no bins'); bad({ storageType: 'crate' as never, qty: 3, pkgs: {} }, /invalid storageType/, 'unknown type'); bad({ storageType: 'pallet', qty: NaN, pkgs: {} }, /invalid qty/, 'NaN');
});
Deno.test('decimals are kept to one place, and areas format without a trailing .0', () => {
  eq(storageM2({ m2: 7.46, pkgs: {} }), 7.5, 'rounded to one decimal'); eq(priceConfig({ m2: 7.46, pkgs: {} }).monthly, 2250, '7.5 m² costs 2250'); eq([fmtM2(12), fmtM2(14.4), fmtM2(0.9)], ['12', '14.4', '0.9'], 'format');
});
Deno.test('comparing plans still works across the formats', () => {
  const a = priceConfig({ storageType: 'pallet', qty: 12, pkgs: {} }), b = priceConfig({ m2: 20, pkgs: {} }), c = priceConfig({ m2: 14.4, pkgs: {} });
  eq(comparePlans(a, b).kind, 'upgrade', 'bigger'); eq(comparePlans(a, c).kind, 'same', 'same area, new format'); eq(comparePlans(b, a).kind, 'downgrade', 'smaller');
});

Deno.test('Fulfilment as you go has no monthly fee, is shown on the plan, and cannot be combined with Fulfilment', () => {
  const base = priceConfig({ m2: 10, pkgs: {} }), payg = priceConfig({ m2: 10, pkgs: { payg: true } });
  if (payg.monthly !== base.monthly || base.monthly !== 3000) throw new Error('as-you-go must add nothing to the monthly price: ' + payg.monthly);
  if (!payg.lines.some((l) => /as you go/i.test(l.label) && l.monthly === 0 && l.once === 0)) throw new Error('it should appear as a zero line');
  const withRet = priceConfig({ m2: 10, pkgs: { payg: true, ret: true } }); if (withRet.monthly !== 4500) throw new Error('returns still work with it: ' + withRet.monthly);
  try { priceConfig({ m2: 10, pkgs: { ful: true, payg: true } }); throw new Error('should refuse both'); } catch (e) { if (!/choose one/.test((e as Error).message)) throw e; }
});

Deno.test('Returns as you go has no monthly fee, cannot be combined with flat returns, and flat plans price exactly as before', () => {
  const r = priceConfig({ m2: 10, pkgs: { payg: true, retp: true } });
  if (r.monthly !== 3000) throw new Error('both pay-as-you-go options add nothing monthly: ' + r.monthly);
  if (!r.lines.some((l) => /returns as you go/i.test(l.label) && l.monthly === 0)) throw new Error('returns line missing');
  try { priceConfig({ m2: 10, pkgs: { ret: true, retp: true } }); throw new Error('should refuse'); } catch (e) { if (!/choose one returns/.test((e as Error).message)) throw e; }
  const flat = priceConfig({ m2: 10, pkgs: { ful: true, ret: true } }); if (flat.monthly !== 3000 + 3500 + 1500) throw new Error('flat plans unchanged: ' + flat.monthly);
  const mix = priceConfig({ m2: 10, pkgs: { ful: true, retp: true } }); if (mix.monthly !== 6500) throw new Error('flat fulfilment with pay-as-you-go returns: ' + mix.monthly);
});

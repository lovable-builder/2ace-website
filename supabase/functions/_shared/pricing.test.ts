// deno test supabase/functions/_shared/pricing.test.ts
import { priceConfig, storageOf, comparePlans, fmtNum, PALLET_PRICE, SHELF_M3_PRICE, type PlanConfig } from './pricing.ts';
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const bad = (c: unknown, re: RegExp, m: string) => { try { priceConfig(c as PlanConfig); } catch (e) { ok(re.test((e as Error).message), `${m}: ${(e as Error).message}`); return; } throw new Error(m + ': should have thrown'); };

Deno.test('storage is 35 zł per pallet place and 35 zł per m³ of shelf space', () => {
  eq([PALLET_PRICE, SHELF_M3_PRICE], [35, 35], 'rates');
  const p = priceConfig({ pallets: 10, shelfM3: 4, pkgs: {} });
  eq([p.lines[0].label, p.lines[0].monthly, p.monthly, p.once], ['Storage (10 pallet places, 4 m³ shelf space)', 490, 490, 0], 'both kinds');
  eq(priceConfig({ pallets: 1, pkgs: {} }).lines[0].label, 'Storage (1 pallet place)', 'one pallet, no shelves');
  eq(priceConfig({ shelfM3: 2.5, pkgs: {} }).lines[0], { label: 'Storage (2.5 m³ shelf space)', monthly: 88, once: 0 }, 'shelves only, half m³ rounds to whole zł');
  eq(priceConfig({ pallets: 500, shelfM3: 500, pkgs: {} }).monthly, 35000, 'the largest');
});
Deno.test('a plan with no pallets or shelf space, or an old per-m² plan, is refused', () => {
  for (const c of [{ pkgs: {} }, { m2: 12, pkgs: {} }, { pallets: 0, shelfM3: 0, pkgs: {} }] as never[]) { let err = ''; try { priceConfig(c); } catch (e) { err = (e as Error).message; } eq(err, 'choose some storage', 'refused'); }
});
Deno.test('the other services are unchanged', () => {
  const p = priceConfig({ pallets: 4, pkgs: {}, storeOn: true, tt: 'managed', meta: 'setup' });
  eq(p.lines.map((l) => [l.label, l.monthly, l.once]), [['Storage (4 pallet places)', 140, 0], ['Storefront hosting and care', 199, 2950], ['TikTok Shop managed', 1890, 1690], ['Meta Business setup', 0, 1190]], 'lines');
  eq([p.monthly, p.once], [2229, 5830], 'totals');
});
Deno.test('2ACE Market is accepted in old configs and bills nothing', () => { eq(priceConfig({ pallets: 5, pkgs: {}, marketOn: true }), priceConfig({ pallets: 5, pkgs: {} }), 'no line, no charge'); });
Deno.test('nonsense amounts and plans with no storage are refused', () => {
  bad({ pallets: 0, shelfM3: 0, pkgs: {} }, /choose some storage/, 'nothing'); bad({ pkgs: {} }, /choose some storage/, 'nothing given');
  bad({ pallets: 1.5, pkgs: {} }, /invalid pallets/, 'half a pallet'); bad({ pallets: -1, pkgs: {} }, /invalid pallets/, 'negative'); bad({ pallets: 501, pkgs: {} }, /invalid pallets/, 'too many');
  bad({ shelfM3: -2, pkgs: {} }, /invalid shelf/, 'negative shelves'); bad({ shelfM3: 'ten', pkgs: {} }, /invalid shelf/, 'text'); bad({ shelfM3: 0.2, pkgs: {} }, /choose some storage/, 'rounds to nothing');
  bad({ m2: 0.5, pkgs: {} }, /invalid m2/, 'old plan, half a metre'); bad({ m2: 2001, pkgs: {} }, /invalid m2/, 'old plan, too big');
});
Deno.test('shelf space is kept to half m³, and numbers format without a trailing .0', () => {
  eq(storageOf({ shelfM3: 3.3, pkgs: {} }).shelfM3, 3.5, 'half steps'); eq([fmtNum(12), fmtNum(14.5), fmtNum(0.5)], ['12', '14.5', '0.5'], 'format');
});
Deno.test('fulfilment and returns are not part of the plan price: only storage (and the storefront) is a fixed monthly price', () => {
  const base = priceConfig({ pallets: 10, pkgs: {} });
  if (base.monthly !== 350 || base.lines.length !== 1) throw new Error('storage only: ' + JSON.stringify(base));
  const store = priceConfig({ pallets: 10, pkgs: {}, storeOn: true }); if (store.monthly !== 549 || store.once !== 2950) throw new Error('storefront still priced: ' + JSON.stringify(store));
});

// Server-side twin of the customer app's pricing (web/src/lib/pricing.ts). Amounts are whole PLN, net of VAT.
// Keep in sync with the browser version; the browser total is display only.

// Storage is sold as pallet places and shelf space, priced at or below the Polish market: 35 zł net a month for each pallet place
// and 35 zł for each m³ of shelf space. No monthly minimum.
// Plans bought before this were sold by the square metre (300 zł per m², and before that per bin or pallet at the same rate). They keep
// their price: a config with only `m2` is a legacy plan and is priced exactly as it always was.
export const PALLET_PRICE = 35;       // per pallet place a month
export const SHELF_M3_PRICE = 35;     // per m³ of shelf space a month
export const MAX_PALLETS = 500;
export const MAX_SHELF_M3 = 500;
export const LEGACY_PRICE_PER_M2 = 300;
const LEGACY_MAX_M2 = 2000;

export type PlanConfig = {
  pallets?: number;                               // pallet places (whole numbers)
  shelfM3?: number;                               // shelf space in m³, in half-m³ steps
  m2?: number;                                    // legacy plans only: the area in square metres
  pkgs?: { imp?: boolean };                       // Import & customs is quoted per shipment. Fulfilment and returns are pay as you go for everyone: they are not part of the plan price.
  storeOn?: boolean;
  domain?: string;
  tt?: 'off' | 'setup' | 'managed';
  meta?: 'off' | 'setup' | 'managed';
  marketOn?: boolean;                             // 2ACE Market is switched off for now; the field is kept so old plans stay valid
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const half = (n: number) => Math.round(n * 2) / 2;
const given = (v: unknown) => v !== undefined && v !== null && v !== '';

export type Storage = { pallets: number; shelfM3: number; legacyM2: number | null };

// The storage a plan reserves. Throws on anything that is not a sane amount, or on a plan with no storage at all.
export function storageOf(c: PlanConfig): Storage {
  if (given(c.pallets) || given(c.shelfM3)) {
    const p = given(c.pallets) ? Number(c.pallets) : 0, m = given(c.shelfM3) ? Number(c.shelfM3) : 0;
    if (!Number.isInteger(p) || p < 0 || p > MAX_PALLETS) throw new Error('invalid pallets');
    if (!Number.isFinite(m) || m < 0 || m > MAX_SHELF_M3) throw new Error('invalid shelf space');
    if (p === 0 && half(m) === 0) throw new Error('choose some storage');
    return { pallets: p, shelfM3: half(m), legacyM2: null };
  }
  if (given(c.m2)) {
    const v = Number(c.m2);
    if (!Number.isFinite(v) || v < 1 || v > LEGACY_MAX_M2) throw new Error('invalid m2');
    return { pallets: 0, shelfM3: 0, legacyM2: round1(v) };
  }
  throw new Error('choose some storage');
}
export const fmtNum = (n: number) => String(round1(n)).replace(/\.0$/, '');

export function storageLabel(s: Storage) {
  if (s.legacyM2 !== null) return `Storage (${fmtNum(s.legacyM2)} m²)`;
  const parts = [];
  if (s.pallets) parts.push(`${s.pallets} pallet place${s.pallets === 1 ? '' : 's'}`);
  if (s.shelfM3) parts.push(`${fmtNum(s.shelfM3)} m³ shelf space`);
  return `Storage (${parts.join(', ')})`;
}
export function storagePrice(s: Storage) {
  return s.legacyM2 !== null ? Math.round(s.legacyM2 * LEGACY_PRICE_PER_M2) : Math.round(s.pallets * PALLET_PRICE + s.shelfM3 * SHELF_M3_PRICE);
}

export type Line = { label: string; monthly: number; once: number };

export function priceConfig(c: PlanConfig) {
  const st = storageOf(c);
  const lines: Line[] = [{ label: storageLabel(st), monthly: storagePrice(st), once: 0 }];
  // Import & customs is quoted per shipment: not billed here.
  if (c.storeOn) lines.push({ label: 'Storefront hosting and care', monthly: 199, once: 2950 });
  const channels: [keyof PlanConfig, string, number, number][] = [
    ['tt', 'TikTok Shop', 1690, 1890],
    ['meta', 'Meta Business', 1190, 1690],
  ];
  for (const [k, name, setup, managed] of channels) {
    const v = c[k];
    if (v === 'setup') lines.push({ label: `${name} setup`, monthly: 0, once: setup });
    if (v === 'managed') lines.push({ label: `${name} managed`, monthly: managed, once: setup });
  }
  // 2ACE Market is a per-category commission on sales (3.6-9.2%): nothing billed up front.
  const monthly = lines.reduce((a, l) => a + l.monthly, 0);
  const once = lines.reduce((a, l) => a + l.once, 0);
  return { lines, monthly, once };
}

// How a new configuration compares with the current one (whole PLN, net of VAT).
export type ChangeKind = 'upgrade' | 'downgrade' | 'same';
export function comparePlans(current: { monthly: number }, next: { monthly: number; once: number }) {
  const delta = next.monthly - current.monthly;
  const kind: ChangeKind = delta > 0 ? 'upgrade' : delta < 0 ? 'downgrade' : 'same';
  return { kind, delta };
}

// Prorated amount for the rest of the current period. Positive = charge now, negative = credit on the next invoice.
// One-time setup fees on the new plan are charged in full right away.
export function prorate(delta: number, once: number, nowSec: number, periodStartSec: number, periodEndSec: number) {
  const span = Math.max(1, periodEndSec - periodStartSec);
  const left = Math.min(1, Math.max(0, (periodEndSec - nowSec) / span));
  return { fractionLeft: left, today: Math.round(delta * left + once) };
}

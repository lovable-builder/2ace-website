// Server-side twin of the customer app's pricing (web/src/lib/pricing.ts). Amounts are whole PLN, net of VAT.
// Keep in sync with the browser version; the browser total is display only.

// Storage is sold by the square metre: 300 zł net a month for each m².
// Plans bought before this were sold per shelf bin (90 zł, 0.3 m²) or per pallet (360 zł, 1.2 m²). Both are exactly 300 zł per m²,
// so an old plan is read as its area and costs exactly what it always did.
export const PRICE_PER_M2 = 300;
export const MIN_M2 = 1;           // smallest space a new plan can ask for
export const MAX_M2 = 2000;

export type PlanConfig = {
  m2?: number;                                    // the area, in square metres (current plans)
  pkgs?: { imp?: boolean };                       // Import & customs is quoted per shipment. Fulfilment and returns are pay as you go for everyone: they are not part of the plan price.
  storeOn?: boolean;
  domain?: string;
  tt?: 'off' | 'setup' | 'managed';
  meta?: 'off' | 'setup' | 'managed';
  marketOn?: boolean;                             // 2ACE Market is switched off for now; the field is kept so old plans stay valid
};

const round1 = (n: number) => Math.round(n * 10) / 10;

// The area of a plan in m², from either the current format or an old bin / pallet plan. Throws on anything that is not a sane amount.
export function storageM2(c: PlanConfig): number {
  if (c.m2 !== undefined && c.m2 !== null) {
    const v = Number(c.m2);
    if (!Number.isFinite(v) || v < MIN_M2 || v > MAX_M2) throw new Error('invalid m2');
    return round1(v);
  }
  throw new Error('invalid m2');
}
export const fmtM2 = (n: number) => String(round1(n)).replace(/\.0$/, '');

export type Line = { label: string; monthly: number; once: number };

export function priceConfig(c: PlanConfig) {
  const m2 = storageM2(c);
  const lines: Line[] = [{ label: `Storage (${fmtM2(m2)} m²)`, monthly: Math.round(m2 * PRICE_PER_M2), once: 0 }];
  const fp = m2;
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

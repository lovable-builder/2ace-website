// What a plan costs, shown live while it is built. Whole PLN, net of VAT. The server prices it again
// (supabase/functions/_shared/pricing.ts) and that is what is charged: keep the two in step.
export const STORAGE = { price: 300, min: 1, max: 1000, step: 1 };

export type Pkgs = { imp?: boolean };
export type PlanConfig = { m2?: number; pkgs?: Pkgs; storeOn?: boolean; domain?: string; tt?: string; meta?: string; marketOn?: boolean };
export type PlanInput = { qty: number; pkgs: Pkgs; storeOn: boolean; domain: string; marketOn: boolean };

// The words on the price lines below, translated where they are shown.
// i18n
export const PRICE_TEXT = ['Storage', '{m2} m² at {price} / m²', 'Import & customs', 'Quoted per shipment', 'Storefront {domain}.pl', 'Hosting and care', '2ACE Market', '{range} commission on market sales'];

export type PriceLine = {
  key: string;
  label: string;          // English; translated where shown
  detail: string;
  vars?: Record<string, string>;
  monthly: number;
  once: number;
  quote?: boolean;        // priced per shipment
  commission?: boolean;   // a share of sales, nothing fixed
};

// 2ACE Market (switched off for new plans; old plans may still have it): Allegro's category commission + ~1.2% payment fee, then 30% lower.
export const MK_CATS = ([['home', 'Home & kitchen', 9], ['beauty', 'Beauty & health', 8], ['fashion', 'Fashion', 12], ['kids', 'Kids', 9], ['tech', 'Tech accessories', 4]] as const)
  .map(([k, name, base]) => ({ k, name, rate: Math.round((base + 1.2) * 0.7 * 10) / 10 }));
export const mkRange = () => { const r = MK_CATS.map((c) => c.rate); return Math.min(...r) + '–' + Math.max(...r) + '%'; };

export const STOREFRONT = { monthly: 199, once: 2950 };

// The area of a saved plan, in m² to one decimal. Plans sold per bin or pallet were saved as their area too.
export const planM2 = (c: PlanConfig | null | undefined) => (c ? Math.round(Number(c.m2 || 0) * 10) / 10 : 0);

export function pricing(p: PlanInput) {
  const lines: PriceLine[] = [];
  const storage = Math.round(p.qty * STORAGE.price);
  lines.push({ key: 'storage', label: 'Storage', detail: '{m2} m² at {price} / m²', monthly: storage, once: 0 });
  if (p.pkgs.imp) lines.push({ key: 'imp', label: 'Import & customs', detail: 'Quoted per shipment', monthly: 0, once: 0, quote: true });
  if (p.storeOn) lines.push({ key: 'store', label: 'Storefront {domain}.pl', vars: { domain: p.domain || 'yourbrand' }, detail: 'Hosting and care', monthly: STOREFRONT.monthly, once: STOREFRONT.once });
  if (p.marketOn) lines.push({ key: 'market', label: '2ACE Market', detail: '{range} commission on market sales', vars: { range: mkRange() }, monthly: 0, once: 0, commission: true });
  return {
    lines,
    storage,
    monthly: lines.reduce((a, l) => a + l.monthly, 0),
    once: lines.reduce((a, l) => a + l.once, 0),
  };
}

// The m² an amount of stock needs: units per pallet place by product size, a pallet place takes about 1.2 m².
export const UNITS_PER_PLACE = { small: 1200, medium: 400, large: 120 } as const;
export type EstSize = keyof typeof UNITS_PER_PLACE;
export function estimateM2(units: number, size: EstSize) {
  const places = Math.max(1, Math.ceil((Number(units) || 0) / UNITS_PER_PLACE[size]));
  return Math.min(STORAGE.max, Math.max(STORAGE.min, Math.ceil(places * 1.2)));
}

// VAT on the first invoice, by the country the company is registered in.
export const EU_VAT = ['PL', 'DE', 'CZ', 'SK', 'LT', 'NL', 'FR', 'IT', 'ES'];
export function vatFor(country: string, net: number) {
  const isPL = country === 'PL', isEU = EU_VAT.includes(country);
  return { kind: isPL ? 'pl' : isEU ? 'eu' : 'outside', vat: isPL ? Math.round(net * 0.23) : 0 } as const;
}

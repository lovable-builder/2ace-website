// What a plan costs, shown live while it is built. Whole PLN, net of VAT. The server prices it again
// (supabase/functions/_shared/pricing.ts) and that is what is charged: keep the two in step.
// Storage is sold as pallet places and shelf space, at or below the Polish market: 35 zł a month per pallet place and per m³ of
// shelf space, no monthly minimum.
export const STORAGE = { pallet: 35, shelf: 35, maxPallets: 500, maxShelf: 500 };

export type Pkgs = { imp?: boolean };
export type PlanConfig = { pallets?: number; shelfM3?: number; pkgs?: Pkgs; storeOn?: boolean; domain?: string; tt?: string; meta?: string; marketOn?: boolean };
export type PlanInput = { pallets: number; shelf: number; pkgs: Pkgs; storeOn: boolean; domain: string; marketOn: boolean };

// The words on the price lines below, translated where they are shown.
// i18n
export const PRICE_TEXT = ['Pallet storage', '{n} pallet places at {price} each', 'Shelf storage', '{n} m³ at {price} per m³', 'Import & customs', 'Quoted per shipment', 'Storefront {domain}.pl', 'Hosting and care', '2ACE Market', '{range} commission on market sales'];

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

const half = (n: number) => Math.round(n * 2) / 2;
// The storage a saved plan reserves.
export function planStorage(c: PlanConfig | null | undefined) {
  const pallets = Math.max(0, Math.round(Number(c?.pallets) || 0)), shelf = Math.max(0, half(Number(c?.shelfM3) || 0));
  return { pallets, shelf };
}
// What a plan being changed starts from.
export const startingStorage = planStorage;

export function pricing(p: PlanInput) {
  const lines: PriceLine[] = [];
  const pallets = Math.round(p.pallets * STORAGE.pallet), shelf = Math.round(p.shelf * STORAGE.shelf);
  if (p.pallets) lines.push({ key: 'pallets', label: 'Pallet storage', detail: '{n} pallet places at {price} each', vars: { n: String(p.pallets), price: String(STORAGE.pallet) }, monthly: pallets, once: 0 });
  if (p.shelf) lines.push({ key: 'shelf', label: 'Shelf storage', detail: '{n} m³ at {price} per m³', vars: { n: String(p.shelf), price: String(STORAGE.shelf) }, monthly: shelf, once: 0 });
  const storage = pallets + shelf;
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

// The storage an amount of stock needs. Small items go on shelves (about 800 a m³); shoebox-sized and bulky goods on pallets
// (about 400 and 120 a pallet place).
export type EstSize = 'small' | 'medium' | 'large';
export const UNITS_PER = { small: 800, medium: 400, large: 120 } as const;
export function estimateStorage(units: number, size: EstSize): { pallets: number; shelf: number } {
  const n = Math.max(0, Number(units) || 0);
  if (size === 'small') return { pallets: 0, shelf: Math.min(STORAGE.maxShelf, Math.max(0.5, Math.ceil((n / UNITS_PER.small) * 2) / 2)) };
  return { pallets: Math.min(STORAGE.maxPallets, Math.max(1, Math.ceil(n / UNITS_PER[size]))), shelf: 0 };
}

// VAT on the first invoice, by the country the company is registered in.
export const EU_VAT = ['PL', 'DE', 'CZ', 'SK', 'LT', 'NL', 'FR', 'IT', 'ES'];
export function vatFor(country: string, net: number) {
  const isPL = country === 'PL', isEU = EU_VAT.includes(country);
  return { kind: isPL ? 'pl' : isEU ? 'eu' : 'outside', vat: isPL ? Math.round(net * 0.23) : 0 } as const;
}

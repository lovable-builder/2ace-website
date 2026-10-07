// Shipping rules that need no network: what we send to the carrier API, what the customer is charged, and the guards on spending money.
// Furgonetka's own request format is documented at https://furgonetka.pl/api/rest (versioned through the Accept header).

// Where parcels leave from: Box 17 in BOXZONE Puchały I (rental agreement of 28.09.2026, handover from 01.01.2027). Change it here.
export const SENDER = {
  name: 'Warehouse Team', // Furgonetka accepts letters only here (no digits), and wants first name + surname style
  company: '2ACE sp. z o.o. Box 17',
  street: 'Żwirowa 66',
  postcode: '05-090',
  city: 'Puchały',
  country_code: 'PL',
  email: 'hello@2ace.pl',
  phone: '608180946',
};
export const DEFAULT_CARRIERS = ['inpost', 'dpd', 'dhl', 'gls', 'ups', 'fedex', 'poczta', 'orlen'];
export const DEFAULT_MARKUP_PERCENT = 30;
export const DEFAULT_MAX_LABEL_PLN = 80;
// The markup for one customer: their own setting if they have one, else the default (SHIPPING_MARKUP_PERCENT, 30).
export function markupFor(orgPercent: number | string | null | undefined, get: (k: string) => string | undefined): number {
  if (orgPercent !== null && orgPercent !== undefined && String(orgPercent) !== '') { const n = Number(orgPercent); if (Number.isFinite(n) && n >= 0 && n <= 500) return n; }
  return settingNum(get, 'SHIPPING_MARKUP_PERCENT', DEFAULT_MARKUP_PERCENT, 0, 500);
}
export const DEFAULT_DAILY_CAP_PLN = 500;

export type OrderShip = { ref: string; ship_name: string; ship_company?: string | null; ship_line1: string; ship_line2?: string | null; ship_postal: string; ship_city: string; ship_country: string; ship_email?: string | null; ship_phone?: string | null };
export type ParcelRow = { weight_g: number; length_cm: number | string; width_cm: number | string; height_cm: number | string };

const clean = (v: unknown) => { const t = String(v ?? '').trim(); return t === '' ? undefined : t; };
const compact = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

// Phone as Furgonetka wants it. Poland: exactly 9 digits, so +48 / 0048 / 48 / a leading 0 are removed. Other countries: digits only.
export function normalizePhone(raw: unknown, country = 'PL'): string | undefined {
  let d = String(raw ?? '').replace(/[^0-9]/g, ''); if (!d) return undefined;
  if (d.startsWith('00')) d = d.slice(2);
  if (String(country).toUpperCase() === 'PL') {
    if (d.length === 11 && d.startsWith('48')) d = d.slice(2);
    else if (d.length === 10 && d.startsWith('0')) d = d.slice(1);
    if (d.length !== 9) throw new Error(`The receiver's phone number must be 9 digits for Poland (it is "${String(raw).trim()}"). Correct it on the order.`);
  }
  return d;
}
// Furgonetka refuses a receiver without both a first name and a surname.
function receiverName(name: unknown): string | undefined {
  const n = clean(name); if (!n) return undefined;
  if (n.split(/\s+/).length < 2) throw new Error(`The receiver's name needs a first name and a surname (it is "${n}"). Correct it on the order.`);
  return n;
}

// The shipment as Furgonetka wants it. Sizes go to whole centimetres rounded UP, weight in kilograms.
// Sizes go to whole centimetres rounded UP, weight in kilograms, whatever the shipment.
const parcelList = (parcels: ParcelRow[], description: string) => parcels.map((p) => ({
  type: 'package',
  width: Math.max(1, Math.ceil(Number(p.width_cm))), depth: Math.max(1, Math.ceil(Number(p.length_cm))), height: Math.max(1, Math.ceil(Number(p.height_cm))),
  weight: Math.max(0.01, Math.round((p.weight_g / 1000) * 100) / 100),
  description,
}));

export function buildPackage(o: OrderShip, parcels: ParcelRow[], serviceId?: number, sender = SENDER) {
  if (!parcels.length) throw new Error('This order has no parcels recorded');
  return compact({
    service_id: serviceId,
    pickup: { ...sender },
    receiver: compact({
      name: receiverName(o.ship_name), company: clean(o.ship_company),
      street: [clean(o.ship_line1), clean(o.ship_line2)].filter(Boolean).join(' '),
      postcode: clean(o.ship_postal), city: clean(o.ship_city), country_code: String(o.ship_country).toUpperCase(),
      email: clean(o.ship_email), phone: normalizePhone(o.ship_phone, String(o.ship_country)),
    }),
    user_reference_number: o.ref,
    parcels: parcelList(parcels, 'E-commerce goods'),
  });
}

// A return: the buyer sends the goods back to us. The buyer is the sender (pickup) and our warehouse is the receiver. The buyer's name and phone follow the same rules as any receiver.
export type ReturnShip = { ref: string; buyer_name: string; buyer_company?: string | null; buyer_line1: string; buyer_line2?: string | null; buyer_postal: string; buyer_city: string; buyer_country: string; buyer_email?: string | null; buyer_phone?: string | null };
export function buildReturnPackage(r: ReturnShip, parcels: ParcelRow[], serviceId?: number, warehouse = SENDER) {
  if (!parcels.length) throw new Error('This return has no parcel recorded');
  return compact({
    service_id: serviceId,
    pickup: compact({
      name: receiverName(r.buyer_name), company: clean(r.buyer_company), street: [clean(r.buyer_line1), clean(r.buyer_line2)].filter(Boolean).join(' '),
      postcode: clean(r.buyer_postal), city: clean(r.buyer_city), country_code: String(r.buyer_country).toUpperCase(), email: clean(r.buyer_email), phone: normalizePhone(r.buyer_phone, String(r.buyer_country)),
    }),
    receiver: { ...warehouse },
    user_reference_number: r.ref,
    parcels: parcelList(parcels, 'Returned goods'),
  });
}

export type Quote = { service_id: number; carrier: string; name: string; available: boolean; reason?: string; cost_net: number; cost_gross: number; tax: number };
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Reads the answer of calculate-price. Sorted: available ones cheapest first, then the unavailable ones with their reason.
export function parseQuotes(raw: unknown): Quote[] {
  const list = (raw as { services_prices?: unknown })?.services_prices;
  if (!Array.isArray(list)) return [];
  const out = list.map((q: Record<string, unknown>) => {
    const pricing = (q.pricing ?? {}) as Record<string, unknown>;
    const errs = Array.isArray(q.errors) ? (q.errors as unknown[]).map((e) => (typeof e === 'string' ? e : String((e as { message?: string })?.message ?? ''))).filter(Boolean) : [];
    const net = num(pricing.price_net), gross = num(pricing.price_gross);
    const carrier = String(q.service ?? '');
    const kind = [q.shipment_type, q.delivery_type].map((x) => String(x ?? '')).filter(Boolean).join(', ');
    // Pickup-point and locker services need a point chosen by the receiver, which we do not collect yet: never offer them.
    const needsPoint = carrier.toLowerCase() === 'orlen' || /point|locker|paczkomat|machine|pickup|punkt|kiosk|pudo|parcel_?shop/i.test(kind);
    if (needsPoint && !errs.length) errs.push('Delivers to a pickup point or locker, which is not supported yet');
    const available = q.available === true && gross > 0 && !needsPoint;
    return { service_id: num(q.service_id), carrier, name: [carrier.toUpperCase(), kind].filter(Boolean).join(' · '), available, reason: available ? undefined : (errs.join('; ') || 'Not available for this parcel'), cost_net: net, cost_gross: gross, tax: num(pricing.tax) || (net > 0 ? Math.round((gross / net - 1) * 100) : 23) } as Quote;
  });
  return out.sort((a, b) => Number(b.available) - Number(a.available) || a.cost_net - b.cost_net);
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
// What the customer is charged for a label: our net cost plus the markup (VAT is added on the invoice).
export const customerNet = (costNet: number, pct: number) => round2(costNet * (1 + pct / 100));
export const customerGross = (costNet: number, pct: number, taxPct: number) => round2(customerNet(costNet, pct) * (1 + taxPct / 100));

// Settings, with safe defaults. A value that is not a sensible number falls back to the default.
export function settingNum(get: (k: string) => string | undefined, key: string, dflt: number, min = 0, max = 1e6): number {
  const n = Number(get(key)); return Number.isFinite(n) && get(key) !== undefined && get(key) !== '' && n >= min && n <= max ? n : dflt;
}
export function carriersFrom(get: (k: string) => string | undefined): string[] {
  const l = (get('SHIPPING_CARRIERS') ?? '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z_]{2,30}$/.test(x));
  return l.length ? l : DEFAULT_CARRIERS;
}

const pl = (n: number) => n.toFixed(2).replace('.', ',') + ' zł';
// The guard in front of every purchase. Returns the reason to refuse, or null to go ahead. Nothing here can be bypassed from the browser.
export function spendCheck(i: { enabled: boolean; role: string; costGross: number; balance: number | null; maxLabel: number; dailyCap: number; spentToday: number; overLimitConfirmed: boolean }): string | null {
  if (!i.enabled) return 'Buying labels is switched off. An admin turns it on with the server setting SHIPPING_ENABLED=true.';
  if (!(i.costGross > 0)) return 'The label price is not valid.';
  if (i.balance === null || !Number.isFinite(i.balance)) return 'Could not read the Furgonetka balance, so nothing was bought.';
  if (i.costGross > i.balance) return `Not enough balance: this label costs ${pl(i.costGross)} and the balance is ${pl(i.balance)}. Top up in Furgonetka.`;
  if (i.spentToday + i.costGross > i.dailyCap) return `The daily limit of ${pl(i.dailyCap)} would be exceeded (${pl(i.spentToday)} spent today). An admin can raise SHIPPING_DAILY_CAP_PLN.`;
  if (i.costGross > i.maxLabel && !(i.role === 'admin' && i.overLimitConfirmed)) return `This label costs ${pl(i.costGross)}, above the ${pl(i.maxLabel)} limit per label. ${i.role === 'admin' ? 'Confirm to buy it anyway.' : 'An admin has to confirm it.'}`;
  return null;
}

// Midnight of the current day in Poland, as a UTC instant (the daily limit counts from there).
export function warsawDayStart(now: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', timeZoneName: 'shortOffset' }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const off = Number((g('timeZoneName').match(/GMT([+-]\d+)/) ?? [])[1] ?? 1);
  return new Date(Date.UTC(Number(g('year')), Number(g('month')) - 1, Number(g('day')), -off, 0, 0));
}

// Waybill numbers out of a shipment as Furgonetka describes it.
export function extractTracking(pkg: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const add = (v: unknown) => { const t = String(v ?? '').trim(); if (t) found.add(t); };
  add(pkg.package_no);
  if (Array.isArray(pkg.parcels)) for (const p of pkg.parcels as Record<string, unknown>[]) { add(p.package_no); add(p.waybill_number); add(p.tracking_number); }
  return [...found];
}

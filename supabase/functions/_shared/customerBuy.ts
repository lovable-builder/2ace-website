// Fulfilment as you go: a customer prices and buys a shipping label for their own order.
// Everything that can touch money is checked here AND again in the database (cs_begin_shipment, under a lock). Customers only ever see the price they
// pay (carrier price plus the markup, before VAT): never our cost, the markup, our balance or our limits. Dependencies are passed in so every branch is tested without a network.
import { CsError, CAN_PREPARE_ROLES, capabilities as baseCapabilities, isUuid, type CsDeps } from './customerShipping.ts';
import { ShipError, buyLabel, type BuyDeps } from './shipBuy.ts';
import { FurgonetkaError, fieldErrors } from './furgonetka.ts';
import { buildPackage, parseQuotes, markupFor, customerNet, customerGross, carriersFrom, settingNum, round2, type OrderShip, type ParcelRow } from './shipping.ts';

export const DEFAULT_CUSTOMER_MAX_LABEL_PLN = 60;      // gross cost per label, no override for customers
export const DEFAULT_CUSTOMER_DAILY_POOL_PLN = 150;    // what all customers together may spend a day; staff keep the rest of the daily cap
export const BUYABLE_STATUS = ['allocated', 'picking', 'packed'];
const pln = (n: number) => n.toFixed(2).replace('.', ',') + ' zł';

export type Item = { sku: string; name: string; qty: number; weight_g: number | null; length_cm: number | null; width_cm: number | null; height_cm: number | null };
export type OrgSettings = { label_buying_enabled: boolean; markup_percent: number | null; max_label_net: number | null };
export interface CsBuyDeps extends CsDeps {
  getenv(k: string): string | undefined;
  furgonetkaEnv: 'sandbox' | 'production';
  api: BuyDeps['api'];
  orderShip(id: string): Promise<(OrderShip & { id: string; org_id: string; status: string }) | null>;
  orgSettings(orgId: string): Promise<OrgSettings | null>;
  orgStatus(orgId: string): Promise<string | null>;
  items(orderId: string): Promise<Item[]>;
  spentToday(scope: 'customers' | 'all'): Promise<number>;
  alert(subject: string, html: string): Promise<void>;
  labelUrl(orgId: string, orderId: string, packageId: string): Promise<string | null>;       // a short-lived link to the PDF (fetched from the carrier service once, then kept in our storage); null while it is not ready
}

// ---------- who may buy, and whether buying is open at all ----------
type Ready = { ok: true; settings: OrgSettings; markup: number; maxLabel: number } | { ok: false; reason: string; status: number };
export async function ready(d: CsBuyDeps, needPayg = true): Promise<Ready> {
  if (!CAN_PREPARE_ROLES.includes(d.role)) return { ok: false, reason: 'Your role cannot buy labels. Ask an owner or operations user.', status: 403 };
  if (d.getenv('CUSTOMER_LABELS_ENABLED') !== 'true') return { ok: false, reason: 'Buying a label with 2ACE is not open yet.', status: 403 };
  if (needPayg && (await d.mode(d.orgId)) !== 'payg') return { ok: false, reason: 'Buying labels yourself is part of Fulfilment as you go.', status: 403 };
  if ((await d.orgStatus(d.orgId)) !== 'active') return { ok: false, reason: 'Your plan is not active, so labels cannot be bought.', status: 403 };
  const s = await d.orgSettings(d.orgId);
  if (!s || !s.label_buying_enabled) return { ok: false, reason: 'Buying labels yourself is not switched on for your account yet. Please contact us.', status: 403 };
  return { ok: true, settings: s, markup: markupFor(s.markup_percent, d.getenv), maxLabel: settingNum(d.getenv, 'CUSTOMER_MAX_LABEL_PLN', DEFAULT_CUSTOMER_MAX_LABEL_PLN, 1, 1000) };
}
async function myOrder(d: CsBuyDeps, id: unknown) {
  if (!isUuid(id)) throw new CsError('Invalid order');
  const o = await d.orderShip(id);
  if (!o || o.org_id !== d.orgId) throw new CsError('Order not found', 404);          // another company's order looks exactly like a missing one
  return o;
}
async function buyableOrder(d: CsBuyDeps, id: unknown) {
  const r = await ready(d);
  if (!r.ok) throw new CsError(r.reason, r.status);
  const o = await myOrder(d, id);
  if (!BUYABLE_STATUS.includes(o.status)) throw new CsError(`A label can be bought for a reserved order that has not shipped yet (this one is ${o.status}).`, 409);
  return { o, r };
}

export async function capabilitiesBuy(d: CsBuyDeps) {
  const base = await baseCapabilities(d);
  const r = await ready(d);
  const rr = await ready(d, false);                                                      // a return label needs no Fulfilment plan, only that buying is open for this customer
  return { ...base, buy_label: r.ok, buy_return_label: rr.ok };
}

// ---------- the parcel ----------
const num = (v: unknown) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
export function cleanParcels(input: unknown): ParcelRow[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 3) throw new CsError('Enter 1 to 3 parcels.');
  return input.map((p, i) => {
    const x = p as Record<string, unknown>, kg = num(x.weight_kg), l = num(x.length_cm), w = num(x.width_cm), h = num(x.height_cm);
    const label = input.length > 1 ? `Parcel ${i + 1}: ` : '';
    if (!(kg >= 0.01 && kg <= 30)) throw new CsError(label + 'Enter the weight in kilograms, from 0.01 to 30.');
    for (const [name, v] of [['length', l], ['width', w], ['height', h]] as const) if (!(v >= 1 && v <= 150)) throw new CsError(label + `Enter the ${name} in centimetres, from 1 to 150.`);
    return { weight_g: Math.round(kg * 1000), length_cm: Math.ceil(l), width_cm: Math.ceil(w), height_cm: Math.ceil(h) };
  });
}

// A starting point from the product sizes the customer entered: weight is the sum plus a little for the box, length and width are the largest
// item, height is the items stacked. Whatever is unknown is left empty and named, so the customer fills it in. It is only a suggestion.
export async function suggest(d: CsBuyDeps, input: { order_id?: unknown }) {
  const o = await myOrder(d, input.order_id);
  const items = await d.items(o.id);
  const missing = items.filter((i) => !(i.weight_g && i.length_cm && i.width_cm && i.height_cm)).map((i) => i.sku);
  const known = items.filter((i) => i.weight_g && i.length_cm && i.width_cm && i.height_cm);
  if (!known.length || missing.length) return { parcel: known.length ? sum(known) : { weight_kg: null, length_cm: null, width_cm: null, height_cm: null }, missing, note: missing.length ? 'Some products have no size yet, so this is only a start. Check it, and fill in the missing numbers.' : '' };
  return { parcel: sum(known), missing: [], note: 'Estimated from your product sizes. Weigh and measure the packed parcel and correct it if needed: the real parcel is checked when we pack.' };
}
function sum(items: Item[]) {
  const g = items.reduce((t, i) => t + Number(i.weight_g) * i.qty, 0) + 150;
  return { weight_kg: Math.round(g / 10) / 100, length_cm: Math.ceil(Math.max(...items.map((i) => Number(i.length_cm)))), width_cm: Math.ceil(Math.max(...items.map((i) => Number(i.width_cm)))), height_cm: Math.ceil(items.reduce((t, i) => t + Number(i.height_cm) * i.qty, 0)) };
}

// ---------- prices ----------
export async function quote(d: CsBuyDeps, input: { order_id?: unknown; parcels?: unknown }) {
  const { o, r } = await buyableOrder(d, input.order_id);
  const parcels = cleanParcels(input.parcels);
  let raw: unknown;
  try { raw = await d.api.quote(buildPackage(o, parcels), { carriers: carriersFrom(d.getenv) } as never); }
  catch (e) { throw new CsError(problemText(e), 422); }
  const offers = parseQuotes(raw).map((q) => {
    const tooBig = q.available && q.cost_gross > r.maxLabel;
    return { service_id: q.service_id, carrier: q.carrier, name: q.name, available: q.available && !tooBig, reason: tooBig ? 'Above the limit for a single label' : q.reason,
      bill_net: q.available ? customerNet(q.cost_net, r.markup) : 0, bill_gross: q.available ? customerGross(q.cost_net, r.markup, q.tax) : 0, tax: q.tax };
  });
  return { env: d.furgonetkaEnv, enabled: d.getenv('SHIPPING_ENABLED') === 'true', offers };
}
// The same explanation the admin sees (Furgonetka's own words and which fields it objects to). It never contains our cost, balance or limits.
export function problemText(e: unknown): string {
  const m = (e as Error).message || 'The carriers could not price this parcel.';
  if (/not set up|Missing server settings/i.test(m)) return 'Shipping is not available right now. Please contact us.';
  if (e instanceof FurgonetkaError) { const detail = fieldErrors(e.payload); return `${m}${detail.length ? ' (' + detail.slice(0, 4).join('; ') + ')' : ''}`; }
  return m;
}

// ---------- the purchase ----------
export const SAFE = (m: string, status: number): { message: string; status: number } => {
  if (/not set up|Missing server settings/i.test(m)) return { message: 'Shipping is not available right now. Nothing was charged. Please contact us.', status: 503 };
  if (/not enough balance|Could not read the Furgonetka balance/i.test(m)) return { message: 'We cannot create this label right now. Nothing was charged. Please try again later or contact us.', status: 503 };
  if (/daily limit|budget/i.test(m)) return { message: 'The shipping budget for today is used up. Nothing was charged. Please try again tomorrow or contact us.', status: 403 };
  if (/switched off/i.test(m)) return { message: 'Buying a label with 2ACE is not open yet.', status: 403 };
  if (/limit per label/i.test(m)) return { message: 'This label is above the limit for a single label. Please contact us.', status: 403 };
  if (/not confirmed|Lost the connection|may have been charged/i.test(m)) return { message: 'We are checking this label with the carrier. Please do not buy it again: we will update your order shortly.', status: 202 };
  if (/was bought, but saving it failed/i.test(m)) return { message: 'Your label was bought but we could not finish recording it. Please do not buy again: 2ACE has been alerted.', status: 500 };
  if (status === 409 || status === 403 || status === 400) return { message: m, status };
  return { message: 'The carrier did not accept this shipment, so nothing was charged. ' + m.replace(/^Furgonetka (rejected the shipment|did not order it): ?/i, ''), status: 422 };
};

export async function buy(d: CsBuyDeps, input: { order_id?: unknown; service_id?: unknown; parcels?: unknown; expected_bill_net?: unknown }) {
  const { o, r } = await buyableOrder(d, input.order_id);
  return await purchase(d, r, { order: o, parcels: cleanParcels(input.parcels), serviceId: Number(input.service_id), expected: Number(input.expected_bill_net), beginRpc: 'cs_begin_shipment', subject: { p_order: o.id }, finishRpc: 'cs_finish_shipment' });
}

// One purchase, for an outgoing order or for a return: the same guards, the same order of events, the same words to the customer.
export type Purchase = { order: OrderShip; parcels: ParcelRow[]; serviceId: number; expected: number; beginRpc: string; subject: Record<string, string>; finishRpc: string; build?: (parcels: ParcelRow[], serviceId?: number) => unknown };
export async function purchase(d: CsBuyDeps, r: { markup: number; maxLabel: number }, p: Purchase) {
  const { serviceId, expected, parcels } = p;
  if (!Number.isInteger(serviceId) || serviceId <= 0) throw new CsError('Choose a carrier.');
  if (!(expected > 0)) throw new CsError('Confirm the price first.');
  const globalCap = settingNum(d.getenv, 'SHIPPING_DAILY_CAP_PLN', 500, 0, 100000);
  const deps: BuyDeps = {
    env: d.furgonetkaEnv, api: d.api,
    settings: { enabled: d.getenv('SHIPPING_ENABLED') === 'true', maxLabel: r.maxLabel, dailyCap: settingNum(d.getenv, 'CUSTOMER_DAILY_CAP_PLN', DEFAULT_CUSTOMER_DAILY_POOL_PLN, 0, 100000), markupPct: r.markup },
    spentToday: () => d.spentToday('customers'),
    begin: async ({ serviceId: sid, quote: q, markupPct }) => {
      const bill = customerNet(q.cost_net, markupPct);
      if (bill > round2(expected) + 0.004) throw new ShipError(`The price changed to ${pln(bill)} + VAT. Please check the new price and confirm again.`, 409);
      if ((await d.spentToday('all')) + q.cost_gross > globalCap) throw new ShipError('The shipping budget for today is used up.', 403);
      const res = await d.rpc(p.beginRpc, { p_org: d.orgId, ...p.subject, p_actor: d.userId, p_env: d.furgonetkaEnv, p_service_id: sid, p_carrier: q.carrier, p_service_name: q.name, p_cost_net: q.cost_net, p_cost_gross: q.cost_gross, p_tax: q.tax, p_markup: markupPct, p_parcels: parcels });
      if (res.error) throw new ShipError(res.error.message, 409);
      const row = res.data as { id: string; order_uuid: string }; return { id: row.id, order_uuid: row.order_uuid };
    },
    fail: async (id, message) => { await d.rpc('cs_fail_shipment', { p_id: id, p_error: message, p_actor: d.userId }); },
    savePackageId: async (id, pkg) => { await d.rpc('cs_save_package', { p_id: id, p_package_id: pkg }); },
    finish: async (id, pkg, tracking) => {
      const res = await d.rpc(p.finishRpc, { p_id: id, p_package_id: pkg, p_tracking: tracking, p_actor: d.userId });
      if (res.error) throw new Error(res.error.message);
      const s = res.data as { carrier: string; tracking_numbers: string[]; cost_gross: number; bill_net: number; bill_gross: number };
      return { carrier: s.carrier, tracking_numbers: s.tracking_numbers ?? [], cost_gross: Number(s.cost_gross), bill_net: Number(s.bill_net), bill_gross: Number(s.bill_gross) };
    },
    alert: (s, h) => d.alert(s, h),
    audit: async () => { /* the database functions write the audit rows */ },
  };
  try {
    const out = await buyLabel(deps, { order: p.order, parcels, serviceId, role: 'customer', confirmOverLimit: false, build: p.build });
    return { ok: true, shipment: { carrier: out.shipment.carrier, tracking_numbers: out.shipment.tracking_numbers, bill_net: out.shipment.bill_net, bill_gross: out.shipment.bill_gross } };
  } catch (e) {
    if (e instanceof CsError) throw e;
    const m = e instanceof ShipError ? SAFE(e.message, e.status) : { message: 'Something went wrong. Nothing was charged. Please try again.', status: 500 };
    if (m.status === 202) return { ok: false, pending: true, message: m.message };
    throw new CsError(m.message, m.status);
  }
}

// The label PDF of an order the customer bought a label for. The carrier service needs a little while to produce it: until then the answer is "not ready", not an error.
export async function labelFile(d: CsBuyDeps, input: { order_id?: unknown }) {
  const o = await myOrder(d, input.order_id);
  const s = await d.shipment?.(o.id);
  if (!s || s.status !== 'purchased' || !s.package_id) throw new CsError('There is no label for this order yet.', 404);
  const url = await d.labelUrl(d.orgId, o.id, s.package_id);
  return url ? { url } : { pending: true, message: 'The carrier is still preparing the label file. Nothing is wrong. Try again in a minute.' };
}

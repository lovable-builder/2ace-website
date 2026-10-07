// Returns, from the customer's side: price and buy the return label (the buyer is the sender, our warehouse the receiver), and download it.
// Same guards, caps and words as outgoing labels (customerBuy.ts); the return itself is announced through the create_return database function.
import { CsError, isUuid } from './customerShipping.ts';
import { purchase, ready, problemText, cleanParcels, type CsBuyDeps } from './customerBuy.ts';
import { buildReturnPackage, parseQuotes, customerNet, customerGross, carriersFrom, type ReturnShip, type ParcelRow } from './shipping.ts';

export type ReturnRow = ReturnShip & { id: string; org_id: string; status: string };
export interface CsReturnDeps extends CsBuyDeps {
  returnShip(id: string): Promise<ReturnRow | null>;
  returnShipment(returnId: string): Promise<{ status: string; carrier: string | null; service_name: string | null; tracking_numbers: string[]; bill_net: number; bill_gross: number; package_id: string | null } | null>;
}

async function myReturn(d: CsReturnDeps, id: unknown) {
  if (!isUuid(id)) throw new CsError('Invalid return');
  const r = await d.returnShip(id);
  if (!r || r.org_id !== d.orgId) throw new CsError('Return not found', 404);              // another company's return looks exactly like a missing one
  return r;
}
async function buyableReturn(d: CsReturnDeps, id: unknown) {
  const rd = await ready(d, false);                                                        // a return label needs no Fulfilment plan, only that buying is open for this customer
  if (!rd.ok) throw new CsError(rd.reason, rd.status);
  const r = await myReturn(d, id);
  if (r.status !== 'announced') throw new CsError(`A return label can be bought for a return that has not been sent yet (this one is ${r.status}).`, 409);
  return { r, rd };
}
const oneParcel = (input: unknown): ParcelRow[] => { const p = cleanParcels(input); if (p.length !== 1) throw new CsError('A return is sent as one parcel.'); return p; };

export async function returnQuote(d: CsReturnDeps, input: { return_id?: unknown; parcels?: unknown }) {
  const { r, rd } = await buyableReturn(d, input.return_id);
  const parcels = oneParcel(input.parcels);
  let raw: unknown;
  try { raw = await d.api.quote(buildReturnPackage(r, parcels), { carriers: carriersFrom(d.getenv) } as never); }
  catch (e) { throw new CsError(problemText(e), 422); }
  const offers = parseQuotes(raw).map((q) => {
    const tooBig = q.available && q.cost_gross > rd.maxLabel;
    return { service_id: q.service_id, carrier: q.carrier, name: q.name, available: q.available && !tooBig, reason: tooBig ? 'Above the limit for a single label' : q.reason,
      bill_net: q.available ? customerNet(q.cost_net, rd.markup) : 0, bill_gross: q.available ? customerGross(q.cost_net, rd.markup, q.tax) : 0, tax: q.tax };
  });
  return { env: d.furgonetkaEnv, enabled: d.getenv('SHIPPING_ENABLED') === 'true', offers };
}

export async function returnBuy(d: CsReturnDeps, input: { return_id?: unknown; service_id?: unknown; parcels?: unknown; expected_bill_net?: unknown }) {
  const { r, rd } = await buyableReturn(d, input.return_id);
  const parcels = oneParcel(input.parcels);
  return await purchase(d, rd, { order: { ref: r.ref, ship_name: r.buyer_name, ship_line1: r.buyer_line1, ship_postal: r.buyer_postal, ship_city: r.buyer_city, ship_country: r.buyer_country }, parcels, serviceId: Number(input.service_id), expected: Number(input.expected_bill_net),
    beginRpc: 'cs_begin_return_shipment', subject: { p_return: r.id }, finishRpc: 'cs_finish_return_shipment', build: (p, sid) => buildReturnPackage(r, p, sid) });
}

export async function returnLabel(d: CsReturnDeps, input: { return_id?: unknown }) {
  const r = await myReturn(d, input.return_id);
  const s = await d.returnShipment(r.id);
  if (!s || s.status !== 'purchased' || !s.package_id) throw new CsError('There is no return label for this return yet.', 404);
  const url = await d.labelUrl(d.orgId, r.id, s.package_id);
  return url ? { url } : { pending: true, message: 'The carrier is still preparing the label file. Nothing is wrong. Try again in a minute.' };
}

// What the customer sees of a return's label: their own price and the tracking, never our cost or markup.
export async function returnStatus(d: CsReturnDeps, input: { return_id?: unknown }) {
  const r = await myReturn(d, input.return_id);
  const s = await d.returnShipment(r.id);
  return { return: { id: r.id, ref: r.ref, status: r.status }, label: s && (s.status === 'purchased' || s.status === 'buying') ? { state: s.status, carrier: s.carrier, service: s.service_name, tracking_numbers: s.tracking_numbers ?? [], bill_net: Number(s.bill_net), bill_gross: Number(s.bill_gross) } : null };
}

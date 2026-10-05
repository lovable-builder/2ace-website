// The label purchase, as one function with everything it touches passed in, so each failure branch can be tested without a network.
// Order of events (nothing can spend money before the guards pass, and a record exists before the money moves):
//   fresh price for exactly this service -> balance / limits / kill switch -> 'buying' row -> Furgonetka dry run -> create (no charge)
//   -> order (THE CHARGE) -> tracking -> 'purchased' row, stock out, order shipped.
import { FurgonetkaError, OrderPending, fieldErrors } from './furgonetka.ts';
import { buildPackage, parseQuotes, spendCheck, extractTracking, type OrderShip, type ParcelRow, type Quote } from './shipping.ts';

export class ShipError extends Error { constructor(m: string, public status = 400) { super(m); } }

export interface BuyDeps {
  env: string;
  api: {
    quote(pkg: unknown, scope: { serviceIds?: number[] }): Promise<unknown>;
    balance(): Promise<unknown>;
    validate(pkg: unknown): Promise<{ ok: boolean; errors: string[] }>;
    createPackage(pkg: unknown): Promise<Record<string, unknown>>;
    orderAndWait(ids: string[], uuid: string): Promise<{ status: string; orderedIds: string[]; errors: string[] }>;
    fetchPackage(id: string): Promise<Record<string, unknown>>;
  };
  settings: { enabled: boolean; maxLabel: number; dailyCap: number; markupPct: number };
  spentToday(): Promise<number>;
  begin(a: { serviceId: number; quote: Quote; markupPct: number }): Promise<{ id: string; order_uuid: string }>;
  fail(shipmentId: string, message: string): Promise<void>;
  savePackageId(shipmentId: string, packageId: string): Promise<void>;
  finish(shipmentId: string, packageId: string, tracking: string[]): Promise<{ carrier: string; tracking_numbers: string[]; cost_gross: number; bill_net: number; bill_gross: number }>;
  alert(subject: string, html: string): Promise<void>;
  audit(action: string, shipmentId: string, payload: Record<string, unknown>): Promise<void>;
}
export type BuyInput = { order: OrderShip; parcels: ParcelRow[]; serviceId: number; role: string; confirmOverLimit: boolean };

const withDetail = (e: FurgonetkaError) => { const d = fieldErrors(e.payload); return `${e.message}${d.length ? ' (' + d.slice(0, 4).join('; ') + ')' : ''}`; };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export async function buyLabel(d: BuyDeps, i: BuyInput) {
  // 1. the price, asked again for exactly this service (the browser's price is never trusted)
  let quote: Quote | undefined;
  try { quote = parseQuotes(await d.api.quote(buildPackage(i.order, i.parcels), { serviceIds: [i.serviceId] })).find((q) => q.service_id === i.serviceId); }
  catch (e) { throw new ShipError(e instanceof FurgonetkaError ? withDetail(e) : (e as Error).message, 502); }
  if (!quote || !quote.available) throw new ShipError(`This service is not available for this parcel${quote?.reason ? ': ' + quote.reason : ''}`);
  // 2. the guards
  let balance: number | null = null;
  try { const b = await d.api.balance() as { balance?: unknown }; balance = typeof b.balance === 'number' ? b.balance : null; }
  catch (e) { throw new ShipError(e instanceof FurgonetkaError ? withDetail(e) : (e as Error).message, 502); }
  const refusal = spendCheck({ enabled: d.settings.enabled, role: i.role, costGross: quote.cost_gross, balance, maxLabel: d.settings.maxLabel, dailyCap: d.settings.dailyCap, spentToday: await d.spentToday(), overLimitConfirmed: i.confirmOverLimit });
  if (refusal) throw new ShipError(refusal, 403);
  // 3. the record, before any money moves
  let sh: { id: string; order_uuid: string };
  try { sh = await d.begin({ serviceId: i.serviceId, quote, markupPct: d.settings.markupPct }); } catch (e) { throw new ShipError((e as Error).message); }
  const close = async (m: string, status: number) => { try { await d.fail(sh.id, m); } catch (_e) { /* the row stays 'buying' and shows up for a recheck */ } return new ShipError(m, status); };
  // 4. dry run, then create in Furgonetka's cart. Neither charges, so any failure here closes the row.
  let packageId = '';
  try {
    const pkg = buildPackage(i.order, i.parcels, i.serviceId);
    const v = await d.api.validate(pkg);
    if (!v.ok) throw await close('Furgonetka rejected the shipment: ' + v.errors.slice(0, 5).join('; '), 422);
    const created = await d.api.createPackage(pkg);
    packageId = String(created.package_id ?? created.id ?? '');
    if (!/^\d+$/.test(packageId)) throw await close('Furgonetka did not return a package id', 502);
  } catch (e) {
    if (e instanceof ShipError) throw e;
    throw await close(e instanceof FurgonetkaError ? withDetail(e) : (e as Error).message, 502);
  }
  await d.savePackageId(sh.id, packageId);                                  // remembered at once, so a crash can be reconciled
  // 5. the charge
  try {
    const v = await d.api.orderAndWait([packageId], sh.order_uuid);
    if (!v.orderedIds.includes(packageId)) throw await close('The carrier refused the order' + (v.errors.length ? ': ' + v.errors.slice(0, 4).join('; ') : ''), 422);
  } catch (e) {
    if (e instanceof ShipError) throw e;
    if (e instanceof FurgonetkaError) throw await close(withDetail(e), 502);          // Furgonetka answered with a refusal: nothing was charged
    // no verdict (timeout or network): we do NOT know whether money was spent, so the row stays open and a person checks it
    await d.audit('shipping.unconfirmed', sh.id, { order: i.order.ref, package: packageId });
    await d.alert('A shipping label order needs checking', `<p>Order <b>${esc(i.order.ref)}</b>: Furgonetka did not confirm the order (package <b>${esc(packageId)}</b>). It may or may not have been charged.</p><p>Open the order in the admin panel and press <b>Check the label order</b>. Do not buy again until it says what happened.</p>`);
    throw new ShipError(e instanceof OrderPending ? 'Furgonetka has not confirmed the order yet. It may have been charged. Open the order and use "Check the label order" in a minute; do not buy again.' : 'Lost the connection to Furgonetka. It may have been charged. Open the order and use "Check the label order"; do not buy again.', 504);
  }
  // 6. the books
  let tracking: string[] = [];
  try { tracking = extractTracking(await d.api.fetchPackage(packageId)); } catch (_e) { /* tracking can be read later; the label is bought */ }
  let done;
  for (let n = 0; n < 2 && !done; n++) { try { done = await d.finish(sh.id, packageId, tracking); } catch (e) { if (n === 1) {
    await d.alert('A shipping label was bought but not recorded', `<p>Order <b>${esc(i.order.ref)}</b>: the label (package <b>${esc(packageId)}</b>) was bought, but saving it failed: ${esc((e as Error).message)}.</p><p>Open the order and press <b>Check the label order</b> to finish recording it.</p>`);
    throw new ShipError('The label was bought, but saving it failed. Press "Check the label order" on the order to finish. Do not buy again.', 500);
  } } }
  return { ok: true, shipment: { carrier: done!.carrier, tracking_numbers: done!.tracking_numbers, cost_gross: Number(done!.cost_gross), bill_net: Number(done!.bill_net), bill_gross: Number(done!.bill_gross) } };
}

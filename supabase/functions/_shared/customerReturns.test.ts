// deno test supabase/functions/_shared/customerReturns.test.ts
import { returnBuy, returnLabel, returnQuote, returnStatus, type CsReturnDeps, type ReturnRow } from './customerReturns.ts';
import { buildReturnPackage, SENDER } from './shipping.ts';
import { CsError } from './customerShipping.ts';
import { OrderPending } from './furgonetka.ts';

const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const ORG = '11111111-1111-1111-1111-111111111111', RID = '44444444-4444-4444-4444-444444444444', USER = '33333333-3333-3333-3333-333333333333';
const ret: ReturnRow = { id: RID, org_id: ORG, ref: 'RET-000005', status: 'announced', buyer_name: 'Anna Nowak', buyer_company: null, buyer_line1: 'Lipowa 5', buyer_line2: '2', buyer_postal: '31-000', buyer_city: 'Krakow', buyer_country: 'PL', buyer_email: 'anna@example.pl', buyer_phone: '+48 600 100 200' };
const P = [{ weight_kg: 0.9, length_cm: 30, width_cm: 20, height_cm: 10 }];
const offers = () => ({ services_prices: [{ service_id: 7, service: 'dpd', available: true, pricing: { price_net: 10, price_gross: 12.3, tax: 23 }, shipment_type: 'package', delivery_type: 'door' }, { service_id: 9, service: 'inpost', available: true, pricing: { price_net: 8, price_gross: 9.84, tax: 23 }, shipment_type: 'package', delivery_type: 'locker' }] });
function rig(o: { env?: Record<string, string>; mode?: string; role?: string; ret?: ReturnRow | null; settings?: unknown; shipment?: unknown; labelUrl?: string | null; quote?: unknown } = {}) {
  const rpcs: [string, Record<string, unknown>][] = []; const sent: unknown[] = []; const log: string[] = [];
  const envv = { CUSTOMER_LABELS_ENABLED: 'true', SHIPPING_ENABLED: 'true', ...(o.env ?? {}) } as Record<string, string>;
  const d: CsReturnDeps = {
    orgId: ORG, role: o.role ?? 'owner', userId: USER, getenv: (k) => envv[k], furgonetkaEnv: 'sandbox', getOrder: async () => null, orderShip: async () => null, mode: async () => o.mode ?? 'storage', orgStatus: async () => 'active',
    orgSettings: async () => (o.settings === undefined ? { label_buying_enabled: true, markup_percent: null, max_label_net: null } : o.settings) as never, items: async () => [], spentToday: async () => 0,
    api: { quote: async (p) => { sent.push(p); log.push('quote'); return o.quote ?? offers(); }, balance: async () => ({ balance: 500 }), validate: async (p) => { sent.push(p); log.push('validate'); return { ok: true, errors: [] }; }, createPackage: async () => { log.push('create'); return { package_id: 555 }; }, orderAndWait: async () => { log.push('order'); return { status: 'successful', orderedIds: ['555'], errors: [] }; }, fetchPackage: async () => ({ parcels: [{ package_no: 'WB1' }] }) },
    alert: async () => {}, shipment: async () => null, labelUrl: async () => (o.labelUrl === undefined ? 'https://x/ret.pdf' : o.labelUrl), download: async () => null, removeFile: async () => {}, ownLabel: async () => null,
    returnShip: async () => (o.ret === undefined ? ret : o.ret), returnShipment: async () => (o.shipment === undefined ? null : o.shipment) as never,
    rpc: async (name, args) => { rpcs.push([name, args]); if (name === 'cs_begin_return_shipment') return { data: { id: 'sh-1', order_uuid: 'u-1' }, error: null }; if (name === 'cs_finish_return_shipment') return { data: { carrier: 'dpd', tracking_numbers: ['WB1'], cost_gross: 12.3, bill_net: 13, bill_gross: 15.99 }, error: null }; return { data: null, error: null }; },
  };
  return { d, rpcs, sent, log };
}
const refuses = async (f: () => Promise<unknown>, status: number, re: RegExp) => { try { await f(); } catch (e) { ok(e instanceof CsError && e.status === status && re.test(e.message), `expected ${status} ${re}, got ${(e as Error).message}`); return; } throw new Error('should have been refused'); };

Deno.test('the return package: the buyer is the sender, our warehouse is the receiver, the reference and parcel are right', () => {
  const p = buildReturnPackage(ret, [{ weight_g: 900, length_cm: 30, width_cm: 20.2, height_cm: 10 }], 7) as Record<string, any>;
  eq(p.service_id, 7, 'service'); eq(p.receiver, { ...SENDER }, 'our warehouse receives'); eq(p.user_reference_number, 'RET-000005', 'reference');
  eq(p.pickup, { name: 'Anna Nowak', street: 'Lipowa 5 2', postcode: '31-000', city: 'Krakow', country_code: 'PL', email: 'anna@example.pl', phone: '600100200' }, 'the buyer picks up from their own address, phone cleaned');
  eq(p.parcels[0], { type: 'package', width: 21, depth: 30, height: 10, weight: 0.9, description: 'Returned goods' }, 'parcel');
  ok(!('service_id' in (buildReturnPackage(ret, [{ weight_g: 900, length_cm: 30, width_cm: 20, height_cm: 10 }]) as object)), 'no service when only pricing');
});
Deno.test('the return package refuses what a carrier would refuse: one-word names, bad phones, no parcel', () => {
  for (const [r, parcels, re] of [[{ ...ret, buyer_name: 'Anna' }, [{ weight_g: 1, length_cm: 1, width_cm: 1, height_cm: 1 }], /first name and a surname/], [{ ...ret, buyer_phone: '12' }, [{ weight_g: 1, length_cm: 1, width_cm: 1, height_cm: 1 }], /9 digits/], [ret, [], /no parcel/]] as const) {
    try { buildReturnPackage(r, parcels as never); throw new Error('should refuse'); } catch (e) { ok(re.test((e as Error).message), (e as Error).message); }
  }
});
Deno.test('quote: the customer sees their price (markup in), no lockers, no cost, and it needs no Fulfilment plan', async () => {
  const r = rig({ mode: 'storage' }); const q = await returnQuote(r.d, { return_id: RID, parcels: P });
  const dpd = q.offers.find((x) => x.service_id === 7)!; eq([dpd.bill_net, dpd.bill_gross, dpd.available], [13, 15.99, true], 'price'); ok(q.offers.find((x) => x.service_id === 9)!.available === false, 'locker not offered'); ok(!JSON.stringify(q).match(/cost|markup|margin|balance/i), 'nothing of ours');
  const sent = r.sent[0] as { pickup: { name: string }; receiver: { company: string } }; ok(sent.pickup.name === 'Anna Nowak' && sent.receiver.company === SENDER.company, 'the quote is for a return, not an outgoing parcel');
});
Deno.test('quote and buy: guards first', async () => {
  for (const f of [(d: CsReturnDeps) => returnQuote(d, { return_id: RID, parcels: P }), (d: CsReturnDeps) => returnBuy(d, { return_id: RID, service_id: 7, parcels: P, expected_bill_net: 13 })]) {
    await refuses(() => f(rig({ env: { CUSTOMER_LABELS_ENABLED: '' } }).d), 403, /not open yet/);
    await refuses(() => f(rig({ role: 'finance' }).d), 403, /role/);
    await refuses(() => f(rig({ settings: { label_buying_enabled: false, markup_percent: null, max_label_net: null } }).d), 403, /not switched on/);
    await refuses(() => f(rig({ ret: { ...ret, org_id: 'other' } }).d), 404, /not found/);
    await refuses(() => f(rig({ ret: null }).d), 404, /not found/);
    await refuses(() => f(rig({ ret: { ...ret, status: 'label_issued' } }).d), 409, /not been sent yet/);
    await refuses(() => f(rig({ ret: { ...ret, status: 'cancelled' } }).d), 409, /cancelled/);
  }
  await refuses(() => returnQuote(rig().d, { return_id: 'nope', parcels: P }), 400, /Invalid return/);
  await refuses(() => returnQuote(rig().d, { return_id: RID, parcels: [P[0], P[0]] }), 400, /one parcel/);
  await refuses(() => returnQuote(rig().d, { return_id: RID, parcels: [] }), 400, /1 to 3 parcels/);
});
Deno.test('buy: records the return label for the return, with the buyer as sender, and the answer has no cost', async () => {
  const r = rig(); const out = await returnBuy(r.d, { return_id: RID, service_id: 7, parcels: P, expected_bill_net: 13 });
  eq(out, { ok: true, shipment: { carrier: 'dpd', tracking_numbers: ['WB1'], bill_net: 13, bill_gross: 15.99 } }, 'result'); eq(r.log, ['quote', 'validate', 'create', 'order'], 'steps');
  const b = r.rpcs.find(([n]) => n === 'cs_begin_return_shipment')![1]; eq([b.p_org, b.p_return, b.p_actor, b.p_service_id, b.p_markup, b.p_parcels], [ORG, RID, USER, 7, 30, [{ weight_g: 900, length_cm: 30, width_cm: 20, height_cm: 10 }]], 'begun for the return');
  ok(!('p_order' in b), 'not an order'); ok(r.rpcs.some(([n]) => n === 'cs_finish_return_shipment'), 'finished as a return label');
  const pkgs = r.sent.filter((x) => (x as { pickup?: unknown }).pickup) as { pickup: { name: string }; receiver: { company: string } }[]; ok(pkgs.length >= 2 && pkgs.every((p) => p.pickup.name === 'Anna Nowak' && p.receiver.company === SENDER.company), 'every package sent to the carrier service is a return');
  ok(!JSON.stringify(out).match(/cost|markup/i), 'no cost');
});
Deno.test('buy: a price that went up is refused before any money moves; an unknown outcome says not to buy again', async () => {
  const up = rig({ quote: { services_prices: [{ service_id: 7, service: 'dpd', available: true, pricing: { price_net: 12, price_gross: 14.76, tax: 23 }, shipment_type: 'package', delivery_type: 'door' }] } });
  await refuses(() => returnBuy(up.d, { return_id: RID, service_id: 7, parcels: P, expected_bill_net: 13 }), 409, /price changed to 15,60 zł/); ok(!up.log.includes('order') && !up.log.includes('create'), 'no money');
  const r = rig(); r.d.api.orderAndWait = async () => { throw new OrderPending('u', 'x'); }; const out = await returnBuy(r.d, { return_id: RID, service_id: 7, parcels: P, expected_bill_net: 13 }) as { ok: boolean; pending?: boolean; message?: string }; ok(out.pending === true && /do not buy it again/.test(out.message ?? ''), 'pending');
});
Deno.test('label and status: only the customer\'s own, calm when not ready', async () => {
  const bought = { status: 'purchased', carrier: 'dpd', service_name: 'DPD', tracking_numbers: ['WB1'], bill_net: 13, bill_gross: 15.99, package_id: '555' };
  eq(await returnLabel(rig({ shipment: bought }).d, { return_id: RID }), { url: 'https://x/ret.pdf' }, 'url');
  const p = await returnLabel(rig({ shipment: bought, labelUrl: null }).d, { return_id: RID }) as { pending?: boolean }; ok(p.pending === true, 'pending');
  await refuses(() => returnLabel(rig().d, { return_id: RID }), 404, /no return label/); await refuses(() => returnLabel(rig({ shipment: bought, ret: { ...ret, org_id: 'x' } }).d, { return_id: RID }), 404, /not found/);
  const s = await returnStatus(rig({ shipment: bought }).d, { return_id: RID }); eq(s.label, { state: 'purchased', carrier: 'dpd', service: 'DPD', tracking_numbers: ['WB1'], bill_net: 13, bill_gross: 15.99 }, 'label'); ok(!JSON.stringify(s).match(/cost|markup/i), 'no cost');
  eq((await returnStatus(rig({ shipment: { ...bought, status: 'failed' } }).d, { return_id: RID })).label, null, 'a failed attempt is not shown as a label');
});

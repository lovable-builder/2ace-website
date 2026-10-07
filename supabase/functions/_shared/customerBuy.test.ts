// deno test supabase/functions/_shared/customerBuy.test.ts
import { buy, capabilitiesBuy, cleanParcels, labelFile, quote, suggest, type CsBuyDeps, type Item } from './customerBuy.ts';
import { CsError } from './customerShipping.ts';
import { FurgonetkaError, OrderPending } from './furgonetka.ts';

const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const ORG = '11111111-1111-1111-1111-111111111111', OID = '22222222-2222-2222-2222-222222222222', USER = '33333333-3333-3333-3333-333333333333';
const order = { id: OID, org_id: ORG, ref: 'ORD-000042', status: 'allocated', ship_name: 'Jan Kowalski', ship_line1: 'Prosta 1', ship_postal: '00-001', ship_city: 'Warszawa', ship_country: 'PL', ship_email: 'j@x.pl', ship_phone: '600100200' };
const PARCELS = [{ weight_kg: 1.8, length_cm: 30, width_cm: 20, height_cm: 15 }];
const offers = (over: Record<string, unknown>[] = []) => ({ services_prices: [{ service_id: 7, service: 'dpd', available: true, pricing: { price_net: 10, price_gross: 12.3, tax: 23 }, shipment_type: 'package', delivery_type: 'door', ...(over[0] ?? {}) },
  { service_id: 9, service: 'inpost', available: true, pricing: { price_net: 8, price_gross: 9.84, tax: 23 }, shipment_type: 'package', delivery_type: 'locker' }, { service_id: 11, service: 'ups', available: true, pricing: { price_net: 60, price_gross: 73.8, tax: 23 }, shipment_type: 'package', delivery_type: 'door' }] });

function rig(o: { env?: Record<string, string>; role?: string; mode?: string; orgStatus?: string; settings?: unknown; order?: unknown; items?: Item[]; spentAll?: number; spentCustomers?: number; quote?: unknown; balance?: unknown; api?: Partial<CsBuyDeps['api']>; begin?: { error?: string }; labelUrl?: string | null; shipment?: unknown } = {}) {
  const log: string[] = []; const rpcs: [string, Record<string, unknown>][] = []; const alerts: string[] = [];
  const envv: Record<string, string> = { CUSTOMER_LABELS_ENABLED: 'true', SHIPPING_ENABLED: 'true', ...(o.env ?? {}) };
  const d: CsBuyDeps = {
    orgId: ORG, role: o.role ?? 'owner', userId: USER, getenv: (k) => envv[k], furgonetkaEnv: 'sandbox',
    getOrder: async () => null, orderShip: async () => (o.order === undefined ? order : o.order) as never, mode: async () => o.mode ?? 'payg', orgStatus: async () => o.orgStatus ?? 'active',
    orgSettings: async () => (o.settings === undefined ? { label_buying_enabled: true, markup_percent: null, max_label_net: null } : o.settings) as never,
    items: async () => o.items ?? [{ sku: 'MUG', name: 'Mug', qty: 4, weight_g: 400, length_cm: 12, width_cm: 10, height_cm: 9 }],
    spentToday: async (scope) => (scope === 'all' ? o.spentAll ?? 0 : o.spentCustomers ?? 0),
    api: { quote: async (_p, s) => { log.push('quote'); return o.quote ?? offers(); }, balance: async () => { log.push('balance'); return o.balance ?? { balance: 500 }; }, validate: async () => { log.push('validate'); return { ok: true, errors: [] }; },
      createPackage: async () => { log.push('create'); return { package_id: 555 }; }, orderAndWait: async () => { log.push('order'); return { status: 'successful', orderedIds: ['555'], errors: [] }; }, fetchPackage: async () => ({ parcels: [{ package_no: 'WB1' }] }), ...(o.api ?? {}) },
    alert: async (s) => { alerts.push(s); },
    shipment: async () => (o.shipment === undefined ? null : o.shipment) as never,
    labelUrl: async () => (o.labelUrl === undefined ? 'https://x/label.pdf' : o.labelUrl),
    download: async () => null, removeFile: async () => {}, ownLabel: async () => null,
    rpc: async (name, args) => {
      rpcs.push([name, args]);
      if (name === 'cs_begin_shipment') return o.begin?.error ? { data: null, error: { message: o.begin.error } } : { data: { id: 'sh-1', order_uuid: 'u-1' }, error: null };
      if (name === 'cs_finish_shipment') return { data: { carrier: 'dpd', tracking_numbers: ['WB1'], cost_gross: 12.3, bill_net: 13, bill_gross: 15.99 }, error: null };
      return { data: null, error: null };
    },
  };
  return { d, log, rpcs, alerts };
}
const refuses = async (f: () => Promise<unknown>, status: number, re: RegExp) => { try { await f(); } catch (e) { ok(e instanceof CsError && e.status === status && re.test(e.message), `expected ${status} ${re}, got ${(e as { status?: number }).status ?? ''} ${(e as Error).message}`); return; } throw new Error('should have been refused'); };
const noMoney = (r: ReturnType<typeof rig>) => { ok(!r.log.includes('order') && !r.log.includes('create'), 'MONEY MOVED OR A SHIPMENT WAS CREATED'); ok(!r.rpcs.some(([n]) => n === 'cs_begin_shipment'), 'a record was started'); };

Deno.test('capabilities: buying is offered only when every switch is on', async () => {
  eq((await capabilitiesBuy(rig().d)).buy_label, true, 'all on');
  for (const [name, o] of [['kill switch off', { env: { CUSTOMER_LABELS_ENABLED: 'no' } }], ['not payg', { mode: 'storage' }], ['plan not active', { orgStatus: 'past_due' }], ['customer not enabled', { settings: { label_buying_enabled: false, markup_percent: null, max_label_net: null } }], ['no settings row', { settings: null }], ['wrong role', { role: 'finance' }]] as const) eq((await capabilitiesBuy(rig(o as never).d)).buy_label, false, name);
});
Deno.test('parcels: 1 to 3, weight and sides in range, comma decimals and rounding up', () => {
  eq(cleanParcels([{ weight_kg: '1,8', length_cm: '30.2', width_cm: 20, height_cm: 15 }]), [{ weight_g: 1800, length_cm: 31, width_cm: 20, height_cm: 15 }], 'cleaned');
  for (const bad of [[], 'x', Array(4).fill(PARCELS[0]), [{ ...PARCELS[0], weight_kg: 0 }], [{ ...PARCELS[0], weight_kg: 31 }], [{ ...PARCELS[0], length_cm: 0 }], [{ ...PARCELS[0], height_cm: 151 }], [{ ...PARCELS[0], width_cm: 'abc' }]]) { try { cleanParcels(bad); throw new Error('should refuse ' + JSON.stringify(bad)); } catch (e) { ok(e instanceof CsError, 'a CsError for ' + JSON.stringify(bad)); } }
});
Deno.test('suggest: sizes from the products, a little for the box, unknown sizes are named', async () => {
  const s = await suggest(rig().d, { order_id: OID });
  eq(s.parcel, { weight_kg: 1.75, length_cm: 12, width_cm: 10, height_cm: 36 }, '4 × 400 g + 150 g; 4 × 9 cm stacked'); eq(s.missing, [], 'nothing missing');
  const m = await suggest(rig({ items: [{ sku: 'A', name: 'A', qty: 1, weight_g: 500, length_cm: 10, width_cm: 10, height_cm: 10 }, { sku: 'B', name: 'B', qty: 1, weight_g: null, length_cm: null, width_cm: null, height_cm: null }] }).d, { order_id: OID });
  eq(m.missing, ['B'], 'the product without a size is named'); ok(/only a start/.test(m.note), 'says it is only a start');
  const none = await suggest(rig({ items: [{ sku: 'B', name: 'B', qty: 1, weight_g: null, length_cm: null, width_cm: null, height_cm: null }] }).d, { order_id: OID });
  eq(none.parcel, { weight_kg: null, length_cm: null, width_cm: null, height_cm: null }, 'nothing known: empty fields');
});
Deno.test('quote: the customer sees the price with the markup and nothing else of ours', async () => {
  const r = rig(); const q = await quote(r.d, { order_id: OID, parcels: PARCELS });
  const dpd = q.offers.find((x) => x.service_id === 7)!; eq([dpd.bill_net, dpd.bill_gross, dpd.available], [13, 15.99, true], '10 net + 30% = 13 net, 15,99 gross');
  ok(!JSON.stringify(q).match(/cost|markup|margin|balance/i), 'no cost, markup or balance in the answer');
  ok(q.offers.find((x) => x.service_id === 9)!.available === false, 'locker services are never offered');
  const ups = q.offers.find((x) => x.service_id === 11)!; ok(ups.available === false && /limit/.test(ups.reason ?? ''), 'a label above the per-label limit (60 zł gross) is not offered: ' + ups.reason);
  eq(q.offers[0].service_id, 7, 'cheapest available first');
  const own = await quote(rig({ settings: { label_buying_enabled: true, markup_percent: 50, max_label_net: null } }).d, { order_id: OID, parcels: PARCELS }); eq(own.offers.find((x) => x.service_id === 7)!.bill_net, 15, 'the customer\'s own markup (50%) applies');
});
Deno.test('quote: guards come first', async () => {
  await refuses(() => quote(rig({ env: { CUSTOMER_LABELS_ENABLED: '' } }).d, { order_id: OID, parcels: PARCELS }), 403, /not open yet/);
  await refuses(() => quote(rig({ role: 'finance' }).d, { order_id: OID, parcels: PARCELS }), 403, /role/);
  await refuses(() => quote(rig({ mode: 'storage' }).d, { order_id: OID, parcels: PARCELS }), 403, /as you go/);
  await refuses(() => quote(rig({ order: { ...order, org_id: 'other' } }).d, { order_id: OID, parcels: PARCELS }), 404, /not found/);
  await refuses(() => quote(rig({ order: null }).d, { order_id: OID, parcels: PARCELS }), 404, /not found/);
  await refuses(() => quote(rig({ order: { ...order, status: 'held' } }).d, { order_id: OID, parcels: PARCELS }), 409, /reserved order/);
  await refuses(() => quote(rig({ order: { ...order, status: 'shipped' } }).d, { order_id: OID, parcels: PARCELS }), 409, /shipped/);
  await refuses(() => quote(rig().d, { order_id: 'nope', parcels: PARCELS }), 400, /Invalid order/);
  await refuses(() => quote(rig().d, { order_id: OID, parcels: [] }), 400, /1 to 3 parcels/);
});
Deno.test('quote: a bad receiver name is explained, a carrier failure is calm, setup problems never leak setting names', async () => {
  await refuses(() => quote(rig({ order: { ...order, ship_name: 'Jan' } }).d, { order_id: OID, parcels: PARCELS }), 422, /first name and a surname/);
  await refuses(() => quote(rig({ api: { quote: async () => { throw new FurgonetkaError(500, {}); } } }).d, { order_id: OID, parcels: PARCELS }), 422, /Furgonetka answered 500/);
  await refuses(() => quote(rig({ api: { quote: async () => { throw new Error('Shipping is not set up yet. Missing server settings: FURGONETKA_PASSWORD'); } } }).d, { order_id: OID, parcels: PARCELS }), 422, /not available right now/);
});
Deno.test('buy: the steps run in the safe order, with the customer\'s price and parcels, and the answer has no cost', async () => {
  const r = rig(); const out = await buy(r.d, { order_id: OID, service_id: 7, parcels: PARCELS, expected_bill_net: 13 });
  eq(out, { ok: true, shipment: { carrier: 'dpd', tracking_numbers: ['WB1'], bill_net: 13, bill_gross: 15.99 } }, 'result');
  eq(r.log, ['quote', 'balance', 'validate', 'create', 'order'], 'quote, balance, then the dry run, create and the charge');
  const b = r.rpcs.find(([n]) => n === 'cs_begin_shipment')![1];
  eq([b.p_org, b.p_order, b.p_actor, b.p_env, b.p_service_id, b.p_cost_net, b.p_markup, b.p_parcels], [ORG, OID, USER, 'sandbox', 7, 10, 30, [{ weight_g: 1800, length_cm: 30, width_cm: 20, height_cm: 15 }]], 'recorded for the customer with the right figures');
  ok(r.rpcs.some(([n]) => n === 'cs_finish_shipment') && r.rpcs.some(([n]) => n === 'cs_save_package'), 'finished and package remembered'); ok(!JSON.stringify(out).match(/cost|markup/i), 'no cost in the answer');
});
Deno.test('buy: a price that went up is refused before any money moves, a price that went down is fine', async () => {
  const up = rig({ quote: offers([{ pricing: { price_net: 12, price_gross: 14.76, tax: 23 } }]) });
  await refuses(() => buy(up.d, { order_id: OID, service_id: 7, parcels: PARCELS, expected_bill_net: 13 }), 409, /price changed to 15,60 zł \+ VAT/);
  noMoney(up);
  const down = rig({ quote: offers([{ pricing: { price_net: 8, price_gross: 9.84, tax: 23 } }]) }); const out = await buy(down.d, { order_id: OID, service_id: 7, parcels: PARCELS, expected_bill_net: 13 });
  ok(out.ok, 'bought at the lower price'); eq(out.shipment!.bill_net, 13, 'recorded by the database (stubbed)');
});
Deno.test('buy: every guard refuses before money moves', async () => {
  const cases: [string, Parameters<typeof rig>[0], number, RegExp][] = [
    ['kill switch', { env: { CUSTOMER_LABELS_ENABLED: 'false' } }, 403, /not open yet/], ['not enabled for the customer', { settings: { label_buying_enabled: false, markup_percent: null, max_label_net: null } }, 403, /not switched on/],
    ['plan inactive', { orgStatus: 'past_due' }, 403, /not active/], ['other company\'s order', { order: { ...order, org_id: 'x' } }, 404, /not found/], ['order on hold', { order: { ...order, status: 'held' } }, 409, /reserved/],
    ['SHIPPING_ENABLED off', { env: { SHIPPING_ENABLED: 'no' } }, 403, /not open yet/], ['balance too low', { balance: { balance: 5 } }, 503, /cannot create this label right now/],
    ['customers\' daily pool', { spentCustomers: 140 }, 403, /budget for today/], ['global daily cap', { spentAll: 495 }, 403, /budget for today/],
    ['over the per-label limit', { quote: offers([{ pricing: { price_net: 60, price_gross: 73.8, tax: 23 } }]) }, 403, /limit for a single label/],
    ['the database says no (exposure limit)', { begin: { error: 'Your shipping labels not invoiced yet are 300 zł. This one (13 zł) would pass your limit of 300 zł. Please contact us.' } }, 409, /would pass your limit/],
    ['the database says no (already bought)', { begin: { error: 'A label is already being bought or has been bought for this order' } }, 409, /already being bought/],
  ];
  for (const [name, o, status, re] of cases) { const r = rig(o); try { await buy(r.d, { order_id: OID, service_id: 7, parcels: PARCELS, expected_bill_net: 13 }); throw new Error(name + ': should be refused'); } catch (e) { ok(e instanceof CsError && e.status === status && re.test(e.message), `${name}: got ${(e as Error).message}`); } ok(!r.log.includes('order') && !r.log.includes('create'), name + ': no money moved'); }
});
Deno.test('buy: what a customer reads never mentions our balance, Furgonetka or our limits in złoty', async () => {
  for (const o of [{ balance: { balance: 5 } }, { spentAll: 495 }, { env: { SHIPPING_ENABLED: 'no' } }] as const) { const r = rig(o as never); try { await buy(r.d, { order_id: OID, service_id: 7, parcels: PARCELS, expected_bill_net: 13 }); } catch (e) { ok(!/balance|top up|furgonetka|SHIPPING_|DAILY_CAP|\d+,\d\d zł/i.test((e as Error).message), (e as Error).message); } }
});
Deno.test('buy: a carrier that refuses is explained calmly, the attempt is closed, nothing is charged', async () => {
  const r = rig({ api: { validate: async () => ({ ok: false, errors: ['/receiver/phone: Incorrect phone number'] }) } });
  await refuses(() => buy(r.d, { order_id: OID, service_id: 7, parcels: PARCELS, expected_bill_net: 13 }), 422, /nothing was charged.*\/receiver\/phone/);
  ok(r.rpcs.some(([n]) => n === 'cs_fail_shipment') && !r.log.includes('order'), 'closed as failed, no charge');
  const c = rig({ api: { orderAndWait: async () => ({ status: 'error', orderedIds: [], errors: ['/packages/1: An error occurred while communicating with the carrier API'] }) } });
  await refuses(() => buy(c.d, { order_id: OID, service_id: 7, parcels: PARCELS, expected_bill_net: 13 }), 422, /carrier API/);
});
Deno.test('buy: an unknown outcome tells the customer not to buy again, alerts staff, and is not an error', async () => {
  const r = rig({ api: { orderAndWait: async () => { throw new OrderPending('u', 'waiting'); } } });
  const out = await buy(r.d, { order_id: OID, service_id: 7, parcels: PARCELS, expected_bill_net: 13 }) as { ok: boolean; pending?: boolean; message?: string };
  ok(out.ok === false && out.pending === true && /do not buy it again/.test(out.message ?? ''), JSON.stringify(out)); ok(r.alerts.length === 1, 'staff were alerted'); ok(!r.rpcs.some(([n]) => n === 'cs_fail_shipment'), 'the attempt stays open for staff to check');
});
Deno.test('buy: input is checked', async () => {
  await refuses(() => buy(rig().d, { order_id: OID, service_id: 'x', parcels: PARCELS, expected_bill_net: 13 }), 400, /Choose a carrier/);
  await refuses(() => buy(rig().d, { order_id: OID, service_id: 7, parcels: PARCELS, expected_bill_net: 0 }), 400, /Confirm the price/);
  await refuses(() => buy(rig().d, { order_id: OID, service_id: 7, parcels: [{}], expected_bill_net: 13 }), 400, /weight/);
});
Deno.test('label: the file of a bought label, "not ready" is calm, no label is a 404, someone else\'s order is not found', async () => {
  const bought = { status: 'purchased', carrier: 'dpd', service_name: 'DPD', tracking_numbers: ['WB1'], bill_net: 13, bill_gross: 15.99, package_id: '555', purchased_at: 'x', created_at: 'x', error: null, buyer_role: 'customer' };
  eq(await labelFile(rig({ shipment: bought }).d, { order_id: OID }), { url: 'https://x/label.pdf' }, 'url');
  const p = await labelFile(rig({ shipment: bought, labelUrl: null }).d, { order_id: OID }) as { pending?: boolean; message?: string }; ok(p.pending === true && /Nothing is wrong/.test(p.message ?? ''), 'pending');
  await refuses(() => labelFile(rig().d, { order_id: OID }), 404, /no label/); await refuses(() => labelFile(rig({ shipment: { ...bought, status: 'failed' } }).d, { order_id: OID }), 404, /no label/);
  await refuses(() => labelFile(rig({ shipment: bought, order: { ...order, org_id: 'x' } }).d, { order_id: OID }), 404, /not found/);
});

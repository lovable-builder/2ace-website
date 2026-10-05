// deno test supabase/functions/_shared/shipBuy.test.ts
import { buyLabel, ShipError, type BuyDeps, type BuyInput } from './shipBuy.ts';
import { FurgonetkaError, OrderPending } from './furgonetka.ts';

const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const order = { ref: 'ORD-000001', ship_name: 'Jan Nowak', ship_line1: 'Prosta 1', ship_postal: '00-001', ship_city: 'Warszawa', ship_country: 'PL', ship_email: 'j@x.pl', ship_phone: '600100200' };
const parcels = [{ weight_g: 1800, length_cm: 30, width_cm: 20, height_cm: 15 }];
const input = (o: Partial<BuyInput> = {}): BuyInput => ({ order, parcels, serviceId: 7, role: 'warehouse', confirmOverLimit: false, ...o });
const quoteReply = (gross = 24.6, net = 20, available = true, id = 7) => ({ services_prices: [{ service_id: id, service: 'dpd', available, pricing: { price_net: net, price_gross: gross, tax: 23 }, errors: available ? [] : [{ message: 'Too heavy' }] }] });

// A full set of fakes. `log` records what happened and in which order.
function rig(over: Partial<Omit<BuyDeps, 'api' | 'settings'>> & { api?: Partial<BuyDeps['api']>; quote?: unknown; balance?: unknown; spent?: number; settings?: Partial<BuyDeps['settings']> } = {}) {
  const log: string[] = []; const calls: Record<string, unknown[]> = {};
  const rec = (k: string, v?: unknown) => { log.push(k); (calls[k] ??= []).push(v); };
  const deps: BuyDeps = {
    env: 'sandbox',
    api: {
      quote: async (_p, scope) => { rec('quote', scope); return over.quote ?? quoteReply(); },
      balance: async () => { rec('balance'); return over.balance ?? { balance: 100 }; },
      validate: async (p) => { rec('validate', p); return { ok: true, errors: [] }; },
      createPackage: async (p) => { rec('create', p); return { package_id: 555 }; },
      orderAndWait: async (ids, uuid) => { rec('order', { ids, uuid }); return { status: 'successful', orderedIds: ['555'], errors: [] }; },
      fetchPackage: async () => { rec('fetch'); return { parcels: [{ package_no: 'WB1' }] }; },
    },
    settings: { enabled: true, maxLabel: 80, dailyCap: 500, markupPct: 30, ...(over.settings ?? {}) },
    spentToday: async () => over.spent ?? 0,
    begin: async (a) => { rec('begin', a); return { id: 'sh-1', order_uuid: 'uuid-1' }; },
    fail: async (id, m) => { rec('fail', { id, m }); },
    savePackageId: async (id, p) => { rec('save', { id, p }); },
    finish: async (id, p, t) => { rec('finish', { id, p, t }); return { carrier: 'dpd', tracking_numbers: t, cost_gross: 24.6, bill_net: 26, bill_gross: 31.98 }; },
    alert: async (s) => { rec('alert', s); },
    audit: async (a) => { rec('audit', a); },
  };
  for (const k of ['begin', 'fail', 'savePackageId', 'finish', 'alert', 'audit', 'spentToday'] as const) if (over[k]) (deps as unknown as Record<string, unknown>)[k] = over[k];
  if (over.api) deps.api = { ...deps.api, ...over.api } as BuyDeps['api'];
  return { deps, log, calls };
}
const refused = async (r: ReturnType<typeof rig>, i: BuyInput, status: number, re: RegExp) => {
  try { await buyLabel(r.deps, i); } catch (e) { ok(e instanceof ShipError && e.status === status && re.test(e.message), `expected ${status} ${re}, got ${(e as Error).message}`); return; }
  throw new Error('should have been refused');
};
const neverMoney = (r: ReturnType<typeof rig>) => { ok(!r.log.includes('order'), 'MONEY WAS SPENT'); ok(!r.log.includes('create'), 'a shipment was created'); ok(!r.log.includes('begin'), 'a record was started'); };

Deno.test('happy path: the steps run in the safe order and the books are written last', async () => {
  const r = rig(); const out = await buyLabel(r.deps, input());
  eq(r.log, ['quote', 'balance', 'begin', 'validate', 'create', 'save', 'order', 'fetch', 'finish'], 'order of events');
  eq(out, { ok: true, shipment: { carrier: 'dpd', tracking_numbers: ['WB1'], cost_gross: 24.6, bill_net: 26, bill_gross: 31.98 } }, 'result');
  eq(r.calls.quote[0], { serviceIds: [7] }, 'priced for exactly this service'); eq(r.calls.order[0], { ids: ['555'], uuid: 'uuid-1' }, 'ordered with the shipment uuid');
  eq(r.calls.finish[0], { id: 'sh-1', p: '555', t: ['WB1'] }, 'finished with package and tracking'); ok(!r.log.includes('fail') && !r.log.includes('alert'), 'no failure, no alert');
  const b = r.calls.begin[0] as { quote: { cost_net: number; cost_gross: number; tax: number }; markupPct: number }; eq([b.quote.cost_net, b.quote.cost_gross, b.quote.tax, b.markupPct], [20, 24.6, 23, 30], 'the record carries cost, tax and the 30% markup');
});
Deno.test('the kill switch stops everything before a record exists', async () => { const r = rig({ settings: { enabled: false } }); await refused(r, input(), 403, /switched off/); neverMoney(r); });
Deno.test('a service that cannot take the parcel, or is missing from the answer, is refused', async () => {
  let r = rig({ quote: quoteReply(24.6, 20, false) }); await refused(r, input(), 400, /not available.*Too heavy/); neverMoney(r);
  r = rig({ quote: quoteReply(24.6, 20, true, 99) }); await refused(r, input(), 400, /not available/); neverMoney(r);
  r = rig({ quote: { services_prices: [] } }); await refused(r, input(), 400, /not available/); neverMoney(r);
});
Deno.test('not enough balance, or an unreadable balance, refuses', async () => {
  let r = rig({ balance: { balance: 10 } }); await refused(r, input(), 403, /Not enough balance/); neverMoney(r);
  r = rig({ balance: {} }); await refused(r, input(), 403, /Could not read the Furgonetka balance/); neverMoney(r);
  r = rig({ balance: { balance: '100' } }); await refused(r, input(), 403, /Could not read/); neverMoney(r);
});
Deno.test('the daily cap refuses, even for an admin who confirms', async () => {
  let r = rig({ spent: 490 }); await refused(r, input(), 403, /daily limit/); neverMoney(r);
  r = rig({ spent: 490 }); await refused(r, input({ role: 'admin', confirmOverLimit: true }), 403, /daily limit/); neverMoney(r);
});
Deno.test('a label above the per-label limit needs an admin and an explicit confirmation', async () => {
  const big = { quote: quoteReply(120, 97.56), balance: { balance: 1000 } };
  let r = rig(big); await refused(r, input(), 403, /An admin has to confirm/); neverMoney(r);
  r = rig(big); await refused(r, input({ confirmOverLimit: true }), 403, /An admin has to confirm/); neverMoney(r);
  r = rig(big); await refused(r, input({ role: 'admin' }), 403, /Confirm to buy it anyway/); neverMoney(r);
  r = rig(big); const out = await buyLabel(r.deps, input({ role: 'admin', confirmOverLimit: true })); ok(out.ok && r.log.includes('order'), 'admin confirmed: bought');
});
Deno.test('an attempt the database refuses (already being bought) never reaches the carrier', async () => {
  const r = rig({ begin: async () => { throw new Error('A label is already being bought or has been bought for this order'); } }); await refused(r, input(), 400, /already being bought/);
  ok(!r.log.includes('create') && !r.log.includes('order'), 'nothing was sent');
});
Deno.test('Furgonetka rejecting the shipment closes the attempt and charges nothing', async () => {
  const r = rig({ api: { validate: async () => ({ ok: false, errors: ['/receiver/phone: required', '/receiver/postcode: wrong'] }) } });
  await refused(r, input(), 422, /rejected the shipment: .*phone/); ok(!r.log.includes('create') && !r.log.includes('order'), 'not created, not ordered'); eq(r.log.filter((x) => x === 'fail').length, 1, 'closed once');
});
Deno.test('a failure while creating the shipment closes the attempt and charges nothing', async () => {
  let r = rig({ api: { createPackage: async () => ({}) } }); await refused(r, input(), 502, /did not return a package id/); ok(!r.log.includes('order') && r.log.includes('fail'), 'closed, not ordered');
  r = rig({ api: { createPackage: async () => { throw new FurgonetkaError(400, { errors: [{ path: '/parcels/0/weight', message: 'too heavy for this service' }] }); } } });
  await refused(r, input(), 502, /too heavy for this service/); ok(!r.log.includes('order') && r.log.includes('fail'), 'closed, not ordered');
});
Deno.test('the carrier refusing the order closes the attempt: it was not charged', async () => {
  let r = rig({ api: { orderAndWait: async () => ({ status: 'error', orderedIds: [], errors: ['/packages/id/555: carrier unavailable'] }) } });
  await refused(r, input(), 422, /refused the order: .*carrier unavailable/); ok(r.log.includes('fail') && !r.log.includes('finish'), 'closed, not recorded as bought');
  r = rig({ api: { orderAndWait: async () => ({ status: 'partial_success', orderedIds: ['999'], errors: [] }) } }); await refused(r, input(), 422, /refused the order/); ok(!r.log.includes('finish'), 'a different package does not count');
});
Deno.test('Furgonetka answering the order with an error (e.g. balance) closes the attempt', async () => {
  const r = rig({ api: { orderAndWait: async () => { throw new FurgonetkaError(400, { errors: [{ message: 'Not enough funds on the account' }] }); } } });
  await refused(r, input(), 502, /Not enough funds/); ok(r.log.includes('fail') && !r.log.includes('finish'), 'closed');
});
Deno.test('NO VERDICT: a timeout is never treated as a failure; the row stays open and the team is alerted', async () => {
  let ordered = 0;
  const r = rig({ api: { orderAndWait: async () => { ordered++; throw new OrderPending('uuid-1', 'running'); } } });
  await refused(r, input(), 504, /may have been charged.*do not buy again/s);
  ok(!r.log.includes('fail'), 'must NOT be closed (money may have been spent)'); ok(!r.log.includes('finish'), 'not recorded as bought'); ok(r.log.includes('alert') && r.log.includes('audit'), 'alerted and audited');
  eq(r.calls.audit[0], 'shipping.unconfirmed', 'audit action'); eq(ordered, 1, 'ordered once only');
});
Deno.test('NO VERDICT: a network failure is handled the same way', async () => {
  const r = rig({ api: { orderAndWait: async () => { throw new TypeError('connection reset'); } } });
  await refused(r, input(), 504, /Lost the connection.*do not buy again/s); ok(!r.log.includes('fail') && r.log.includes('alert'), 'open and alerted');
});
Deno.test('after payment: tracking is best effort, a record failure is retried once, and a second failure alerts but never "fails" the shipment', async () => {
  let r = rig({ api: { fetchPackage: async () => { throw new Error('boom'); } } }); const out = await buyLabel(r.deps, input()); eq(out.shipment.tracking_numbers, [], 'bought without tracking numbers'); ok(r.log.includes('finish'), 'still recorded');
  let n = 0; r = rig({ finish: async (id, p, t) => { if (++n === 1) throw new Error('db hiccup'); return { carrier: 'dpd', tracking_numbers: t, cost_gross: 24.6, bill_net: 26, bill_gross: 31.98 }; } });
  ok((await buyLabel(r.deps, input())).ok, 'the retry succeeded'); eq(n, 2, 'finish tried twice'); ok(!r.log.includes('alert'), 'no alert needed');
  r = rig({ finish: async () => { throw new Error('db down'); } }); await refused(r, input(), 500, /bought, but saving it failed.*Do not buy again/s);
  ok(r.log.includes('alert') && !r.log.includes('fail'), 'alerted; a paid label is never marked failed'); eq(r.log.filter((x) => x === 'order').length, 1, 'never ordered twice');
});
Deno.test('the package id is saved BEFORE the charge, so a crash can be reconciled', async () => {
  const r = rig(); await buyLabel(r.deps, input()); ok(r.log.indexOf('save') < r.log.indexOf('order'), 'saved first'); eq(r.calls.save[0], { id: 'sh-1', p: '555' }, 'with the package id');
});

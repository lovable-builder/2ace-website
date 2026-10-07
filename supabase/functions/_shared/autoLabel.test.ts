// deno test supabase/functions/_shared/autoLabel.test.ts
import { autoLabel, AUTO_MAX_TRIES, type AutoDeps } from './autoLabel.ts';
import { ShipError } from './shipBuy.ts';
import type { Quote } from './shipping.ts';
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const q = (id: number, name: string, net: number, available = true): Quote => ({ service_id: id, carrier: name.toLowerCase(), name, available, cost_net: net, cost_gross: Math.round(net * 123) / 100, tax: 23 });
const SHIP = { carrier: 'dpd', tracking_numbers: ['WB1'], cost_gross: 15.38, bill_net: 16.25, bill_gross: 19.99 };

function rig(over: Partial<AutoDeps> & { quotes?: Quote[]; results?: Array<'ok' | ShipError | Error> } = {}) {
  const bought: number[] = []; const results = [...(over.results ?? ['ok'])];
  const deps: AutoDeps = {
    enabled: true, hasOwnLabel: async () => false, hasActiveShipment: async () => false,
    candidates: async () => over.quotes ?? [q(1, 'UPS', 20), q(2, 'DPD', 12.5), q(3, 'DHL', 15)],
    buy: async (id) => { bought.push(id); const r = results.shift() ?? 'ok'; if (r === 'ok') return { shipment: SHIP }; throw r; }, ...over,
  };
  return { deps, bought };
}

Deno.test('it buys the cheapest available carrier', async () => {
  const r = rig(); const out = await autoLabel(r.deps);
  eq(r.bought, [2], 'DPD is the cheapest'); ok(out.status === 'bought' && out.service === 'DPD' && out.shipment.carrier === 'dpd', JSON.stringify(out));
});
Deno.test('unavailable carriers are never tried, even when cheaper', async () => {
  const r = rig({ quotes: [q(9, 'INPOST', 5, false), q(2, 'DPD', 12.5)] }); await autoLabel(r.deps); eq(r.bought, [2], 'only the available one');
});
Deno.test('it does nothing while switched off', async () => { const r = rig({ enabled: false }); const out = await autoLabel(r.deps); ok(out.status === 'skipped' && out.reason === 'off', 'skipped'); eq(r.bought, [], 'nothing bought'); });
Deno.test('it never buys for an order with the customer\'s own label', async () => { const r = rig({ hasOwnLabel: async () => true }); const out = await autoLabel(r.deps); ok(out.status === 'skipped' && out.reason === 'own_label', 'skipped'); eq(r.bought, [], 'nothing bought'); });
Deno.test('it never buys a second label for an order that already has one', async () => { const r = rig({ hasActiveShipment: async () => true }); const out = await autoLabel(r.deps); ok(out.status === 'skipped' && out.reason === 'has_label', 'skipped'); eq(r.bought, [], 'nothing bought'); });
Deno.test('a carrier that refuses the parcel before any charge: the next cheapest is tried', async () => {
  const r = rig({ results: [new ShipError('Furgonetka rejected the shipment: /receiver: locker point required', 422), 'ok'] });
  const out = await autoLabel(r.deps); eq(r.bought, [2, 3], 'DPD refused, DHL next'); ok(out.status === 'bought' && out.service === 'DHL' && out.tried.join() === 'DPD,DHL', JSON.stringify(out));
  const r2 = rig({ results: [new ShipError('This service is not available for this parcel: Too heavy', 400), 'ok'] }); await autoLabel(r2.deps); eq(r2.bought, [2, 3], 'a vanished quote also moves on');
});
Deno.test('it gives up after three tries and says which carriers refused', async () => {
  const refuse = () => new ShipError('The carrier refused the order', 422);
  const r = rig({ quotes: [q(1, 'A', 1), q(2, 'B', 2), q(3, 'C', 3), q(4, 'D', 4)], results: [refuse(), refuse(), refuse(), 'ok'] });
  const out = await autoLabel(r.deps); eq(r.bought, [1, 2, 3], 'exactly three attempts, the fourth is never tried'); ok(AUTO_MAX_TRIES === 3 && out.status === 'needs_person' && /A, B, C/.test(out.message), JSON.stringify(out));
});
Deno.test('a limit stops everything: it never tries another carrier or overrides it', async () => {
  const r = rig({ results: [new ShipError('This label costs 95,00 zł, above the 80,00 zł limit per label. An admin has to confirm it.', 403), 'ok'] });
  const out = await autoLabel(r.deps); eq(r.bought, [2], 'stopped at the first refusal'); ok(out.status === 'needs_person' && /above the 80,00 zł limit/.test(out.message), JSON.stringify(out));
});
Deno.test('NEVER BUY TWICE: after an unknown result (maybe charged) it stops at once', async () => {
  for (const status of [504, 500]) {
    const r = rig({ results: [new ShipError('Furgonetka has not confirmed the order yet. It may have been charged.', status), 'ok'] });
    const out = await autoLabel(r.deps); eq(r.bought, [2], 'exactly one attempt for ' + status); ok(out.status === 'needs_person' && /may have been charged/.test(out.message), JSON.stringify(out));
  }
});
Deno.test('a connection failure to the carrier stops it too (502), and so does anything unexpected', async () => {
  let r = rig({ results: [new ShipError('Furgonetka answered 500', 502), 'ok'] }); let out = await autoLabel(r.deps); eq(r.bought, [2], '502 stops'); ok(out.status === 'needs_person', 'needs a person');
  r = rig({ results: [new Error('boom'), 'ok'] }); out = await autoLabel(r.deps); eq(r.bought, [2], 'an unexpected error stops'); ok(out.status === 'needs_person' && /boom/.test(out.message), JSON.stringify(out));
  r = rig({ results: [new ShipError('A label is already being bought or has been bought for this order', 400), 'ok'] }); out = await autoLabel(r.deps); eq(r.bought, [2], 'an "already bought" refusal stops, it does not try another carrier');
});
Deno.test('no carrier can take the parcel: it says so and buys nothing', async () => {
  for (const quotes of [[], [q(1, 'A', 5, false)]]) { const r = rig({ quotes }); const out = await autoLabel(r.deps); ok(out.status === 'needs_person' && /No carrier can take this parcel/.test(out.message) && out.tried.length === 0, JSON.stringify(out)); eq(r.bought, [], 'nothing bought'); }
});
Deno.test('a failed quote lookup is not swallowed', async () => {
  let threw = false; try { await autoLabel(rig({ candidates: async () => { throw new Error('quotes down'); } }).deps); } catch (e) { threw = /quotes down/.test((e as Error).message); } ok(threw, 'the error reaches the caller');
});
Deno.test('ties on price are broken by the order Furgonetka returned them in (stable)', async () => {
  const r = rig({ quotes: [q(7, 'GLS', 10), q(8, 'DPD', 10)] }); await autoLabel(r.deps); eq(r.bought, [7], 'first of equal prices');
});
Deno.test('an order that already has a label (bought by the customer, or their own) is reported as such even while automatic labels are off', async () => {
  const a = rig({ enabled: false, hasActiveShipment: async () => true }); const x = await autoLabel(a.deps); ok(x.status === 'skipped' && x.reason === 'has_label', 'a bought label is reported'); eq(a.bought, [], 'nothing bought');
  const b = rig({ enabled: false, hasOwnLabel: async () => true }); const y = await autoLabel(b.deps); ok(y.status === 'skipped' && y.reason === 'own_label', 'an own label is reported');
});

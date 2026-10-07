// deno test supabase/functions/_shared/usageBilling.test.ts
import { describe, onInvoiceCreated, onInvoiceEvent, type Line, type UsageDeps } from './usageBilling.ts';
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const L = (kind: string, count: number, net_cents: number, note: string | null = null): Line => ({ kind, count, net_cents, note });
function rig(o: { enabled?: boolean; org?: string | null; lines?: Line[]; total?: number; failAt?: number } = {}) {
  const items: Record<string, unknown>[] = [], prepared: string[][] = [], events: string[][] = [], alerts: string[] = []; let n = 0;
  const lines = o.lines ?? [L('label', 2, 3300), L('handling', 3, 1200)];
  const d: UsageDeps = {
    enabled: o.enabled ?? true,
    orgByCustomer: async () => (o.org === undefined ? 'org-1' : o.org),
    prepare: async (org, inv) => { prepared.push([org, inv]); return { lines, total_cents: o.total ?? lines.reduce((t, l) => t + l.net_cents, 0) }; },
    createItem: async (p) => { if (o.failAt !== undefined && n++ === o.failAt) throw new Error('stripe down'); items.push(p); },
    event: async (inv, ev) => { events.push([inv, ev]); return 3; },
    alert: async (s) => { alerts.push(s); },
  };
  return { d, items, prepared, events, alerts };
}
const cycle = { id: 'in_1', customer: 'cus_1', status: 'draft', billing_reason: 'subscription_cycle' };

Deno.test('the monthly draft invoice gets one line per kind, in grosz, with idempotency keys that repeat exactly', async () => {
  const r = rig(); const out = await onInvoiceCreated(r.d, cycle);
  eq(out, { status: 'added', items: 2, total_cents: 4500 }, 'result'); eq(r.prepared, [['org-1', 'in_1']], 'prepared for that customer and invoice');
  eq(r.items.map((i) => [i.amount, i.description, i.idempotencyKey, i.invoice, i.customer, i.currency]), [[3300, 'Shipping labels (2 labels)', 'usage-in_1-0-label', 'in_1', 'cus_1', 'pln'], [1200, 'Handling fees (3 orders)', 'usage-in_1-1-handling', 'in_1', 'cus_1', 'pln']], 'items');
  const again = rig(); await onInvoiceCreated(again.d, cycle); eq(again.items.map((i) => i.idempotencyKey), r.items.map((i) => i.idempotencyKey), 'a retried webhook uses the same keys, so Stripe creates nothing twice');
});
Deno.test('a credit is a negative line with its own wording', async () => {
  const r = rig({ lines: [L('handling', 10, 400000), L('credit', 1, -50000, 'Credit for a damaged parcel')] }); await onInvoiceCreated(r.d, cycle);
  ok(r.items.some((i) => i.amount === -50000 && /Credit for a damaged parcel/.test(String(i.description))), 'credit line'); eq(r.items.length, 2, 'two lines');
});
Deno.test('only the monthly subscription invoice carries usage: not an upgrade, not a manual invoice, not a finalized one, not when switched off', async () => {
  for (const [name, inv, enabled] of [['upgrade', { ...cycle, billing_reason: 'subscription_update' }, true], ['manual', { ...cycle, billing_reason: 'manual' }, true], ['already final', { ...cycle, status: 'open' }, true], ['no customer', { ...cycle, customer: null }, true], ['first invoice', { ...cycle, billing_reason: 'subscription_create' }, true], ['switched off', cycle, false]] as const) {
    const r = rig({ enabled }); const out = await onInvoiceCreated(r.d, inv); ok(out.status === 'skipped' || out.status === 'off', name + ': ' + out.status); ok(!r.prepared.length && !r.items.length, name + ': nothing touched');
  }
});
Deno.test('an unknown Stripe customer and an empty ledger add nothing', async () => {
  const a = rig({ org: null }); eq((await onInvoiceCreated(a.d, cycle)).status, 'skipped', 'unknown customer'); ok(!a.prepared.length, 'not prepared');
  const b = rig({ lines: [] }); eq((await onInvoiceCreated(b.d, cycle)).status, 'nothing', 'empty'); ok(!b.items.length, 'no items');
  const c = rig({ lines: [L('label', 1, 0)] }); eq((await onInvoiceCreated(c.d, cycle)).status, 'nothing', 'zero lines are not sent'); ok(!c.items.length, 'no zero item');
});
Deno.test('a total that would not be positive is never sent to Stripe: a person is alerted and the charges stay queued', async () => {
  const r = rig({ lines: [L('credit', 1, -5000, 'x')], total: -5000 }); eq((await onInvoiceCreated(r.d, cycle)).status, 'nothing', 'nothing added'); ok(!r.items.length && r.alerts.length === 1, 'alerted, no item');
});
Deno.test('if Stripe fails part-way the error is raised so Stripe retries the webhook, and the retry repeats the same keys', async () => {
  const r = rig({ failAt: 1 }); let threw = false; try { await onInvoiceCreated(r.d, cycle); } catch { threw = true; } ok(threw, 'raised'); eq(r.items.length, 1, 'the first line was created');
  const retry = rig(); await onInvoiceCreated(retry.d, cycle); eq(retry.items[0].idempotencyKey, r.items[0].idempotencyKey, 'same key for the first line');
});
Deno.test('invoice events move the charges along, and do nothing when switched off', async () => {
  const r = rig(); eq(await onInvoiceEvent(r.d, 'invoice.finalized', 'in_1'), 3, 'count'); await onInvoiceEvent(r.d, 'invoice.paid', 'in_1'); await onInvoiceEvent(r.d, 'invoice.voided', 'in_1');
  eq(r.events, [['in_1', 'finalized'], ['in_1', 'paid'], ['in_1', 'voided']], 'events'); const off = rig({ enabled: false }); eq(await onInvoiceEvent(off.d, 'invoice.paid', 'in_1'), 0, 'off'); ok(!off.events.length, 'untouched'); eq(await onInvoiceEvent(r.d, 'invoice.paid', ''), 0, 'no id');
});
Deno.test('descriptions read naturally, singular and plural', () => {
  eq(describe(L('label', 1, 100)), 'Shipping labels (1 label)', 'one'); eq(describe(L('handling', 1, 1)), 'Handling fees (1 order)', 'one order'); eq(describe(L('return_handling', 4, 1)), 'Return handling fees (4 returns)', 'returns'); eq(describe(L('return_label', 2, 1)), 'Return labels (2 labels)', 'return labels'); eq(describe(L('weird', 2, 1)), 'Usage (weird)', 'unknown kind');
});

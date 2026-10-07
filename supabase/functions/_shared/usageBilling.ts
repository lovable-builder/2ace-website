// Usage charges on the customer's monthly invoice. The database decides what is owed (usage_prepare_invoice: ceilings, queueing, idempotent);
// this decides how it is written to Stripe. Dependencies are passed in, so every branch is tested without Stripe or a database.
export type Line = { kind: string; note: string | null; count: number; net_cents: number };
export interface UsageDeps {
  enabled: boolean;                                                            // USAGE_BILLING_ENABLED
  orgByCustomer(customerId: string): Promise<string | null>;
  prepare(orgId: string, invoiceId: string): Promise<{ lines: Line[]; total_cents: number }>;
  createItem(p: { customer: string; invoice: string; amount: number; currency: 'pln'; description: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<void>;
  event(invoiceId: string, ev: 'finalized' | 'paid' | 'voided'): Promise<number>;
  alert(subject: string, html: string): Promise<void>;
}
export type Invoice = { id: string; customer?: string | null; status?: string | null; billing_reason?: string | null };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const describe = (l: Line): string => ({
  label: `Shipping labels (${plural(l.count, 'label', 'labels')})`,
  adjustment: `Shipping adjustments (${l.count})`,
  handling: `Handling fees (${plural(l.count, 'order', 'orders')})`,
  return_handling: `Return handling fees (${plural(l.count, 'return', 'returns')})`,
  return_label: `Return labels (${plural(l.count, 'label', 'labels')})`,
  credit: l.note || 'Monthly ceiling',
} as Record<string, string>)[l.kind] ?? `Usage (${l.kind})`;

// Stripe created a draft invoice. For the monthly subscription invoice of a customer with pending usage charges, add them as lines.
export async function onInvoiceCreated(d: UsageDeps, inv: Invoice): Promise<{ status: 'off' | 'skipped' | 'nothing' | 'added'; items?: number; total_cents?: number }> {
  if (!d.enabled) return { status: 'off' };
  // Only the monthly subscription invoice, and only while it is still a draft (an upgrade or a one-off invoice must never carry usage charges).
  if (inv.billing_reason !== 'subscription_cycle' || inv.status !== 'draft' || !inv.customer) return { status: 'skipped' };
  const org = await d.orgByCustomer(inv.customer);
  if (!org) return { status: 'skipped' };
  const r = await d.prepare(org, inv.id);
  const lines = r.lines.filter((l) => l.net_cents !== 0);
  if (!lines.length) return { status: 'nothing' };
  if (r.total_cents <= 0) {                                                    // credits would exceed charges: never create a negative balance by machine, a person decides
    await d.alert('Usage charges need a person: the invoice total would not be positive', `<p>Invoice <b>${inv.id}</b> of organization <b>${org}</b>: the usage lines add up to ${(r.total_cents / 100).toFixed(2)} zł. Nothing was added to the Stripe invoice. The charges stay queued in the ledger.</p>`);
    return { status: 'nothing' };
  }
  let i = 0;
  for (const l of lines) {
    await d.createItem({ customer: inv.customer, invoice: inv.id, amount: l.net_cents, currency: 'pln', description: describe(l), metadata: { org_id: org, kind: l.kind, kind_count: String(l.count) }, idempotencyKey: `usage-${inv.id}-${i++}-${l.kind}` });
  }
  return { status: 'added', items: lines.length, total_cents: r.total_cents };
}

export async function onInvoiceEvent(d: UsageDeps, type: 'invoice.finalized' | 'invoice.paid' | 'invoice.voided', invoiceId: string): Promise<number> {
  if (!d.enabled || !invoiceId) return 0;
  return await d.event(invoiceId, type === 'invoice.finalized' ? 'finalized' : type === 'invoice.paid' ? 'paid' : 'voided');
}

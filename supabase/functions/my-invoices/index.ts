import Stripe from 'npm:stripe';
import { withMonitoring } from '../_shared/monitor.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { caller } from '../_shared/auth.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);

Deno.serve(withMonitoring('my-invoices', async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  const me = await caller(req);
  if (!me) return json(req, { error: 'unauthorized' }, 401);
  // Billing data is for owner/finance only.
  if (!me.orgId || !['owner', 'finance'].includes(me.role ?? '')) return json(req, { invoices: [], subscription: null });
  if (!me.customer) return json(req, { invoices: [], subscription: null });

  try {
    const [inv, subs] = await Promise.all([
      stripe.invoices.list({ customer: me.customer, limit: 24 }),
      stripe.subscriptions.list({ customer: me.customer, status: 'all', limit: 1 }),
    ]);
    const s = subs.data[0] as unknown as (Stripe.Subscription & { current_period_end?: number }) | undefined;
    const periodEnd = s?.current_period_end ?? (s?.items?.data?.[0] as unknown as { current_period_end?: number })?.current_period_end;
    return json(req, {
      invoices: inv.data.filter((i) => i.status !== 'draft').map((i) => ({
        id: i.id, number: i.number, created: i.created, currency: i.currency, status: i.status,
        total: i.total, amount_paid: i.amount_paid, amount_due: i.amount_due,
        hosted_invoice_url: i.hosted_invoice_url, invoice_pdf: i.invoice_pdf,
      })),
      subscription: s ? { status: s.status, cancel_at_period_end: s.cancel_at_period_end, current_period_end: periodEnd ?? null } : null,
    });
  } catch (e) {
    console.error(e);
    return json(req, { error: 'Could not load invoices' }, 502);
  }
}));

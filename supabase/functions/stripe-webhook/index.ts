import Stripe from 'npm:stripe';
import { withMonitoring } from '../_shared/monitor.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendEmail, layout, esc } from '../_shared/email.ts';
import { createDomainOrder } from '../_shared/domainOrder.ts';
import { recurringMonthlyPLN } from '../_shared/stripeTotals.ts';
import { onInvoiceCreated, onInvoiceEvent, type UsageDeps } from '../_shared/usageBilling.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);
const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// Usage charges (labels, handling fees, returns) join the customer's monthly invoice. Off until USAGE_BILLING_ENABLED=true.
const usage: UsageDeps = {
  enabled: Deno.env.get('USAGE_BILLING_ENABLED') === 'true',
  orgByCustomer: async (cus) => { const { data } = await db.from('organizations').select('id').eq('stripe_customer_id', cus).maybeSingle(); return (data?.id as string) ?? null; },
  prepare: async (org, inv) => { const { data, error } = await db.rpc('usage_prepare_invoice', { p_org: org, p_invoice: inv }); if (error) throw new Error(error.message); return data as never; },
  createItem: async (p) => { await stripe.invoiceItems.create({ customer: p.customer, invoice: p.invoice, amount: p.amount, currency: p.currency, description: p.description, metadata: p.metadata, tax_behavior: 'exclusive' }, { idempotencyKey: p.idempotencyKey }); },
  event: async (inv, ev) => { const { data, error } = await db.rpc('usage_invoice_event', { p_invoice: inv, p_event: ev }); if (error) throw new Error(error.message); return Number(data ?? 0); },
  alert: async (subject, html) => { try { await sendEmail({ to: Deno.env.get('LEAD_NOTIFY_TO') ?? 'hello@2ace.pl', subject, html: layout(subject, html) }); } catch (_e) { /* the log has it */ } },
};

async function setOrg(orgId: string | undefined | null, status: string) {
  if (orgId) await db.from('organizations').update({ status }).eq('id', orgId);
}

async function syncSub(sub: Stripe.Subscription) {
  const orgId = sub.metadata?.org_id;
  if (!orgId) return;
  const end = (sub as unknown as { current_period_end?: number }).current_period_end
    ?? (sub.items?.data?.[0] as unknown as { current_period_end?: number })?.current_period_end;
  await db.from('subscriptions').upsert({
    stripe_subscription_id: sub.id, org_id: orgId, status: sub.status,
    current_period_end: end ? new Date(end * 1000).toISOString() : null, updated_at: new Date().toISOString(),
  });
  // Keep the plan's monthly price equal to what Stripe really bills, so the dashboard can never show a different amount than the invoices.
  if (sub.status === 'active' || sub.status === 'trialing') {
    const billed = recurringMonthlyPLN(sub);
    const { data: pl } = await db.from('plans').select('id, monthly_pln').eq('org_id', orgId).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (pl && billed > 0 && pl.monthly_pln !== billed) {
      console.warn('plan monthly differs from Stripe, aligning', orgId, pl.monthly_pln, '->', billed);
      await db.from('plans').update({ monthly_pln: billed }).eq('id', pl.id);
    }
  }
  const map: Record<string, string> = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled' };
  if (map[sub.status]) await setOrg(orgId, map[sub.status]);
}

Deno.serve(withMonitoring('stripe-webhook', async (req) => {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('missing signature', { status: 400 });
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, secret);
  } catch (e) {
    console.error('bad signature', (e as Error).message);
    return new Response('bad signature', { status: 400 });
  }

  // Idempotency: skip events we've already handled.
  const { error: dup } = await db.from('webhook_events').insert({ id: event.id, type: event.type });
  if (dup) return new Response('duplicate', { status: 200 });

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') {
          if (s.metadata?.kind === 'domain') {
            await createDomainOrder({ orgId: s.metadata.org_id, planId: null, name: s.metadata.domain, email: s.customer_details?.email ?? '', sessionId: s.id });
            break;
          }
          const orgId = s.metadata?.org_id ?? s.client_reference_id;
          await setOrg(orgId, 'active');
          if (s.metadata?.plan_id) await db.from('plans').update({ status: 'active' }).eq('id', s.metadata.plan_id);
          if (typeof s.subscription === 'string') await syncSub(await stripe.subscriptions.retrieve(s.subscription));
          if (s.metadata?.domain) await createDomainOrder({ orgId: (s.metadata?.org_id ?? s.client_reference_id) as string, planId: s.metadata?.plan_id ?? null, name: s.metadata.domain, email: s.customer_details?.email ?? '', sessionId: s.id });
        }
        break;
      }
      case 'checkout.session.async_payment_failed': {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.metadata?.plan_id) await db.from('plans').update({ status: 'draft' }).eq('id', s.metadata.plan_id);
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncSub(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.created': { const inv = event.data.object as Stripe.Invoice; await onInvoiceCreated(usage, { id: inv.id as string, customer: typeof inv.customer === 'string' ? inv.customer : inv.customer?.id ?? null, status: inv.status, billing_reason: inv.billing_reason }); break; }
      case 'invoice.finalized':
      case 'invoice.voided': await onInvoiceEvent(usage, event.type, (event.data.object as Stripe.Invoice).id as string); break;
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const inv = event.data.object as Stripe.Invoice & { subscription?: string | null };
        if (event.type === 'invoice.paid') await onInvoiceEvent(usage, 'invoice.paid', inv.id as string);
        const subId = inv.subscription ?? (inv as unknown as { parent?: { subscription_details?: { subscription?: string } } }).parent?.subscription_details?.subscription;
        if (subId) await syncSub(await stripe.subscriptions.retrieve(subId));
        if (inv.customer_email) {
          const paid = event.type === 'invoice.paid';
          const money = ((paid ? inv.amount_paid : inv.amount_due) / 100).toFixed(2) + ' ' + inv.currency.toUpperCase();
          const link = inv.hosted_invoice_url ? `<p><a href="${esc(inv.hosted_invoice_url)}" style="color:#A8701A">View invoice${inv.invoice_pdf ? '' : ''}</a>${inv.invoice_pdf ? ` &middot; <a href="${esc(inv.invoice_pdf)}" style="color:#A8701A">Download PDF</a>` : ''}</p>` : '';
          await sendEmail({
            to: inv.customer_email,
            subject: paid ? `Payment received: ${money}` : 'Payment failed: action needed',
            html: layout(paid ? 'Payment received' : 'We could not take your payment',
              paid ? `<p>Thank you. We received <b>${esc(money)}</b>${inv.number ? ` for invoice ${esc(inv.number)}` : ''}.</p>${link}`
                   : `<p>Your payment of <b>${esc(money)}</b> did not go through. Please update your payment method in your account to keep your plan active.</p>${link}`),
          });
        }
        break;
      }
    }
  } catch (e) {
    console.error('handler failed', event.type, e);
    await db.from('webhook_events').delete().eq('id', event.id); // let Stripe retry
    return new Response('handler error', { status: 500 });
  }
  return new Response('ok', { status: 200 });
}));

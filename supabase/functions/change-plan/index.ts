import Stripe from 'npm:stripe';
import { corsHeaders, json } from '../_shared/cors.ts';
import { admin, caller } from '../_shared/auth.ts';
import { priceConfig, comparePlans, prorate, type PlanConfig } from '../_shared/pricing.ts';
import { validName, cleanName, rdapStatus } from '../_shared/domain.ts';
import { createDomainOrder } from '../_shared/domainOrder.ts';

// Upgrade or downgrade an existing subscription. Changes apply immediately with proration:
// an upgrade is invoiced now; a downgrade is credited on the next invoice.
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method' }, 405);
  const me = await caller(req);
  if (!me) return json(req, { error: 'unauthorized' }, 401);
  if (!me.orgId || !['owner', 'finance'].includes(me.role ?? '')) return json(req, { error: 'Only the account owner or finance role can change the plan' }, 403);

  let b: { config: PlanConfig; preview?: boolean };
  try { b = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }
  let next;
  try { next = priceConfig(b.config); } catch (e) { return json(req, { error: String((e as Error).message) }, 400); }

  const { data: plan } = await admin.from('plans').select('id, config, monthly_pln').eq('org_id', me.orgId).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle();
  const { data: subRow } = await admin.from('subscriptions').select('stripe_subscription_id').eq('org_id', me.orgId).in('status', ['active', 'trialing', 'past_due']).limit(1).maybeSingle();
  if (!plan || !subRow) return json(req, { error: 'You have no active plan to change' }, 409);

  const { kind, delta } = comparePlans({ monthly: plan.monthly_pln }, next);
  const wasStore = !!(plan.config as PlanConfig).storeOn;
  // Adding a storefront needs a .pl name unless the company already has a domain order.
  const { data: dom } = await admin.from('domain_orders').select('id').eq('org_id', me.orgId).in('status', ['pending', 'registered']).limit(1);
  const hasDomain = !!(dom && dom.length);
  const addingStore = !!b.config.storeOn && !wasStore;
  const domain = cleanName(b.config.domain);
  const needDomain = addingStore && !hasDomain;
  if (needDomain && !validName(domain)) return json(req, { error: 'Enter a valid name for your .pl store domain' }, 400);

  const sub = await stripe.subscriptions.retrieve(subRow.stripe_subscription_id) as unknown as Stripe.Subscription & { current_period_start?: number; current_period_end?: number };
  const item0 = sub.items.data[0] as unknown as { current_period_start?: number; current_period_end?: number };
  const start = sub.current_period_start ?? item0?.current_period_start ?? Math.floor(Date.now() / 1000) - 15 * 86400;
  const end = sub.current_period_end ?? item0?.current_period_end ?? start + 30 * 86400;
  // Setup fees are only charged for newly added services, not for ones the customer already pays for.
  const prevOnce = priceConfig(plan.config as PlanConfig).once;
  const onceToCharge = Math.max(0, next.once - prevOnce);
  const est = prorate(delta, onceToCharge, Math.floor(Date.now() / 1000), start, end);

  const summary = {
    kind, delta, currentMonthly: plan.monthly_pln, newMonthly: next.monthly, onceToCharge,
    todayEstimate: est.today, periodEnd: end, needDomain,
  };
  if (b.preview) return json(req, summary);
  if (kind === 'same' && onceToCharge === 0) return json(req, { error: 'This is the same as your current plan' }, 400);

  if (needDomain) {
    const st = await rdapStatus(domain);
    if (st === 'taken') return json(req, { error: `${domain}.pl is already registered. Choose another name.` }, 409);
  }

  const items: Stripe.SubscriptionUpdateParams.Item[] = sub.items.data.map((i) => ({ id: i.id, deleted: true }));
  for (const l of next.lines) {
    if (l.monthly > 0) items.push({ price_data: { currency: 'pln', unit_amount: l.monthly * 100, recurring: { interval: 'month' }, product_data: { name: l.label } } });
  }
  if (!items.some((i) => 'price_data' in i)) return json(req, { error: 'Nothing to bill' }, 400);
  const addInvoiceItems: Stripe.SubscriptionUpdateParams.AddInvoiceItem[] = onceToCharge > 0
    ? [{ price_data: { currency: 'pln', unit_amount: onceToCharge * 100, product_data: { name: 'One-time setup for added services' } }, quantity: 1 }]
    : [];

  try {
    await stripe.subscriptions.update(sub.id, {
      items,
      add_invoice_items: addInvoiceItems,
      // Upgrades and setup fees are invoiced now (and must succeed); downgrades are credited on the next invoice.
      proration_behavior: delta > 0 || onceToCharge > 0 ? 'always_invoice' : 'create_prorations',
      payment_behavior: 'error_if_incomplete',
      metadata: { org_id: me.orgId, changed_by: me.user.id },
    });
  } catch (e) {
    console.error('plan change failed', e);
    return json(req, { error: 'We could not change your plan, and you were not charged. Check your payment method in Billing and try again.' }, 402);
  }

  // Record the new plan; the old one is kept for history.
  await admin.from('plans').update({ status: 'canceled' }).eq('id', plan.id);
  const { data: np } = await admin.from('plans').insert({ org_id: me.orgId, config: b.config, monthly_pln: next.monthly, once_pln: next.once, status: 'active' }).select('id').single();
  if (needDomain && np) await createDomainOrder({ orgId: me.orgId, planId: np.id, name: domain, email: me.user.email ?? '', sessionId: null });
  return json(req, { ok: true, ...summary });
});

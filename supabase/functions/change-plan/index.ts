import Stripe from 'npm:stripe';
import { withMonitoring, captureException } from '../_shared/monitor.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { admin, caller } from '../_shared/auth.ts';
import { priceConfig, comparePlans, prorate, storageM2, type PlanConfig } from '../_shared/pricing.ts';
import { validName, cleanName, rdapStatus } from '../_shared/domain.ts';
import { createDomainOrder } from '../_shared/domainOrder.ts';
import { recurringMonthlyPLN } from '../_shared/stripeTotals.ts';
import { sendEmail, layout, esc } from '../_shared/email.ts';

const TEAM_INBOX = Deno.env.get('LEAD_NOTIFY_TO') ?? 'hello@2ace.pl';

// Upgrade or downgrade an existing subscription. Changes apply immediately with proration:
// an upgrade is invoiced now; a downgrade is credited on the next invoice.
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);

// Stripe does not accept an inline product for subscription updates (unlike Checkout), so each line needs a real product.
// Deterministic ids mean the same label reuses the same product instead of cluttering the catalogue.
async function productFor(label: string): Promise<string> {
  const data = new TextEncoder().encode(label);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', data)), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
  const id = 'ace_' + hash;
  try { await stripe.products.retrieve(id); return id; } catch (_e) { /* not created yet */ }
  try { await stripe.products.create({ id, name: label }); } catch (e) {
    if ((e as { code?: string }).code !== 'resource_already_exists') throw e;   // created by a parallel request
  }
  return id;
}

// Two configs are "the same plan" only if every choice matches. Market (a commission per sale) and Import & customs (quoted per shipment)
// carry no monthly price, so adding or removing them changes the plan without changing the price.
const sig = (c: PlanConfig) => JSON.stringify([storageM2(c),  !!c.pkgs?.imp, !!c.storeOn, !!c.marketOn, c.tt ?? 'off', c.meta ?? 'off']);

Deno.serve(withMonitoring('change-plan', async (req) => {
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

  const configChange = sig(plan.config as PlanConfig) !== sig(b.config);
  const summary = {
    kind, delta, currentMonthly: plan.monthly_pln, newMonthly: next.monthly, onceToCharge,
    todayEstimate: est.today, periodEnd: end, needDomain, configChange,
  };
  if (b.preview) return json(req, summary);
  if (kind === 'same' && onceToCharge === 0) {
    if (!configChange) return json(req, { error: 'This is the same as your current plan' }, 400);
    // Same monthly price, different services (e.g. adding Market or Import & customs): nothing to bill, so Stripe is not touched.
    await admin.from('plans').update({ status: 'canceled' }).eq('id', plan.id);
    const { error: pe } = await admin.from('plans').insert({ org_id: me.orgId, config: b.config, monthly_pln: next.monthly, once_pln: next.once, status: 'active' });
    if (pe) {
      console.error('plan record failed', pe);
      await admin.from('plans').update({ status: 'active' }).eq('id', plan.id);   // put the old plan back so the customer is never left without one
      return json(req, { error: 'We could not save the change. Nothing was changed.' }, 500);
    }
    return json(req, { ok: true, ...summary, configOnly: true });
  }

  if (needDomain) {
    const st = await rdapStatus(domain);
    if (st === 'taken') return json(req, { error: `${domain}.pl is already registered. Choose another name.` }, 409);
  }

  const items: Stripe.SubscriptionUpdateParams.Item[] = sub.items.data.map((i) => ({ id: i.id, deleted: true }));
  for (const l of next.lines) {
    if (l.monthly > 0) items.push({ price_data: { currency: 'pln', unit_amount: l.monthly * 100, recurring: { interval: 'month' }, product: await productFor(l.label) } });
  }
  if (!items.some((i) => 'price_data' in i)) return json(req, { error: 'Nothing to bill' }, 400);
  const addInvoiceItems: Stripe.SubscriptionUpdateParams.AddInvoiceItem[] = onceToCharge > 0
    ? [{ price_data: { currency: 'pln', unit_amount: onceToCharge * 100, product: await productFor('One-time setup for added services') }, quantity: 1 }]
    : [];

  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(sub.id, {
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

  // Stripe has now been changed (and any upgrade charged). From here on, never leave our record behind Stripe: check the new monthly total,
  // save the plan, and if anything is off say so loudly and tell the team, instead of showing the customer the old price.
  const problem = async (what: string) => {
    await captureException(new Error('plan change inconsistent: ' + what), { fn: 'change-plan' });
    await sendEmail({ to: TEAM_INBOX, subject: `ACTION NEEDED: plan change for ${me.orgName ?? me.orgId}`,
      html: layout('A plan change needs a manual check', `<p>${esc(me.orgName ?? '')} (${esc(me.orgId!)}) changed plan in Stripe, but: <b>${esc(what)}</b>.</p><p>Stripe subscription ${esc(sub.id)}. Compare the customer's plan in the admin panel with the subscription in Stripe.</p>`) });
    return json(req, { error: 'Your payment went through, but we could not finish saving the new plan. We have been alerted and will fix it today. You do not need to do anything.' }, 500);
  };
  const billed = recurringMonthlyPLN(updated);
  if (billed !== next.monthly) return await problem(`Stripe will bill ${billed} zł a month but the new plan is ${next.monthly} zł`);

  // Record the new plan; the old one is kept for history. Both writes are checked.
  const { error: e1 } = await admin.from('plans').update({ status: 'canceled' }).eq('id', plan.id);
  const { data: np, error: e2 } = await admin.from('plans').insert({ org_id: me.orgId, config: b.config, monthly_pln: next.monthly, once_pln: next.once, status: 'active' }).select('id').single();
  if (e1 || e2 || !np) return await problem(`the plan record could not be saved (${(e1 ?? e2)?.message ?? 'unknown'})`);
  if (needDomain) await createDomainOrder({ orgId: me.orgId, planId: np.id, name: domain, email: me.user.email ?? '', sessionId: null });
  return json(req, { ok: true, ...summary });
}));

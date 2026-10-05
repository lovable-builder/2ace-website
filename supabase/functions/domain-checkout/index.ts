import Stripe from 'npm:stripe';
import { corsHeaders, json } from '../_shared/cors.ts';
import { admin, caller } from '../_shared/auth.ts';
import { validName, cleanName, rdapStatus } from '../_shared/domain.ts';
import { createDomainOrder } from '../_shared/domainOrder.ts';

// A customer with an active plan but no domain asks for one. Free if their plan includes a storefront,
// otherwise a one-time fee through Stripe. Both paths end in the same domain_orders flow as a new plan.
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);
const SITE = Deno.env.get('SITE_URL') ?? 'https://2ace.pl';
const FEE_PLN = 99; // net, excl. VAT; one-time, first year
const AUTO_TAX = Deno.env.get('STRIPE_AUTOMATIC_TAX') === 'true';
// See create-checkout: Hostinger needs each customer's acceptance of its Domain Name Registration Agreement, kept 3+ years.
const DOMAIN_AGREEMENT_VERSION = 'hostinger-domain-registration-2026-10';

async function eligibility(orgId: string) {
  const { data: org } = await admin.from('organizations').select('status').eq('id', orgId).single();
  if (org?.status !== 'active') return { eligible: false, reason: 'inactive' as const };
  const { data: orders } = await admin.from('domain_orders').select('domain, status').eq('org_id', orgId).in('status', ['pending', 'registered']);
  if (orders && orders.length) return { eligible: false, reason: 'has_domain' as const, domains: orders };
  const { data: plan } = await admin.from('plans').select('id, config').eq('org_id', orgId).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle();
  const free = !!(plan?.config as { storeOn?: boolean } | undefined)?.storeOn;
  return { eligible: true, free, planId: plan?.id ?? null, fee: FEE_PLN };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method' }, 405);
  const me = await caller(req);
  if (!me) return json(req, { error: 'unauthorized' }, 401);
  if (!me.orgId || !['owner', 'finance'].includes(me.role ?? '')) return json(req, { error: 'Only the account owner or finance role can request a domain' }, 403);

  let b: { action?: string; name?: string; accept?: boolean };
  try { b = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }
  const el = await eligibility(me.orgId);
  if (b.action === 'info') return json(req, el);
  if (!el.eligible) return json(req, { error: el.reason === 'has_domain' ? 'You already have a domain' : 'Your plan is not active yet' }, 409);

  if (b.accept !== true) return json(req, { error: 'Please accept the Hostinger Domain Name Registration Agreement to continue.' }, 400);
  const name = cleanName(b.name);
  if (!validName(name)) return json(req, { error: 'Enter a valid .pl name: letters, numbers and hyphens' }, 400);
  const status = await rdapStatus(name);
  if (status === 'taken') return json(req, { error: `${name}.pl is already registered. Try another name.` }, 409);
  if (status === 'unknown') return json(req, { error: 'We could not reach the registry just now. Please try again in a moment.' }, 503);

  const email = me.user.email ?? '';
  const { data: prof } = await admin.from('profiles').select('full_name').eq('user_id', me.user.id).maybeSingle();
  await admin.from('agreements').insert({
    org_id: me.orgId, user_id: me.user.id, signer_name: (prof?.full_name as string | null) || me.orgName || email, version: DOMAIN_AGREEMENT_VERSION,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0] ?? null,
  });
  if (el.free) {
    await createDomainOrder({ orgId: me.orgId, planId: el.planId, name, email, sessionId: null });
    return json(req, { ok: true, free: true });
  }

  // One-time paid domain: make sure the company has a Stripe customer (it does once it has paid for a plan).
  let customer = me.customer;
  if (!customer) {
    const c = await stripe.customers.create({ name: me.orgName, email, metadata: { org_id: me.orgId } });
    customer = c.id;
    await admin.from('organizations').update({ stripe_customer_id: customer }).eq('id', me.orgId);
  }
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => String.fromCharCode(97 + (n % 26))).join('');
  const session = await stripe.checkout.sessions.create({
    mode: 'payment', customer, client_reference_id: me.orgId,
    line_items: [{ quantity: 1, price_data: { currency: 'pln', unit_amount: FEE_PLN * 100, product_data: { name: `${name}.pl domain, first year` } } }],
    metadata: { kind: 'domain', org_id: me.orgId, domain: name },
    invoice_creation: { enabled: true },
    customer_update: { name: 'auto', address: 'auto' },
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    ...(AUTO_TAX ? { automatic_tax: { enabled: true } } : {}),
    success_url: `${SITE}/platform?domain=success`,
    cancel_url: `${SITE}/platform?domain=cancelled`,
    integration_identifier: `2ace-domain-${rand}`,
  } as Stripe.Checkout.SessionCreateParams);
  return json(req, { url: session.url });
});

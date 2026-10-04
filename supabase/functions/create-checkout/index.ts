import Stripe from 'npm:stripe';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';
import { priceConfig, type PlanConfig } from '../_shared/pricing.ts';
import { validName, cleanName } from '../_shared/domain.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);
const SITE = Deno.env.get('SITE_URL') ?? 'https://2ace.pl';
const AGREEMENT_VERSION = '2026-10-v1';
// Only enable once the VAT registration exists in Stripe (otherwise no tax is collected).
const AUTO_TAX = Deno.env.get('STRIPE_AUTOMATIC_TAX') === 'true';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
  const { data: u } = await admin.auth.getUser(token);
  const user = u?.user;
  if (!user) return json(req, { error: 'unauthorized' }, 401);

  let b: { config: PlanConfig; company: string; country: string; vatId?: string; signName: string };
  try { b = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }
  const company = String(b.company ?? '').trim().slice(0, 200);
  const signName = String(b.signName ?? '').trim().slice(0, 200);
  const country = String(b.country ?? '').trim().slice(0, 8);
  if (!company || !signName) return json(req, { error: 'company and signName required' }, 400);

  let priced;
  try { priced = priceConfig(b.config); } catch (e) { return json(req, { error: String((e as Error).message) }, 400); }

  // A storefront plan needs a valid .pl name; it is registered for the customer after payment.
  const domain = b.config.storeOn ? cleanName(b.config.domain) : '';
  if (b.config.storeOn && !validName(domain)) return json(req, { error: 'Enter a valid name for your .pl store domain' }, 400);

  // Org: reuse the user's existing one, else create.
  let orgId: string;
  const { data: m } = await admin.from('members').select('org_id').eq('user_id', user.id).limit(1).maybeSingle();
  if (m) {
    orgId = m.org_id;
    await admin.from('organizations').update({ name: company, country, vat_id: b.vatId ?? null }).eq('id', orgId);
  } else {
    const { data: o, error } = await admin.from('organizations').insert({ name: company, country, vat_id: b.vatId ?? null }).select('id').single();
    if (error) { console.error(error); return json(req, { error: 'server' }, 500); }
    orgId = o.id;
    await admin.from('members').insert({ org_id: orgId, user_id: user.id, role: 'owner' });
  }

  // One live subscription per company: changes go through the billing portal, not a second checkout.
  const { data: live } = await admin.from('subscriptions').select('stripe_subscription_id').eq('org_id', orgId).in('status', ['active', 'trialing', 'past_due']).limit(1);
  if (live && live.length) return json(req, { error: 'already subscribed' }, 409);

  const { data: org } = await admin.from('organizations').select('stripe_customer_id').eq('id', orgId).single();
  let customer = org?.stripe_customer_id as string | null;
  if (!customer) {
    const c = await stripe.customers.create({ name: company, email: user.email, metadata: { org_id: orgId } });
    customer = c.id;
    await admin.from('organizations').update({ stripe_customer_id: customer }).eq('id', orgId);
  }

  const { data: plan, error: pe } = await admin.from('plans')
    .insert({ org_id: orgId, config: b.config, monthly_pln: priced.monthly, once_pln: priced.once, status: 'checkout' })
    .select('id').single();
  if (pe) { console.error(pe); return json(req, { error: 'server' }, 500); }

  await admin.from('agreements').insert({
    org_id: orgId, user_id: user.id, signer_name: signName, version: AGREEMENT_VERSION,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0] ?? null,
  });

  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  for (const l of priced.lines) {
    if (l.monthly > 0) line_items.push({ quantity: 1, price_data: { currency: 'pln', unit_amount: l.monthly * 100, recurring: { interval: 'month' }, product_data: { name: l.label } } });
    if (l.once > 0) line_items.push({ quantity: 1, price_data: { currency: 'pln', unit_amount: l.once * 100, product_data: { name: `${l.label}: one-time setup` } } });
  }
  if (!line_items.length) return json(req, { error: 'nothing to bill' }, 400);

  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => String.fromCharCode(97 + (n % 26))).join('');
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: orgId,
    line_items,
    metadata: { org_id: orgId, plan_id: plan.id, ...(domain ? { domain } : {}) },
    subscription_data: { metadata: { org_id: orgId, plan_id: plan.id } },
    customer_update: { name: 'auto', address: 'auto' },
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    ...(AUTO_TAX ? { automatic_tax: { enabled: true } } : {}),
    success_url: `${SITE}/platform.html?checkout=success`,
    cancel_url: `${SITE}/platform.html?checkout=cancelled`,
    integration_identifier: `2ace-checkout-${rand}`,
  } as Stripe.Checkout.SessionCreateParams);

  return json(req, { url: session.url, monthly: priced.monthly, once: priced.once });
});

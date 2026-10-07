import Stripe from 'npm:stripe';
import { withMonitoring } from '../_shared/monitor.ts';
import { corsHeaders, json } from '../_shared/cors.ts';
import { caller } from '../_shared/auth.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);
const SITE = Deno.env.get('SITE_URL') ?? 'https://2ace.pl';

Deno.serve(withMonitoring('billing-portal', async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  const me = await caller(req);
  if (!me) return json(req, { error: 'unauthorized' }, 401);
  if (!me.customer || !['owner', 'finance'].includes(me.role ?? '')) return json(req, { error: 'No billing account yet' }, 400);
  try {
    const s = await stripe.billingPortal.sessions.create({ customer: me.customer, return_url: `${SITE}/account` });
    return json(req, { url: s.url });
  } catch (e) {
    console.error(e);
    // Most common cause: the Customer Portal is not activated in the Stripe Dashboard yet.
    return json(req, { error: 'Billing portal is not available yet' }, 502);
  }
}));

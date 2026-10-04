import Stripe from 'npm:stripe';
import { createClient } from 'npm:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);
const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

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
  const map: Record<string, string> = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled' };
  if (map[sub.status]) await setOrg(orgId, map[sub.status]);
}

Deno.serve(async (req) => {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('missing signature', { status: 400 });
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, secret);
  } catch (e) {
    console.error('bad signature', e.message);
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
          const orgId = s.metadata?.org_id ?? s.client_reference_id;
          await setOrg(orgId, 'active');
          if (s.metadata?.plan_id) await db.from('plans').update({ status: 'active' }).eq('id', s.metadata.plan_id);
          if (typeof s.subscription === 'string') await syncSub(await stripe.subscriptions.retrieve(s.subscription));
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
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const inv = event.data.object as Stripe.Invoice & { subscription?: string | null };
        const subId = inv.subscription ?? (inv as unknown as { parent?: { subscription_details?: { subscription?: string } } }).parent?.subscription_details?.subscription;
        if (subId) await syncSub(await stripe.subscriptions.retrieve(subId));
        break;
      }
    }
  } catch (e) {
    console.error('handler failed', event.type, e);
    await db.from('webhook_events').delete().eq('id', event.id); // let Stripe retry
    return new Response('handler error', { status: 500 });
  }
  return new Response('ok', { status: 200 });
});

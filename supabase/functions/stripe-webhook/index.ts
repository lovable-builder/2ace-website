import Stripe from 'npm:stripe';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendEmail, layout, esc } from '../_shared/email.ts';
import { validName, rdapStatus } from '../_shared/domain.ts';
import { autoRegisterPl, type Reg, type OrgData } from '../_shared/hostinger.ts';

const NOTIFY = Deno.env.get('LEAD_NOTIFY_TO') ?? 'warsaw@2ace.eu';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);
const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

async function setOrg(orgId: string | undefined | null, status: string) {
  if (orgId) await db.from('organizations').update({ status }).eq('id', orgId);
}

// After payment, record the domain this plan needs. With HOSTINGER_AUTO_REGISTER=true we try to buy it
// automatically (safe fallbacks inside autoRegisterPl); otherwise, or on any problem, the team registers it by hand.
async function createDomainOrder(s: Stripe.Checkout.Session) {
  const name = s.metadata?.domain, orgId = s.metadata?.org_id ?? s.client_reference_id;
  if (!name || !validName(name) || !orgId) return;
  const domain = name + '.pl';
  const availability = await rdapStatus(name);
  const { data: ins, error } = await db.from('domain_orders').insert({ org_id: orgId, plan_id: s.metadata?.plan_id ?? null, domain, availability }).select('id').single();
  if (error) { if (error.code === '23505') return; throw error; } // 23505: already recorded by an earlier delivery of this event
  const orderId = ins.id as string;

  const { data: o } = await db.from('organizations').select('name, country, vat_id, address_line, city, postal_code, phone, region').eq('id', orgId).single();
  const email = s.customer_details?.email ?? '';

  // Automatic purchase: never let a failure here break the webhook (a retry must not buy twice).
  let reg: Reg | null = null;
  if (Deno.env.get('HOSTINGER_AUTO_REGISTER') === 'true' && availability === 'free' && o) {
    try {
      const { data: m } = await db.from('members').select('user_id').eq('org_id', orgId).eq('role', 'owner').limit(1).maybeSingle();
      const { data: pr } = m ? await db.from('profiles').select('full_name').eq('user_id', m.user_id).maybeSingle() : { data: null };
      const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
      const { count } = await db.from('domain_orders').select('id', { count: 'exact', head: true }).eq('auto', true).gte('created_at', start.toISOString());
      reg = await autoRegisterPl({ name, org: o as OrgData, fullName: pr?.full_name ?? null, email, monthCount: count ?? 0 });
      await db.from('domain_orders').update({
        auto: reg.outcome !== 'manual', whois_id: reg.whoisId ?? null, order_ref: reg.orderRef ?? null, notes: reg.message,
        status: reg.outcome === 'registered' ? 'registered' : 'pending', registered_at: reg.outcome === 'registered' ? new Date().toISOString() : null,
      }).eq('id', orderId);
    } catch (e) { console.error('auto register failed', e); reg = { outcome: 'manual', message: 'Unexpected error: ' + String(e).slice(0, 120) }; }
  }

  const row = (k: string, v?: string | null) => `<tr><td style="padding:4px 14px 4px 0;color:#666">${esc(k)}</td><td>${esc(v || '-')}</td></tr>`;
  const done = reg?.outcome === 'registered', processing = reg?.outcome === 'processing';
  const headline = done ? `Registered ${domain} automatically` : processing ? `Check ${domain} in hPanel` : `Register ${domain} for ${o?.name ?? 'a new customer'}`;
  await sendEmail({
    to: NOTIFY, replyTo: email || undefined, subject: headline,
    html: layout(headline, `
      ${done ? `<p style="color:#2F7D55"><b>Done.</b> The domain was bought through the Hostinger API${reg?.orderRef ? ` (order ${esc(reg.orderRef)})` : ''}. Nothing else to do.</p>` : ''}
      ${processing ? `<p style="color:#B3392C"><b>Check hPanel:</b> ${esc(reg!.message)}. Do not buy it again until you have checked.</p>` : ''}
      ${reg?.outcome === 'manual' ? `<p><b>Automatic registration did not run:</b> ${esc(reg.message)}.</p>` : ''}
      ${availability === 'taken' ? '<p style="color:#B3392C"><b>Heads up:</b> the registry now shows this name as already registered. Contact the customer for another name.</p>' : ''}
      ${availability === 'unknown' ? '<p><b>Note:</b> the registry check did not answer. Check availability in Hostinger first.</p>' : ''}
      ${done ? '' : '<p>Register the domain in Hostinger in <b>the customer\'s company name</b>, then set the order to registered.</p>'}
      <table style="font-size:14px;border-collapse:collapse">${row('Domain', domain)}${row('Availability now', availability)}${row('Company', o?.name)}${row('Country', o?.country)}${row('Voivodeship', o?.region)}${row('Tax / VAT ID', o?.vat_id)}${row('Address', [o?.address_line, o?.postal_code, o?.city].filter(Boolean).join(', '))}${row('Phone', o?.phone)}${row('Customer email', email)}</table>
      <p style="font-size:13px;color:#666">Order row: <code>domain_orders</code> id ${esc(orderId)}. Set status to <code>registered</code> when done.</p>`),
  });
  if (email) {
    await sendEmail({
      to: email, subject: done ? `Your domain ${domain} is registered` : 'Your plan is active: we are registering your domain',
      html: layout(done ? 'Your domain is registered' : 'Your plan is active',
        done ? `<p>Good news: <b>${esc(domain)}</b> is registered in your company's name. We are connecting it to your store.</p>`
             : `<p>Thank you. We are registering <b>${esc(domain)}</b> for you and will confirm within one working day. If the name is no longer available we will contact you first.</p>`),
    });
  }
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
          await createDomainOrder(s);
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
});

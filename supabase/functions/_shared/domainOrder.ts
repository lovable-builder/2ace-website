import { sendEmail, layout, esc } from './email.ts';
import { validName, rdapStatus } from './domain.ts';
import { autoRegisterPl, type Reg, type OrgData } from './hostinger.ts';
import { admin as db } from './auth.ts';

const NOTIFY = Deno.env.get('LEAD_NOTIFY_TO') ?? 'warsaw@2ace.eu';

// After payment, record the domain this plan needs. With HOSTINGER_AUTO_REGISTER=true we try to buy it
// automatically (safe fallbacks inside autoRegisterPl); otherwise, or on any problem, the team registers it by hand.
export async function createDomainOrder(o: { orgId: string; planId?: string | null; name: string; email: string; sessionId?: string | null }) {
  const { name, orgId, email } = o;
  if (!name || !validName(name) || !orgId) return;
  const domain = name + '.pl';
  const availability = await rdapStatus(name);
  const { data: ins, error } = await db.from('domain_orders').insert({ org_id: orgId, plan_id: o.planId ?? null, domain, availability, session_id: o.sessionId ?? null }).select('id').single();
  if (error) { if (error.code === '23505') return; throw error; } // 23505: already recorded by an earlier delivery of this event
  const orderId = ins.id as string;

  const { data: org } = await db.from('organizations').select('name, country, vat_id, address_line, city, postal_code, phone, region').eq('id', orgId).single();

  // Automatic purchase: never let a failure here break the webhook (a retry must not buy twice).
  let reg: Reg | null = null;
  if (Deno.env.get('HOSTINGER_AUTO_REGISTER') === 'true' && availability === 'free' && org) {
    try {
      const { data: m } = await db.from('members').select('user_id').eq('org_id', orgId).eq('role', 'owner').limit(1).maybeSingle();
      const { data: pr } = m ? await db.from('profiles').select('full_name').eq('user_id', m.user_id).maybeSingle() : { data: null };
      const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
      const { count } = await db.from('domain_orders').select('id', { count: 'exact', head: true }).eq('auto', true).gte('created_at', start.toISOString());
      reg = await autoRegisterPl({ name, org: org as OrgData, fullName: pr?.full_name ?? null, email, monthCount: count ?? 0 });
      await db.from('domain_orders').update({
        auto: reg.outcome !== 'manual', whois_id: reg.whoisId ?? null, order_ref: reg.orderRef ?? null, notes: reg.message,
        status: reg.outcome === 'registered' ? 'registered' : 'pending', registered_at: reg.outcome === 'registered' ? new Date().toISOString() : null,
      }).eq('id', orderId);
    } catch (e) { console.error('auto register failed', e); reg = { outcome: 'manual', message: 'Unexpected error: ' + String(e).slice(0, 120) }; }
  }

  const row = (k: string, v?: string | null) => `<tr><td style="padding:4px 14px 4px 0;color:#666">${esc(k)}</td><td>${esc(v || '-')}</td></tr>`;
  const done = reg?.outcome === 'registered', processing = reg?.outcome === 'processing';
  const headline = done ? `Registered ${domain} automatically` : processing ? `Check ${domain} in hPanel` : `Register ${domain} for ${org?.name ?? 'a new customer'}`;
  await sendEmail({
    to: NOTIFY, replyTo: email || undefined, subject: headline,
    html: layout(headline, `
      ${done ? `<p style="color:#2F7D55"><b>Done.</b> The domain was bought through the Hostinger API${reg?.orderRef ? ` (order ${esc(reg.orderRef)})` : ''}. Nothing else to do.</p>` : ''}
      ${processing ? `<p style="color:#B3392C"><b>Check hPanel:</b> ${esc(reg!.message)}. Do not buy it again until you have checked.</p>` : ''}
      ${reg?.outcome === 'manual' ? `<p><b>Automatic registration did not run:</b> ${esc(reg.message)}.</p>` : ''}
      ${availability === 'taken' ? '<p style="color:#B3392C"><b>Heads up:</b> the registry now shows this name as already registered. Contact the customer for another name.</p>' : ''}
      ${availability === 'unknown' ? '<p><b>Note:</b> the registry check did not answer. Check availability in Hostinger first.</p>' : ''}
      ${done ? '' : '<p>Register the domain in Hostinger in <b>the customer\'s company name</b>, then set the order to registered.</p>'}
      <table style="font-size:14px;border-collapse:collapse">${row('Domain', domain)}${row('Availability now', availability)}${row('Company', org?.name)}${row('Country', org?.country)}${row('Voivodeship', org?.region)}${row('Tax / VAT ID', org?.vat_id)}${row('Address', [org?.address_line, org?.postal_code, org?.city].filter(Boolean).join(', '))}${row('Phone', org?.phone)}${row('Customer email', email)}</table>
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


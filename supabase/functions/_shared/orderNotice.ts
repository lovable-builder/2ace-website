import { admin } from './auth.ts';
import { sendEmail, layout, esc } from './email.ts';

const SITE = Deno.env.get('SITE_URL') ?? 'https://2ace.pl';
const TEAM_INBOX = Deno.env.get('LEAD_NOTIFY_TO') ?? 'hello@2ace.pl';

// Tell the customer (and our inbox) once that an order is on hold because stock is short. The flag is claimed first, so a retry never emails twice.
export async function notifyHeld(orderIds: string[]): Promise<number> {
  if (!orderIds.length) return 0;
  const { data: claimed } = await admin.from('orders').update({ held_notified_at: new Date().toISOString() })
    .in('id', orderIds.slice(0, 200)).eq('status', 'held').is('held_notified_at', null).select('id, ref, external_ref, org_id, hold_reason, ship_name');
  for (const o of claimed ?? []) {
    const { data: m } = await admin.from('members').select('user_id, organizations(name)').eq('org_id', o.org_id).eq('role', 'owner').limit(1).maybeSingle();
    const { data: p } = m ? await admin.from('profiles').select('email').eq('user_id', m.user_id).maybeSingle() : { data: null };
    const org = (m?.organizations as unknown as { name?: string } | null)?.name ?? 'a customer';
    const label = o.external_ref ? `${o.ref} (your reference ${o.external_ref})` : o.ref;
    if (p?.email) await sendEmail({ to: p.email as string, subject: `Order ${o.ref} is on hold: not enough stock`,
      html: layout('Your order is on hold', `<p>Order <b>${esc(label)}</b> for ${esc(o.ship_name)} cannot be reserved yet:</p><p><b>${esc(o.hold_reason ?? 'not enough stock')}</b></p><p>Nothing was reserved. As soon as the stock is on our shelves, the order is reserved automatically. To add stock, book a delivery in your dashboard under Inbound.</p><p><a href="${SITE}/app/dashboard/orders">Open your dashboard</a></p>`) });
    await sendEmail({ to: TEAM_INBOX, subject: `Order ${o.ref} on hold (${org})`,
      html: layout('An order is on hold', `<p><b>${esc(org)}</b>: order ${esc(o.ref)} is short of stock: ${esc(o.hold_reason ?? '')}.</p><p><a href="${SITE}/admin#orders/${o.id}">Open the order</a></p>`) });
  }
  return claimed?.length ?? 0;
}

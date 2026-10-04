import { corsHeaders, json } from '../_shared/cors.ts';
import { admin, staffCaller, audit, type StaffCtx, type StaffRole } from '../_shared/auth.ts';
import { sendEmail, layout, esc } from '../_shared/email.ts';
import { retryAutoRegister } from '../_shared/domainOrder.ts';
import Stripe from 'npm:stripe';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);

// One endpoint for every staff action. Reads happen in the browser under RLS; everything that CHANGES data goes through here:
// role-checked, validated, and written to the audit log before we answer.
const SITE = Deno.env.get('SITE_URL') ?? 'https://2ace.pl';
const TEAM_INBOX = Deno.env.get('LEAD_NOTIFY_TO') ?? 'warsaw@2ace.eu';
const ORG_STATUS = ['pending', 'active', 'past_due', 'canceled'];
const DOMAIN_STATUS = ['pending', 'registered', 'failed', 'cancelled'];
const REQ_STATUS = ['new', 'open', 'waiting', 'resolved'];
const PRIORITY = ['low', 'normal', 'high'];
const ROLES: StaffRole[] = ['admin', 'support', 'warehouse'];
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
const text = (v: unknown, max = 4000) => String(v ?? '').trim().slice(0, max);
class Bad extends Error { constructor(m: string, public status = 400) { super(m); } }

// Who to email about an organization: its owner.
async function ownerOf(orgId: string) {
  const { data: m } = await admin.from('members').select('user_id').eq('org_id', orgId).eq('role', 'owner').limit(1).maybeSingle();
  if (!m) return null;
  const { data: p } = await admin.from('profiles').select('full_name, email').eq('user_id', m.user_id).maybeSingle();
  return p ? { name: p.full_name as string | null, email: p.email as string | null } : null;
}

const actions: Record<string, { roles?: StaffRole[]; run: (s: StaffCtx, b: Record<string, unknown>) => Promise<unknown> }> = {
  me: { run: async (s) => ({ id: s.user.id, role: s.role, email: s.user.email }) },

  // ---------- staff management (admin) ----------
  'staff.list': { roles: ['admin'], run: async () => {
    const { data: rows } = await admin.from('staff_users').select('user_id, role, active, created_at').order('created_at');
    const out = [];
    for (const r of rows ?? []) { const { data } = await admin.auth.admin.getUserById(r.user_id); out.push({ ...r, email: data?.user?.email ?? null }); }
    return { staff: out };
  } },
  'staff.directory': { roles: ['admin', 'support'], run: async () => {
    const { data: rows } = await admin.from('staff_users').select('user_id, role, active');
    const out = [];
    for (const r of rows ?? []) { const { data } = await admin.auth.admin.getUserById(r.user_id); out.push({ user_id: r.user_id, role: r.role, active: r.active, email: data?.user?.email ?? null }); }
    return { staff: out };
  } },
  'staff.invite': { roles: ['admin'], run: async (s, b) => {
    const email = text(b.email, 200).toLowerCase(), role = text(b.role, 20) as StaffRole;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Bad('Enter a valid email');
    if (!ROLES.includes(role)) throw new Bad('Choose a role');
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    let uid = list?.users.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
    let invited = false;
    if (!uid) {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: SITE + '/admin' });
      if (error || !data.user) throw new Bad('Could not send the invitation: ' + (error?.message ?? 'unknown'), 502);
      uid = data.user.id; invited = true;
    }
    const { data: prev } = await admin.from('staff_users').select('role, active').eq('user_id', uid).maybeSingle();
    const { error } = await admin.from('staff_users').upsert({ user_id: uid, role, active: true, created_by: s.user.id });
    if (error) throw new Error(error.message);
    await audit(s, prev ? 'staff.change_role' : 'staff.add', 'staff_users', uid, null, prev ?? null, { email, role, active: true });
    return { ok: true, invited };
  } },
  'staff.update': { roles: ['admin'], run: async (s, b) => {
    const uid = b.user_id; if (!isUuid(uid)) throw new Bad('Invalid user');
    const { data: cur } = await admin.from('staff_users').select('role, active').eq('user_id', uid).maybeSingle();
    if (!cur) throw new Bad('Not a staff member', 404);
    const patch: Record<string, unknown> = {};
    if (b.role !== undefined) { if (!ROLES.includes(b.role as StaffRole)) throw new Bad('Invalid role'); patch.role = b.role; }
    if (b.active !== undefined) patch.active = !!b.active;
    if (uid === s.user.id && Object.keys(patch).length) throw new Bad('You cannot change your own access. Ask another admin.');
    const wouldLoseAdmin = cur.role === 'admin' && cur.active && (patch.role && patch.role !== 'admin' || patch.active === false);
    if (wouldLoseAdmin) {
      const { count } = await admin.from('staff_users').select('user_id', { count: 'exact', head: true }).eq('role', 'admin').eq('active', true);
      if ((count ?? 0) <= 1) throw new Bad('There must always be at least one active admin');
    }
    const { error } = await admin.from('staff_users').update(patch).eq('user_id', uid);
    if (error) throw new Error(error.message);
    await audit(s, 'staff.update', 'staff_users', uid, null, cur, { ...cur, ...patch });
    return { ok: true };
  } },

  // ---------- customers ----------
  'org.setStatus': { roles: ['admin'], run: async (s, b) => {
    const orgId = b.org_id, status = text(b.status, 20), reason = text(b.reason, 500);
    if (!isUuid(orgId)) throw new Bad('Invalid organization');
    if (!ORG_STATUS.includes(status)) throw new Bad('Invalid status');
    if (reason.length < 3) throw new Bad('Give a reason for the change');
    const { data: cur } = await admin.from('organizations').select('status').eq('id', orgId).maybeSingle();
    if (!cur) throw new Bad('Organization not found', 404);
    const { error } = await admin.from('organizations').update({ status }).eq('id', orgId);
    if (error) throw new Error(error.message);
    await audit(s, 'org.set_status', 'organizations', orgId, orgId, { status: cur.status }, { status }, reason);
    return { ok: true };
  } },
  // Stripe invoices for a customer (read-only, audited). Resend = email the hosted invoice link through Resend.
  'org.invoices': { roles: ['admin', 'support'], run: async (s, b) => {
    const orgId = b.org_id; if (!isUuid(orgId)) throw new Bad('Invalid organization');
    const { data: o } = await admin.from('organizations').select('stripe_customer_id').eq('id', orgId).maybeSingle();
    if (!o) throw new Bad('Organization not found', 404);
    if (!o.stripe_customer_id) return { invoices: [], customer: null };
    let list;
    try { list = await stripe.invoices.list({ customer: o.stripe_customer_id, limit: 24 }); }
    catch (e) { console.error(e); throw new Bad('Could not reach Stripe', 502); }
    await audit(s, 'org.invoices_view', 'organizations', orgId, orgId, null, null);
    return { customer: o.stripe_customer_id, invoices: list.data.filter((i) => i.status !== 'draft').map((i) => ({
      id: i.id, number: i.number, created: i.created, status: i.status, currency: i.currency, total: i.total, amount_due: i.amount_due,
      hosted_invoice_url: i.hosted_invoice_url, invoice_pdf: i.invoice_pdf })) };
  } },
  'invoice.resend': { roles: ['admin', 'support'], run: async (s, b) => {
    const orgId = b.org_id, invId = text(b.invoice_id, 100);
    if (!isUuid(orgId) || !/^in_[A-Za-z0-9]+$/.test(invId)) throw new Bad('Invalid invoice');
    const { data: o } = await admin.from('organizations').select('stripe_customer_id').eq('id', orgId).maybeSingle();
    if (!o?.stripe_customer_id) throw new Bad('Customer has no billing account', 404);
    let inv;
    try { inv = await stripe.invoices.retrieve(invId); } catch { throw new Bad('Invoice not found', 404); }
    if (inv.customer !== o.stripe_customer_id) throw new Bad('Invoice does not belong to this customer', 403);   // never trust an id alone
    if (!inv.hosted_invoice_url) throw new Bad('This invoice has no online link');
    const owner = await ownerOf(orgId);
    if (!owner?.email) throw new Bad('No owner email on file');
    const ok = await sendEmail({ to: owner.email, subject: `Invoice ${inv.number ?? ''} from 2ACE`.trim(),
      html: layout('Your invoice', `<p>Here is your invoice${inv.number ? ' <b>' + esc(inv.number) + '</b>' : ''}.</p><p><a href="${esc(inv.hosted_invoice_url)}" style="display:inline-block;background:#FF6A1A;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:700">View invoice</a></p>`) });
    if (!ok) throw new Bad('Email could not be sent', 502);
    await audit(s, 'invoice.resend', 'organizations', orgId, orgId, null, { invoice: invId, to: owner.email });
    return { ok: true, to: owner.email };
  } },
  'viewas.start': { roles: ['admin', 'support'], run: async (s, b) => {
    const orgId = b.org_id, reason = text(b.reason, 500);
    if (!isUuid(orgId)) throw new Bad('Invalid organization');
    if (reason.length < 3) throw new Bad('Say why you are opening this customer, for the audit log');
    await audit(s, 'impersonate_view', 'organizations', orgId, orgId, null, null, reason);
    return { ok: true };
  } },

  // ---------- domain queue ----------
  'domain.update': { roles: ['admin', 'support'], run: async (s, b) => {
    const id = b.id, status = text(b.status, 20);
    if (!isUuid(id)) throw new Bad('Invalid order');
    if (!DOMAIN_STATUS.includes(status)) throw new Bad('Invalid status');
    const { data: cur } = await admin.from('domain_orders').select('*').eq('id', id).maybeSingle();
    if (!cur) throw new Bad('Order not found', 404);
    const patch: Record<string, unknown> = { status };
    if (b.notes !== undefined) patch.notes = text(b.notes, 1000) || null;
    if (b.order_ref !== undefined) patch.order_ref = text(b.order_ref, 100) || null;
    patch.registered_at = status === 'registered' ? (cur.registered_at ?? new Date().toISOString()) : null;
    const { error } = await admin.from('domain_orders').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
    await audit(s, 'domain.update', 'domain_orders', id, cur.org_id, { status: cur.status, notes: cur.notes, order_ref: cur.order_ref }, patch);
    if (status === 'registered' && cur.status !== 'registered') {   // tell the customer once
      const o = await ownerOf(cur.org_id);
      if (o?.email) await sendEmail({ to: o.email, subject: `Your domain ${cur.domain} is registered`, html: layout('Your domain is registered', `<p><b>${esc(cur.domain)}</b> is registered in your company's name. We are connecting it to your store.</p>`) });
    }
    return { ok: true };
  } },
  'domain.retry': { roles: ['admin', 'support'], run: async (s, b) => {
    const id = b.id; if (!isUuid(id)) throw new Bad('Invalid order');
    const { data: cur } = await admin.from('domain_orders').select('org_id, status').eq('id', id).maybeSingle();
    if (!cur) throw new Bad('Order not found', 404);
    const reg = await retryAutoRegister(id);
    await audit(s, 'domain.retry_auto', 'domain_orders', id, cur.org_id, { status: cur.status }, { outcome: reg.outcome, message: reg.message });
    return { outcome: reg.outcome, message: reg.message };
  } },

  // ---------- requests inbox ----------
  'request.update': { roles: ['admin', 'support'], run: async (s, b) => {
    const id = b.request_id; if (!isUuid(id)) throw new Bad('Invalid request');
    const { data: cur } = await admin.from('requests').select('status, priority, assignee, org_id').eq('id', id).maybeSingle();
    if (!cur) throw new Bad('Request not found', 404);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (b.status !== undefined) { if (!REQ_STATUS.includes(text(b.status, 20))) throw new Bad('Invalid status'); patch.status = b.status; }
    if (b.priority !== undefined) { if (!PRIORITY.includes(text(b.priority, 20))) throw new Bad('Invalid priority'); patch.priority = b.priority; }
    if (b.assignee !== undefined) {
      if (b.assignee !== null && !isUuid(b.assignee)) throw new Bad('Invalid assignee');
      if (b.assignee) { const { data: st } = await admin.from('staff_users').select('active').eq('user_id', b.assignee).maybeSingle(); if (!st?.active) throw new Bad('That person is not active staff'); }
      patch.assignee = b.assignee;
    }
    const { error } = await admin.from('requests').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
    await audit(s, 'request.update', 'requests', id, cur.org_id, cur, patch);
    if (b.assignee && b.assignee !== cur.assignee && b.assignee !== s.user.id) {   // tell the new owner (not yourself)
      const { data: who } = await admin.auth.admin.getUserById(b.assignee as string);
      const { data: rq } = await admin.from('requests').select('subject, requester_name').eq('id', id).maybeSingle();
      if (who?.user?.email) await sendEmail({ to: who.user.email, subject: `Assigned to you: ${rq?.subject ?? 'request'}`,
        html: layout('A request was assigned to you', `<p><b>${esc(rq?.subject ?? '')}</b>${rq?.requester_name ? ' from ' + esc(rq.requester_name) : ''}.</p><p><a href="${SITE}/admin#requests/${id}">Open it in the admin panel</a></p>`) });
    }
    return { ok: true };
  } },
  'request.message': { roles: ['admin', 'support'], run: async (s, b) => {
    const id = b.request_id; if (!isUuid(id)) throw new Bad('Invalid request');
    const kind = text(b.kind, 10), body = text(b.body);
    if (!['reply', 'note', 'incoming'].includes(kind)) throw new Bad('Invalid message type');
    if (body.length < 2) throw new Bad('Write a message first');
    const { data: r } = await admin.from('requests').select('id, org_id, subject, requester_name, requester_email, status').eq('id', id).maybeSingle();
    if (!r) throw new Bad('Request not found', 404);
    const direction = kind === 'reply' ? 'out' : kind === 'note' ? 'note' : 'in';
    if (kind === 'reply' && !r.requester_email) throw new Bad('This request has no email address to reply to');
    const { error } = await admin.from('request_messages').insert({ request_id: id, direction, author_id: s.user.id, body });
    if (error) throw new Error(error.message);
    const patch: Record<string, unknown> = { last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (kind === 'reply') patch.status = 'waiting';
    if (kind === 'incoming' && r.status !== 'new') patch.status = 'open';
    await admin.from('requests').update(patch).eq('id', id);
    await audit(s, 'request.' + kind, 'requests', id, r.org_id, null, { length: body.length });
    if (kind === 'reply') {
      await sendEmail({
        to: r.requester_email!, replyTo: TEAM_INBOX, subject: `Re: ${r.subject}`,
        html: layout(r.subject, `<p style="white-space:pre-wrap">${esc(body)}</p><p style="font-size:13px;color:#666;margin-top:20px">Reply to this email to continue the conversation.</p>`),
      });
    }
    return { ok: true };
  } },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method' }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }
  const act = actions[String(b.action ?? '')];
  if (!act) return json(req, { error: 'unknown action' }, 400);
  const s = await staffCaller(req, act.roles);
  if ('error' in s) return json(req, { error: s.error }, s.status);
  try { return json(req, await act.run(s, b)); }
  catch (e) {
    if (e instanceof Bad) return json(req, { error: e.message }, e.status);
    console.error('admin-api', b.action, e);
    return json(req, { error: 'Something went wrong. Nothing was changed if you see this twice, tell the developer.' }, 500);
  }
});

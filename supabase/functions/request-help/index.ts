import { corsHeaders, json } from '../_shared/cors.ts';
import { admin, caller } from '../_shared/auth.ts';
import { sendEmail, layout, esc } from '../_shared/email.ts';

// A logged-in customer sends a request from the dashboard. The topic comes from a fixed list.
const NOTIFY = Deno.env.get('LEAD_NOTIFY_TO') ?? 'warsaw@2ace.eu';
const SUBJECTS: Record<string, string> = {
  inbound: 'Book an inbound delivery', products: 'Add my products', imports: 'Import and customs quote',
  team: 'Add team members', domain: 'Domain question', plan: 'Change my plan', billing: 'Billing and invoices', other: 'Something else',
};
const hits = new Map<string, number[]>();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method' }, 405);
  const me = await caller(req);
  if (!me) return json(req, { error: 'unauthorized' }, 401);

  const now = Date.now(), list = (hits.get(me.user.id) ?? []).filter((t) => now - t < 3600_000);
  if (list.length >= 10) return json(req, { error: 'You have sent several requests in the last hour. Please wait a little, or email us directly.' }, 429);
  list.push(now); hits.set(me.user.id, list); if (hits.size > 5000) hits.clear();

  let b: { subject?: string; message?: string };
  try { b = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }
  const key = String(b.subject ?? 'other');
  const label = SUBJECTS[key];
  const message = String(b.message ?? '').trim().slice(0, 4000);
  if (!label) return json(req, { error: 'Choose a topic' }, 400);
  if (message.length < 5) return json(req, { error: 'Please add a few details to your message' }, 400);

  const { data: prof } = await admin.from('profiles').select('full_name').eq('user_id', me.user.id).maybeSingle();
  const name = prof?.full_name || me.user.email || 'Customer';
  const email = me.user.email ?? '';
  const company = me.orgName ?? '';
  const { data: plan } = me.orgId ? await admin.from('plans').select('monthly_pln').eq('org_id', me.orgId).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle() : { data: null };

  const { data: lead, error } = await admin.from('leads').insert({ name, email, message, subject: label, org_id: me.orgId ?? null, source: 'dashboard' }).select('id').single();
  if (error) { console.error(error); return json(req, { error: 'We could not send your request. Please try again.' }, 500); }
  // Also open an inbox request for staff (best effort: the lead is already saved).
  const { data: rq } = await admin.from('requests').insert({ org_id: me.orgId ?? null, lead_id: lead.id, requester_name: name, requester_email: email, subject: label, source: 'dashboard' }).select('id').single();
  if (rq) await admin.from('request_messages').insert({ request_id: rq.id, direction: 'in', body: message });

  // Email is best effort: the request is already saved.
  const row = (k: string, v: string) => `<tr><td style="padding:4px 14px 4px 0;color:#666">${esc(k)}</td><td>${esc(v || '-')}</td></tr>`;
  await Promise.all([
    sendEmail({
      to: NOTIFY, replyTo: email || undefined, subject: `${label}: ${company || name}`,
      html: layout(label, `<table style="font-size:14px;border-collapse:collapse">${row('Company', company)}${row('Customer', name)}${row('Email', email)}${row('Plan', plan ? plan.monthly_pln + ' PLN / month' : 'no active plan')}</table><p style="white-space:pre-wrap;margin-top:16px">${esc(message)}</p>`),
    }),
    email ? sendEmail({ to: email, subject: `We got your request: ${label}`, html: layout('We got your request', `<p>Thanks, ${esc(name.split(' ')[0])}. We received your request about <b>${esc(label)}</b> and reply within one working day.</p>`) }) : Promise.resolve(false),
  ]);
  return json(req, { ok: true });
});

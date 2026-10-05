import { corsHeaders, json } from '../_shared/cors.ts';
import { admin, caller, userClient } from '../_shared/auth.ts';
import { sendEmail, layout, esc } from '../_shared/email.ts';

// A customer asks to edit or delete one of their deliveries or products. The request goes into the approval queue;
// nothing changes until a warehouse or admin user approves it. The database function does the checking, this one carries the
// customer's own identity to it and tells the team.
const SITE = Deno.env.get('SITE_URL') ?? 'https://2ace.pl';
const TEAM_INBOX = Deno.env.get('LEAD_NOTIFY_TO') ?? 'warsaw@2ace.eu';
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method' }, 405);
  const me = await caller(req);
  if (!me || !me.orgId) return json(req, { error: 'unauthorized' }, 401);
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
  let b: { action?: string; entity?: string; id?: string; kind?: string; payload?: Record<string, unknown> };
  try { b = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }
  if (!isUuid(b.id)) return json(req, { error: 'Invalid item' }, 400);
  const db = userClient(token);

  if (b.action === 'cancel') {
    const { error } = await db.rpc('cancel_change', { p_id: b.id });
    if (error) return json(req, { error: error.message }, 400);
    return json(req, { ok: true });
  }

  const entity = String(b.entity ?? ''), kind = String(b.kind ?? '');
  const { data, error } = await db.rpc('request_change', { p_entity: entity, p_id: b.id, p_action: kind, p_payload: b.payload ?? {} });
  if (error) return json(req, { error: error.message }, 400);
  const { data: row } = await admin.from('change_requests').select('summary').eq('id', data as string).maybeSingle();
  const summary = String(row?.summary ?? 'Change request');
  await sendEmail({ to: TEAM_INBOX, subject: `Change request: ${summary} (${me.orgName ?? 'customer'})`,
    html: layout('A customer asked for a change', `<p><b>${esc(me.orgName ?? 'A customer')}</b> asks to: ${esc(summary)}.</p><p>Nothing has changed yet.</p><p><a href="${SITE}/admin#approvals">Review it in the admin panel</a></p>`) });
  return json(req, { ok: true, id: data });
});

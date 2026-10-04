import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';
import { sendEmail, layout, esc } from '../_shared/email.ts';

const NOTIFY = Deno.env.get('LEAD_NOTIFY_TO') ?? 'warsaw@2ace.eu';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method' }, 405);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }

  if (b.website) return json(req, { ok: true }); // honeypot: bots fill hidden fields
  const name = String(b.name ?? '').trim().slice(0, 200);
  const email = String(b.email ?? '').trim().slice(0, 200);
  const message = String(b.message ?? '').trim().slice(0, 4000);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(req, { error: 'invalid' }, 400);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: lead, error } = await db.from('leads').insert({ name, email, message }).select('id').single();
  if (error) { console.error(error); return json(req, { error: 'server' }, 500); }
  // Also open an inbox request for staff (best effort: the lead is already saved).
  const { data: rq } = await db.from('requests').insert({ lead_id: lead.id, requester_name: name, requester_email: email, subject: 'Message from the website', source: 'website' }).select('id').single();
  if (rq && message) await db.from('request_messages').insert({ request_id: rq.id, direction: 'in', body: message });
  // Email is best effort: a mail failure must not lose the lead (it is already saved).
  await Promise.all([
    sendEmail({ to: NOTIFY, replyTo: email, subject: `New lead: ${name}`, html: layout('New lead from 2ace.pl', `<p><b>${esc(name)}</b> (${esc(email)})</p><p style="white-space:pre-wrap">${esc(message || '(no message)')}</p>`) }),
    sendEmail({ to: email, subject: 'We got your message | 2ACE', html: layout(`Thanks, ${name.split(' ')[0]}`, '<p>We received your message. A person who runs the floor replies within one working day.</p>') }),
  ]);
  return json(req, { ok: true });
});

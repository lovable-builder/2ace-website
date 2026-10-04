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
  const { error } = await db.from('leads').insert({ name, email, message });
  if (error) { console.error(error); return json(req, { error: 'server' }, 500); }
  // Email is best effort: a mail failure must not lose the lead (it is already saved).
  await Promise.all([
    sendEmail({ to: NOTIFY, replyTo: email, subject: `New lead: ${name}`, html: layout('New lead from 2ace.pl', `<p><b>${esc(name)}</b> (${esc(email)})</p><p style="white-space:pre-wrap">${esc(message || '(no message)')}</p>`) }),
    sendEmail({ to: email, subject: 'We got your message | 2ACE', html: layout(`Thanks, ${name.split(' ')[0]}`, '<p>We received your message. A person who runs the floor replies within one working day.</p>') }),
  ]);
  return json(req, { ok: true });
});

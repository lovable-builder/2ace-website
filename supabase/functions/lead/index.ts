import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

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
  return json(req, { ok: true });
});

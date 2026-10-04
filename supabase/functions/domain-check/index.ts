import { corsHeaders, json } from '../_shared/cors.ts';
import { validName as valid, cleanName, rdapStatus, type DomainStatus } from '../_shared/domain.ts';

// Free .pl availability check against NASK's public RDAP service. The answer is "probably free":
// reserved names are only caught by the registrar at order time.
type Status = DomainStatus;

const cache = new Map<string, { s: Status; t: number }>();
const TTL = 5 * 60 * 1000;
const hits = new Map<string, number[]>();

function limited(ip: string) {
  const now = Date.now(), list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 30;
}

async function lookup(name: string): Promise<Status> {
  const c = cache.get(name);
  if (c && Date.now() - c.t < TTL) return c.s;
  const s: Status = await rdapStatus(name);
  if (s !== 'unknown') cache.set(name, { s, t: Date.now() });
  if (cache.size > 2000) cache.clear();
  return s;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method' }, 405);
  if (limited(req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'x')) return json(req, { error: 'Too many checks. Please wait a minute.' }, 429);

  let b: { name?: string };
  try { b = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }
  const name = cleanName(b.name);
  if (!valid(name)) return json(req, { status: 'invalid', name });

  const status = await lookup(name);
  let alternatives: string[] = [];
  if (status === 'taken') {
    const cands = [`${name}-sklep`, `${name}-shop`, `moje${name}`, `${name}pl`].filter(valid);
    const res = await Promise.all(cands.map(async (c) => [c, await lookup(c)] as const));
    alternatives = res.filter(([, s]) => s === 'free').map(([c]) => c).slice(0, 3);
  }
  return json(req, { status, name, alternatives });
});

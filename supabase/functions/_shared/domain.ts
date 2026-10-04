// .pl domain helpers shared by domain-check, create-checkout and stripe-webhook.
const RDAP = 'https://rdap.dns.pl/domain/';
export type DomainStatus = 'free' | 'taken' | 'unknown';

// Letters, digits and hyphens, 2-63 chars, no leading/trailing hyphen, no "--" except punycode.
export function validName(n: string) {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(n) && n.length >= 2 && (!n.includes('--') || n.startsWith('xn--'));
}
export const cleanName = (raw: unknown) => String(raw ?? '').trim().toLowerCase().replace(/\.pl$/, '');

// NASK's public RDAP: 200 = registered, 404 = not registered. Anything else is "unknown".
export async function rdapStatus(name: string): Promise<DomainStatus> {
  try {
    const r = await fetch(RDAP + name + '.pl', { headers: { accept: 'application/rdap+json' }, signal: AbortSignal.timeout(6000) });
    await r.body?.cancel();
    if (r.status === 200) return 'taken';
    if (r.status === 404) return 'free';
  } catch (e) { console.error('rdap failed', name, String(e)); }
  return 'unknown';
}

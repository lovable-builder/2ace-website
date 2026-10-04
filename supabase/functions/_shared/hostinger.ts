// Automatic .pl registration through the Hostinger API. Every step before the purchase is free and fails
// safe to "manual" (the team gets an email). Only the final purchase spends money, behind a monthly cap.
const BASE = 'https://developers.hostinger.com';
const REGIONS = ['Dolnośląskie', 'Kujawsko-pomorskie', 'Lubelskie', 'Lubuskie', 'Łódzkie', 'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie', 'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-mazurskie', 'Wielkopolskie', 'Zachodniopomorskie'];

export type Reg = { outcome: 'registered' | 'processing' | 'manual'; message: string; whoisId?: number; orderRef?: string };
export type OrgData = { name: string; country: string | null; address_line: string | null; city: string | null; postal_code: string | null; phone: string | null; region: string | null };

async function api(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method, signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

// First error lines from a Hostinger 422, so the team email says why it needs manual handling.
function why(data: any): string {
  const errs = data?.errors ? Object.values(data.errors).flat().map((m) => String(m).slice(0, 110)).slice(0, 4).join(' | ') : '';
  return String(data?.message ?? 'rejected').slice(0, 140) + (errs ? ' :: ' + errs : '');
}

// Polish phone only for now: +48 / 0048 / 9 digits.
function plPhone(raw: string | null): string | null {
  const d = String(raw ?? '').replace(/[\s().-]/g, '').replace(/^\+/, '').replace(/^00/, '');
  if (/^48\d{9}$/.test(d)) return d.slice(2);
  if (/^\d{9}$/.test(d)) return d;
  return null;
}

export async function autoRegisterPl(opts: {
  name: string; org: OrgData; fullName: string | null; email: string; monthCount: number;
}): Promise<Reg> {
  const token = Deno.env.get('HOSTINGER_API_TOKEN');
  const manual = (message: string): Reg => ({ outcome: 'manual', message });
  if (!token) return manual('No Hostinger token configured');
  const cap = Number(Deno.env.get('HOSTINGER_MONTHLY_CAP') ?? 10);
  if (opts.monthCount >= cap) return manual(`Monthly automatic-purchase cap reached (${cap})`);

  const { org } = opts;
  if (org.country !== 'PL') return manual('Registrant is not in Poland: automatic registration supports Polish companies only');
  const names = String(opts.fullName ?? '').trim().split(/\s+/);
  if (names.length < 2) return manual('Need a first and last name for the contact (account has: "' + (opts.fullName ?? '') + '")');
  if (!org.region || !REGIONS.includes(org.region)) return manual('Voivodeship missing or unrecognised: ' + (org.region ?? 'none'));
  const zip = String(org.postal_code ?? '').replace(/^(\d{2})(\d{3})$/, '$1-$2');
  if (!/^\d{2}-\d{3}$/.test(zip)) return manual('Postal code must look like 00-000, got: ' + (org.postal_code ?? 'none'));
  const phone = plPhone(org.phone);
  if (!phone) return manual('Phone must be a Polish number (9 digits, optional +48), got: ' + (org.phone ?? 'none'));
  if (!org.address_line || !org.city) return manual('Street address or city missing');

  let sent = false;
  try {
    // 1. Free: authoritative availability from the registrar.
    const av = await api(token, 'POST', '/api/domains/v1/availability', { domain: opts.name, tlds: ['pl'] });
    const hit = Array.isArray(av.data) ? av.data.find((x: any) => x.domain === opts.name + '.pl') : null;
    if (av.status !== 200 || !hit) return manual('Availability check failed: ' + why(av.data));
    if (!hit.is_available) return manual('Registrar says not available' + (hit.restriction ? ': ' + hit.restriction : ''));

    // 2. Free: find the 1-year .pl price item and check the price ceiling.
    const cat = await api(token, 'GET', '/api/billing/v1/catalog?category=DOMAIN&name=.PL*');
    const item = Array.isArray(cat.data) ? cat.data.find((i: any) => i.id === 'hostingerpl-domain-pl') : null;
    const price = item?.prices?.find((p: any) => p.period === 1 && p.period_unit === 'year' && p.currency === 'PLN');
    if (!price) return manual('Could not find the 1-year .pl price in the catalog');
    const maxCents = Math.round(Number(Deno.env.get('HOSTINGER_MAX_FIRST_YEAR_PLN') ?? 60) * 100);
    if (price.first_period_price > maxCents) return manual(`First-year price ${price.first_period_price / 100} PLN is above the ${maxCents / 100} PLN ceiling`);

    // 3. Free: create the registrant contact. Hostinger validates it here; any problem falls back to manual.
    const w = await api(token, 'POST', '/api/domains/v1/whois', {
      tld: 'pl', entity_type: 'organization', country: 'PL',
      whois_details: {
        first_name: names[0], last_name: names.slice(1).join(' '), email: opts.email, company_name: org.name,
        address: org.address_line, city: org.city, country_code: 'PL', phone_cc: '48', phone_number: phone, state_pl: org.region, zip_pl: zip,
      },
      tld_details: { source: '2ace' },
    });
    const whoisId = w.data?.id;
    if (w.status !== 200 || !whoisId) return manual('Contact rejected by Hostinger: ' + why(w.data));

    // 4. The only step that spends money.
    sent = true;
    const p = await api(token, 'POST', '/api/domains/v1/portfolio', {
      domain: opts.name + '.pl', item_id: price.id,
      domain_contacts: { owner_id: whoisId, admin_id: whoisId, billing_id: whoisId, tech_id: whoisId },
    });
    if (p.status === 200) return { outcome: 'registered', message: 'Registered automatically', whoisId, orderRef: String(p.data?.id ?? '') };
    if (p.status === 202) return { outcome: 'processing', message: 'Payment is processing at Hostinger; confirm in hPanel', whoisId, orderRef: String(p.data?.id ?? '') };
    return { outcome: 'manual', message: 'Purchase refused: ' + why(p.data), whoisId };
  } catch (e) {
    if (!sent) return manual('Hostinger call failed before purchase: ' + String(e).slice(0, 100));
    // The purchase request may or may not have gone through: tell the team to check hPanel instead of retrying.
    return { outcome: 'processing', message: 'Hostinger call failed midway (' + String(e).slice(0, 100) + '). Check hPanel before retrying.' };
  }
}

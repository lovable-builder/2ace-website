import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { config } from '../lib/config';
import { currentSession, freshSession, signOut as clearSession, type Session } from '../lib/session';
import { publicLogoUrl } from '../lib/api';
import type { PlanConfig } from '../lib/pricing';

// Who is signed in, their company, its status and active plan. Loaded once at start and again after a plan change or payment.
export type Account = {
  session: Session | null;
  loaded: boolean;              // the company lookup has finished (or there is no session)
  email: string;
  userName: string;
  orgId: string;
  role: string;
  orgName: string;
  orgCountry: string;
  orgVat: string;
  activated: boolean;           // the company's plan is paid and live
  logoUrl: string;
  hasDomain: boolean;
  domainName: string;
  domainOffer: boolean;         // an active owner/finance member without a domain: offer one
  curPlan: { config: PlanConfig; monthly: number } | null;
};

const EMPTY: Omit<Account, 'session' | 'loaded' | 'email'> = {
  userName: '', orgId: '', role: '', orgName: '', orgCountry: '', orgVat: '', activated: false, logoUrl: '',
  hasDomain: false, domainName: '', domainOffer: false, curPlan: null,
};

type Ctx = Account & { reload: () => Promise<Account>; signOut: () => void };
const AccountContext = createContext<Ctx | null>(null);

type OrgRow = { org_id: string; role: string; organizations: { name: string; country: string | null; vat_id: string | null; logo_path: string | null; status: string; domain_orders: { domain: string; status: string }[] | null } | null };

// Reads through the REST API with the person's token. A failed read is treated as "nothing there": the header is not worth an error page.
async function load(s: Session): Promise<Account> {
  const c = config();
  const H = { apikey: c.supabaseAnonKey, Authorization: 'Bearer ' + s.access_token };
  const get = <T,>(path: string): Promise<T[]> => fetch(c.supabaseUrl + '/rest/v1/' + path, { headers: H }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const uid = s.user.id;
  const [m, pr] = await Promise.all([
    get<OrgRow>('members?select=org_id,role,organizations(name,country,vat_id,logo_path,status,domain_orders(domain,status))&user_id=eq.' + uid + '&limit=1'),
    get<{ full_name: string | null }>('profiles?select=full_name&user_id=eq.' + uid + '&limit=1'),
  ]);
  const a: Account = { ...EMPTY, session: s, loaded: true, email: s.user.email ?? '', userName: pr[0]?.full_name || '' };
  const row = m[0], o = row?.organizations;
  if (row && o) {
    const live = (o.domain_orders || []).find((d) => d.status === 'pending' || d.status === 'registered');
    a.orgId = row.org_id; a.role = row.role; a.orgName = o.name || ''; a.orgCountry = o.country || ''; a.orgVat = o.vat_id || '';
    a.activated = o.status === 'active';
    a.hasDomain = !!live; a.domainName = live ? live.domain : '';
    a.domainOffer = o.status === 'active' && (row.role === 'owner' || row.role === 'finance') && !live;
    if (o.logo_path) a.logoUrl = publicLogoUrl(o.logo_path);
    const pl = await get<{ config: PlanConfig; monthly_pln: number }>('plans?select=config,monthly_pln,once_pln&org_id=eq.' + row.org_id + '&status=eq.active&order=created_at.desc&limit=1');
    a.curPlan = pl[0] ? { config: pl[0].config, monthly: pl[0].monthly_pln } : null;
  }
  return a;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [acct, setAcct] = useState<Account>(() => {
    const s = currentSession();
    return { ...EMPTY, session: s, loaded: !s, email: s?.user.email ?? '' };
  });

  const reload = useCallback(async () => {
    const s = await freshSession();
    const next: Account = s ? await load(s) : { ...EMPTY, session: null, loaded: true, email: '' };
    setAcct(next);
    return next;
  }, []);

  // Once, at start: the session read synchronously above decides whether there is anything to load.
  const hadSession = !!acct.session;
  useEffect(() => { if (hadSession) void reload(); }, [hadSession, reload]);

  const signOut = useCallback(() => { clearSession(); setAcct({ ...EMPTY, session: null, loaded: true, email: '' }); }, []);
  const value = useMemo(() => ({ ...acct, reload, signOut }), [acct, reload, signOut]);
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): Ctx {
  const c = useContext(AccountContext);
  if (!c) throw new Error('useAccount outside AccountProvider');
  return c;
}

// The name to greet: the company without its legal suffix, else the person, else "there".
export const customerName = (company: string, a: Pick<Account, 'orgName' | 'userName'>) => {
  const co = company.trim() || a.orgName.trim();
  return co ? co.replace(/\s+sp\. z o\.o\.$/i, '') : a.userName || '';
};

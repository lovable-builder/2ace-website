import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { callFn } from '../lib/api';
import { clearPlan, restorePlan, savePlan } from '../lib/planStore';
import { planM2, STORAGE, type EstSize, type PlanConfig, type Pkgs } from '../lib/pricing';
import { COUNTRIES } from '../lib/countries';

export type DomainStatus = 'checking' | 'free' | 'taken' | 'empty' | 'unchecked' | 'invalid' | 'unknown' | 'limited';

export type PlanState = {
  qty: number;
  pkgs: Pkgs;
  storeOn: boolean;
  domain: string;
  marketOn: boolean;        // only ever true on an old plan being changed: Market is not sold to new plans
  domainStatus: DomainStatus | null;
  domainAlts: string[];
  theme: 'mono' | 'market' | 'editorial';
  langs: Record<string, boolean>;
  pays: Record<string, boolean>;
  company: string;
  country: string;
  vat: string;
  email: string;
  estUnits: number | '';
  estSize: EstSize;
  tried: boolean;           // Continue was pressed on Review with the company details incomplete
};

export const NEW_PLAN: PlanState = {
  qty: 15, pkgs: { imp: false }, storeOn: false, domain: '', marketOn: false, domainStatus: null, domainAlts: [],
  theme: 'mono', langs: { Polish: true, English: true, German: false, Czech: false },
  pays: { BLIK: true, Przelewy24: true, Cards: true, 'Apple Pay': false, PayPo: false },
  company: '', country: 'DE', vat: '', email: '', estUnits: 6000, estSize: 'medium', tried: false,
};

// A plan being changed starts from what the customer has now.
export function fromCurrent(c: PlanConfig, base: PlanState): PlanState {
  return { ...base, qty: planM2(c), pkgs: c.pkgs || {}, storeOn: !!c.storeOn, marketOn: !!c.marketOn, domain: '', domainStatus: null, domainAlts: [] };
}

type Ctx = {
  draft: PlanState;                 // a new customer's plan, kept in the browser
  change: PlanState | null;         // an existing plan being changed (never saved in the browser)
  active: PlanState;                // whichever of the two is on screen
  update: (patch: Partial<PlanState>) => void;
  updateDraft: (patch: Partial<PlanState>) => void;
  startChange: (c: PlanConfig) => void;
  endChange: () => void;
  checkDomain: (name: string) => Promise<void>;
  forget: () => void;               // after payment: the saved plan is done with
};
const PlanContext = createContext<Ctx | null>(null);

function restored(): PlanState {
  const r = restorePlan(STORAGE.max);
  const s: PlanState = { ...NEW_PLAN };
  if (r.qty !== undefined) s.qty = Number(r.qty);
  if (r.pkgs) s.pkgs = r.pkgs;
  if (r.storeOn !== undefined) s.storeOn = !!r.storeOn;
  if (typeof r.domain === 'string') s.domain = r.domain;
  if (r.marketOn !== undefined) s.marketOn = !!r.marketOn;
  if (typeof r.company === 'string') s.company = r.company;
  if (typeof r.country === 'string' && COUNTRIES.some((c) => c.code === r.country)) s.country = r.country;
  if (typeof r.vat === 'string') s.vat = r.vat;
  return s;
}

export function PlanProvider({ children, fresh = false }: { children: ReactNode; fresh?: boolean }) {
  const [draft, setDraft] = useState<PlanState>(() => (fresh ? { ...NEW_PLAN } : restored()));
  const [change, setChange] = useState<PlanState | null>(null);
  const changeRef = useRef(change); changeRef.current = change;

  // Save the new-customer plan a moment after each change.
  const persisted = JSON.stringify([draft.qty, draft.pkgs, draft.storeOn, draft.domain, draft.marketOn, draft.company, draft.country, draft.vat]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => savePlan({ qty: draft.qty, pkgs: draft.pkgs, storeOn: draft.storeOn, domain: draft.domain, tt: 'off', meta: 'off', marketOn: draft.marketOn, company: draft.company, country: draft.country, vat: draft.vat }), 400);
    return () => clearTimeout(t);
  }, [persisted]); // `persisted` covers every saved field of `draft`

  const update = useCallback((patch: Partial<PlanState>) => {
    if (changeRef.current) setChange((c) => (c ? { ...c, ...patch } : c));
    else setDraft((d) => ({ ...d, ...patch }));
  }, []);

  // The .pl registry check. Only the newest answer counts: typing on while a check runs must not show an old result.
  const domainToken = useRef(0);
  const checkDomain = useCallback(async (name: string) => {
    if (!name) return;
    update({ domainStatus: 'checking', domainAlts: [] });
    const token = ++domainToken.current;
    try {
      const r = await callFn<{ status?: DomainStatus; alternatives?: string[] }>('domain-check', { name }, { auth: false });
      if (token !== domainToken.current) return;
      if (r.status === 429) return update({ domainStatus: 'limited' });
      if (!r.ok) return update({ domainStatus: 'unknown' });
      update({ domainStatus: r.data.status || 'unknown', domainAlts: r.data.alternatives || [] });
    } catch { if (token === domainToken.current) update({ domainStatus: 'unknown' }); }
  }, [update]);

  const updateDraft = useCallback((patch: Partial<PlanState>) => setDraft((d) => ({ ...d, ...patch })), []);
  const startChange = useCallback((c: PlanConfig) => setChange(fromCurrent(c, draft)), [draft]);
  const endChange = useCallback(() => setChange(null), []);
  const forget = useCallback(() => { clearPlan(); setDraft({ ...NEW_PLAN }); }, []);

  const value = useMemo<Ctx>(() => ({ draft, change, active: change ?? draft, update, updateDraft, startChange, endChange, checkDomain, forget }), [draft, change, update, updateDraft, startChange, endChange, checkDomain, forget]);
  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export function usePlan(): Ctx {
  const c = useContext(PlanContext);
  if (!c) throw new Error('usePlan outside PlanProvider');
  return c;
}

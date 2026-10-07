import { useEffect, useRef } from 'react';
import { useAccount } from './account';
import { usePlan } from './plan';
import { COUNTRIES } from '../lib/countries';

// Once the company is known, fill the plan's company details from it, without overwriting anything already typed.
export function usePrefill() {
  const a = useAccount();
  const { draft, updateDraft } = usePlan();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !a.loaded || !a.session) return;
    done.current = true;
    const patch: Partial<typeof draft> = {};
    if (a.orgId) {
      if (!draft.company) patch.company = a.orgName;
      if (!draft.vat && a.orgVat) patch.vat = a.orgVat;
      if (a.orgCountry && COUNTRIES.some((c) => c.code === a.orgCountry)) patch.country = a.orgCountry;
    }
    if (!draft.email && a.email) patch.email = a.email;
    if (Object.keys(patch).length) updateDraft(patch);
  }, [a.loaded, a.session, a.orgId, a.orgName, a.orgVat, a.orgCountry, a.email, draft.company, draft.vat, draft.email, updateDraft]);
}

// The plan a visitor is building survives a reload and the trip through /login for a day. A plan saved before storage was sold
// by the pallet and m³ (`qty`, in m²) comes back as the pallet places that area held.
const KEY = 'ace_plan';
const TTL = 24 * 3600 * 1000;

export type SavedPlan = {
  pallets?: number; shelf?: number; qty?: number; orders?: number; pkgs?: { imp?: boolean }; storeOn?: boolean; domain?: string; tt?: string; meta?: string; marketOn?: boolean;
  company?: string; country?: string; vat?: string; step?: number;
};
const KEYS: (keyof SavedPlan)[] = ['pallets', 'shelf', 'qty', 'orders', 'pkgs', 'storeOn', 'domain', 'tt', 'meta', 'marketOn', 'company', 'country', 'vat', 'step'];

export function savePlan(plan: SavedPlan) {
  const p: SavedPlan = {};
  for (const k of KEYS) if (plan[k] !== undefined) (p as Record<string, unknown>)[k] = plan[k];
  try { localStorage.setItem(KEY, JSON.stringify({ v: 2, t: Date.now(), plan: p })); } catch { /* storage blocked */ }
}

export function clearPlan() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

export function restorePlan(): SavedPlan {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!o || !o.plan || Date.now() - (o.t || 0) > TTL) { if (o) clearPlan(); return {}; }
    const out: SavedPlan = {};
    for (const k of KEYS) if (o.plan[k] !== undefined) (out as Record<string, unknown>)[k] = o.plan[k];
    if (out.pallets === undefined && out.shelf === undefined && Number(out.qty) >= 0.3 && Number(out.qty) <= 1000) out.pallets = Math.max(1, Math.round(Number(out.qty) / 1.2));
    delete out.qty;
    if (!(Number.isInteger(Number(out.pallets)) && Number(out.pallets) >= 0 && Number(out.pallets) <= 500)) delete out.pallets;
    if (!(Number(out.shelf) >= 0 && Number(out.shelf) <= 500)) delete out.shelf;
    delete out.step;                   // the builder always opens at Space; only the choices come back
    delete out.tt; delete out.meta;    // marketing channels are no longer sold in the builder
    return out;
  } catch { return {}; }
}

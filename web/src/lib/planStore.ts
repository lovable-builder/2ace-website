// The plan a visitor is building survives a reload and the trip through /login for a day. Same key and shape as /platform used,
// so a plan started on either page carries over to the other.
const KEY = 'ace_plan';
const TTL = 24 * 3600 * 1000;

export type SavedPlan = {
  qty?: number; orders?: number; pkgs?: { imp?: boolean }; storeOn?: boolean; domain?: string; tt?: string; meta?: string; marketOn?: boolean;
  company?: string; country?: string; vat?: string; step?: number;
};
const KEYS: (keyof SavedPlan)[] = ['qty', 'orders', 'pkgs', 'storeOn', 'domain', 'tt', 'meta', 'marketOn', 'company', 'country', 'vat', 'step'];

export function savePlan(plan: SavedPlan) {
  const p: SavedPlan = {};
  for (const k of KEYS) if (plan[k] !== undefined) (p as Record<string, unknown>)[k] = plan[k];
  try { localStorage.setItem(KEY, JSON.stringify({ v: 2, t: Date.now(), plan: p })); } catch { /* storage blocked */ }
}

export function clearPlan() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

export function restorePlan(maxM2: number): SavedPlan {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!o || !o.plan || Date.now() - (o.t || 0) > TTL) { if (o) clearPlan(); return {}; }
    const out: SavedPlan = {};
    for (const k of KEYS) if (o.plan[k] !== undefined) (out as Record<string, unknown>)[k] = o.plan[k];
    if (!(Number(out.qty) >= 0.3 && Number(out.qty) <= maxM2)) delete out.qty;
    delete out.step;                   // the builder always opens at Space; only the choices come back
    delete out.tt; delete out.meta;    // marketing channels are no longer sold in the builder
    return out;
  } catch { return {}; }
}

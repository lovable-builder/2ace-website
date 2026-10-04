import { el } from './ui.js';

// Shared bits for the warehouse screens. All writes are database functions (RPCs): they check the caller's role, validate and audit.
export async function rpc(ctx, fn, args) {
  const { data, error } = await ctx.sb.rpc(fn, args || {});
  if (error) throw new Error(error.message);
  return data;
}
export const canAct = (ctx) => ctx.me.role === 'admin' || ctx.me.role === 'warehouse';
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
export const KINDS = ['receiving', 'bin', 'pallet', 'pack', 'returns', 'quarantine', 'shipping'];

export async function loadOrgs(ctx) {
  if (!ctx.session.orgs) { const { data, error } = await ctx.sb.rpc('wms_orgs'); if (error) throw new Error(error.message); ctx.session.orgs = data || []; }
  return ctx.session.orgs;
}
export const orgName = (orgs, id) => (orgs.find((o) => o.id === id) || {}).name || '-';
export const orgSelect = (orgs, value, allLabel) => el('select', {}, allLabel != null && el('option', { value: '', text: allLabel }),
  orgs.map((o) => el('option', { value: o.id, text: o.name, ...(o.id === value ? { selected: true } : {}) })));

// Run an async action from a button: disable it while it works, show errors in `err`.
export async function guarded(btn, err, fn) {
  btn.disabled = true; if (err) err.textContent = '';
  try { return await fn(); } catch (e) { if (err) err.textContent = e.message; else throw e; } finally { btn.disabled = false; }
}

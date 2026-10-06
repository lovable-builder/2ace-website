import { corsHeaders, json } from '../_shared/cors.ts';
import { admin, caller } from '../_shared/auth.ts';
import { CsError, attachOwnLabel, capabilities, removeOwnLabel, status, type CsDeps } from '../_shared/customerShipping.ts';

// Shipping, from the customer's side. Every action is for the signed-in customer's own company and own orders.
// Money-moving actions (buying a label) are added in a later step and stay switched off until billing is in place.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method' }, 405);
  const me = await caller(req);
  if (!me || !me.orgId || !me.role) return json(req, { error: 'unauthorized' }, 401);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }

  const deps: CsDeps = {
    orgId: me.orgId, role: me.role, userId: me.user.id,
    getOrder: async (id) => { const { data } = await admin.from('orders').select('id, org_id, ref, status, label_source').eq('id', id).maybeSingle(); return data as never; },
    mode: async (org) => { const { data } = await admin.rpc('org_fulfil_mode', { p_org: org }); return String(data ?? 'storage'); },
    download: async (path) => { const { data } = await admin.storage.from('labels').download(path); return data ? new Uint8Array(await data.arrayBuffer()) : null; },
    removeFile: async (path) => { await admin.storage.from('labels').remove([path]); },
    rpc: async (name, args) => { const r = await admin.rpc(name, args); return { data: r.data, error: r.error ? { message: r.error.message } : null }; },
    ownLabel: async (orderId) => { const { data } = await admin.from('own_labels').select('filename, storage_path, tracking_numbers, carrier_name, created_at').eq('order_id', orderId).is('voided_at', null).maybeSingle(); return data as never; },
  };
  try {
    switch (b.action) {
      case 'capabilities': return json(req, await capabilities(deps));
      case 'status': return json(req, await status(deps, b.order_id));
      case 'own_label.attach': return json(req, await attachOwnLabel(deps, { order_id: b.order_id, path: b.path, filename: b.filename, tracking: b.tracking, carrier: b.carrier }));
      case 'own_label.remove': return json(req, await removeOwnLabel(deps, { order_id: b.order_id }));
      default: return json(req, { error: 'Unknown action' }, 400);
    }
  } catch (e) {
    if (e instanceof CsError) return json(req, { error: e.message }, e.status);
    console.error('customer-shipping', (e as Error).message);
    return json(req, { error: 'Something went wrong. Please try again.' }, 500);
  }
});

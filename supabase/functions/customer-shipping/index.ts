import { corsHeaders, json } from '../_shared/cors.ts';
import { admin, caller } from '../_shared/auth.ts';
import { CsError, attachOwnLabel, removeOwnLabel, status } from '../_shared/customerShipping.ts';
import { buy, capabilitiesBuy, labelFile, quote, suggest, type CsBuyDeps } from '../_shared/customerBuy.ts';
import { returnBuy, returnLabel, returnQuote, returnStatus, type CsReturnDeps, type ReturnRow } from '../_shared/customerReturns.ts';
import { Furgonetka, configFromEnv, type TokenStore } from '../_shared/furgonetka.ts';
import { sendEmail, layout } from '../_shared/email.ts';
import { warsawDayStart, type OrderShip } from '../_shared/shipping.ts';

// Shipping, from the customer's side. Every action is for the signed-in customer's own company and own orders.
// Buying a label (suggest, quote, buy, label) stays closed until CUSTOMER_LABELS_ENABLED=true and it is switched on for that customer.
const env = (k: string) => Deno.env.get(k);
const TEAM_INBOX = env('LEAD_NOTIFY_TO') ?? 'hello@2ace.pl';
const tokenStore: TokenStore = {
  async get(key) { const { data } = await admin.from('shipping_tokens').select('access_token, refresh_token, expires_at').eq('key', key).maybeSingle(); return data ? { access_token: data.access_token as string, refresh_token: data.refresh_token as string | null, expires_at: Number(data.expires_at) } : null; },
  async set(key, t) { const { error } = await admin.from('shipping_tokens').upsert({ key, access_token: t.access_token, refresh_token: t.refresh_token ?? null, expires_at: t.expires_at, updated_at: new Date().toISOString() }); if (error) console.error('token cache', error.message); },
};
const furg = () => new Furgonetka(configFromEnv(env), tokenStore);
const furgonetkaEnv = (env('FURGONETKA_ENV') === 'production' ? 'production' : 'sandbox') as 'sandbox' | 'production';
const ORDER_COLS = 'id, org_id, ref, status, label_source, ship_name, ship_company, ship_line1, ship_line2, ship_postal, ship_city, ship_country, ship_email, ship_phone';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method' }, 405);
  const me = await caller(req);
  if (!me || !me.orgId || !me.role) return json(req, { error: 'unauthorized' }, 401);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }

  const spent = async (scope: 'customers' | 'all') => {
    let q = admin.from('shipments').select('cost_gross').eq('env', furgonetkaEnv).in('status', ['buying', 'purchased']).gte('created_at', warsawDayStart(new Date()).toISOString());
    if (scope === 'customers') q = q.eq('buyer_role', 'customer');
    const { data } = await q; return (data ?? []).reduce((t, r) => t + Number(r.cost_gross), 0);
  };
  const deps: CsReturnDeps = {
    orgId: me.orgId, role: me.role, userId: me.user.id, getenv: env, furgonetkaEnv,
    getOrder: async (id) => { const { data } = await admin.from('orders').select('id, org_id, ref, status, label_source').eq('id', id).maybeSingle(); return data as never; },
    orderShip: async (id) => { const { data } = await admin.from('orders').select(ORDER_COLS).eq('id', id).maybeSingle(); return data as (OrderShip & { id: string; org_id: string; status: string }) | null; },
    mode: async (org) => { const { data } = await admin.rpc('org_fulfil_mode', { p_org: org }); return String(data ?? 'storage'); },
    orgSettings: async (org) => { const { data } = await admin.from('org_shipping_settings').select('label_buying_enabled, markup_percent, max_label_net').eq('org_id', org).maybeSingle(); return data ? { label_buying_enabled: !!data.label_buying_enabled, markup_percent: data.markup_percent == null ? null : Number(data.markup_percent), max_label_net: data.max_label_net == null ? null : Number(data.max_label_net) } : null; },
    orgStatus: async (org) => { const { data } = await admin.from('organizations').select('status').eq('id', org).maybeSingle(); return (data?.status as string) ?? null; },
    items: async (orderId) => {
      const { data } = await admin.from('order_lines').select('qty, products(sku, name, weight_g, length_cm, width_cm, height_cm)').eq('order_id', orderId);
      return (data ?? []).map((l: Record<string, unknown>) => { const p = (l.products ?? {}) as Record<string, unknown>; const n = (v: unknown) => (v == null ? null : Number(v)); return { sku: String(p.sku ?? ''), name: String(p.name ?? ''), qty: Number(l.qty), weight_g: n(p.weight_g), length_cm: n(p.length_cm), width_cm: n(p.width_cm), height_cm: n(p.height_cm) }; });
    },
    spentToday: spent,
    api: {
      quote: (p, s) => furg().quote(p, s as { carriers?: string[]; serviceIds?: number[] }),
      balance: () => furg().balance() as Promise<unknown>,
      validate: (p) => furg().validate(p),
      createPackage: (p) => furg().createPackage(p),
      orderAndWait: (ids, uuid) => furg().orderAndWait(ids, uuid),
      fetchPackage: (id) => furg().fetchPackage(id),
    },
    alert: async (subject, html) => { try { await sendEmail({ to: TEAM_INBOX, subject, html: layout(subject, html) }); } catch (e) { console.error('shipping alert email failed', (e as Error).message); } },
    shipment: async (orderId) => {
      const { data } = await admin.from('shipments').select('status, carrier, service_name, tracking_numbers, bill_net, bill_gross, provider_package_id, purchased_at, created_at, error, buyer_role').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      return data ? { status: data.status as string, carrier: data.carrier as string | null, service_name: data.service_name as string | null, tracking_numbers: (data.tracking_numbers as string[]) ?? [], bill_net: Number(data.bill_net), bill_gross: Number(data.bill_gross), package_id: data.provider_package_id as string | null, purchased_at: data.purchased_at as string | null, created_at: data.created_at as string, error: data.error as string | null, buyer_role: data.buyer_role as string } : null;
    },
    // The label PDF: kept in our private storage after the first download, so the customer is not dependent on the carrier service later.
    labelUrl: async (orgId, orderId, packageId) => {
      const path = `${orgId}/${orderId}/bought-${packageId}.pdf`;
      const signed = async () => { const r = await admin.storage.from('labels').createSignedUrl(path, 120); return r.data?.signedUrl ?? null; };
      const have = await signed(); if (have) return have;
      let file: { bytes: Uint8Array; contentType: string } | null = null;
      for (let i = 0; i < 8 && !file; i++) { file = await furg().label(packageId); if (!file) await new Promise((r) => setTimeout(r, 2500)); }
      if (!file || file.bytes.length < 5 || file.bytes[0] !== 0x25) return null;
      const up = await admin.storage.from('labels').upload(path, file.bytes, { contentType: 'application/pdf', upsert: true });
      if (up.error) { console.error('label cache', up.error.message); return null; }
      return await signed();
    },
    returnShip: async (id) => { const { data } = await admin.from('returns').select('id, org_id, ref, status, buyer_name, buyer_company, buyer_line1, buyer_line2, buyer_postal, buyer_city, buyer_country, buyer_email, buyer_phone').eq('id', id).maybeSingle(); return data as ReturnRow | null; },
    returnShipment: async (returnId) => {
      const { data } = await admin.from('shipments').select('status, carrier, service_name, tracking_numbers, bill_net, bill_gross, provider_package_id').eq('return_id', returnId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      return data ? { status: data.status as string, carrier: data.carrier as string | null, service_name: data.service_name as string | null, tracking_numbers: (data.tracking_numbers as string[]) ?? [], bill_net: Number(data.bill_net), bill_gross: Number(data.bill_gross), package_id: data.provider_package_id as string | null } : null;
    },
    download: async (path) => { const { data } = await admin.storage.from('labels').download(path); return data ? new Uint8Array(await data.arrayBuffer()) : null; },
    removeFile: async (path) => { await admin.storage.from('labels').remove([path]); },
    rpc: async (name, args) => { const r = await admin.rpc(name, args); return { data: r.data, error: r.error ? { message: r.error.message } : null }; },
    ownLabel: async (orderId) => { const { data } = await admin.from('own_labels').select('filename, storage_path, tracking_numbers, carrier_name, created_at').eq('order_id', orderId).is('voided_at', null).maybeSingle(); return (data as never) ?? null; },
  };
  try {
    switch (b.action) {
      case 'capabilities': return json(req, await capabilitiesBuy(deps));
      case 'status': return json(req, await status(deps, b.order_id));
      case 'own_label.attach': return json(req, await attachOwnLabel(deps, { order_id: b.order_id, path: b.path, filename: b.filename, tracking: b.tracking, carrier: b.carrier }));
      case 'own_label.remove': return json(req, await removeOwnLabel(deps, { order_id: b.order_id }));
      case 'suggest': return json(req, await suggest(deps, { order_id: b.order_id }));
      case 'quote': return json(req, await quote(deps, { order_id: b.order_id, parcels: b.parcels }));
      case 'buy': { const r = await buy(deps, { order_id: b.order_id, service_id: b.service_id, parcels: b.parcels, expected_bill_net: b.expected_bill_net }); return json(req, r, 'pending' in r && r.pending ? 202 : 200); }
      case 'label': return json(req, await labelFile(deps, { order_id: b.order_id }));
      case 'return.status': return json(req, await returnStatus(deps, { return_id: b.return_id }));
      case 'return.quote': return json(req, await returnQuote(deps, { return_id: b.return_id, parcels: b.parcels }));
      case 'return.buy': { const r = await returnBuy(deps, { return_id: b.return_id, service_id: b.service_id, parcels: b.parcels, expected_bill_net: b.expected_bill_net }); return json(req, r, 'pending' in r && r.pending ? 202 : 200); }
      case 'return.label': return json(req, await returnLabel(deps, { return_id: b.return_id }));
      default: return json(req, { error: 'Unknown action' }, 400);
    }
  } catch (e) {
    if (e instanceof CsError) return json(req, { error: e.message }, e.status);
    console.error('customer-shipping', (e as Error).message);
    return json(req, { error: 'Something went wrong. Please try again.' }, 500);
  }
});

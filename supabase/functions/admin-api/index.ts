import { corsHeaders, json } from '../_shared/cors.ts';
import { admin, staffCaller, audit, userClient, type StaffCtx, type StaffRole } from '../_shared/auth.ts';
import { sendEmail, layout, esc } from '../_shared/email.ts';
import { retryAutoRegister } from '../_shared/domainOrder.ts';
import Stripe from 'npm:stripe';
import { STAFF_GUIDE, OWNER_GUIDE } from '../_shared/helpContent.ts';
import { notifyHeld } from '../_shared/orderNotice.ts';
import { Furgonetka, FurgonetkaError, OrderPending, configFromEnv, fieldErrors, type TokenStore } from '../_shared/furgonetka.ts';
import { buyLabel, ShipError } from '../_shared/shipBuy.ts';
import { buildPackage, parseQuotes, markupFor, customerNet, customerGross, spendCheck, settingNum, carriersFrom, warsawDayStart, extractTracking, DEFAULT_MARKUP_PERCENT, DEFAULT_MAX_LABEL_PLN, DEFAULT_DAILY_CAP_PLN, type OrderShip, type ParcelRow } from '../_shared/shipping.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!);

// One endpoint for every staff action. Reads happen in the browser under RLS; everything that CHANGES data goes through here:
// role-checked, validated, and written to the audit log before we answer.
const SITE = Deno.env.get('SITE_URL') ?? 'https://2ace.pl';
const TEAM_INBOX = Deno.env.get('LEAD_NOTIFY_TO') ?? 'hello@2ace.pl';
const ORG_STATUS = ['pending', 'active', 'past_due', 'canceled'];
const DOMAIN_STATUS = ['pending', 'registered', 'failed', 'cancelled'];
const REQ_STATUS = ['new', 'open', 'waiting', 'resolved'];
const PRIORITY = ['low', 'normal', 'high'];
const ROLES: StaffRole[] = ['admin', 'support', 'warehouse'];
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
const text = (v: unknown, max = 4000) => String(v ?? '').trim().slice(0, max);
// The one cached Furgonetka login lives in a table only the server can read.
const tokenStore: TokenStore = {
  async get(key) { const { data } = await admin.from('shipping_tokens').select('access_token, refresh_token, expires_at').eq('key', key).maybeSingle(); return data ? { access_token: data.access_token as string, refresh_token: data.refresh_token as string | null, expires_at: Number(data.expires_at) } : null; },
  async set(key, t) { const { error } = await admin.from('shipping_tokens').upsert({ key, access_token: t.access_token, refresh_token: t.refresh_token ?? null, expires_at: t.expires_at, updated_at: new Date().toISOString() }); if (error) console.error('token cache', error.message); },
};
class Bad extends Error { constructor(m: string, public status = 400) { super(m); } }

// Who to email about an organization: its owner.
async function ownerOf(orgId: string) {
  const { data: m } = await admin.from('members').select('user_id').eq('org_id', orgId).eq('role', 'owner').limit(1).maybeSingle();
  if (!m) return null;
  const { data: p } = await admin.from('profiles').select('full_name, email').eq('user_id', m.user_id).maybeSingle();
  return p ? { name: p.full_name as string | null, email: p.email as string | null } : null;
}

// ---------- shipping helpers ----------
const env = (k: string) => Deno.env.get(k);
function shippingApi(): Furgonetka {
  try { return new Furgonetka(configFromEnv(env), tokenStore); } catch (e) { throw new Bad((e as Error).message); }
}
// Turns a Furgonetka failure into a message staff can act on (field errors included, never secrets).
function shippingFail(e: unknown): never {
  if (e instanceof Bad) throw e;
  if (e instanceof FurgonetkaError) {
    const detail = fieldErrors(e.payload);
    throw new Bad(`${e.message}${detail.length ? ' (' + detail.slice(0, 4).join('; ') + ')' : ''}`, 502);
  }
  throw new Bad((e as Error).message || 'Shipping failed', 502);
}
const ORDER_COLS = 'id, org_id, ref, status, ship_name, ship_company, ship_line1, ship_line2, ship_postal, ship_city, ship_country, ship_email, ship_phone';
async function packedOrder(id: unknown) {
  if (!isUuid(id)) throw new Bad('Invalid order');
  const [{ data: o }, { data: pc }] = await Promise.all([admin.from('orders').select(ORDER_COLS).eq('id', id).maybeSingle(), admin.from('parcels').select('weight_g, length_cm, width_cm, height_cm').eq('order_id', id).order('seq')]);
  if (!o) throw new Bad('Order not found', 404);
  if (o.status === 'shipped') throw new Bad('This order has already shipped');
  if (o.status !== 'packed') throw new Bad(`Only a packed order can be shipped (this one is ${o.status})`);
  if (!pc?.length) throw new Bad('This order has no parcels recorded');
  return { order: o as OrderShip & { id: string; org_id: string; status: string }, parcels: pc as ParcelRow[] };
}
// A customer's own markup if the admin set one, else the default.
async function orgMarkup(orgId: string): Promise<number> {
  const { data } = await admin.from('org_shipping_settings').select('markup_percent').eq('org_id', orgId).maybeSingle();
  return markupFor(data?.markup_percent as number | null | undefined, env);
}
async function spentToday(e: string): Promise<number> {
  const { data } = await admin.from('shipments').select('cost_gross').eq('env', e).in('status', ['buying', 'purchased']).gte('created_at', warsawDayStart(new Date()).toISOString());
  return (data ?? []).reduce((t, r) => t + Number(r.cost_gross), 0);
}
async function shippingAlert(subject: string, lines: string) {
  try { await sendEmail({ to: TEAM_INBOX, subject, html: layout(subject, lines) }); } catch (e) { console.error('shipping alert email failed', (e as Error).message); }
}
const b64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
// Records a paid label: retried once, because after the money is spent a transient database error must not lose the record.
async function finishShipment(s: StaffCtx, shipmentId: string, packageId: string, tracking: string[]) {
  const db = userClient(s.token);
  let last = '';
  for (let i = 0; i < 2; i++) {
    const { data, error } = await db.rpc('finish_shipment', { p_id: shipmentId, p_package_id: packageId, p_tracking: tracking });
    if (!error) return data as { carrier: string; tracking_numbers: string[]; cost_gross: number; bill_net: number; bill_gross: number; order_id: string; org_id: string };
    last = error.message;
  }
  throw new Bad(last);
}

const actions: Record<string, { roles?: StaffRole[]; run: (s: StaffCtx, b: Record<string, unknown>) => Promise<unknown> }> = {
  me: { run: async (s) => ({ id: s.user.id, role: s.role, email: s.user.email }) },

  // ---------- shipping connection (Furgonetka) ----------
  // Admin only. Logs in, reads the balance and the carrier services. Free: nothing is bought. Always answers with ok true/false so the screen can explain.
  'shipping.test': { roles: ['admin'], run: async (s) => {
    let api: Furgonetka;
    try { api = new Furgonetka(configFromEnv((k) => Deno.env.get(k)), tokenStore); }
    catch (e) { return { ok: false, step: 'settings', error: (e as Error).message }; }
    try {
      const balance = await api.balance();
      const raw = await api.services();
      const list = Array.isArray(raw) ? raw : (raw as { services?: unknown[]; data?: unknown[] })?.services ?? (raw as { data?: unknown[] })?.data ?? raw;
      await audit(s, 'shipping.test', 'shipping', null, null, null, { ok: true, env: api.env });
      return { ok: true, env: api.env, base: api.base, balance, services: Array.isArray(list) ? list.slice(0, 80) : list };
    } catch (e) {
      await audit(s, 'shipping.test', 'shipping', null, null, null, { ok: false, env: api.env });
      return { ok: false, env: api.env, step: 'api', status: e instanceof FurgonetkaError ? e.status : null, error: (e as Error).message };
    }
  } },

  // ---------- per-customer shipping settings (admin only; the database function re-checks the role and audits) ----------
  'org.setShipping': { roles: ['admin'], run: async (s, b) => {
    if (!isUuid(b.org_id)) throw new Bad('Invalid customer');
    const patch = (b.patch ?? {}) as Record<string, unknown>;
    const { error } = await userClient(s.token).rpc('set_org_shipping', { p_org: b.org_id, p_patch: patch });
    if (error) throw new Bad(error.message);
    return { ok: true };
  } },

  // ---------- shipping labels ----------
  // Prices for a packed order from the main carriers. Free: nothing is created or charged. The customer price includes our markup.
  'shipping.quote': { roles: ['admin', 'warehouse'], run: async (_s, b) => {
    const { order, parcels } = await packedOrder(b.order_id);
    const api = shippingApi(), pct = await orgMarkup(order.org_id);
    try {
      const raw = await api.quote(buildPackage(order, parcels), { carriers: carriersFrom(env) });
      const quotes = parseQuotes(raw).map((q) => (q.available ? { ...q, bill_net: customerNet(q.cost_net, pct), bill_gross: customerGross(q.cost_net, pct, q.tax) } : q));
      return { env: api.env, enabled: env('SHIPPING_ENABLED') === 'true', markup_percent: pct, max_label: settingNum(env, 'SHIPPING_MAX_LABEL_PLN', DEFAULT_MAX_LABEL_PLN, 0), quotes };
    } catch (e) { return shippingFail(e); }
  } },

  // Buys one label. The only step that spends money, and every guard runs here on the server:
  //   kill switch -> fresh price for exactly this service -> balance -> per-label limit (admin confirmation) -> daily cap -> a 'buying' row is written FIRST.
  // Furgonetka's own dry run comes before anything is created. Ordering is the charge; it is repeat-safe through the shipment's order_uuid.
  'shipping.buy': { roles: ['admin', 'warehouse'], run: async (s, b) => {
    const serviceId = Number(b.service_id);
    if (!Number.isInteger(serviceId) || serviceId <= 0) throw new Bad('Choose a carrier service');
    const { order, parcels } = await packedOrder(b.order_id);
    const api = shippingApi(), db = userClient(s.token), pct = await orgMarkup(order.org_id);
    try {
      return await buyLabel({
        env: api.env, api,
        settings: { enabled: env('SHIPPING_ENABLED') === 'true', maxLabel: settingNum(env, 'SHIPPING_MAX_LABEL_PLN', DEFAULT_MAX_LABEL_PLN, 0), dailyCap: settingNum(env, 'SHIPPING_DAILY_CAP_PLN', DEFAULT_DAILY_CAP_PLN, 0), markupPct: pct },
        spentToday: () => spentToday(api.env),
        begin: async (a) => {
          const { data, error } = await db.rpc('begin_shipment', { p_order: order.id, p_env: api.env, p_service_id: a.serviceId, p_carrier: a.quote.carrier, p_service_name: a.quote.name, p_cost_net: a.quote.cost_net, p_cost_gross: a.quote.cost_gross, p_tax: a.quote.tax, p_markup: a.markupPct });
          if (error) throw new Error(error.message);
          return data as { id: string; order_uuid: string };
        },
        fail: async (id, m) => { const { error } = await db.rpc('fail_shipment', { p_id: id, p_error: m }); if (error) throw new Error(error.message); },
        savePackageId: async (id, pkg) => { await admin.from('shipments').update({ provider_package_id: pkg }).eq('id', id); },
        finish: (id, pkg, tr) => finishShipment(s, id, pkg, tr),
        alert: shippingAlert,
        audit: (action, id, payload) => audit(s, action, 'shipments', id, order.org_id, null, payload),
      }, { order, parcels, serviceId, role: s.role, confirmOverLimit: b.confirm_over_limit === true });
    } catch (e) { if (e instanceof ShipError) throw new Bad(e.message, e.status); throw e; }
  } },

  // Asks Furgonetka what happened to an order whose answer never arrived (or whose record failed), and finishes or closes it.
  'shipping.recheck': { roles: ['admin', 'warehouse'], run: async (s, b) => {
    if (!isUuid(b.order_id)) throw new Bad('Invalid order');
    const { data: sh } = await admin.from('shipments').select('id, status, order_uuid, provider_package_id').eq('order_id', b.order_id).eq('status', 'buying').maybeSingle();
    if (!sh) throw new Bad('There is no label order waiting to be checked for this order');
    if (!sh.provider_package_id) { await userClient(s.token).rpc('fail_shipment', { p_id: sh.id, p_error: 'Closed after a failure before the shipment was created' }); return { ok: true, result: 'closed', message: 'Nothing had been created at Furgonetka, so the attempt was closed. You can buy again.' }; }
    const api = shippingApi();
    try {
      const v = await api.waitForOrder(sh.order_uuid, { tries: 4, delayMs: 1500 });
      if (v.orderedIds.includes(sh.provider_package_id)) {
        let tracking: string[] = []; try { tracking = extractTracking(await api.fetchPackage(sh.provider_package_id)); } catch (_e) { /* later */ }
        const done = await finishShipment(s, sh.id, sh.provider_package_id, tracking);
        await audit(s, 'shipping.recheck', 'shipments', sh.id, done.org_id, null, { result: 'purchased' });
        return { ok: true, result: 'purchased', message: 'The label had been bought. It is recorded now and the order is shipped.' };
      }
      await userClient(s.token).rpc('fail_shipment', { p_id: sh.id, p_error: 'Furgonetka did not order it' + (v.errors.length ? ': ' + v.errors.join('; ') : '') });
      await audit(s, 'shipping.recheck', 'shipments', sh.id, null, null, { result: 'not_ordered' });
      return { ok: true, result: 'closed', message: 'Furgonetka did not order it, so nothing was charged. You can buy again.' };
    } catch (e) {
      if (e instanceof OrderPending) return { ok: true, result: 'pending', message: 'Furgonetka still has not decided. Try again in a few minutes.' };
      return shippingFail(e);
    }
  } },

  // The label file (PDF) for a shipped order, for printing.
  'shipping.label': { roles: ['admin', 'warehouse'], run: async (s, b) => {
    if (!isUuid(b.order_id)) throw new Bad('Invalid order');
    const { data: sh } = await admin.from('shipments').select('id, org_id, provider_package_id').eq('order_id', b.order_id).eq('status', 'purchased').maybeSingle();
    if (!sh?.provider_package_id) throw new Bad('No label has been bought for this order', 404);
    const api = shippingApi();
    try {
      let file = null;
      for (let i = 0; i < 5 && !file; i++) { file = await api.label(sh.provider_package_id); if (!file) await new Promise((r) => setTimeout(r, 1500)); }
      if (!file) throw new Bad('Furgonetka has not produced the label yet. Try again in a moment.', 409);
      await audit(s, 'shipping.label', 'shipments', sh.id, sh.org_id, null, { package: sh.provider_package_id });
      return { content_type: file.contentType, pdf_base64: b64(file.bytes) };
    } catch (e) { return shippingFail(e); }
  } },

  // ---------- orders ----------
  // After staff create an order that came out on hold, tell the customer once (the claim flag prevents duplicates).
  'order.notify': { roles: ['admin', 'warehouse'], run: async (_s, b) => {
    const ids = Array.isArray(b.order_ids) ? (b.order_ids as unknown[]).filter(isUuid) : [];
    if (!ids.length) throw new Bad('No orders given');
    return { notified: await notifyHeld(ids) };
  } },

  // ---------- help: the staff manual lives here, not in a public file, so only signed-in staff can read it ----------
  'help.get': { run: async (s, b) => {
    if (text(b.guide, 10) === 'owner') {
      if (s.role !== 'admin') throw new Bad('Only admins can read the setup guide', 403);
      return { html: OWNER_GUIDE };
    }
    return { html: STAFF_GUIDE };
  } },

  // ---------- staff management (admin) ----------
  'staff.list': { roles: ['admin'], run: async () => {
    const { data: rows } = await admin.from('staff_users').select('user_id, role, active, created_at').order('created_at');
    const out = [];
    for (const r of rows ?? []) { const { data } = await admin.auth.admin.getUserById(r.user_id); out.push({ ...r, email: data?.user?.email ?? null }); }
    return { staff: out };
  } },
  'staff.directory': { roles: ['admin', 'support'], run: async () => {
    const { data: rows } = await admin.from('staff_users').select('user_id, role, active');
    const out = [];
    for (const r of rows ?? []) { const { data } = await admin.auth.admin.getUserById(r.user_id); out.push({ user_id: r.user_id, role: r.role, active: r.active, email: data?.user?.email ?? null }); }
    return { staff: out };
  } },
  'staff.invite': { roles: ['admin'], run: async (s, b) => {
    const email = text(b.email, 200).toLowerCase(), role = text(b.role, 20) as StaffRole;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Bad('Enter a valid email');
    if (!ROLES.includes(role)) throw new Bad('Choose a role');
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    let uid = list?.users.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
    let invited = false;
    if (!uid) {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: SITE + '/admin' });
      if (error || !data.user) throw new Bad('Could not send the invitation: ' + (error?.message ?? 'unknown'), 502);
      uid = data.user.id; invited = true;
    }
    const { data: prev } = await admin.from('staff_users').select('role, active').eq('user_id', uid).maybeSingle();
    const { error } = await admin.from('staff_users').upsert({ user_id: uid, role, active: true, created_by: s.user.id });
    if (error) throw new Error(error.message);
    await audit(s, prev ? 'staff.change_role' : 'staff.add', 'staff_users', uid, null, prev ?? null, { email, role, active: true });
    return { ok: true, invited };
  } },
  'staff.update': { roles: ['admin'], run: async (s, b) => {
    const uid = b.user_id; if (!isUuid(uid)) throw new Bad('Invalid user');
    const { data: cur } = await admin.from('staff_users').select('role, active').eq('user_id', uid).maybeSingle();
    if (!cur) throw new Bad('Not a staff member', 404);
    const patch: Record<string, unknown> = {};
    if (b.role !== undefined) { if (!ROLES.includes(b.role as StaffRole)) throw new Bad('Invalid role'); patch.role = b.role; }
    if (b.active !== undefined) patch.active = !!b.active;
    if (uid === s.user.id && Object.keys(patch).length) throw new Bad('You cannot change your own access. Ask another admin.');
    const wouldLoseAdmin = cur.role === 'admin' && cur.active && (patch.role && patch.role !== 'admin' || patch.active === false);
    if (wouldLoseAdmin) {
      const { count } = await admin.from('staff_users').select('user_id', { count: 'exact', head: true }).eq('role', 'admin').eq('active', true);
      if ((count ?? 0) <= 1) throw new Bad('There must always be at least one active admin');
    }
    const { error } = await admin.from('staff_users').update(patch).eq('user_id', uid);
    if (error) throw new Error(error.message);
    await audit(s, 'staff.update', 'staff_users', uid, null, cur, { ...cur, ...patch });
    return { ok: true };
  } },

  // ---------- customers ----------
  'org.setStatus': { roles: ['admin'], run: async (s, b) => {
    const orgId = b.org_id, status = text(b.status, 20), reason = text(b.reason, 500);
    if (!isUuid(orgId)) throw new Bad('Invalid organization');
    if (!ORG_STATUS.includes(status)) throw new Bad('Invalid status');
    if (reason.length < 3) throw new Bad('Give a reason for the change');
    const { data: cur } = await admin.from('organizations').select('status').eq('id', orgId).maybeSingle();
    if (!cur) throw new Bad('Organization not found', 404);
    const { error } = await admin.from('organizations').update({ status }).eq('id', orgId);
    if (error) throw new Error(error.message);
    await audit(s, 'org.set_status', 'organizations', orgId, orgId, { status: cur.status }, { status }, reason);
    return { ok: true };
  } },
  // Stripe invoices for a customer (read-only, audited). Resend = email the hosted invoice link through Resend.
  'org.invoices': { roles: ['admin', 'support'], run: async (s, b) => {
    const orgId = b.org_id; if (!isUuid(orgId)) throw new Bad('Invalid organization');
    const { data: o } = await admin.from('organizations').select('stripe_customer_id').eq('id', orgId).maybeSingle();
    if (!o) throw new Bad('Organization not found', 404);
    if (!o.stripe_customer_id) return { invoices: [], customer: null };
    let list;
    try { list = await stripe.invoices.list({ customer: o.stripe_customer_id, limit: 24 }); }
    catch (e) { console.error(e); throw new Bad('Could not reach Stripe', 502); }
    await audit(s, 'org.invoices_view', 'organizations', orgId, orgId, null, null);
    return { customer: o.stripe_customer_id, invoices: list.data.filter((i) => i.status !== 'draft').map((i) => ({
      id: i.id, number: i.number, created: i.created, status: i.status, currency: i.currency, total: i.total, amount_due: i.amount_due,
      hosted_invoice_url: i.hosted_invoice_url, invoice_pdf: i.invoice_pdf })) };
  } },
  'invoice.resend': { roles: ['admin', 'support'], run: async (s, b) => {
    const orgId = b.org_id, invId = text(b.invoice_id, 100);
    if (!isUuid(orgId) || !/^in_[A-Za-z0-9]+$/.test(invId)) throw new Bad('Invalid invoice');
    const { data: o } = await admin.from('organizations').select('stripe_customer_id').eq('id', orgId).maybeSingle();
    if (!o?.stripe_customer_id) throw new Bad('Customer has no billing account', 404);
    let inv;
    try { inv = await stripe.invoices.retrieve(invId); } catch { throw new Bad('Invoice not found', 404); }
    if (inv.customer !== o.stripe_customer_id) throw new Bad('Invoice does not belong to this customer', 403);   // never trust an id alone
    if (!inv.hosted_invoice_url) throw new Bad('This invoice has no online link');
    const owner = await ownerOf(orgId);
    if (!owner?.email) throw new Bad('No owner email on file');
    const ok = await sendEmail({ to: owner.email, subject: `Invoice ${inv.number ?? ''} from 2ACE`.trim(),
      html: layout('Your invoice', `<p>Here is your invoice${inv.number ? ' <b>' + esc(inv.number) + '</b>' : ''}.</p><p><a href="${esc(inv.hosted_invoice_url)}" style="display:inline-block;background:#FF6A1A;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:700">View invoice</a></p>`) });
    if (!ok) throw new Bad('Email could not be sent', 502);
    await audit(s, 'invoice.resend', 'organizations', orgId, orgId, null, { invoice: invId, to: owner.email });
    return { ok: true, to: owner.email };
  } },
  'viewas.start': { roles: ['admin', 'support'], run: async (s, b) => {
    const orgId = b.org_id, reason = text(b.reason, 500);
    if (!isUuid(orgId)) throw new Bad('Invalid organization');
    if (reason.length < 3) throw new Bad('Say why you are opening this customer, for the audit log');
    await audit(s, 'impersonate_view', 'organizations', orgId, orgId, null, null, reason);
    return { ok: true };
  } },

  // ---------- domain queue ----------
  'domain.update': { roles: ['admin', 'support'], run: async (s, b) => {
    const id = b.id, status = text(b.status, 20);
    if (!isUuid(id)) throw new Bad('Invalid order');
    if (!DOMAIN_STATUS.includes(status)) throw new Bad('Invalid status');
    const { data: cur } = await admin.from('domain_orders').select('*').eq('id', id).maybeSingle();
    if (!cur) throw new Bad('Order not found', 404);
    const patch: Record<string, unknown> = { status };
    if (b.notes !== undefined) patch.notes = text(b.notes, 1000) || null;
    if (b.order_ref !== undefined) patch.order_ref = text(b.order_ref, 100) || null;
    patch.registered_at = status === 'registered' ? (cur.registered_at ?? new Date().toISOString()) : null;
    const { error } = await admin.from('domain_orders').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
    await audit(s, 'domain.update', 'domain_orders', id, cur.org_id, { status: cur.status, notes: cur.notes, order_ref: cur.order_ref }, patch);
    if (status === 'registered' && cur.status !== 'registered') {   // tell the customer once
      const o = await ownerOf(cur.org_id);
      if (o?.email) await sendEmail({ to: o.email, subject: `Your domain ${cur.domain} is registered`, html: layout('Your domain is registered', `<p><b>${esc(cur.domain)}</b> is registered in your company's name. We are connecting it to your store.</p>`) });
    }
    return { ok: true };
  } },
  'domain.retry': { roles: ['admin', 'support'], run: async (s, b) => {
    const id = b.id; if (!isUuid(id)) throw new Bad('Invalid order');
    const { data: cur } = await admin.from('domain_orders').select('org_id, status').eq('id', id).maybeSingle();
    if (!cur) throw new Bad('Order not found', 404);
    const reg = await retryAutoRegister(id);
    await audit(s, 'domain.retry_auto', 'domain_orders', id, cur.org_id, { status: cur.status }, { outcome: reg.outcome, message: reg.message });
    return { outcome: reg.outcome, message: reg.message };
  } },

  // ---------- receiving: announce differences once ----------
  // Called after "close receiving". Claims the not-yet-announced discrepancies of a delivery (so a retry never emails twice), then emails the
  // customer's owner and our team inbox, with 7-day links to any photos of damaged goods.
  'discrepancy.notify': { roles: ['admin', 'warehouse'], run: async (s, b) => {
    const id = b.booking_id; if (!isUuid(id)) throw new Bad('Invalid delivery');
    const { data: bk } = await admin.from('inbound_bookings').select('id, org_id, ref').eq('id', id).maybeSingle();
    if (!bk) throw new Bad('Delivery not found', 404);
    const { data: claimed } = await admin.from('discrepancies').update({ notified_at: new Date().toISOString() }).eq('booking_id', id).is('notified_at', null)
      .select('id, kind, expected_qty, received_qty, product_id, products(sku, name)');
    if (!claimed?.length) return { notified: 0 };
    const { data: rl } = await admin.from('receipt_lines').select('product_id, photo_paths').eq('booking_id', id);
    const paths = (rl ?? []).flatMap((r) => (r.photo_paths as string[] | null) ?? []);
    const urlFor = new Map<string, string>();
    if (paths.length) { const { data: signed } = await admin.storage.from('receiving').createSignedUrls(paths, 60 * 60 * 24 * 7); for (const x of signed ?? []) if (x.signedUrl && x.path) urlFor.set(x.path, x.signedUrl); }
    const photosOf = (pid: string) => (rl ?? []).filter((r) => r.product_id === pid).flatMap((r) => (r.photo_paths as string[] | null) ?? []).map((p) => urlFor.get(p)).filter(Boolean) as string[];
    const WHY: Record<string, string> = { short: 'fewer arrived than booked', over: 'more arrived than booked', damaged: 'arrived damaged', unexpected: 'was not on the booking' };
    type D = { kind: string; expected_qty: number; received_qty: number; product_id: string; products: { sku: string; name: string } | { sku: string; name: string }[] | null };
    const item = (d: D) => {
      const pr = Array.isArray(d.products) ? d.products[0] : d.products;
      const counts = d.kind === 'short' || d.kind === 'over' ? ` (booked ${d.expected_qty}, received ${d.received_qty})` : d.received_qty ? ` (${d.received_qty} units)` : '';
      const ph = d.kind === 'damaged' ? photosOf(d.product_id) : [];
      return `<li><b>${esc(pr?.sku ?? '')}</b> ${esc(pr?.name ?? '')}: ${WHY[d.kind] ?? esc(d.kind)}${counts}${ph.length ? '<br>' + ph.map((u, i) => `<a href="${esc(u)}">Photo ${i + 1}</a>`).join(' · ') : ''}</li>`;
    };
    const list = `<ul>${(claimed as D[]).map(item).join('')}</ul>`;
    const owner = await ownerOf(bk.org_id);
    if (owner?.email) await sendEmail({ to: owner.email, subject: `Delivery ${bk.ref}: we found differences`,
      html: layout('We found differences in your delivery', `<p>We received delivery <b>${esc(bk.ref)}</b> and found the following:</p>${list}<p>We will contact you about what to do next. You can also see this in your dashboard under Inbound.</p>`) });
    await sendEmail({ to: TEAM_INBOX, subject: `Discrepancies on ${bk.ref} (${claimed.length})`,
      html: layout('Discrepancies opened', `<p>Delivery <b>${esc(bk.ref)}</b> was closed with differences:</p>${list}<p><a href="${SITE}/admin#discrepancies">Open the discrepancies list</a></p>`) });
    await audit(s, 'discrepancy.notify', 'inbound_bookings', id, bk.org_id, null, { count: claimed.length });
    return { notified: claimed.length };
  } },

  // ---------- customer change requests ----------
  // The decision runs as the signed-in staff member (their JWT), so the database function sees who decided and applies the change atomically.
  'change.decide': { roles: ['admin', 'warehouse'], run: async (s, b) => {
    const id = b.id; if (!isUuid(id)) throw new Bad('Invalid request');
    const approve = b.approve === true, note = text(b.note, 500);
    const { data, error } = await userClient(s.token).rpc('decide_change', { p_id: id, p_approve: approve, p_note: note || null });
    if (error) throw new Bad(error.message);
    const c = data as { org_id: string; summary: string; status: string; decision_note: string | null };
    const owner = await ownerOf(c.org_id);
    if (owner?.email) {
      await sendEmail({ to: owner.email, subject: `${approve ? 'Approved' : 'Declined'}: ${c.summary}`,
        html: layout(approve ? 'Your change was approved' : 'Your change was declined',
          `<p><b>${esc(c.summary)}</b></p><p>${approve ? 'We have applied it. You can see the result in your dashboard.' : 'Nothing was changed.'}</p>${c.decision_note ? `<p style="white-space:pre-wrap">${esc(c.decision_note)}</p>` : ''}`) });
    }
    return { ok: true, status: c.status };
  } },

  // ---------- requests inbox ----------
  'request.update': { roles: ['admin', 'support'], run: async (s, b) => {
    const id = b.request_id; if (!isUuid(id)) throw new Bad('Invalid request');
    const { data: cur } = await admin.from('requests').select('status, priority, assignee, org_id').eq('id', id).maybeSingle();
    if (!cur) throw new Bad('Request not found', 404);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (b.status !== undefined) { if (!REQ_STATUS.includes(text(b.status, 20))) throw new Bad('Invalid status'); patch.status = b.status; }
    if (b.priority !== undefined) { if (!PRIORITY.includes(text(b.priority, 20))) throw new Bad('Invalid priority'); patch.priority = b.priority; }
    if (b.assignee !== undefined) {
      if (b.assignee !== null && !isUuid(b.assignee)) throw new Bad('Invalid assignee');
      if (b.assignee) { const { data: st } = await admin.from('staff_users').select('active').eq('user_id', b.assignee).maybeSingle(); if (!st?.active) throw new Bad('That person is not active staff'); }
      patch.assignee = b.assignee;
    }
    const { error } = await admin.from('requests').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
    await audit(s, 'request.update', 'requests', id, cur.org_id, cur, patch);
    if (b.assignee && b.assignee !== cur.assignee && b.assignee !== s.user.id) {   // tell the new owner (not yourself)
      const { data: who } = await admin.auth.admin.getUserById(b.assignee as string);
      const { data: rq } = await admin.from('requests').select('subject, requester_name').eq('id', id).maybeSingle();
      if (who?.user?.email) await sendEmail({ to: who.user.email, subject: `Assigned to you: ${rq?.subject ?? 'request'}`,
        html: layout('A request was assigned to you', `<p><b>${esc(rq?.subject ?? '')}</b>${rq?.requester_name ? ' from ' + esc(rq.requester_name) : ''}.</p><p><a href="${SITE}/admin#requests/${id}">Open it in the admin panel</a></p>`) });
    }
    return { ok: true };
  } },
  'request.message': { roles: ['admin', 'support'], run: async (s, b) => {
    const id = b.request_id; if (!isUuid(id)) throw new Bad('Invalid request');
    const kind = text(b.kind, 10), body = text(b.body);
    if (!['reply', 'note', 'incoming'].includes(kind)) throw new Bad('Invalid message type');
    if (body.length < 2) throw new Bad('Write a message first');
    const { data: r } = await admin.from('requests').select('id, org_id, subject, requester_name, requester_email, status').eq('id', id).maybeSingle();
    if (!r) throw new Bad('Request not found', 404);
    const direction = kind === 'reply' ? 'out' : kind === 'note' ? 'note' : 'in';
    if (kind === 'reply' && !r.requester_email) throw new Bad('This request has no email address to reply to');
    const { error } = await admin.from('request_messages').insert({ request_id: id, direction, author_id: s.user.id, body });
    if (error) throw new Error(error.message);
    const patch: Record<string, unknown> = { last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (kind === 'reply') patch.status = 'waiting';
    if (kind === 'incoming' && r.status !== 'new') patch.status = 'open';
    await admin.from('requests').update(patch).eq('id', id);
    await audit(s, 'request.' + kind, 'requests', id, r.org_id, null, { length: body.length });
    if (kind === 'reply') {
      await sendEmail({
        to: r.requester_email!, replyTo: TEAM_INBOX, subject: `Re: ${r.subject}`,
        html: layout(r.subject, `<p style="white-space:pre-wrap">${esc(body)}</p><p style="font-size:13px;color:#666;margin-top:20px">Reply to this email to continue the conversation.</p>`),
      });
    }
    return { ok: true };
  } },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method' }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }
  const act = actions[String(b.action ?? '')];
  if (!act) return json(req, { error: 'unknown action' }, 400);
  const s = await staffCaller(req, act.roles);
  if ('error' in s) return json(req, { error: s.error }, s.status);
  try { return json(req, await act.run(s, b)); }
  catch (e) {
    if (e instanceof Bad) return json(req, { error: e.message }, e.status);
    console.error('admin-api', b.action, e);
    return json(req, { error: 'Something went wrong. Nothing was changed if you see this twice, tell the developer.' }, 500);
  }
});

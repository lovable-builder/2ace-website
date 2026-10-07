// What a customer may do about shipping their own orders. Everything the outside world hands us is checked here, before the database is asked.
// Dependencies are passed in, so every branch can be tested without a network. The database functions it calls are callable only by this
// function (service role): a customer can never reach them directly, so they cannot skip the checks below.
export class CsError extends Error { constructor(m: string, public status = 400) { super(m); } }

export const OWN_LABEL_MAX_BYTES = 2 * 1024 * 1024;
export const CAN_PREPARE_ROLES = ['owner', 'operations', 'staff'];
export const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
// A real PDF starts with "%PDF-". The browser's own idea of the file type is never trusted.
export const isPdf = (b: Uint8Array) => b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;

export interface CsDeps {
  orgId: string; role: string; userId: string;
  getOrder(id: string): Promise<{ id: string; org_id: string; ref: string; status: string; label_source: string | null } | null>;
  mode(orgId: string): Promise<string>;
  download(path: string): Promise<Uint8Array | null>;
  removeFile(path: string): Promise<void>;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
  shipment?(orderId: string): Promise<{ status: string; carrier: string | null; service_name: string | null; tracking_numbers: string[]; bill_net: number; bill_gross: number; package_id: string | null; purchased_at: string | null; created_at: string; error: string | null; buyer_role: string } | null>;
  ownLabel(orderId: string): Promise<{ filename: string | null; storage_path: string | null; tracking_numbers: string[]; carrier_name: string | null; created_at: string } | null>;
}

function allowed(d: CsDeps) { if (!CAN_PREPARE_ROLES.includes(d.role)) throw new CsError('Your role cannot prepare shipping. Ask an owner or operations user.', 403); }
async function ownOrder(d: CsDeps, id: unknown) {
  if (!isUuid(id)) throw new CsError('Invalid order');
  const o = await d.getOrder(id);
  if (!o || o.org_id !== d.orgId) throw new CsError('Order not found', 404);   // another customer's order looks exactly like a missing one
  return o;
}

// What this customer can do right now. The page asks first, so it never calls something that is not deployed or not allowed.
export async function capabilities(d: CsDeps) {
  const mode = await d.mode(d.orgId);
  return { mode, can_prepare: CAN_PREPARE_ROLES.includes(d.role), own_label: mode === 'payg' && CAN_PREPARE_ROLES.includes(d.role), buy_label: false };
}

export async function status(d: CsDeps, orderId: unknown) {
  const o = await ownOrder(d, orderId);
  const l = await d.ownLabel(o.id);
  const sh = d.shipment ? await d.shipment(o.id) : null;
  // A label we bought for this customer: only what the customer is meant to see (their price, never our cost or markup).
  const bought = sh && (sh.status === 'purchased' || sh.status === 'buying') ? { state: sh.status, carrier: sh.carrier, service: sh.service_name, tracking_numbers: sh.tracking_numbers ?? [], bill_net: Number(sh.bill_net), bill_gross: Number(sh.bill_gross), by: sh.buyer_role, purchased_at: sh.purchased_at } : null;
  return { order: { id: o.id, ref: o.ref, status: o.status }, label_source: o.label_source, bought_label: bought, own_label: l ? { filename: l.filename, has_file: !!l.storage_path, path: l.storage_path, tracking_numbers: l.tracking_numbers, carrier: l.carrier_name, added_at: l.created_at } : null };
}

// The customer uploaded a PDF to their folder (the storage rules already limit where) and now registers it on an order.
export async function attachOwnLabel(d: CsDeps, input: { order_id?: unknown; path?: unknown; filename?: unknown; tracking?: unknown; carrier?: unknown }) {
  allowed(d);
  const o = await ownOrder(d, input.order_id);
  const path = input.path == null || input.path === '' ? null : String(input.path);
  const tracking = Array.isArray(input.tracking) ? input.tracking.map((x) => String(x)) : String(input.tracking ?? '').split(/[\n,;]+/);
  let size: number | null = null;
  if (path) {
    if (!new RegExp(`^${d.orgId}/${o.id}/[0-9a-f-]{36}\\.pdf$`).test(path)) throw new CsError('Invalid label file');   // exactly the folder and name the storage rules allow
    const bytes = await d.download(path);
    if (!bytes) throw new CsError('The label file was not uploaded. Please try again.');
    size = bytes.length;
    if (size < 1 || size > OWN_LABEL_MAX_BYTES) { await d.removeFile(path); throw new CsError('The label file must be a PDF of at most 2 MB.'); }
    if (!isPdf(bytes)) { await d.removeFile(path); throw new CsError('That file is not a PDF. Upload the label as a PDF.'); }
  }
  const { data, error } = await d.rpc('attach_own_label', { p_org: d.orgId, p_order: o.id, p_path: path, p_filename: input.filename == null ? null : String(input.filename).slice(0, 120), p_size: size, p_tracking: tracking, p_carrier: input.carrier == null ? null : String(input.carrier), p_actor: d.userId });
  if (error) { if (path) await d.removeFile(path); throw new CsError(error.message); }
  const replaced = (data as { replaced_path?: string | null } | null)?.replaced_path;
  if (replaced && replaced !== path) await d.removeFile(replaced);
  return { ok: true };
}

export async function removeOwnLabel(d: CsDeps, input: { order_id?: unknown }) {
  allowed(d);
  const o = await ownOrder(d, input.order_id);
  const { data, error } = await d.rpc('remove_own_label', { p_org: d.orgId, p_order: o.id, p_actor: d.userId });
  if (error) throw new CsError(error.message);
  if (typeof data === 'string' && data) await d.removeFile(data);
  return { ok: true };
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errText, rest, rpc, signUrls } from '../lib/api';
import { useAccount } from './account';

// Everything the dashboard shows about the customer's goods, read with their own token (row-level security filters it).
export type InvRow = { product_id: string; sku: string; name: string; active: boolean; on_hand: number; available: number; unplaced: number; quarantined: number; incoming: number; photo_paths: string[] | null };
export type Line = { product_id: string; products: { sku: string; name: string } };
export type Booking = { id: string; ref: string; status: string; expected_date: string | null; carrier: string | null; tracking: string | null; notes: string | null; created_at: string; inbound_lines: (Line & { expected_qty: number })[] | null };
export type Order = {
  id: string; ref: string; external_ref: string | null; status: string; label_source: string | null; hold_reason: string | null; details_request_note?: string | null;
  ship_name: string; ship_line1: string; ship_line2: string | null; ship_postal: string; ship_city: string; ship_country: string; ship_phone: string | null; ship_email: string | null;
  created_at: string; shipped_at: string | null; order_lines: (Line & { qty: number })[] | null;
};
export type Return = { id: string; ref: string; status: string; fee_mode: string | null; reason: string | null; order_id: string | null; created_at: string; buyer_name: string; buyer_city: string;
  return_lines: { qty: number; received_qty: number | null; grade: string | null; note: string | null; products: { sku: string; name: string } }[] | null };
export type Charge = { at: string; kind: string; size_class?: string | null; note?: string | null; order_ref?: string | null; return_ref?: string | null; net: number; status: string };
export type Change = { id?: string; status: 'pending' | 'rejected' | 'done'; summary?: string; decision_note?: string | null };

export type WhData = {
  loaded: boolean;
  err: string;
  inv: InvRow[];
  codes: Record<string, string[]>;           // product -> barcodes
  book: Booking[];
  issues: Record<string, string[]>;          // booking -> differences found when it was received
  photos: Record<string, string[]>;          // booking -> signed links to photos of damaged goods
  changes: Record<string, Change>;           // item -> its newest pending or declined change request
  photoUrls: Record<string, string>;         // product photo path -> signed link
  orders: Order[];
  returns: Return[];
  charges: Charge[];
};

const EMPTY: WhData = { loaded: false, err: '', inv: [], codes: {}, book: [], issues: {}, photos: {}, changes: {}, photoUrls: {}, orders: [], returns: [], charges: [] };

type Ctx = WhData & {
  reload: () => Promise<void>;
  note: string;
  setNote: (s: string) => void;
  setErr: (s: string) => void;
  patchOrder: (id: string, patch: Partial<Order>) => void;
};
const WhContext = createContext<Ctx | null>(null);

const ORDER_COLS = 'id,ref,external_ref,status,label_source,hold_reason,ship_name,ship_line1,ship_line2,ship_postal,ship_city,ship_country,ship_phone,ship_email,created_at,shipped_at,order_lines(qty,product_id,products(sku,name))';
const WHY: Record<string, (d: { received_qty: number; expected_qty: number }) => string> = {
  short: (d) => d.received_qty + ' of ' + d.expected_qty + ' arrived', over: (d) => d.received_qty + ' arrived, ' + d.expected_qty + ' booked',
  damaged: (d) => d.received_qty + ' damaged', unexpected: (d) => d.received_qty + ' not on the booking',
};

export async function loadWarehouse(orgId: string): Promise<WhData> {
  const [inv, codes, book, dis, dmg, chg, orders, returns, charges] = await Promise.all([
    rest<InvRow[]>('v_inventory_by_product?select=product_id,sku,name,active,on_hand,available,unplaced,quarantined,incoming,photo_paths&order=sku'),
    rest<{ product_id: string; barcode: string }[]>('product_barcodes?select=product_id,barcode'),
    rest<Booking[]>('inbound_bookings?select=id,ref,status,expected_date,carrier,tracking,notes,created_at,inbound_lines(product_id,expected_qty,products(sku,name))&order=created_at.desc&limit=50'),
    rest<{ booking_id: string; kind: string; expected_qty: number; received_qty: number; products: { sku: string } | null }[]>('discrepancies?select=booking_id,kind,expected_qty,received_qty,products(sku)&order=created_at'),
    rest<{ booking_id: string; photo_paths: string[] | null }[]>('receipt_lines?select=booking_id,photo_paths&condition=eq.damaged'),
    rest<{ id: string; entity_id: string; summary: string; status: string; decision_note: string | null }[]>('change_requests?select=id,entity_id,summary,status,decision_note&order=requested_at.desc&limit=200'),
    // the correction note needs a newer database; without it the orders still load, just without the note
    rest<Order[]>('orders?select=' + ORDER_COLS.replace('hold_reason,', 'hold_reason,details_request_note,') + '&order=created_at.desc&limit=100').catch(() => rest<Order[]>('orders?select=' + ORDER_COLS + '&order=created_at.desc&limit=100')),
    // returns and charges need a newer database: until then they are simply empty
    rest<Return[]>('returns?select=id,ref,status,fee_mode,reason,order_id,created_at,buyer_name,buyer_city,return_lines(qty,received_qty,grade,note,products(sku,name))&order=created_at.desc&limit=100').catch(() => []),
    rpc<Charge[]>('my_charges', { p_org: orgId }).catch(() => []),
  ]);
  const changes: Record<string, Change> = {};
  for (const c of chg) {   // newest first: keep the newest open or declined request per item
    if (!changes[c.entity_id] && (c.status === 'pending' || c.status === 'rejected')) changes[c.entity_id] = { id: c.id, status: c.status, summary: c.summary, decision_note: c.decision_note };
    else if (!changes[c.entity_id]) changes[c.entity_id] = { status: 'done' };
  }
  const codeMap: Record<string, string[]> = {};
  for (const c of codes) (codeMap[c.product_id] ??= []).push(c.barcode);
  const issues: Record<string, string[]> = {};
  for (const d of dis) (issues[d.booking_id] ??= []).push((d.products?.sku || '') + ': ' + (WHY[d.kind] ? WHY[d.kind](d) : d.kind));
  const byBooking: Record<string, string[]> = {};
  for (const r of dmg) for (const p of r.photo_paths || []) (byBooking[r.booking_id] ??= []).push(p);
  const [urls, photoUrls] = await Promise.all([signUrls('receiving', Object.values(byBooking).flat()), signUrls('products', inv.flatMap((p) => p.photo_paths || []))]);
  const photos: Record<string, string[]> = {};
  for (const k of Object.keys(byBooking)) photos[k] = byBooking[k].map((p) => urls[p]).filter(Boolean);
  return { loaded: true, err: '', inv, codes: codeMap, book, issues, photos, changes, photoUrls, orders, returns: Array.isArray(returns) ? returns : [], charges: Array.isArray(charges) ? charges : [] };
}

export function WarehouseProvider({ children }: { children: ReactNode }) {
  const { orgId, loaded: accountLoaded } = useAccount();
  const [data, setData] = useState<WhData>(EMPTY);
  const [note, setNote] = useState('');
  const orgRef = useRef(orgId); orgRef.current = orgId;

  const reload = useCallback(async () => {
    const org = orgRef.current;
    if (!org) return;
    try { const d = await loadWarehouse(org); if (orgRef.current === org) setData(d); }
    catch (e) { setData((x) => ({ ...x, loaded: true, err: errText(e) })); }
  }, []);
  useEffect(() => {
    if (orgId) void reload();
    else if (accountLoaded) setData({ ...EMPTY, loaded: true });   // signed in without a company yet: nothing to load
  }, [orgId, accountLoaded, reload]);

  const setErr = useCallback((err: string) => setData((x) => ({ ...x, err })), []);
  const patchOrder = useCallback((id: string, patch: Partial<Order>) => setData((x) => ({ ...x, orders: x.orders.map((o) => (o.id === id ? { ...o, ...patch } : o)) })), []);
  const value = useMemo<Ctx>(() => ({ ...data, reload, note, setNote, setErr, patchOrder }), [data, reload, note, setErr, patchOrder]);
  return <WhContext.Provider value={value}>{children}</WhContext.Provider>;
}

export function useWarehouse(): Ctx {
  const c = useContext(WhContext);
  if (!c) throw new Error('useWarehouse outside WarehouseProvider');
  return c;
}

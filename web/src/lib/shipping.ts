import { ApiError, callFn } from './api';
import { MSG } from './messages';

// The customer-shipping function: what this customer may do, prices, buying and downloading labels, own labels, return labels.
// Every check (spend limits, prices, who owns the order) happens on the server; the browser only asks and shows.
export const SHIPPING_UNAVAILABLE = MSG.shipping;

export async function shipping<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
  const r = await callFn<T>('customer-shipping', body);
  if (r.status === 404 && !r.data.error) throw new ApiError(SHIPPING_UNAVAILABLE, 404);
  if (!r.ok) throw new ApiError(r.data.error || MSG.failed, r.status, r.data);
  return r.data;
}

export type Caps = { mode?: string; own_label?: boolean; buy_label?: boolean; buy_return_label?: boolean };
export type Bought = { state?: string; service?: string | null; carrier?: string | null; tracking_numbers?: string[] | null; bill_net: number };
export type OwnLabel = { filename?: string | null; carrier?: string | null; tracking_numbers?: string[] | null };
export type OrderShipInfo = { own_label?: OwnLabel | null; bought_label?: Bought | null; last_failed?: string | null };
export type Pending = { pending?: boolean; message?: string };

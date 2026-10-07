// Automatic label: right after an order is packed, buy the cheapest carrier that can take the parcel, within the usual limits.
// It never works around a guard: a refused limit, an empty balance or an unknown result stops it and leaves the order for a person.
// The purchase itself is `buy` (the same tested flow staff use), passed in, so every rule here can be tested without a network.
import { ShipError } from './shipBuy.ts';
import type { Quote } from './shipping.ts';

export const AUTO_MAX_TRIES = 3;
export type AutoResult =
  | { status: 'bought'; shipment: { carrier: string; tracking_numbers: string[]; cost_gross: number; bill_net: number; bill_gross: number }; service: string; tried: string[] }
  | { status: 'skipped'; reason: 'off' | 'own_label' | 'has_label'; message: string }
  | { status: 'needs_person'; message: string; tried: string[] };

export interface AutoDeps {
  enabled: boolean;                                                   // SHIPPING_AUTO_LABEL
  hasOwnLabel(): Promise<boolean>;
  hasActiveShipment(): Promise<boolean>;
  candidates(): Promise<Quote[]>;                                     // quotes that are available
  buy(serviceId: number): Promise<{ shipment: { carrier: string; tracking_numbers: string[]; cost_gross: number; bill_net: number; bill_gross: number } }>;
}

// An error that means "this carrier cannot take it, nothing was charged": try the next one. Anything else stops the whole thing.
const tryNext = (e: ShipError) => e.status === 422 || (e.status === 400 && /not available/i.test(e.message));

export async function autoLabel(d: AutoDeps): Promise<AutoResult> {
  // An order that already has a label (the customer's own, or one the customer bought) is said so first, whether or not automatic labels are on.
  if (await d.hasOwnLabel()) return { status: 'skipped', reason: 'own_label', message: "The customer provided their own label, so none is bought." };
  if (await d.hasActiveShipment()) return { status: 'skipped', reason: 'has_label', message: 'This order already has a label bought for it.' };
  if (!d.enabled) return { status: 'skipped', reason: 'off', message: 'Automatic labels are switched off.' };
  const list = [...(await d.candidates())].filter((q) => q.available).sort((a, b) => a.cost_net - b.cost_net).slice(0, AUTO_MAX_TRIES);
  if (!list.length) return { status: 'needs_person', message: 'No carrier can take this parcel automatically. Check the prices and buy a label by hand.', tried: [] };
  const tried: string[] = [];
  for (const q of list) {
    tried.push(q.name);
    try {
      const r = await d.buy(q.service_id);
      return { status: 'bought', shipment: r.shipment, service: q.name, tried };
    } catch (e) {
      if (e instanceof ShipError && tryNext(e)) continue;                                   // refused before any charge: next cheapest
      const m = e instanceof ShipError ? e.message : (e as Error).message;
      return { status: 'needs_person', message: m, tried };                                 // a limit, the balance, or an unknown result: a person decides
    }
  }
  return { status: 'needs_person', message: `None of the ${tried.length} cheapest carriers would take it (${tried.join(', ')}). Buy a label by hand.`, tried };
}

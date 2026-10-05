import type Stripe from 'npm:stripe';

// What Stripe will actually bill every month for a subscription, in whole PLN (net). Used to check that our plan record and Stripe agree.
export function recurringMonthlyPLN(sub: Stripe.Subscription): number {
  let cents = 0;
  for (const i of sub.items?.data ?? []) {
    if (i.price?.recurring?.interval === 'month') cents += (i.price.unit_amount ?? 0) * (i.quantity ?? 1);
  }
  return Math.round(cents / 100);
}

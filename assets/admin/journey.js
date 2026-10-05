import { el, clear } from './ui.js';

// The journey of goods and orders, as a picture. Numbers are live; every station links to the screen where you work on it.
export const STEPS = [
  { k: 'booked', icon: '📋', title: 'Booked', hint: 'A customer announces a delivery', route: 'inbound' },
  { k: 'arrived', icon: '🚚', title: 'Arriving', hint: 'You scan the goods in', route: 'inbound' },
  { k: 'shelf', icon: '🗄️', title: 'On the shelf', hint: "Stored in the customer's bin, ready to sell", route: 'stock', unit: 'units' },
  { k: 'ordered', icon: '🛒', title: 'Ordered', hint: 'An order reserves its stock', route: 'orders' },
  { k: 'picking', icon: '🎯', title: 'Picking', hint: 'Collected from the shelves', route: 'orders' },
  { k: 'packed', icon: '📦', title: 'Packed', hint: 'Boxed, weighed, waiting for a label', route: 'orders' },
  { k: 'shipped', icon: '🚀', title: 'Shipped', hint: 'Label bought, on its way (last 7 days)', route: 'orders' },
];

const count = (ctx, table, build) => build(ctx.sb.from(table).select('id', { count: 'exact', head: true })).then((r) => r.count ?? 0);

export async function loadJourney(ctx) {
  const week = new Date(Date.now() - 7 * 864e5).toISOString();
  const [booked, arrived, ordered, held, picking, packed, shipped, stock] = await Promise.all([
    count(ctx, 'inbound_bookings', (q) => q.eq('status', 'booked')),
    count(ctx, 'inbound_bookings', (q) => q.eq('status', 'receiving')),
    count(ctx, 'orders', (q) => q.eq('status', 'allocated')),
    count(ctx, 'orders', (q) => q.eq('status', 'held')),
    count(ctx, 'orders', (q) => q.eq('status', 'picking')),
    count(ctx, 'orders', (q) => q.eq('status', 'packed')),
    count(ctx, 'orders', (q) => q.eq('status', 'shipped').gte('shipped_at', week)),
    ctx.sb.from('stock_levels').select('on_hand, locations(kind)').gt('on_hand', 0).limit(5000),
  ]);
  const shelf = (stock.data || []).filter((r) => r.locations && ['bin', 'pallet'].includes(r.locations.kind)).reduce((t, r) => t + r.on_hand, 0);
  return { booked, arrived, shelf, ordered, held, picking, packed, shipped };
}

// The strip for the Overview screen.
export function journeyStrip(ctx) {
  const track = el('ol', { class: 'track' }, el('li', { class: 'muted', text: 'Loading…' }));
  const box = el('section', { class: 'journey card' },
    el('h2', { text: 'The journey of an order' }),
    el('p', { class: 'muted', text: 'Follow the goods from a booked delivery to a shipped parcel. The numbers are live. Click a step to open it.' }),
    el('div', { class: 'lane' }, el('span', { class: 'parcel', 'aria-hidden': 'true', text: '📦' }), track));
  loadJourney(ctx).then((c) => {
    clear(track).append(...STEPS.map((s, i) => {
      const n = c[s.k] ?? 0;
      return el('li', { class: 'station' + (n > 0 ? ' on' : '') },
        el('a', { href: '#' + s.route, 'aria-label': `${s.title}: ${n}${s.unit ? ' ' + s.unit : ''}. ${s.hint}` },
          el('span', { class: 'ico' }, s.icon, s.k === 'ordered' && c.held > 0 && el('em', { class: 'badge', title: 'Orders on hold, not enough stock', text: c.held + ' on hold' })),
          el('b', { class: 'n', text: String(n) }), el('span', { class: 't', text: s.title }), el('small', { text: s.hint })),
        i < STEPS.length - 1 && el('i', { class: 'hop', 'aria-hidden': 'true' }));
    }));
  }).catch((e) => { clear(track).append(el('li', { class: 'err', text: 'Could not load the journey: ' + e.message })); });
  return box;
}

// A small progress tracker for one order.
const ORDER_STEPS = [['Received', '📝'], ['Reserved', '🔒'], ['Picking', '🎯'], ['Packed', '📦'], ['Shipped', '🚀']];
const AT = { new: 0, held: 1, allocated: 1, picking: 2, packed: 3, shipped: 4 };
export function orderStepper(status) {
  if (status === 'cancelled') return el('div', { class: 'note' }, el('b', { text: 'Cancelled' }), el('p', { text: 'This order was cancelled and its stock released.' }));
  const at = AT[status] ?? 0, held = status === 'held';
  return el('ol', { class: 'stepper', 'aria-label': 'Order progress' }, ORDER_STEPS.map(([label, icon], i) => {
    const state = held && i === 1 ? 'stuck' : i < at || (status === 'shipped' && i === 4) ? 'done' : i === at ? 'now' : 'todo';
    return el('li', { class: state, 'aria-current': state === 'now' ? 'step' : null },
      el('span', { class: 'dot' }, state === 'done' ? '✓' : state === 'stuck' ? '!' : icon),
      el('span', { class: 'lbl', text: held && i === 1 ? 'Waiting for stock' : label }));
  }));
}

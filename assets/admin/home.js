import { el, clear } from './ui.js';
import { journeyStrip } from './journey.js';

// Landing screen: what needs attention right now.
export async function render(ctx, root) {
  clear(root).append(el('h1', { text: 'Overview' }), el('p', { class: 'muted', text: 'Loading…' }));
  const sum = async () => { const { data } = await ctx.sb.from('v_inventory_by_product').select('unplaced'); return (data || []).reduce((s, r) => s + r.unplaced, 0); };
  const warehouseCards = async () => {
    const [hold, toPick, apr, exp, rcv, unplaced, disc] = await Promise.all([
      ctx.sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'held').then((r) => r.count ?? 0),
      ctx.sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'allocated').then((r) => r.count ?? 0),
      ctx.sb.from('change_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending').then((r) => r.count ?? 0),
      ctx.sb.from('inbound_bookings').select('id', { count: 'exact', head: true }).eq('status', 'booked').then((r) => r.count ?? 0),
      ctx.sb.from('inbound_bookings').select('id', { count: 'exact', head: true }).eq('status', 'receiving').then((r) => r.count ?? 0),
      sum(), ctx.sb.from('discrepancies').select('id', { count: 'exact', head: true }).eq('status', 'open').then((r) => r.count ?? 0)]);
    const card = (n, label, route, hot) => el('a', { class: 'stat' + (hot && n ? ' hot' : ''), href: '#' + route }, el('b', { text: String(n) }), el('span', { text: label }));
    return [card(hold, 'Orders on hold', 'orders', true), card(toPick, 'Orders to pick', 'orders'), card(apr, 'Changes to approve', 'approvals', true), card(exp, 'Deliveries expected', 'inbound'), card(rcv, 'Being received', 'inbound', true), card(unplaced, 'Units to put away', 'stock/putaway', true), card(disc, 'Open discrepancies', 'discrepancies', true)];
  };
  if (ctx.me.role === 'warehouse') {
    try { return clear(root).append(el('h1', { text: 'Overview' }), journeyStrip(ctx), el('div', { class: 'stats' }, await warehouseCards())); }
    catch (e) { return clear(root).append(el('h1', { text: 'Overview' }), el('p', { class: 'err', text: 'Could not load: ' + e.message })); }
  }
  const count = async (table, build) => { const q = ctx.sb.from(table).select('id', { count: 'exact', head: true }); const r = await build(q); return r.count ?? 0; };
  try {
    const [newReq, openReq, pendDom, pastDue, active] = await Promise.all([
      count('requests', (q) => q.eq('status', 'new')),
      count('requests', (q) => q.in('status', ['open', 'waiting'])),
      count('domain_orders', (q) => q.eq('status', 'pending')),
      ctx.sb.from('organizations').select('id', { count: 'exact', head: true }).eq('status', 'past_due').then((r) => r.count ?? 0),
      ctx.sb.from('organizations').select('id', { count: 'exact', head: true }).eq('status', 'active').then((r) => r.count ?? 0),
    ]);
    const card = (n, label, route, hot) => el('a', { class: 'stat' + (hot && n ? ' hot' : ''), href: '#' + route }, el('b', { text: String(n) }), el('span', { text: label }));
    clear(root).append(el('h1', { text: 'Overview' }),
      el('div', { class: 'stats' },
        card(newReq, 'New requests', 'requests', true), card(openReq, 'Open requests', 'requests'),
        card(pendDom, 'Domains to register', 'domains', true), card(pastDue, 'Customers past due', 'customers', true), card(active, 'Active customers', 'customers')),
      el('h2', { text: 'Warehouse' }), journeyStrip(ctx), el('div', { class: 'stats' }, await warehouseCards()));
  } catch (e) { clear(root).append(el('h1', { text: 'Overview' }), el('p', { class: 'err', text: 'Could not load: ' + e.message })); }
}

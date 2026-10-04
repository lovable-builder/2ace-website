import { el, clear } from './ui.js';

// Landing screen: what needs attention right now.
export async function render(ctx, root) {
  clear(root).append(el('h1', { text: 'Overview' }), el('p', { class: 'muted', text: 'Loading…' }));
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
        card(pendDom, 'Domains to register', 'domains', true), card(pastDue, 'Customers past due', 'customers', true), card(active, 'Active customers', 'customers')));
  } catch (e) { clear(root).append(el('h1', { text: 'Overview' }), el('p', { class: 'err', text: 'Could not load: ' + e.message })); }
}

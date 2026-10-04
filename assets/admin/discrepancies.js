import { el, clear, table, pill, modal, toast, fmtDate, field } from './ui.js';
import { rpc, canAct, loadOrgs, orgName, guarded } from './wms.js';

const WHY = { short: 'Fewer arrived than booked', over: 'More arrived than booked', damaged: 'Arrived damaged', unexpected: 'Not on the booking' };

export async function render(ctx, root) {
  clear(root).append(el('h1', { text: 'Discrepancies' }), el('p', { class: 'muted', text: 'Loading…' }));
  const orgs = await loadOrgs(ctx);
  const st = el('select', {}, el('option', { value: 'open', text: 'Open' }), el('option', { value: 'resolved', text: 'Resolved' }), el('option', { value: '', text: 'All' }));
  const holder = el('div');
  const load = async () => {
    let q = ctx.sb.from('discrepancies').select('*, products(sku, name), inbound_bookings(ref)').order('created_at', { ascending: false }).limit(200);
    if (st.value) q = q.eq('status', st.value);
    const { data, error } = await q; if (error) return clear(holder).append(el('p', { class: 'err', text: error.message }));
    clear(holder).append(table([
      { label: 'Delivery', render: (d) => el('a', { href: '#inbound/' + d.booking_id, text: d.inbound_bookings.ref }) }, { label: 'Customer', render: (d) => orgName(orgs, d.org_id) },
      { label: 'Product', render: (d) => `${d.products.sku} - ${d.products.name}` }, { label: 'Issue', render: (d) => el('div', {}, pill(d.kind, d.status === 'open' ? 'warn' : 'muted'), el('small', { class: 'muted', text: ' ' + WHY[d.kind] })) },
      { label: 'Booked / got', render: (d) => `${d.expected_qty} / ${d.received_qty}` }, { label: 'Found', render: (d) => fmtDate(d.created_at) },
      { label: 'Decision', render: (d) => (d.status === 'resolved' ? d.resolution : canAct(ctx) ? el('button', { class: 'btn tiny', text: 'Resolve', onclick: () => resolve(d) }) : '-') },
    ], data));
  };
  const resolve = (d) => modal('Resolve: ' + WHY[d.kind], (body, done) => {
    const t = el('textarea', { rows: '3', placeholder: 'What was decided? e.g. "Customer informed, accepts short delivery"' }), err = el('p', { class: 'err' });
    const go = el('button', { class: 'btn', text: 'Mark resolved', onclick: () => guarded(go, err, async () => { await rpc(ctx, 'resolve_discrepancy', { p_id: d.id, p_resolution: t.value }); done(true); }) });
    body.append(t, err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), go));
  }).then((ok) => { if (ok) { toast('Resolved'); load(); } });
  st.addEventListener('change', load);
  clear(root).append(el('h1', { text: 'Discrepancies' }), el('div', { class: 'row' }, st), holder); load();
}

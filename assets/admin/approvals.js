import { el, clear, table, pill, field, modal, toast, kv, fmtDate, fmtDay } from './ui.js';
import { canAct, loadOrgs, orgName, guarded } from './wms.js';

// Customer edits and deletes wait here. Approving applies the change; declining needs a reason the customer sees.
const KIND = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: 'muted' };

export async function render(ctx, root) {
  clear(root).append(el('h1', { text: 'Approvals' }), el('p', { class: 'muted', text: 'Loading…' }));
  const orgs = await loadOrgs(ctx);
  const st = el('select', {}, el('option', { value: 'pending', text: 'Waiting for a decision' }), el('option', { value: '', text: 'All' }), ['approved', 'rejected', 'cancelled'].map((s) => el('option', { value: s, text: s })));
  const holder = el('div');
  const load = async () => {
    let q = ctx.sb.from('change_requests').select('*').order('requested_at', { ascending: false }).limit(200);
    if (st.value) q = q.eq('status', st.value);
    const { data, error } = await q; if (error) return clear(holder).append(el('p', { class: 'err', text: error.message }));
    clear(holder).append(table([
      { label: 'Customer', render: (c) => orgName(orgs, c.org_id) }, { label: 'Request', render: (c) => el('strong', { text: c.summary }) },
      { label: 'Asked', render: (c) => fmtDate(c.requested_at) }, { label: 'Status', render: (c) => pill(c.status, KIND[c.status]) },
      { label: 'Decision', render: (c) => c.decision_note || '' },
    ], data, (c) => open(c)));
  };
  const open = async (c) => {
    // current state next to what was asked for
    const rows = [];
    if (c.entity === 'inbound') {
      const [b, ln, pr] = await Promise.all([ctx.sb.from('inbound_bookings').select('*').eq('id', c.entity_id).maybeSingle(), ctx.sb.from('inbound_lines').select('product_id, expected_qty').eq('booking_id', c.entity_id), ctx.sb.from('products').select('id, sku, name').eq('org_id', c.org_id)]);
      const name = (id) => { const p = (pr.data || []).find((x) => x.id === id); return p ? p.sku + ' - ' + p.name : id; };
      if (!b.data) rows.push(['Delivery', 'This delivery no longer exists']);
      else if (c.action === 'delete') rows.push(['Delivery', `${b.data.ref}, ${b.data.status}, ${(ln.data || []).map((l) => name(l.product_id) + ' × ' + l.expected_qty).join(', ')}`]);
      else {
        const p = c.payload || {}; const cur = b.data;
        const diff = (label, a, n) => rows.push([label, (a || '-') === (n || '-') ? (a || '-') : `${a || '-'}  →  ${n || '-'}`]);
        diff('Expected date', cur.expected_date, p.expected); diff('Carrier', cur.carrier, p.carrier); diff('Tracking', cur.tracking, p.tracking); diff('Notes', cur.notes, p.notes);
        const old = Object.fromEntries((ln.data || []).map((l) => [l.product_id, l.expected_qty])); const nu = Object.fromEntries((p.lines || []).map((l) => [l.product_id, l.qty]));
        for (const id of new Set([...Object.keys(old), ...Object.keys(nu)])) rows.push([name(id), id in old && id in nu ? (old[id] === nu[id] ? String(old[id]) : `${old[id]}  →  ${nu[id]}`) : id in nu ? `added: ${nu[id]}` : `removed (was ${old[id]})`]);
      }
    } else {
      const [pr, bc] = await Promise.all([ctx.sb.from('products').select('*').eq('id', c.entity_id).maybeSingle(), ctx.sb.from('product_barcodes').select('barcode').eq('product_id', c.entity_id)]);
      if (!pr.data) rows.push(['Product', 'This product no longer exists']);
      else if (c.action === 'delete') rows.push(['Product', `${pr.data.sku} - ${pr.data.name}`], ['Barcodes', (bc.data || []).map((x) => x.barcode).join(', ')]);
      else { const p = c.payload || {}; rows.push(['Product', pr.data.sku]); if ('name' in p) rows.push(['Name', `${pr.data.name}  →  ${p.name}`]); if ('ean' in p) rows.push(['Add barcode', p.ean]); if ('active' in p) rows.push(['Status', `${pr.data.active ? 'active' : 'switched off'}  →  ${p.active ? 'active' : 'switched off'}`]); }
    }
    const act = canAct(ctx) && c.status === 'pending';
    await modal(c.summary, (body, done) => {
      const err = el('p', { class: 'err' }), note = el('textarea', { rows: '3', placeholder: 'Reason shown to the customer (required to decline)' });
      const decide = (approve, btn) => guarded(btn, err, async () => { await ctx.api('change.decide', { id: c.id, approve, note: note.value }); done(approve ? 'approved' : 'declined'); });
      const yes = el('button', { class: 'btn', text: 'Approve and apply', onclick: () => decide(true, yes) }), no = el('button', { class: 'btn ghost', text: 'Decline', onclick: () => decide(false, no) });
      body.append(kv([['Customer', orgName(orgs, c.org_id)], ['Asked', fmtDate(c.requested_at)], ['Status', c.status], ['Decision', c.decision_note], ...rows]),
        act && field('Note', note), err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Close' }), act && no, act && yes));
    }).then((r) => { if (r) { toast(r === 'approved' ? 'Approved and applied. The customer was emailed.' : 'Declined. The customer was emailed.'); load(); } });
  };
  st.addEventListener('change', load);
  clear(root).append(el('h1', { text: 'Approvals' }), el('p', { class: 'muted', text: 'Customers cannot change or delete their deliveries and products on their own. They ask here, and nothing changes until you approve it.' }), el('div', { class: 'row' }, st), holder); load();
}

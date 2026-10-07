import { el, clear, table, pill, modal, toast, kv, fmtDate, field } from './ui.js';
import { rpc, canAct, loadOrgs, orgName, orgSelect, guarded } from './wms.js';

// Returns: goods coming back to the warehouse. The customer announces a return and issues the label; here the parcel is received (weight and longest side
// decide the handling class), each line is inspected and graded (A goes back on the customer's shelf, B and C are set aside in quarantine), and the customer is told.
const KIND = { announced: 'warn', label_issued: 'warn', received: 'warn', graded: 'ok', cancelled: 'muted' };
const LABEL = { announced: 'announced', label_issued: 'label issued, on its way', received: 'received, to inspect', graded: 'graded', cancelled: 'cancelled' };
const GRADE = { A: 'A: sellable, back on the shelf', B: 'B: damaged, set aside', C: 'C: not sellable, set aside' };

export async function render(ctx, root, params) {
  if (params && params[0]) return detail(ctx, root, params[0]);
  clear(root).append(el('h1', { text: 'Returns' }), el('p', { class: 'muted', text: 'Loading…' }));
  const orgs = await loadOrgs(ctx);
  let tab = 'todo'; const holder = el('div'), tabs = el('div', { class: 'row' });
  const { data, error } = await ctx.sb.from('returns').select('*, return_lines(qty, products(sku))').order('created_at', { ascending: false }).limit(300);
  if (error) return clear(root).append(el('h1', { text: 'Returns' }), el('p', { class: 'err', text: error.message }));
  const all = data || [];
  const sets = { todo: (r) => ['announced', 'label_issued', 'received'].includes(r.status), done: (r) => r.status === 'graded', cancelled: (r) => r.status === 'cancelled' };
  const show = () => {
    clear(tabs).append(...[['todo', 'To handle'], ['done', 'Graded'], ['cancelled', 'Cancelled']].map(([k, l]) => el('button', { class: 'btn tiny ' + (tab === k ? '' : 'ghost'), text: l + ' (' + all.filter(sets[k]).length + ')', onclick: () => { tab = k; show(); } })));
    const rows = all.filter(sets[tab]);
    clear(holder).append(table([
      { label: 'Return', render: (r) => el('strong', { text: r.ref }) }, { label: 'Customer', render: (r) => orgName(orgs, r.org_id) }, { label: 'Buyer', render: (r) => r.buyer_name + ', ' + r.buyer_city },
      { label: 'Items', render: (r) => (r.return_lines || []).map((l) => l.products.sku + ' × ' + l.qty).join(', ') }, { label: 'Status', render: (r) => pill(LABEL[r.status] || r.status, KIND[r.status]) }, { label: 'Announced', render: (r) => fmtDate(r.created_at) },
    ], rows, (r) => ctx.go('returns/' + r.id)));
    if (!rows.length) holder.append(el('p', { class: 'muted', text: tab === 'todo' ? 'No returns waiting. When a customer announces one it appears here.' : 'Nothing here.' }));
  };
  clear(root).append(el('h1', { text: 'Returns' }), el('p', { class: 'muted', text: 'Parcels coming back for our customers. Receive each one when it arrives, then inspect and grade every line. The customer is emailed the outcome.' }), tabs, holder); show();
}

async function detail(ctx, root, id) {
  clear(root).append(el('p', { class: 'muted', text: 'Loading…' }));
  const orgs = await loadOrgs(ctx);
  const [rt, ln, sh, ch] = await Promise.all([
    ctx.sb.from('returns').select('*').eq('id', id).maybeSingle(),
    ctx.sb.from('return_lines').select('id, qty, received_qty, grade, note, products(sku, name)').eq('return_id', id).order('id'),
    ctx.sb.from('shipments').select('status, carrier, service_name, tracking_numbers').eq('return_id', id).order('created_at', { ascending: false }),
    ctx.sb.from('shipping_charges').select('kind, net, status, size_class, note').eq('return_id', id),
  ]);
  const r = rt.data; if (!r) return clear(root).append(el('p', { class: 'err', text: 'Return not found.' }), el('button', { class: 'btn ghost', onclick: () => ctx.go('returns'), text: 'Back' }));
  const act = canAct(ctx), reload = () => detail(ctx, root, id), lines = ln.data || [], label = (sh.data || []).find((s) => s.status === 'purchased');
  const fee = (ch.data || []).find((c) => c.kind === 'return_handling');
  // receive
  const receiveBox = () => {
    const w = el('input', { type: 'number', min: '1', max: '70000', placeholder: 'Weight in grams', 'aria-label': 'Weight in grams' }), sd = el('input', { type: 'number', min: '1', max: '300', step: 'any', placeholder: 'Longest side in cm', 'aria-label': 'Longest side in cm' }), err = el('p', { class: 'err' });
    const go = el('button', { class: 'btn', text: 'Receive the parcel', onclick: () => guarded(go, err, async () => { await rpc(ctx, 'receive_return', { p_return: id, p_weight_g: Number(w.value), p_side_cm: Number(sd.value) }); toast('Parcel received'); reload(); }) });
    return el('section', { class: 'card' }, el('h2', { text: 'The parcel has arrived' }), el('p', { class: 'muted', text: 'Weigh it and measure its longest side. This decides the handling fee class. Then inspect the goods line by line.' }), el('div', { class: 'row' }, field('Weight (g)', w), field('Longest side (cm)', sd)), err, el('div', { class: 'row' }, go));
  };
  // grade one line
  const gradeRow = (l) => {
    if (l.grade) return el('div', { class: 'row' }, pill(l.grade, l.grade === 'A' ? 'ok' : 'bad'), ` ${l.received_qty} of ${l.qty} came back. ${GRADE[l.grade] || ''}`, l.note && el('span', { class: 'muted', text: ' · ' + l.note }));
    if (r.status !== 'received' || !act) return el('span', { class: 'muted', text: r.status === 'received' ? '' : 'Receive the parcel first' });
    const q = el('input', { type: 'number', min: '0', value: String(l.qty), style: 'width:80px', 'aria-label': 'Came back' }), g = el('select', { 'aria-label': 'Grade' }, el('option', { value: '', text: 'Grade' }), ...Object.entries(GRADE).map(([k, t]) => el('option', { value: k, text: t }))), nt = el('input', { placeholder: 'Note (optional)', 'aria-label': 'Note' }), err = el('p', { class: 'err' });
    const go = el('button', { class: 'btn tiny', text: 'Save grade', onclick: () => guarded(go, err, async () => {
      const res = await rpc(ctx, 'grade_return_line', { p_line: l.id, p_received: Number(q.value), p_grade: g.value || null, p_note: nt.value });
      if (res && res.finished) { try { await ctx.api('return.notify', { id }); toast('Return finished and the customer was told'); } catch (e) { toast('Return finished. The email could not be sent: ' + e.message, true); } } else toast('Saved');
      reload(); }) });
    return el('div', {}, el('div', { class: 'row' }, field('Came back', q), field('Grade', g), field('Note', nt), go), err);
  };
  const cancel = async () => { try { await rpc(ctx, 'cancel_return', { p_return: id }); toast('Cancelled'); reload(); } catch (e) { toast(e.message, true); } };
  clear(root).append(
    el('div', { class: 'row between' }, el('div', {}, el('button', { class: 'btn ghost tiny', onclick: () => ctx.go('returns'), text: '← Returns' }), el('h1', { text: r.ref + ' ' }), pill(LABEL[r.status] || r.status, KIND[r.status])),
      act && r.status === 'announced' && !label && el('button', { class: 'btn ghost', onclick: cancel, text: 'Cancel return' })),
    el('div', { class: 'cols' },
      el('section', { class: 'card' }, el('h2', { text: 'Return' }), kv([['Customer', orgName(orgs, r.org_id)], ['Reason', r.reason], ['Announced', fmtDate(r.created_at)], ['Received', r.received_at ? fmtDate(r.received_at) + ` (${r.weight_g} g, longest side ${r.side_cm} cm)` : null], ['Graded', r.graded_at ? fmtDate(r.graded_at) : null], ['Customer told', r.notified_at ? fmtDate(r.notified_at) : null], ['Fee', r.fee_mode === 'payg' ? 'Pay as you go: a handling fee per return' : 'Flat monthly fee, no charge per return']])),
      el('section', { class: 'card' }, el('h2', { text: 'The buyer' }), kv([['Name', r.buyer_name], ['Company', r.buyer_company], ['Address', [r.buyer_line1, r.buyer_line2].filter(Boolean).join(', ')], ['Postal code and city', `${r.buyer_postal} ${r.buyer_city}`], ['Country', r.buyer_country], ['Phone', r.buyer_phone], ['Email', r.buyer_email]]))),
    el('section', { class: 'card' }, el('h2', { text: 'Return label' }), label ? kv([['Carrier', label.service_name || label.carrier], ['Tracking', (label.tracking_numbers || []).join(', ') || 'Not available yet']]) : el('p', { class: 'muted', text: 'No label was issued here. The goods may still arrive.' })),
    ['announced', 'label_issued'].includes(r.status) && act && receiveBox(),
    el('section', { class: 'card' }, el('h2', { text: 'Goods' }), ...lines.map((l) => el('div', { class: 'ex' }, el('b', { text: `${l.products.sku} · ${l.products.name}` }), el('p', { class: 'muted', text: `The customer says ${l.qty} are coming back.` }), gradeRow(l)))),
    fee && el('section', { class: 'card' }, el('h2', { text: 'Handling fee' }), kv([['Class', fee.size_class], ['Fee', Number(fee.net).toFixed(2).replace('.', ',') + ' zł + VAT'], ['Status', fee.status === 'waived' ? 'Test, never invoiced' : fee.status], ['Note', fee.note]])));
}

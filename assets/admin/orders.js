import { el, clear, table, pill, field, modal, toast, kv, fmtDate, confirmBox } from './ui.js';
import { rpc, canAct, loadOrgs, orgName, orgSelect, guarded } from './wms.js';

// Orders: every customer's orders with what is reserved for them. A held order has reserved nothing and says what is short.
const KIND = { new: 'warn', held: 'bad', allocated: 'ok', picking: 'warn', packed: 'ok', shipped: 'ok', cancelled: 'muted' };
const LABEL = { new: 'received', held: 'on hold', allocated: 'reserved', picking: 'picking', packed: 'packed', shipped: 'shipped', cancelled: 'cancelled' };
const OPEN = ['new', 'held', 'allocated', 'picking', 'packed'];

export async function render(ctx, root, params) {
  if (params && params[0]) return detail(ctx, root, params[0]);
  clear(root).append(el('h1', { text: 'Orders' }), el('p', { class: 'muted', text: 'Loading…' }));
  const orgs = await loadOrgs(ctx);
  const st = el('select', {}, el('option', { value: 'open', text: 'Open orders' }), el('option', { value: 'held', text: 'On hold' }), el('option', { value: '', text: 'All' }), ['allocated', 'picking', 'packed', 'shipped', 'cancelled'].map((s) => el('option', { value: s, text: LABEL[s] })));
  const cust = orgSelect(orgs, '', 'All customers'), holder = el('div');
  const load = async () => {
    let q = ctx.sb.from('orders').select('*, order_lines(qty)').order('created_at', { ascending: false }).limit(300);
    if (st.value === 'open') q = q.in('status', OPEN); else if (st.value) q = q.eq('status', st.value);
    if (cust.value) q = q.eq('org_id', cust.value);
    const { data, error } = await q; if (error) return clear(holder).append(el('p', { class: 'err', text: error.message }));
    clear(holder).append(table([
      { label: 'Order', render: (o) => el('strong', { text: o.ref }) }, { label: 'Customer', render: (o) => orgName(orgs, o.org_id) }, { label: 'Their ref', render: (o) => o.external_ref || '-' },
      { label: 'Ship to', render: (o) => `${o.ship_name}, ${o.ship_city} ${o.ship_country}` }, { label: 'Units', render: (o) => String(o.order_lines.reduce((s, l) => s + l.qty, 0)) },
      { label: 'Status', render: (o) => el('div', {}, pill(LABEL[o.status] || o.status, KIND[o.status]), o.status === 'held' && el('small', { class: 'muted', text: ' ' + (o.hold_reason || '') })) },
      { label: 'Created', render: (o) => fmtDate(o.created_at) },
    ], data, (o) => ctx.go('orders/' + o.id)));
  };
  st.addEventListener('change', load); cust.addEventListener('change', load);

  const create = () => modal('New order for a customer', (body, done) => {
    const o = orgSelect(orgs, '', 'Choose a customer'); const err = el('p', { class: 'err' });
    const f = { ref: el('input', { placeholder: 'Their order number (optional)' }), name: el('input', { placeholder: 'Recipient name' }), email: el('input', { type: 'email', placeholder: 'Email (optional)' }), phone: el('input', { placeholder: 'Phone (optional)' }),
      line1: el('input', { placeholder: 'Street and number' }), postal: el('input', { placeholder: 'Postal code' }), city: el('input', { placeholder: 'City' }), country: el('input', { maxlength: '2', value: 'PL', placeholder: 'PL', style: 'width:70px' }) };
    const lines = el('div'), note = el('div'); let prods = [];
    const addLine = () => { const sel = el('select', {}, el('option', { value: '', text: 'Product' }), prods.map((p) => el('option', { value: p.id, text: p.sku + ' - ' + p.name }))); const q = el('input', { type: 'number', min: '1', value: '1', 'aria-label': 'Units', style: 'width:90px' }); const row = el('div', { class: 'row line' }, sel, q, el('button', { class: 'btn ghost tiny', text: 'Remove', onclick: () => row.remove() })); lines.append(row); };
    o.addEventListener('change', async () => { clear(lines); clear(note); prods = o.value ? (await ctx.sb.from('products').select('id, sku, name').eq('org_id', o.value).eq('active', true).order('sku')).data || [] : []; if (o.value && !prods.length) note.append(el('p', { class: 'err', text: 'This customer has no products yet. Add them under Products first.' })); else if (o.value) addLine(); });
    const go = el('button', { class: 'btn', text: 'Create order', onclick: () => guarded(go, err, async () => {
      if (!o.value) throw new Error('Choose a customer');
      const ls = [...lines.querySelectorAll('.line')].map((r) => ({ product_id: r.querySelector('select').value, qty: Number(r.querySelector('input').value) })).filter((l) => l.product_id);
      const r = await rpc(ctx, 'create_order', { p_org: o.value, p_external_ref: f.ref.value, p_ship: { name: f.name.value, email: f.email.value, phone: f.phone.value, line1: f.line1.value, postal: f.postal.value, city: f.city.value, country: f.country.value }, p_notes: null, p_lines: ls, p_channel: 'manual' });
      try { if (r.status === 'held') await ctx.api('order.notify', { order_ids: [r.id] }); } catch { /* the order exists either way */ }
      done(r); }) });
    body.append(field('Customer', o), el('div', { class: 'row' }, field('Their reference', f.ref), field('Recipient', f.name)), el('div', { class: 'row' }, field('Email', f.email), field('Phone', f.phone)),
      field('Street and number', f.line1), el('div', { class: 'row' }, field('Postal code', f.postal), field('City', f.city), field('Country', f.country)), note, el('strong', { text: 'Products and units' }), lines,
      el('button', { class: 'btn ghost tiny', text: '+ Add another product', onclick: () => prods.length && addLine() }), err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), go));
  }).then((r) => { if (r) { toast(r.status === 'held' ? `${r.ref} created but on hold: not enough stock. The customer was told.` : r.duplicate ? `${r.ref} already existed` : `${r.ref} created and stock reserved`, r.status === 'held'); load(); } });

  clear(root).append(el('div', { class: 'row between' }, el('h1', { text: 'Orders' }), canAct(ctx) && el('button', { class: 'btn', onclick: create, text: 'New order' })),
    el('p', { class: 'muted', text: 'An order is accepted only if all of it can be reserved. If any line is short, nothing is reserved and the order waits on hold. It is reserved automatically when stock is put away.' }), el('div', { class: 'row' }, st, cust), holder); load();
}

async function detail(ctx, root, id) {
  clear(root).append(el('p', { class: 'muted', text: 'Loading…' }));
  const orgs = await loadOrgs(ctx);
  const o = (await ctx.sb.from('orders').select('*').eq('id', id).maybeSingle()).data;
  if (!o) return clear(root).append(el('p', { class: 'err', text: 'Order not found.' }), el('button', { class: 'btn ghost', onclick: () => ctx.go('orders'), text: 'Back' }));
  const [ln, al, cr] = await Promise.all([
    ctx.sb.from('order_lines').select('id, qty, products(sku, name)').eq('order_id', id),
    ctx.sb.from('allocations').select('order_line_id, qty, status, lot, locations(code)').eq('order_id', id),
    ctx.sb.from('change_requests').select('summary, status').eq('entity_id', id).eq('status', 'pending'),
  ]);
  const act = canAct(ctx), reload = () => detail(ctx, root, id);
  const where = (lineId) => (al.data || []).filter((a) => a.order_line_id === lineId && a.status !== 'released').map((a) => `${a.locations.code} × ${a.qty}`).join(', ') || '-';
  const reserve = async () => { try { const s = await rpc(ctx, 'allocate_order', { p_order: id }); toast(s === 'allocated' ? 'Stock reserved' : s === 'held' ? 'Still not enough stock' : 'Status: ' + s, s === 'held'); reload(); } catch (e) { toast(e.message, true); } };
  const cancel = async () => { if (!(await confirmBox('Cancel ' + o.ref + '?', 'Its reservations are released. This cannot be undone.', 'Cancel order'))) return; try { await rpc(ctx, 'cancel_order', { p_id: id }); toast('Cancelled'); reload(); } catch (e) { toast(e.message, true); } };
  const cancellable = ['new', 'held', 'allocated'].includes(o.status);
  clear(root).append(
    el('div', { class: 'row between' }, el('div', {}, el('button', { class: 'btn ghost tiny', onclick: () => ctx.go('orders'), text: '← Orders' }), el('h1', { text: o.ref + ' ' }), pill(LABEL[o.status] || o.status, KIND[o.status])),
      act && el('div', { class: 'row' }, o.status === 'held' && el('button', { class: 'btn', onclick: reserve, text: 'Try to reserve now' }), cancellable && el('button', { class: 'btn ghost', onclick: cancel, text: 'Cancel order' }))),
    (cr.data || []).length > 0 && el('div', { class: 'note' }, el('b', { text: 'Customer request' }), el('p', {}, 'The customer asked: ' + cr.data[0].summary + '. Decide it under '), el('a', { href: '#approvals', text: 'Approvals' }), '.'),
    o.status === 'held' && el('div', { class: 'rule' }, el('b', { text: 'On hold' }), el('p', { text: o.hold_reason || 'Not enough stock.' }), el('p', { class: 'muted', text: 'Nothing is reserved. It reserves itself when stock is put away in a bin, or use "Try to reserve now".' })),
    el('div', { class: 'cols' },
      el('section', { class: 'card' }, el('h2', { text: 'Order' }), kv([['Customer', orgName(orgs, o.org_id)], ['Their reference', o.external_ref], ['Channel', o.channel], ['Created', fmtDate(o.created_at)], ['Reserved', o.allocated_at ? fmtDate(o.allocated_at) : null], ['Notes', o.notes]])),
      el('section', { class: 'card' }, el('h2', { text: 'Ship to' }), kv([['Name', o.ship_name], ['Company', o.ship_company], ['Address', [o.ship_line1, o.ship_line2].filter(Boolean).join(', ')], ['Postal code and city', `${o.ship_postal} ${o.ship_city}`], ['Country', o.ship_country], ['Email', o.ship_email], ['Phone', o.ship_phone]]))),
    el('section', { class: 'card' }, el('h2', { text: 'Items' }), table([{ label: 'Product', render: (l) => `${l.products.sku} - ${l.products.name}` }, { label: 'Units', render: (l) => String(l.qty) }, { label: 'Reserved at', render: (l) => where(l.id) }], ln.data || [])));
}

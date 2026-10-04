import { el, clear, table, pill, field, modal, toast, fmtDate } from './ui.js';
import { rpc, canAct, loadOrgs, orgName, orgSelect, guarded, newKey } from './wms.js';

export async function render(ctx, root, params) {
  const tab = (params && params[0]) || 'putaway';
  const orgs = await loadOrgs(ctx), act = canAct(ctx);
  const tabs = el('div', { class: 'row tabs' }, [['putaway', 'To put away'], ['all', 'All stock'], ['ledger', 'Ledger']].map(([k, l]) => el('a', { class: 'btn tiny ' + (tab === k ? '' : 'ghost'), href: '#stock/' + k, text: l })));
  const holder = el('div', {}, el('p', { class: 'muted', text: 'Loading…' }));
  clear(root).append(el('h1', { text: 'Stock' }), tabs, holder);
  const reload = () => render(ctx, root, params);

  if (tab === 'ledger') {
    const { data, error } = await ctx.sb.from('stock_movements').select('id, at, org_id, qty, reason, note, products(sku, name), locations(code)').order('id', { ascending: false }).limit(200);
    if (error) return clear(holder).append(el('p', { class: 'err', text: error.message }));
    return clear(holder).append(el('p', { class: 'muted', text: 'Every change in stock, newest first. Rows are never edited or deleted.' }), table([
      { label: 'When', render: (m) => fmtDate(m.at) }, { label: 'Customer', render: (m) => orgName(orgs, m.org_id) }, { label: 'Product', render: (m) => m.products.sku }, { label: 'Location', render: (m) => m.locations.code },
      { label: 'Change', render: (m) => el('b', { text: (m.qty > 0 ? '+' : '') + m.qty }) }, { label: 'Reason', key: 'reason' }, { label: 'Note', render: (m) => m.note || '' }], data));
  }

  const { data, error } = await ctx.sb.from('stock_levels').select('org_id, product_id, location_id, lot, on_hand, reserved, products(sku, name), locations(code, kind)').gt('on_hand', 0).order('org_id').limit(2000);
  if (error) return clear(holder).append(el('p', { class: 'err', text: error.message }));

  const putaway = async (r) => {
    const { data: asg } = await ctx.sb.from('location_assignments').select('location_id, locations(code, kind)').eq('org_id', r.org_id).is('released_at', null);
    const { data: shared } = await ctx.sb.from('locations').select('id, code, kind').in('kind', ['pack', 'returns', 'quarantine']).eq('active', true);
    const dests = [...(asg || []).map((a) => ({ id: a.location_id, code: a.locations.code, kind: a.locations.kind })), ...(shared || [])].filter((d) => d.id !== r.location_id).sort((a, c) => a.code.localeCompare(c.code));
    return modal(`Move ${r.products.sku} from ${r.locations.code}`, (body, done) => {
      if (!dests.length) { body.append(el('p', { class: 'err', text: 'This customer has no bins assigned yet. Assign one under Locations first.' }), el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Close' })); return; }
      const to = el('select', {}, dests.map((d) => el('option', { value: d.id, text: d.code + ' (' + d.kind + ')' }))), q = el('input', { type: 'number', min: '1', max: String(r.on_hand - r.reserved), value: String(r.on_hand - r.reserved) }), err = el('p', { class: 'err' });
      const go = el('button', { class: 'btn', text: 'Move', onclick: () => guarded(go, err, async () => { await rpc(ctx, 'putaway', { p_org: r.org_id, p_product: r.product_id, p_from: r.location_id, p_to: to.value, p_qty: Number(q.value), p_lot: r.lot, p_key: newKey() }); done(true); }) });
      body.append(field('Destination', to), field('Quantity', q), err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), go));
    }).then((ok) => { if (ok) { toast('Moved'); reload(); } });
  };
  const adjust = (r) => modal(`Adjust ${r.products.sku} at ${r.locations.code}`, (body, done) => {
    const d = el('input', { type: 'number', placeholder: 'e.g. -2 or 5' }), why = el('input', { placeholder: 'Reason (required)' }), err = el('p', { class: 'err' });
    const go = el('button', { class: 'btn', text: 'Post adjustment', onclick: () => guarded(go, err, async () => { await rpc(ctx, 'adjust_stock', { p_org: r.org_id, p_product: r.product_id, p_location: r.location_id, p_delta: Number(d.value), p_reason: why.value, p_lot: r.lot, p_key: newKey() }); done(true); }) });
    body.append(el('p', { class: 'muted', text: `Currently ${r.on_hand} on hand. Enter the change, not the new total. Changes above 20 units need an admin.` }), field('Change', d), field('Reason', why), err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), go));
  }).then((ok) => { if (ok) { toast('Adjustment posted'); reload(); } });

  const cust = orgSelect(orgs, '', 'All customers'), q = el('input', { type: 'search', placeholder: 'Search SKU or location', class: 'grow' }), rows = el('div');
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const list = data.filter((r) => (tab !== 'putaway' || r.locations.kind === 'receiving') && (!cust.value || r.org_id === cust.value) && (!t || r.products.sku.toLowerCase().includes(t) || r.locations.code.toLowerCase().includes(t)));
    clear(rows).append(table([
      { label: 'Customer', render: (r) => orgName(orgs, r.org_id) }, { label: 'Product', render: (r) => el('a', { href: '#products/' + r.product_id, text: r.products.sku + ' - ' + r.products.name }) },
      { label: 'Location', render: (r) => el('span', {}, el('strong', { text: r.locations.code }), ' ', pill(r.locations.kind)) }, { label: 'On hand', render: (r) => String(r.on_hand) }, { label: 'Reserved', render: (r) => String(r.reserved) },
      act && { label: '', render: (r) => el('div', { class: 'row' }, el('button', { class: 'btn tiny', text: 'Move', onclick: () => putaway(r) }), el('button', { class: 'btn ghost tiny', text: 'Adjust', onclick: () => adjust(r) })) },
    ].filter(Boolean), list));
  };
  q.addEventListener('input', draw); cust.addEventListener('change', draw); draw();
  clear(holder).append(tab === 'putaway' ? el('p', { class: 'muted', text: 'Goods waiting in the receiving area. Move each one to the customer\'s bin.' }) : null, el('div', { class: 'row' }, q, cust), rows);
}

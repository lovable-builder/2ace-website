import { el, clear, table, pill, field, modal, toast, fmtDate } from './ui.js';
import { rpc, canAct, loadOrgs, orgName, orgSelect, guarded, newKey, signedUrls, thumb } from './wms.js';

export async function render(ctx, root, params) {
  const tab = (params && params[0]) || 'all';
  const orgs = await loadOrgs(ctx), act = canAct(ctx);
  const tabs = el('div', { class: 'row tabs' }, [['all', 'All stock'], ['putaway', 'To put away'], ['ledger', 'Ledger']].map(([k, l]) => el('a', { class: 'btn tiny ' + (tab === k ? '' : 'ghost'), href: '#stock/' + k, text: l })));
  const holder = el('div', {}, el('p', { class: 'muted', text: 'Loading…' }));
  const reload = () => render(ctx, root, params);
  // One form to put units on the shelf: opening stock, a recount, or test stock. No delivery to book, nothing to put away.
  const addStock = () => modal('Add stock', (body, done) => {
    const cust = orgSelect(orgs, '', 'Choose a customer'), prod = el('select', {}, el('option', { value: '', text: 'Choose a customer first' })), qty = el('input', { type: 'number', min: '1', value: '10' }), note = el('input', { placeholder: 'Note (optional), e.g. Opening stock' }), err = el('p', { class: 'err' });
    cust.addEventListener('change', async () => {
      clear(prod).append(el('option', { value: '', text: cust.value ? 'Loading…' : 'Choose a customer first' }));
      if (!cust.value) return;
      const { data: ps } = await ctx.sb.from('products').select('id, sku, name').eq('org_id', cust.value).eq('active', true).order('sku');
      clear(prod).append(el('option', { value: '', text: (ps || []).length ? 'Choose a product' : 'This customer has no active products yet' }), ...(ps || []).map((p) => el('option', { value: p.id, text: p.sku + ' - ' + p.name })));
    });
    const key = newKey();
    const go = el('button', { class: 'btn', text: 'Add stock', onclick: () => guarded(go, err, async () => {
      if (!cust.value || !prod.value) throw new Error('Choose a customer and a product');
      const r = await rpc(ctx, 'add_stock', { p_org: cust.value, p_product: prod.value, p_qty: Number(qty.value), p_note: note.value || null, p_key: key });
      done({ qty: r.qty, location: r.location });
    }) });
    body.append(el('p', { class: 'muted', text: 'The units go straight into the customer\'s own bin (created automatically if they have none) and can be ordered at once.' }), field('Customer', cust), field('Product', prod), field('Units', qty), field('Note', note), err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), go));
  }).then((r) => { if (r) { toast(`Added ${r.qty} units to ${r.location}`); reload(); } });
  clear(root).append(el('div', { class: 'row between' }, el('h1', { text: 'Stock' }), act && el('button', { class: 'btn', onclick: addStock, text: 'Add stock' })), tabs, holder);

  if (tab === 'ledger') {
    const { data, error } = await ctx.sb.from('stock_movements').select('id, at, org_id, qty, reason, note, products(sku, name), locations(code)').order('id', { ascending: false }).limit(200);
    if (error) return clear(holder).append(el('p', { class: 'err', text: error.message }));
    return clear(holder).append(el('p', { class: 'muted', text: 'Every change in stock, newest first. Rows are never edited or deleted.' }), table([
      { label: 'When', render: (m) => fmtDate(m.at) }, { label: 'Customer', render: (m) => orgName(orgs, m.org_id) }, { label: 'Product', render: (m) => m.products.sku }, { label: 'Location', render: (m) => m.locations.code },
      { label: 'Change', render: (m) => el('b', { text: (m.qty > 0 ? '+' : '') + m.qty }) }, { label: 'Reason', key: 'reason' }, { label: 'Note', render: (m) => m.note || '' }], data));
  }

  const { data, error } = await ctx.sb.from('stock_levels').select('org_id, product_id, location_id, lot, on_hand, reserved, products(sku, name, photo_paths), locations(code, kind)').gt('on_hand', 0).order('org_id').limit(2000);
  if (error) return clear(holder).append(el('p', { class: 'err', text: error.message }));

  const purls = await signedUrls(ctx, data.map((r) => (r.products.photo_paths || [])[0]).filter(Boolean), 'products');
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
      { label: '', render: (r) => thumb(purls[(r.products.photo_paths || [])[0]]) }, { label: 'Customer', render: (r) => orgName(orgs, r.org_id) }, { label: 'Product', render: (r) => el('a', { href: '#products/' + r.product_id, text: r.products.sku + ' - ' + r.products.name }) },
      { label: 'Location', render: (r) => el('span', {}, el('strong', { text: r.locations.code }), ' ', pill(r.locations.kind)) }, { label: 'On hand', render: (r) => String(r.on_hand) }, { label: 'Reserved', render: (r) => String(r.reserved) },
      act && { label: '', render: (r) => el('div', { class: 'row' }, el('button', { class: 'btn tiny', text: 'Move', onclick: () => putaway(r) }), el('button', { class: 'btn ghost tiny', text: 'Adjust', onclick: () => adjust(r) })) },
    ].filter(Boolean), list));
  };
  q.addEventListener('input', draw); cust.addEventListener('change', draw); draw();
  clear(holder).append(tab === 'putaway' ? el('p', { class: 'muted', text: 'Goods waiting in the receiving area: deliveries that were not on the booking, or all goods when automatic storing is switched off. Good goods are normally stored in the customer\'s bin on arrival.' }) : null, el('div', { class: 'row' }, q, cust), rows);
}

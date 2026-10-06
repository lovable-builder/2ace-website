import { el, clear, table, pill, field, modal, toast, kv, fmtDate, confirmBox } from './ui.js';
import { orderStepper } from './journey.js';
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
    const f = { ref: el('input', { placeholder: 'Their order number (optional)' }), name: el('input', { placeholder: 'First name and surname' }), email: el('input', { type: 'email', placeholder: 'Email (optional)' }), phone: el('input', { placeholder: 'Phone, 9 digits (required)' }),
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
  const [ln, al, cr, pc, sh, ol, pr] = await Promise.all([
    ctx.sb.from('order_lines').select('id, qty, products(sku, name)').eq('order_id', id),
    ctx.sb.from('allocations').select('order_line_id, qty, status, lot, locations!location_id(code)').eq('order_id', id),
    ctx.sb.from('change_requests').select('summary, status').eq('entity_id', id).eq('status', 'pending'),
    ctx.sb.from('parcels').select('seq, weight_g, length_cm, width_cm, height_cm, packed_at').eq('order_id', id).order('seq'),
    ctx.sb.from('shipments').select('*').eq('order_id', id).order('created_at', { ascending: false }),
    ctx.sb.from('own_labels').select('*').eq('order_id', id).is('voided_at', null).maybeSingle(),
    ctx.sb.rpc('order_ship_problems', { p_order: id }),
  ]);
  const act = canAct(ctx), reload = () => detail(ctx, root, id);
  const where = (lineId) => (al.data || []).filter((a) => a.order_line_id === lineId && a.status !== 'released').map((a) => `${a.locations.code} × ${a.qty} (${a.status === 'picked' ? 'picked' : 'to pick'})`).join(', ') || '-';
  const reserve = async () => { try { const s = await rpc(ctx, 'allocate_order', { p_order: id }); toast(s === 'allocated' ? 'Stock reserved' : s === 'held' ? 'Still not enough stock' : 'Status: ' + s, s === 'held'); reload(); } catch (e) { toast(e.message, true); } };
  const cancel = async () => { if (!(await confirmBox('Cancel ' + o.ref + '?', 'Its reservations are released. This cannot be undone.', 'Cancel order'))) return; try { await rpc(ctx, 'cancel_order', { p_id: id }); toast('Cancelled'); reload(); } catch (e) { toast(e.message, true); } };
  const cancellable = ['new', 'held', 'allocated'].includes(o.status);
  clear(root).append(
    el('div', { class: 'row between' }, el('div', {}, el('button', { class: 'btn ghost tiny', onclick: () => ctx.go('orders'), text: '← Orders' }), el('h1', { text: o.ref + ' ' }), pill(LABEL[o.status] || o.status, KIND[o.status])),
      act && el('div', { class: 'row' }, o.status === 'held' && el('button', { class: 'btn', onclick: reserve, text: 'Try to reserve now' }), cancellable && el('button', { class: 'btn ghost', onclick: cancel, text: 'Cancel order' }))),
    orderStepper(o.status),
    (cr.data || []).length > 0 && el('div', { class: 'note' }, el('b', { text: 'Customer request' }), el('p', {}, 'The customer asked: ' + cr.data[0].summary + '. Decide it under '), el('a', { href: '#approvals', text: 'Approvals' }), '.'),
    o.status === 'held' && el('div', { class: 'rule' }, el('b', { text: 'On hold' }), el('p', { text: o.hold_reason || 'Not enough stock.' }), el('p', { class: 'muted', text: 'Nothing is reserved. It reserves itself when stock is put away in a bin, or use "Try to reserve now". If a picker reported a problem, return the picked items from the packing station to the shelf and count the bin first.' })),
    el('div', { class: 'cols' },
      el('section', { class: 'card' }, el('h2', { text: 'Order' }), kv([['Customer', orgName(orgs, o.org_id)], ['Their reference', o.external_ref], ['Channel', o.channel], ['Created', fmtDate(o.created_at)], ['Reserved', o.allocated_at ? fmtDate(o.allocated_at) : null], ['Notes', o.notes]])),
      shipToCard(ctx, o, (pr && pr.data) || [], (sh.data || []), act, reload)),
    el('section', { class: 'card' }, el('h2', { text: 'Items' }), table([{ label: 'Product', render: (l) => `${l.products.sku} - ${l.products.name}` }, { label: 'Units', render: (l) => String(l.qty) }, { label: 'Reserved at', render: (l) => where(l.id) }], ln.data || [])),
    (pc.data || []).length > 0 && el('section', { class: 'card' }, el('h2', { text: 'Parcels' }), table([{ label: '#', render: (p) => String(p.seq) }, { label: 'Weight', render: (p) => (p.weight_g / 1000).toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 3 }) + ' kg' }, { label: 'Size', render: (p) => `${Number(p.length_cm)} × ${Number(p.width_cm)} × ${Number(p.height_cm)} cm` }, { label: 'Packed', render: (p) => fmtDate(p.packed_at) }], pc.data)),
    shippingCard(ctx, o, sh.data || [], act, reload, ol.data || null));
}


// The delivery details, with what is wrong with them for a shipping label, a way to correct them, and a way to ask the customer.
const EDITABLE = ['new', 'held', 'allocated', 'picking', 'packed'];
function shipToCard(ctx, o, problems, shipments, act, reload) {
  const live = shipments.find((s) => s.status === 'purchased' || s.status === 'buying'), last = shipments[0];
  const editable = act && EDITABLE.includes(o.status) && !live;
  const card = el('section', { class: 'card' }, el('h2', { text: 'Ship to' }), kv([['Name', o.ship_name], ['Company', o.ship_company], ['Address', [o.ship_line1, o.ship_line2].filter(Boolean).join(', ')], ['Postal code and city', `${o.ship_postal} ${o.ship_city}`], ['Country', o.ship_country], ['Email', o.ship_email], ['Phone', o.ship_phone]]));
  const failed = last && last.status === 'failed' && last.error && !live ? last.error : '';
  if (EDITABLE.includes(o.status) && !live && (problems.length || failed)) {
    card.append(el('div', { class: 'rule' }, el('b', { text: problems.length ? 'These details will not pass the shipping label' : 'The last label attempt failed' }),
      problems.length ? el('ul', {}, problems.map((m) => el('li', { text: m }))) : null, failed && !problems.length ? el('p', { text: failed }) : null));
  }
  if (live) card.append(el('p', { class: 'muted', text: 'A label is already bought for these details, so they cannot be changed here.' }));
  if (o.details_requested_at && EDITABLE.includes(o.status)) card.append(el('p', { class: 'muted', text: 'We asked the customer for a correction on ' + fmtDate(o.details_requested_at) + (o.details_request_note ? ': "' + o.details_request_note.slice(0, 160) + (o.details_request_note.length > 160 ? '…' : '') + '"' : '') }));
  if (editable) card.append(el('div', { class: 'row' }, el('button', { class: 'btn tiny', text: 'Edit details', onclick: () => editShip(ctx, o, reload) }),
    el('button', { class: 'btn tiny ghost', text: o.details_requested_at ? 'Ask the customer again' : 'Ask the customer to correct it', onclick: () => askCustomer(ctx, o, problems, failed, reload) })));
  return card;
}

const editShip = (ctx, o, reload) => modal('Edit the delivery details of ' + o.ref, (body, done) => {
  const f = { name: el('input', { value: o.ship_name || '', placeholder: 'First name and surname' }), company: el('input', { value: o.ship_company || '' }), email: el('input', { type: 'email', value: o.ship_email || '' }), phone: el('input', { value: o.ship_phone || '', placeholder: '9 digits for Poland' }),
    line1: el('input', { value: o.ship_line1 || '', placeholder: 'Street and house number' }), line2: el('input', { value: o.ship_line2 || '' }), postal: el('input', { value: o.ship_postal || '', placeholder: '00-001' }), city: el('input', { value: o.ship_city || '' }), country: el('input', { value: o.ship_country || 'PL', maxlength: '2', style: 'width:70px' }) };
  const err = el('p', { class: 'err' });
  const save = el('button', { class: 'btn', text: 'Save', onclick: () => guarded(save, err, async () => {
    await rpc(ctx, 'update_order_ship', { p_order: o.id, p_ship: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value])) });
    toast('Details saved'); done(true);
  }) });
  body.append(el('p', { class: 'muted', text: 'The same rules as a new order: first name and surname, a 9-digit Polish phone, the house number, a valid postal code. Customers can see this order, so only correct what is wrong.' }),
    field('Recipient (first name and surname)', f.name), field('Company', f.company), el('div', { class: 'row' }, field('Email', f.email), field('Phone', f.phone)), field('Street and house number', f.line1), field('Second address line', f.line2),
    el('div', { class: 'row' }, field('Postal code', f.postal), field('City', f.city), field('Country', f.country)), err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), save));
}).then((ok) => { if (ok) reload(); });

const askCustomer = (ctx, o, problems, failed, reload) => modal('Ask the customer to correct ' + o.ref, (body, done) => {
  const first = problems.length ? problems.join('\n') : failed ? 'The carrier did not accept the delivery details: ' + failed : '';
  const msg = el('textarea', { rows: '6', 'aria-label': 'What to correct', placeholder: 'What needs to be corrected, in plain words' }); msg.value = first;
  const err = el('p', { class: 'err' });
  const send = el('button', { class: 'btn', text: 'Send email', onclick: () => guarded(send, err, async () => { const r = await ctx.api('order.requestDetails', { order_id: o.id, message: msg.value }); toast('Emailed to ' + r.to); done(true); }) });
  body.append(el('p', { class: 'muted', text: 'The owner of the customer account gets an email with this text and the current details. They reply with the correction, you click Edit details, and the label can be made. Nothing is charged.' }),
    field('What to correct', msg), err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), send));
}).then((ok) => { if (ok) reload(); });

const pln = (n) => Number(n).toFixed(2).replace('.', ',') + ' zł';

// Shipping label: prices from the carriers, buying one, the label file, and the way out of an unconfirmed order.
function shippingCard(ctx, o, shipments, act, reload, own) {
  const live = shipments.find((s) => s.status === 'purchased' || s.status === 'buying'), last = shipments[0];
  const card = el('section', { class: 'card' }, el('h2', { text: 'Shipping label' }));
  // "Mark shipped": the order leaves the building. Goods leave the stock here, for labels that were not bought and shipped in one go.
  const shipBtn = () => el('button', { class: 'btn', text: 'Mark shipped', onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { await rpc(ctx, 'ship_order', { p_order: o.id }); toast('Marked as shipped'); reload(); } catch (err) { toast(err.message, true); b.disabled = false; }
  } });
  // The customer brought their own label (a PDF and/or tracking numbers): we print it and stick it. Nothing is bought.
  if (own) {
    card.append(kv([['Label', "The customer's own label"], ['Carrier', own.carrier_name], ['Tracking', (own.tracking_numbers || []).join(', ') || 'None given'], ['File', own.storage_path ? (own.filename || 'label.pdf') : 'No file, tracking only'], ['Added', fmtDate(own.created_at)], ['Charged', 'Nothing: 2ACE did not buy it']]));
    const row = el('div', { class: 'row' });
    if (own.storage_path) row.append(el('button', { class: 'btn ghost', text: 'Open the PDF to print', onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { const { data, error } = await ctx.sb.storage.from('labels').createSignedUrl(own.storage_path, 120); if (error) throw new Error(error.message); window.open(data.signedUrl, '_blank'); } catch (err) { toast(err.message, true); } finally { b.disabled = false; }
    } }));
    if (act && o.status === 'packed') row.append(shipBtn());
    else if (o.status !== 'packed' && o.status !== 'shipped') row.append(el('span', { class: 'muted', text: 'It can be marked shipped once the order is packed.' }));
    card.append(row); return card;
  }
  if (live && live.status === 'purchased') {
    card.append(kv([['Carrier', live.service_name || live.carrier], ['Tracking', (live.tracking_numbers || []).join(', ') || 'Not available yet'], ['We paid', `${pln(live.cost_net)} + VAT (${pln(live.cost_gross)})`], ['Charged to customer', `${pln(live.bill_net)} + VAT (${pln(live.bill_gross)}), ${Number(live.markup_percent)}% markup`], ['Billing', live.billing_status === 'pending' ? 'Waiting to be invoiced' : live.billing_status], ['Environment', live.env === 'sandbox' ? 'Test (sandbox): nothing real was charged' : 'Live'], ['Bought', fmtDate(live.purchased_at)]]));
    if (act && o.status === 'packed') card.append(el('div', { class: 'row' }, shipBtn()));
    if (act) card.append(el('div', { class: 'row' }, el('button', { class: 'btn', text: 'Download label', onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { const r = await ctx.api('shipping.label', { order_id: o.id }); if (r.pending) { toast(r.message, true); return; } const bytes = Uint8Array.from(atob(r.pdf_base64), (c) => c.charCodeAt(0)); window.open(URL.createObjectURL(new Blob([bytes], { type: r.content_type || 'application/pdf' })), '_blank'); }
      catch (err) { toast(err.message, true); } finally { b.disabled = false; }
    } })));
    return card;
  }
  if (live && live.status === 'buying') {
    card.append(el('div', { class: 'rule' }, el('b', { text: 'A label order is waiting to be checked' }), el('p', { text: 'Furgonetka did not confirm this order, or recording it failed. It may already have been charged, so do not buy again. Check what happened:' })));
    if (act) card.append(el('div', { class: 'row' }, el('button', { class: 'btn', text: 'Check the label order', onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { const r = await ctx.api('shipping.recheck', { order_id: o.id }); toast(r.message, r.result === 'pending'); reload(); } catch (err) { toast(err.message, true); b.disabled = false; }
    } })));
    return card;
  }
  if (o.status !== 'packed') { card.append(el('p', { class: 'muted', text: 'A label can be bought once the order is packed.' })); return card; }
  if (last && last.status === 'failed') card.append(el('div', { class: 'note' }, el('b', { text: 'The last attempt failed, nothing was charged' }), el('p', { text: last.error || '' })));
  const out = el('div'), err = el('p', { class: 'err' });
  card.append(el('p', { class: 'muted', text: 'Prices come from the carriers for these parcels. Getting prices is free; nothing is bought until you press Buy.' }));
  if (!act) return card.append(el('p', { class: 'muted', text: 'Only warehouse staff and admins can buy labels.' })), card;
  const quoteBtn = el('button', { class: 'btn', text: 'Get shipping prices' });
  // One click: the cheapest carrier that takes the parcel, within the usual limits (what happens by itself after packing when automatic labels are on).
  const autoBtn = el('button', { class: 'btn ghost', text: 'Create the cheapest label', title: 'Buys the cheapest carrier that can take this parcel, within the limits' });
  autoBtn.onclick = async () => {
    autoBtn.disabled = true; err.textContent = '';
    try {
      const r = await ctx.api('shipping.auto', { order_id: o.id });
      if (r.status === 'bought') { toast('Label bought: ' + r.service); reload(); return; }
      if (r.status === 'skipped' && r.reason === 'off') { err.textContent = 'Automatic labels are switched off (SHIPPING_AUTO_LABEL). Use "Get shipping prices" instead, or ask an admin to switch it on.'; }
      else err.textContent = r.message || 'It could not create a label.';
    } catch (e) { err.textContent = e.message; } finally { autoBtn.disabled = false; }
  };
  const buy = async (q, r, btn) => {
    const over = q.cost_gross > r.max_label;
    const msg = `${q.name}. We pay ${pln(q.cost_net)} + VAT (${pln(q.cost_gross)}). The customer is charged ${pln(q.bill_net)} + VAT (${r.markup_percent}% markup).` + (r.env === 'sandbox' ? ' This is the test environment: nothing real is charged.' : ' This spends real money from the Furgonetka balance.') + (over ? ` This is above the usual limit of ${pln(r.max_label)} per label.` : '');
    if (!(await confirmBox('Buy this label?', msg, 'Buy label'))) return;
    btn.disabled = true;
    try { await ctx.api('shipping.buy', { order_id: o.id, service_id: q.service_id, confirm_over_limit: over && ctx.me.role === 'admin' }); toast('Label bought'); reload(); }
    catch (e) { toast(e.message, true); err.textContent = e.message; btn.disabled = false; }
  };
  quoteBtn.onclick = () => guarded(quoteBtn, err, async () => {
    clear(out).append(el('p', { class: 'muted', text: 'Asking the carriers…' }));
    const r = await ctx.api('shipping.quote', { order_id: o.id });
    clear(out);
    if (!r.quotes.length) { out.append(el('p', { class: 'muted', text: 'No carrier answered for this parcel.' })); return; }
    if (!r.enabled) out.append(el('div', { class: 'rule' }, el('b', { text: 'Buying is switched off' }), el('p', { text: 'An admin turns it on with the server setting SHIPPING_ENABLED=true. You can still compare prices.' })));
    out.append(el('p', { class: 'muted' }, 'Environment: ', pill(r.env === 'sandbox' ? 'test' : 'live', r.env === 'sandbox' ? 'ok' : 'bad'), ` · customer markup ${r.markup_percent}%`),
      table([{ label: 'Carrier', render: (q) => el('span', { class: q.available ? '' : 'muted' }, q.name || q.carrier, q.available ? '' : ' (not available: ' + q.reason + ')') },
        { label: 'We pay (net)', render: (q) => (q.available ? pln(q.cost_net) : '-') },
        { label: 'Customer pays (net)', render: (q) => (q.available ? pln(q.bill_net) : '-') },
        { label: '', render: (q) => (q.available ? el('button', { class: 'btn tiny', text: 'Buy label', onclick: (e) => buy(q, r, e.currentTarget) }) : '') }], r.quotes));
  });
  card.append(el('div', { class: 'row' }, quoteBtn, autoBtn), err, out);
  return card;
}

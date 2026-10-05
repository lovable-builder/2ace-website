import { el, clear, table, pill, field, modal, toast, kv, fmtDate, fmtDay, confirmBox } from './ui.js';
import { rpc, canAct, loadOrgs, orgName, orgSelect, guarded, newKey, uploadPhotos, signedUrls } from './wms.js';

const OPEN = ['booked', 'receiving'];
const KIND = { booked: 'warn', receiving: 'warn', received: 'ok', cancelled: 'muted' };

export async function render(ctx, root, params) {
  if (params && params[0]) return detail(ctx, root, params[0]);
  clear(root).append(el('h1', { text: 'Inbound' }), el('p', { class: 'muted', text: 'Loading…' }));
  const orgs = await loadOrgs(ctx);
  const st = el('select', {}, el('option', { value: 'open', text: 'Expected and receiving' }), el('option', { value: 'received', text: 'Received' }), el('option', { value: 'cancelled', text: 'Cancelled' }), el('option', { value: '', text: 'All' }));
  const holder = el('div');
  const load = async () => {
    let q = ctx.sb.from('inbound_bookings').select('*, inbound_lines(expected_qty)').order('expected_date', { ascending: true, nullsFirst: false }).limit(300);
    if (st.value === 'open') q = q.in('status', OPEN); else if (st.value) q = q.eq('status', st.value);
    const { data, error } = await q; if (error) return clear(holder).append(el('p', { class: 'err', text: error.message }));
    clear(holder).append(table([
      { label: 'Ref', render: (b) => el('strong', { text: b.ref }) }, { label: 'Customer', render: (b) => orgName(orgs, b.org_id) },
      { label: 'Expected', render: (b) => fmtDay(b.expected_date) }, { label: 'Carrier', render: (b) => [b.carrier, b.tracking].filter(Boolean).join(' · ') || '-' },
      { label: 'Units', render: (b) => String(b.inbound_lines.reduce((s, l) => s + l.expected_qty, 0)) }, { label: 'Status', render: (b) => pill(b.status, KIND[b.status]) },
    ], data, (b) => ctx.go('inbound/' + b.id)));
  };
  st.addEventListener('change', load);
  const book = () => deliveryDialog(ctx, orgs, null).then((ok) => { if (ok) { toast('Delivery booked'); load(); } });
  clear(root).append(el('div', { class: 'row between' }, el('h1', { text: 'Inbound' }), canAct(ctx) && el('button', { class: 'btn', onclick: book, text: 'Book a delivery' })), el('div', { class: 'row' }, st), holder); load();
}

// One dialog for booking a new delivery and editing a booked one: pick the customer (new only), details, and lines with units that can be changed or removed.
export function deliveryDialog(ctx, orgs, existing) {
  const editing = !!existing;
  return modal(editing ? 'Edit ' + existing.booking.ref : 'Book a delivery for a customer', (body, done) => {
    const o = editing ? el('input', { value: orgName(orgs, existing.booking.org_id), disabled: true }) : orgSelect(orgs, '', 'Choose a customer');
    const date = el('input', { type: 'date', value: editing ? existing.booking.expected_date || '' : '' }), carrier = el('input', { placeholder: 'Carrier', value: editing ? existing.booking.carrier || '' : '' }), tracking = el('input', { placeholder: 'Tracking', value: editing ? existing.booking.tracking || '' : '' });
    const lines = el('div', { class: 'lines' }), note = el('div'), err = el('p', { class: 'err' }); let prods = [];
    const addLine = (pid, qty) => {
      const sel = el('select', {}, el('option', { value: '', text: 'Product' }), prods.map((p) => el('option', { value: p.id, text: p.sku + ' - ' + p.name, ...(p.id === pid ? { selected: true } : {}) })));
      const q = el('input', { type: 'number', min: '1', value: String(qty || 1), 'aria-label': 'Units', style: 'width:90px' });
      const row = el('div', { class: 'row line' }, sel, q, el('button', { class: 'btn ghost tiny', 'aria-label': 'Remove line', text: 'Remove', onclick: () => row.remove() }));
      lines.append(row);
    };
    const loadProducts = async (orgId) => {
      clear(lines); clear(note);
      prods = orgId ? (await ctx.sb.from('products').select('id, sku, name').eq('org_id', orgId).eq('active', true).order('sku')).data || [] : [];
      if (orgId && !prods.length) note.append(el('p', { class: 'err', text: 'This customer has no products yet. Add one under Products first (or the customer can add their own), then book the delivery.' }), el('button', { class: 'btn ghost tiny', text: 'Go to Products', onclick: () => { done(null); ctx.go('products'); } }));
      else if (orgId) { if (editing) existing.lines.forEach((l) => addLine(l.product_id, l.expected_qty)); else addLine(); }
    };
    if (editing) loadProducts(existing.booking.org_id); else o.addEventListener('change', () => loadProducts(o.value));
    const go = el('button', { class: 'btn', text: editing ? 'Save changes' : 'Book', onclick: () => guarded(go, err, async () => {
      const ls = [...lines.querySelectorAll('.line')].map((r) => ({ product_id: r.querySelector('select').value, qty: Number(r.querySelector('input').value) })).filter((l) => l.product_id);
      if (editing) await rpc(ctx, 'update_inbound', { p_id: existing.booking.id, p_carrier: carrier.value, p_tracking: tracking.value, p_expected: date.value || null, p_notes: existing.booking.notes || null, p_lines: ls });
      else { if (!o.value) throw new Error('Choose a customer'); await rpc(ctx, 'book_inbound', { p_org: o.value, p_carrier: carrier.value, p_tracking: tracking.value, p_expected: date.value || null, p_notes: null, p_lines: ls }); }
      done(true); }) });
    body.append(field('Customer', o), el('div', { class: 'row' }, field('Expected date', date), field('Carrier', carrier), field('Tracking', tracking)), note, el('strong', { text: 'Products and units' }), lines,
      el('button', { class: 'btn ghost tiny', text: '+ Add another product', onclick: () => prods.length && addLine() }), err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), go));
  });
}

async function detail(ctx, root, id) {
  clear(root).append(el('p', { class: 'muted', text: 'Loading…' }));
  const orgs = await loadOrgs(ctx);
  const b = (await ctx.sb.from('inbound_bookings').select('*').eq('id', id).maybeSingle()).data;
  if (!b) return clear(root).append(el('p', { class: 'err', text: 'Delivery not found.' }), el('button', { class: 'btn ghost', onclick: () => ctx.go('inbound'), text: 'Back' }));
  const [ln, rc, pr, ds] = await Promise.all([
    ctx.sb.from('inbound_lines').select('product_id, expected_qty').eq('booking_id', id),
    ctx.sb.from('receipt_lines').select('*, products(sku, name)').eq('booking_id', id).order('created_at', { ascending: false }),
    ctx.sb.from('products').select('id, sku, name').eq('org_id', b.org_id).order('sku'),
    ctx.sb.from('discrepancies').select('kind, status, expected_qty, received_qty, products(sku)').eq('booking_id', id),
  ]);
  const urls = await signedUrls(ctx, (rc.data || []).flatMap((r) => r.photo_paths || []));
  const prods = pr.data || [], pmap = Object.fromEntries(prods.map((p) => [p.id, p]));
  const got = (pid, c) => (rc.data || []).filter((r) => r.product_id === pid && r.condition === c).reduce((s, r) => s + r.qty, 0);
  const open = OPEN.includes(b.status), act = canAct(ctx);
  const reload = () => detail(ctx, root, id);

  const form = () => {
    const expected = new Set((ln.data || []).map((l) => l.product_id));
    const sorted = [...prods].sort((a, c) => (expected.has(c.id) - expected.has(a.id)) || a.sku.localeCompare(c.sku));
    const sel = el('select', {}, sorted.map((p) => el('option', { value: p.id, text: (expected.has(p.id) ? '' : '(not booked) ') + p.sku + ' - ' + p.name })));
    const qty = el('input', { type: 'number', min: '1', value: '1', style: 'width:90px' }), cond = el('select', {}, el('option', { value: 'good', text: 'Good' }), el('option', { value: 'damaged', text: 'Damaged' })), note = el('input', { placeholder: 'Note (optional)' }), err = el('p', { class: 'err' });
    const photos = el('input', { type: 'file', accept: 'image/*', multiple: true, capture: 'environment' });
    const photoBox = el('label', { class: 'field', style: 'display:none' }, el('span', { text: 'Photos of the damage (recommended)' }), photos);
    cond.addEventListener('change', () => { photoBox.style.display = cond.value === 'damaged' ? '' : 'none'; });
    const go = el('button', { class: 'btn', text: 'Receive', onclick: () => guarded(go, err, async () => {
      const r = await rpc(ctx, 'receive_line', { p_booking: id, p_product: sel.value, p_qty: Number(qty.value), p_condition: cond.value, p_lot: '', p_expiry: null, p_note: note.value || null, p_key: newKey() });
      let photoFail = '';
      if (cond.value === 'damaged' && photos.files.length) { try { const paths = await uploadPhotos(ctx, b.org_id, id, photos.files); await rpc(ctx, 'add_receipt_photos', { p_line: r.receipt_id, p_paths: paths }); } catch (e) { photoFail = e.message; } }
      toast(photoFail ? 'Received, but the photos did not upload: ' + photoFail : r.condition === 'unexpected' ? 'Received. This product was not on the booking, so it is flagged.' : r.condition === 'good' && r.location ? 'Received and stored in ' + r.location + '. Available now.' : 'Received', !!photoFail); reload(); }) });
    return el('section', { class: 'card' }, el('h2', { text: 'Receive goods' }), el('div', { class: 'row' }, sel, qty, cond, note, go), photoBox, err,
      el('p', { class: 'muted', text: 'Good goods go straight into the customer\'s own bin (created automatically) and are available at once. Damaged goods go to quarantine. Use the scan page on a phone for fast receiving.' }));
  };
  const close = async () => {
    const short = (ln.data || []).filter((l) => got(l.product_id, 'good') < l.expected_qty).length;
    const ok = await confirmBox('Close receiving?', short ? `${short} product(s) arrived short. Closing creates a discrepancy for each difference and cannot be undone.` : 'Everything booked has arrived. Close this delivery?', 'Close receiving');
    if (!ok) return; try { const r = await rpc(ctx, 'receive_close', { p_booking: id }); let told = ''; if (r.discrepancies) { try { await ctx.api('discrepancy.notify', { booking_id: id }); told = ' The customer was emailed.'; } catch (e) { told = ' The email to the customer failed: ' + e.message; } } toast(r.discrepancies ? r.discrepancies + ' discrepancies opened.' + told : 'Closed, no differences'); reload(); } catch (e) { toast(e.message, true); }
  };
  const editable = b.status === 'booked' && !(rc.data || []).length;
  const edit = () => deliveryDialog(ctx, orgs, { booking: b, lines: ln.data || [] }).then((ok) => { if (ok) { toast('Saved'); reload(); } });
  const del = async () => { if (!(await confirmBox('Delete this delivery?', 'It is removed completely. This cannot be undone.', 'Delete'))) return; try { await rpc(ctx, 'delete_inbound', { p_id: id }); toast('Deleted'); ctx.go('inbound'); } catch (e) { toast(e.message, true); } };
  const cancel = async () => { if (!(await confirmBox('Cancel delivery?', 'It has not arrived. This cannot be undone.', 'Cancel delivery'))) return; try { await rpc(ctx, 'cancel_inbound', { p_id: id }); toast('Cancelled'); reload(); } catch (e) { toast(e.message, true); } };
  clear(root).append(
    el('div', { class: 'row between' }, el('div', {}, el('button', { class: 'btn ghost tiny', onclick: () => ctx.go('inbound'), text: '← Inbound' }), el('h1', { text: b.ref + ' ' }), pill(b.status, KIND[b.status])),
      act && el('div', { class: 'row' }, editable && el('button', { class: 'btn ghost', onclick: edit, text: 'Edit' }), (editable || b.status === 'cancelled') && el('button', { class: 'btn ghost', onclick: del, text: 'Delete' }), b.status === 'booked' && el('button', { class: 'btn ghost', onclick: cancel, text: 'Cancel delivery' }), open && el('button', { class: 'btn', onclick: close, text: 'Close receiving' }))),
    el('section', { class: 'card' }, kv([['Customer', orgName(orgs, b.org_id)], ['Expected', fmtDay(b.expected_date)], ['Carrier', b.carrier], ['Tracking', b.tracking], ['Notes', b.notes], ['Booked', fmtDate(b.created_at)], ['Received', b.received_at ? fmtDate(b.received_at) : null]])),
    act && open && form(),
    el('section', { class: 'card' }, el('h2', { text: 'Expected vs received' }), table([
      { label: 'Product', render: (l) => (pmap[l.product_id] ? `${pmap[l.product_id].sku} - ${pmap[l.product_id].name}` : l.product_id) }, { label: 'Booked', render: (l) => String(l.expected_qty) },
      { label: 'Good', render: (l) => { const g = got(l.product_id, 'good'); return el('b', { class: g < l.expected_qty ? 'warnText' : '', text: String(g) }); } }, { label: 'Damaged', render: (l) => String(got(l.product_id, 'damaged')) },
    ], ln.data || [])),
    (rc.data || []).length > 0 && el('section', { class: 'card' }, el('h2', { text: 'Receiving log' }), table([
      { label: 'When', render: (r) => fmtDate(r.created_at) }, { label: 'Product', render: (r) => r.products.sku }, { label: 'Qty', render: (r) => String(r.qty) }, { label: 'Condition', render: (r) => pill(r.condition, r.condition === 'good' ? 'ok' : 'warn') }, { label: 'Note', render: (r) => r.note || '' }, { label: 'Photos', render: (r) => el('div', { class: 'row' }, (r.photo_paths || []).filter((p) => urls[p]).map((p) => el('a', { href: urls[p], target: '_blank', rel: 'noopener' }, el('img', { src: urls[p], alt: 'Damage photo', style: 'height:44px;border-radius:3px' })))) }], rc.data)),
    (ds.data || []).length > 0 && el('section', { class: 'card' }, el('h2', { text: 'Discrepancies' }), table([
      { label: 'Product', render: (d) => d.products.sku }, { label: 'Issue', render: (d) => pill(d.kind, d.status === 'open' ? 'warn' : 'muted') }, { label: 'Booked / got', render: (d) => `${d.expected_qty} / ${d.received_qty}` }, { label: 'Status', key: 'status' }], ds.data, () => ctx.go('discrepancies'))));
}

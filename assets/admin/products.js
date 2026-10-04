import { el, clear, table, pill, field, modal, toast, kv, fmtDate, confirmBox } from './ui.js';
import { rpc, canAct, loadOrgs, orgName, orgSelect, guarded } from './wms.js';

const num = (v) => (v === '' || v == null ? null : Number(v));

export async function render(ctx, root, params) {
  if (params && params[0]) return detail(ctx, root, params[0]);
  clear(root).append(el('h1', { text: 'Products' }), el('p', { class: 'muted', text: 'Loading…' }));
  const orgs = await loadOrgs(ctx);
  const [inv, bc] = await Promise.all([ctx.sb.from('v_inventory_by_product').select('*').order('sku'), ctx.sb.from('product_barcodes').select('product_id, barcode')]);
  if (inv.error) return clear(root).append(el('h1', { text: 'Products' }), el('p', { class: 'err', text: inv.error.message }));
  const codes = {}; for (const b of bc.data || []) (codes[b.product_id] = codes[b.product_id] || []).push(b.barcode);
  const cust = orgSelect(orgs, '', 'All customers'), q = el('input', { type: 'search', placeholder: 'Search SKU, name or barcode', class: 'grow' }), holder = el('div');
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const rows = inv.data.filter((p) => (!cust.value || p.org_id === cust.value) && (!t || p.sku.toLowerCase().includes(t) || p.name.toLowerCase().includes(t) || (codes[p.product_id] || []).some((c) => c.toLowerCase().includes(t))));
    clear(holder).append(table([
      { label: 'Customer', render: (p) => orgName(orgs, p.org_id) }, { label: 'SKU', render: (p) => el('strong', { text: p.sku }) }, { label: 'Name', key: 'name' },
      { label: 'Barcode', render: (p) => (codes[p.product_id] || []).join(', ') || '-' },
      { label: 'On hand', render: (p) => String(p.on_hand) }, { label: 'Unplaced', render: (p) => (p.unplaced ? el('b', { text: String(p.unplaced) }) : '0') },
      { label: 'Incoming', render: (p) => String(p.incoming) }, { label: '', render: (p) => (p.active ? '' : pill('off', 'muted')) },
    ], rows, (p) => ctx.go('products/' + p.product_id)));
  };
  q.addEventListener('input', draw); cust.addEventListener('change', draw); draw();
  const create = () => modal('New product', (body, done) => {
    const o = orgSelect(orgs, ''), sku = el('input', { maxlength: '60' }), name = el('input'), ean = el('input', { placeholder: 'EAN / barcode (optional)' }), err = el('p', { class: 'err' });
    const go = el('button', { class: 'btn', text: 'Create', onclick: () => guarded(go, err, async () => { if (!o.value) throw new Error('Choose a customer'); await rpc(ctx, 'create_product', { p_org: o.value, p_sku: sku.value, p_name: name.value, p_ean: ean.value }); done(true); }) });
    body.append(el('p', { class: 'muted', text: 'Creating on behalf of a customer. Customers can add their own from their dashboard.' }), field('Customer', o), field('SKU', sku), field('Name', name), field('Barcode', ean), err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), go));
  }).then((ok) => { if (ok) { toast('Product created'); render(ctx, root); } });
  clear(root).append(el('div', { class: 'row between' }, el('h1', { text: 'Products' }), canAct(ctx) && el('button', { class: 'btn', onclick: create, text: 'New product' })), el('div', { class: 'row' }, q, cust), holder);
}

async function detail(ctx, root, id) {
  clear(root).append(el('p', { class: 'muted', text: 'Loading…' }));
  const orgs = await loadOrgs(ctx);
  const [p, bc, lv, mv] = await Promise.all([
    ctx.sb.from('products').select('*').eq('id', id).maybeSingle(),
    ctx.sb.from('product_barcodes').select('barcode').eq('product_id', id),
    ctx.sb.from('stock_levels').select('on_hand, reserved, lot, locations(code, kind)').eq('product_id', id),
    ctx.sb.from('stock_movements').select('id, at, qty, reason, note, lot, locations(code)').eq('product_id', id).order('id', { ascending: false }).limit(100),
  ]);
  const pr = p.data; if (!pr) return clear(root).append(el('p', { class: 'err', text: 'Product not found.' }), el('button', { class: 'btn ghost', onclick: () => ctx.go('products'), text: 'Back' }));
  const act = canAct(ctx);
  const edit = () => modal('Edit ' + pr.sku, (body, done) => {
    const f = { name: el('input', { value: pr.name }), length_cm: el('input', { type: 'number', step: '0.1', value: pr.length_cm ?? '' }), width_cm: el('input', { type: 'number', step: '0.1', value: pr.width_cm ?? '' }), height_cm: el('input', { type: 'number', step: '0.1', value: pr.height_cm ?? '' }), weight_g: el('input', { type: 'number', value: pr.weight_g ?? '' }), hs_code: el('input', { value: pr.hs_code ?? '' }), origin_country: el('input', { maxlength: '2', value: pr.origin_country ?? '' }) };
    const act2 = el('select', {}, el('option', { value: 'true', text: 'Active' }), el('option', { value: 'false', text: 'Switched off', ...(pr.active ? {} : { selected: true }) })); const err = el('p', { class: 'err' });
    const go = el('button', { class: 'btn', text: 'Save', onclick: () => guarded(go, err, async () => {
      const patch = { name: f.name.value, length_cm: num(f.length_cm.value), width_cm: num(f.width_cm.value), height_cm: num(f.height_cm.value), weight_g: num(f.weight_g.value), hs_code: f.hs_code.value, origin_country: f.origin_country.value, active: act2.value === 'true' };
      await rpc(ctx, 'update_product', { p_id: id, p_patch: patch }); done(true); }) });
    body.append(field('Name', f.name), el('div', { class: 'row' }, field('Length cm', f.length_cm), field('Width cm', f.width_cm), field('Height cm', f.height_cm), field('Weight g', f.weight_g)), el('div', { class: 'row' }, field('HS code', f.hs_code), field('Origin (2 letters)', f.origin_country)), field('Status', act2), err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), go));
  }).then((ok) => { if (ok) { toast('Saved'); detail(ctx, root, id); } });
  const del = async () => { if (!(await confirmBox('Delete ' + pr.sku + '?', 'Only products that were never used can be deleted. Otherwise switch it off from Edit.', 'Delete'))) return; try { await rpc(ctx, 'delete_product', { p_id: id }); toast('Deleted'); ctx.go('products'); } catch (e) { toast(e.message, true); } };
  const addBc = () => modal('Add barcode', (body, done) => {
    const i = el('input', { placeholder: 'Scan or type the barcode' }), err = el('p', { class: 'err' });
    const go = el('button', { class: 'btn', text: 'Add', onclick: () => guarded(go, err, async () => { await rpc(ctx, 'add_product_barcode', { p_product: id, p_barcode: i.value }); done(true); }) });
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    body.append(field('Barcode', i), err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), go));
  }).then((ok) => { if (ok) { toast('Barcode added'); detail(ctx, root, id); } });
  clear(root).append(
    el('div', { class: 'row between' }, el('div', {}, el('button', { class: 'btn ghost tiny', onclick: () => ctx.go('products'), text: '← Products' }), el('h1', { text: pr.name })), act && el('div', { class: 'row' }, el('button', { class: 'btn ghost', onclick: addBc, text: 'Add barcode' }), el('button', { class: 'btn ghost', onclick: del, text: 'Delete' }), el('button', { class: 'btn', onclick: edit, text: 'Edit' }))),
    el('div', { class: 'cols' },
      el('section', { class: 'card' }, el('h2', { text: 'Details' }), kv([['Customer', orgName(orgs, pr.org_id)], ['SKU', pr.sku], ['Barcodes', (bc.data || []).map((b) => b.barcode).join(', ')], ['Size cm', [pr.length_cm, pr.width_cm, pr.height_cm].every((x) => x) ? `${pr.length_cm} × ${pr.width_cm} × ${pr.height_cm}` : null], ['Weight', pr.weight_g ? pr.weight_g + ' g' : null], ['HS code', pr.hs_code], ['Origin', pr.origin_country], ['Status', pr.active ? 'active' : 'switched off']])),
      el('section', { class: 'card' }, el('h2', { text: 'Stock by location' }), table([{ label: 'Location', render: (r) => el('strong', { text: r.locations.code }) }, { label: 'Type', render: (r) => r.locations.kind }, { label: 'On hand', render: (r) => String(r.on_hand) }, { label: 'Reserved', render: (r) => String(r.reserved) }], (lv.data || []).filter((r) => r.on_hand > 0)))),
    el('section', { class: 'card' }, el('h2', { text: 'Ledger (latest 100)' }), table([{ label: 'When', render: (m) => fmtDate(m.at) }, { label: 'Location', render: (m) => m.locations.code }, { label: 'Change', render: (m) => el('b', { text: (m.qty > 0 ? '+' : '') + m.qty }) }, { label: 'Reason', key: 'reason' }, { label: 'Note', render: (m) => m.note || '' }], mv.data || [])));
}

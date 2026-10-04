import { el, clear, table, pill, field, modal, toast, confirmBox } from './ui.js';
import { rpc, canAct, loadOrgs, orgName, orgSelect, guarded, KINDS } from './wms.js';

const KIND_HELP = { receiving: 'Where goods land before they are put away', bin: 'Shelf bin, dedicated to one customer', pallet: 'Pallet slot, dedicated to one customer', pack: 'Packing station', returns: 'Returns area', quarantine: 'Damaged or on hold', shipping: 'Ready to ship' };

export async function render(ctx, root) {
  clear(root).append(el('h1', { text: 'Locations' }), el('p', { class: 'muted', text: 'Loading…' }));
  const orgs = await loadOrgs(ctx);
  const [locs, asg, lv] = await Promise.all([
    ctx.sb.from('locations').select('*').order('code'),
    ctx.sb.from('location_assignments').select('location_id, org_id').is('released_at', null),
    ctx.sb.from('stock_levels').select('location_id, on_hand'),
  ]);
  if (locs.error) return clear(root).append(el('h1', { text: 'Locations' }), el('p', { class: 'err', text: locs.error.message }));
  const owner = Object.fromEntries((asg.data || []).map((a) => [a.location_id, a.org_id]));
  const units = {}; for (const r of lv.data || []) units[r.location_id] = (units[r.location_id] || 0) + r.on_hand;
  const act = canAct(ctx), picked = new Set();
  const kind = el('select', {}, el('option', { value: '', text: 'All types' }), KINDS.map((k) => el('option', { value: k, text: k })));
  const q = el('input', { type: 'search', placeholder: 'Search code', class: 'grow' });
  const holder = el('div');
  const reload = () => render(ctx, root);

  const doAssign = async (l) => modal('Assign ' + l.code + ' to a customer', (body, done) => {
    const sel = orgSelect(orgs, owner[l.id]); const err = el('p', { class: 'err' });
    const go = el('button', { class: 'btn', text: 'Assign', onclick: () => guarded(go, err, async () => { await rpc(ctx, 'assign_location', { p_location: l.id, p_org: sel.value }); done(true); }) });
    body.append(field('Customer', sel), err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), go));
  }).then((ok) => { if (ok) { toast('Assigned'); reload(); } });

  const draw = () => {
    const t = q.value.trim().toUpperCase();
    const rows = locs.data.filter((l) => (!kind.value || l.kind === kind.value) && (!t || l.code.includes(t)));
    clear(holder).append(table([
      act && { label: '', render: (l) => el('input', { type: 'checkbox', 'aria-label': 'Select ' + l.code, ...(picked.has(l.id) ? { checked: true } : {}), onclick: (e) => { e.stopPropagation(); e.target.checked ? picked.add(l.id) : picked.delete(l.id); } }) },
      { label: 'Code', render: (l) => el('strong', { class: 'mono', text: l.code }) },
      { label: 'Type', render: (l) => pill(l.kind) },
      { label: 'Customer', render: (l) => (owner[l.id] ? orgName(orgs, owner[l.id]) : (l.kind === 'bin' || l.kind === 'pallet' ? el('span', { class: 'muted', text: 'free' }) : el('span', { class: 'muted', text: 'shared area' }))) },
      { label: 'Units', render: (l) => String(units[l.id] || 0) },
      { label: 'Status', render: (l) => (l.active ? pill('active', 'ok') : pill('off', 'muted')) },
      act && { label: '', render: (l) => el('div', { class: 'row' },
        (l.kind === 'bin' || l.kind === 'pallet') && l.active && el('button', { class: 'btn ghost tiny', text: owner[l.id] ? 'Reassign' : 'Assign', onclick: () => doAssign(l) }),
        owner[l.id] && el('button', { class: 'btn ghost tiny', text: 'Release', onclick: async () => { try { await rpc(ctx, 'release_location', { p_location: l.id }); toast('Released'); reload(); } catch (e) { toast(e.message, true); } } }),
        el('button', { class: 'btn ghost tiny', text: l.active ? 'Switch off' : 'Switch on', onclick: async () => { try { await rpc(ctx, 'set_location_active', { p_location: l.id, p_active: !l.active }); reload(); } catch (e) { toast(e.message, true); } } })) },
    ].filter(Boolean), rows));
  };
  q.addEventListener('input', draw); kind.addEventListener('change', draw); draw();

  const create = () => modal('New location', (body, done) => {
    const code = el('input', { placeholder: 'A-01-01', maxlength: '30' }), k = el('select', {}, ['bin', 'pallet', 'receiving', 'quarantine', 'pack', 'returns', 'shipping'].map((x) => el('option', { value: x, text: x + ' - ' + KIND_HELP[x] }))), label = el('input', { placeholder: 'Optional note' }); const err = el('p', { class: 'err' });
    const go = el('button', { class: 'btn', text: 'Create', onclick: () => guarded(go, err, async () => { await rpc(ctx, 'create_location', { p_code: code.value, p_kind: k.value, p_label: label.value }); done(true); }) });
    body.append(field('Code (this is printed on the barcode label)', code), field('Type', k), field('Note', label), err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), go));
  }).then((ok) => { if (ok) { toast('Location created'); reload(); } });

  const bulk = () => modal('Create many locations', (body, done) => {
    const pre = el('input', { placeholder: 'A-01-' }), from = el('input', { type: 'number', value: '1', min: '0' }), to = el('input', { type: 'number', value: '20', min: '1' }), k = el('select', {}, ['bin', 'pallet'].map((x) => el('option', { value: x, text: x }))); const err = el('p', { class: 'err' });
    const preview = el('p', { class: 'muted' }); const codes = () => { const a = +from.value, b = +to.value, out = []; if (!(b >= a) || b - a > 199) return out; for (let i = a; i <= b; i++) out.push(pre.value.toUpperCase() + String(i).padStart(2, '0')); return out; };
    const upd = () => { const c = codes(); preview.textContent = c.length ? c.length + ' locations: ' + c[0] + (c.length > 1 ? ' … ' + c[c.length - 1] : '') : 'Pick a range of up to 200'; }; [pre, from, to].forEach((i) => i.addEventListener('input', upd)); upd();
    const go = el('button', { class: 'btn', text: 'Create all', onclick: () => guarded(go, err, async () => { let n = 0; for (const c of codes()) { await rpc(ctx, 'create_location', { p_code: c, p_kind: k.value, p_label: null }); n++; } done(n); }) });
    body.append(field('Starts with', pre), el('div', { class: 'row' }, field('From', from), field('To', to)), field('Type', k), preview, err, el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), go));
  }).then((n) => { if (n) { toast(n + ' locations created'); reload(); } });

  const print = () => {
    const sel = locs.data.filter((l) => picked.has(l.id)); if (!sel.length) return toast('Tick the locations to print first', true);
    const w = window.open('', '_blank'); if (!w) return toast('Allow pop-ups to print labels', true);
    const data = JSON.stringify(sel.map((l) => ({ c: l.code, k: l.kind }))).replace(/</g, '\\u003c');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Location labels</title><style>body{margin:12px;font-family:Arial,sans-serif}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.l{border:1px dashed #999;padding:8px;text-align:center;break-inside:avoid}.l b{display:block;font-size:20px;margin-top:2px}.l small{color:#555;text-transform:uppercase;letter-spacing:.08em}svg{max-width:100%;height:60px}@media print{.no{display:none}}</style><button class="no" onclick="print()">Print</button><div class="g" id="g"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js"><\/script><script>const d=${data},g=document.getElementById('g');for(const x of d){const e=document.createElement('div');e.className='l';e.innerHTML='<small></small><svg></svg><b></b>';e.querySelector('small').textContent=x.k;e.querySelector('b').textContent=x.c;g.appendChild(e);JsBarcode(e.querySelector('svg'),x.c,{format:'CODE128',displayValue:false,height:60,margin:0});}<\/script>`);
    w.document.close();
  };
  clear(root).append(el('div', { class: 'row between' }, el('h1', { text: 'Locations' }),
    act && el('div', { class: 'row' }, el('button', { class: 'btn ghost', onclick: print, text: 'Print labels' }), el('button', { class: 'btn ghost', onclick: bulk, text: 'Create many' }), el('button', { class: 'btn', onclick: create, text: 'New location' }))),
    el('p', { class: 'muted', text: 'Every bin and pallet slot is dedicated to one customer: use Assign on a bin or pallet row. That assignment is what storage is billed from. Receiving, quarantine and the other areas are shared and cannot be assigned.' }), el('div', { class: 'row' }, q, kind), holder);
}

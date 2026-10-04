import { el, clear, table, statusPill, fmtDate, field, kv, copyBtn, toast, confirmBox } from './ui.js';

export async function render(ctx, root, params) {
  if (params && params[0]) return detail(ctx, root, params[0]);
  clear(root).append(el('h1', { text: 'Domain orders' }), el('p', { class: 'muted', text: 'Loading…' }));
  const { data, error } = await ctx.sb.from('domain_orders').select('id, domain, status, availability, auto, notes, created_at, organizations(name)').order('created_at', { ascending: false }).limit(500);
  if (error) return clear(root).append(el('h1', { text: 'Domain orders' }), el('p', { class: 'err', text: 'Could not load: ' + error.message }));
  const st = el('select', {}, el('option', { value: 'pending', text: 'To do (pending)' }), el('option', { value: '', text: 'All' }), ['registered', 'failed', 'cancelled'].map((s) => el('option', { value: s, text: s })));
  const holder = el('div');
  const draw = () => clear(holder).append(table([
    { label: 'Domain', render: (d) => el('strong', { text: d.domain }) }, { label: 'Company', render: (d) => (d.organizations && d.organizations.name) || '-' },
    { label: 'Status', render: (d) => statusPill(d.status) }, { label: 'Registry now', render: (d) => d.availability || '-' },
    { label: 'How', render: (d) => (d.auto ? 'automatic' : 'manual') }, { label: 'Note', render: (d) => d.notes || '-' }, { label: 'Ordered', render: (d) => fmtDate(d.created_at) },
  ], data.filter((d) => !st.value || d.status === st.value), (d) => ctx.go('domains/' + d.id)));
  st.addEventListener('change', draw); draw();
  clear(root).append(el('h1', { text: 'Domain orders' }), el('div', { class: 'row' }, st), holder);
}

async function detail(ctx, root, id) {
  clear(root).append(el('p', { class: 'muted', text: 'Loading…' }));
  const { data: d } = await ctx.sb.from('domain_orders').select('*, organizations(*)').eq('id', id).maybeSingle();
  if (!d) return clear(root).append(el('p', { class: 'err', text: 'Order not found.' }), el('button', { class: 'btn ghost', onclick: () => ctx.go('domains'), text: 'Back' }));
  const o = d.organizations || {};
  const { data: mem } = await ctx.sb.from('members').select('user_id').eq('org_id', d.org_id).eq('role', 'owner').limit(1);
  const owner = mem && mem[0] ? (await ctx.sb.from('profiles').select('full_name, email, phone').eq('user_id', mem[0].user_id).maybeSingle()).data : null;
  const registrant = [
    ['Company name', o.name], ['Owner name', owner && owner.full_name], ['Email', owner && owner.email], ['Phone', o.phone || (owner && owner.phone)],
    ['Street', o.address_line], ['Postal code', o.postal_code], ['City', o.city], ['Voivodeship', o.region], ['Country', o.country], ['Tax / VAT ID', o.vat_id],
  ];
  const notes = el('textarea', { rows: '3', placeholder: 'Notes (for the team)' }); notes.value = d.notes || '';
  const ref = el('input', { type: 'text', placeholder: 'Hostinger order id (optional)', value: d.order_ref || '' });
  const act = async (label, fn) => { try { const out = await fn(); toast(label); return out; } catch (e) { toast(e.message, true); } };
  const setStatus = async (status) => {
    if (status === 'registered' && !(await confirmBox('Mark as registered?', `${d.domain} will be marked registered and the customer gets an email.`, 'Mark registered'))) return;
    if (await act('Updated', () => ctx.api('domain.update', { id, status, notes: notes.value, order_ref: ref.value }))) detail(ctx, root, id);
  };
  const retry = async () => {
    const out = await act('Retry finished', () => ctx.api('domain.retry', { id }));
    if (out) { toast(out.outcome === 'registered' ? 'Registered automatically' : out.message, out.outcome === 'manual'); detail(ctx, root, id); }
  };
  clear(root).append(
    el('div', { class: 'row between' }, el('div', {}, el('button', { class: 'btn ghost tiny', onclick: () => ctx.go('domains'), text: '← Domain orders' }), el('h1', { text: d.domain })), statusPill(d.status)),
    d.availability === 'taken' && el('p', { class: 'err', text: 'The registry showed this name as already registered at order time. Contact the customer for another name.' }),
    el('div', { class: 'cols' },
      el('section', { class: 'card' }, el('h2', { text: 'Order' }), kv([['Ordered', fmtDate(d.created_at)], ['Registry at order time', d.availability], ['How', d.auto ? 'bought automatically' : 'manual'], ['Hostinger order', d.order_ref], ['Registered', d.registered_at ? fmtDate(d.registered_at) : null]]),
        el('button', { class: 'btn ghost tiny', onclick: () => ctx.go('customers/' + d.org_id), text: 'Open customer' })),
      el('section', { class: 'card' }, el('h2', { text: 'Register in the customer\'s company name' }),
        kv(registrant.map(([k, v]) => [k, v ? el('span', {}, v, ' ', copyBtn(v)) : null])))),
    el('section', { class: 'card' }, el('h2', { text: 'Update' }), field('Notes', notes), field('Hostinger order id', ref),
      el('div', { class: 'row' }, ctx.me.role !== 'warehouse' && el('button', { class: 'btn', onclick: () => setStatus('registered'), text: 'Mark registered' }),
        el('button', { class: 'btn ghost', onclick: () => setStatus('failed'), text: 'Mark failed' }), el('button', { class: 'btn ghost', onclick: () => setStatus('cancelled'), text: 'Cancel order' }),
        d.status !== 'pending' && el('button', { class: 'btn ghost', onclick: () => setStatus('pending'), text: 'Back to pending' }),
        d.status === 'pending' && el('button', { class: 'btn ghost', onclick: retry, text: 'Retry automatic registration' }),
        el('button', { class: 'btn ghost', onclick: () => setStatus(d.status), text: 'Save notes only' }))));
}

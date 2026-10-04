import { el, clear, table, statusPill, fmtDate, fmtDay, zl, field, kv, askReason, modal, toast } from './ui.js';

const REASONS = ['Support request', 'Billing check', 'Domain order', 'Onboarding help', 'Data correction', 'Other'];
const planSummary = (c) => { if (!c) return '-'; const on = [c.pkgs && c.pkgs.ful && 'fulfillment', c.pkgs && c.pkgs.ret && 'returns', c.pkgs && c.pkgs.imp && 'import', c.storeOn && 'storefront', c.marketOn && 'Market'].filter(Boolean); return `${c.qty} ${c.storageType === 'shelf' ? 'bins' : 'pallets'}` + (on.length ? ' + ' + on.join(', ') : ''); };

export async function render(ctx, root, params) {
  if (params && params[0]) return detail(ctx, root, params[0]);
  clear(root).append(el('h1', { text: 'Customers' }), el('p', { class: 'muted', text: 'Loading…' }));
  const { data, error } = await ctx.sb.rpc('admin_customers');
  if (error) return clear(root).append(el('h1', { text: 'Customers' }), el('p', { class: 'err', text: 'Could not load: ' + error.message }));
  const q = el('input', { type: 'search', placeholder: 'Search company, owner, email or domain', class: 'grow' });
  const st = el('select', {}, el('option', { value: '', text: 'All statuses' }), ['active', 'pending', 'past_due', 'canceled'].map((s) => el('option', { value: s, text: s })));
  const holder = el('div');
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const rows = data.filter((r) => (!st.value || r.status === st.value) && (!t || [r.name, r.owner_name, r.owner_email, r.domain].some((x) => (x || '').toLowerCase().includes(t))));
    clear(holder).append(table([
      { label: 'Company', render: (r) => el('strong', { text: r.name }) },
      { label: 'Owner', render: (r) => el('div', {}, el('div', { text: r.owner_name || '-' }), el('small', { class: 'muted', text: r.owner_email || '' })) },
      { label: 'Country', key: 'country' },
      { label: 'Plan', render: (r) => (r.monthly_pln ? zl(r.monthly_pln) + ' / mo' : '-') },
      { label: 'Status', render: (r) => statusPill(r.status) },
      { label: 'Domain', render: (r) => r.domain || '-' },
      { label: 'Open requests', render: (r) => (Number(r.open_requests) ? el('b', { text: String(r.open_requests) }) : '0') },
      { label: 'Joined', render: (r) => fmtDay(r.created_at) },
    ], rows, (r) => ctx.go('customers/' + r.org_id)));
    holder.dataset.count = String(rows.length);
  };
  q.addEventListener('input', draw); st.addEventListener('change', draw); draw();
  clear(root).append(el('h1', { text: 'Customers' }), el('div', { class: 'row' }, q, st), holder);
}

async function detail(ctx, root, orgId) {
  clear(root).append(el('p', { class: 'muted', text: 'Loading…' }));
  // Opening a customer is audited with a reason (once per customer per browser session).
  const key = 'opened:' + orgId;
  if (!ctx.session[key]) {
    const reason = await askReason('Why are you opening this customer?', REASONS);
    if (!reason) return ctx.go('customers');
    try { await ctx.api('viewas.start', { org_id: orgId, reason }); ctx.session[key] = true; } catch (e) { toast(e.message, true); return ctx.go('customers'); }
  }
  const sb = ctx.sb;
  const [org, mem, plans, subs, agr, doms, reqs] = await Promise.all([
    sb.from('organizations').select('*').eq('id', orgId).maybeSingle(),
    sb.from('members').select('user_id, role').eq('org_id', orgId),
    sb.from('plans').select('*').eq('org_id', orgId).order('created_at', { ascending: false }),
    sb.from('subscriptions').select('*').eq('org_id', orgId).order('updated_at', { ascending: false }),
    sb.from('agreements').select('*').eq('org_id', orgId).order('signed_at', { ascending: false }),
    sb.from('domain_orders').select('*').eq('org_id', orgId).order('created_at', { ascending: false }),
    sb.from('requests').select('id, subject, status, last_message_at').eq('org_id', orgId).order('last_message_at', { ascending: false }),
  ]);
  const o = org.data; if (!o) return clear(root).append(el('p', { class: 'err', text: 'Customer not found.' }), el('button', { class: 'btn ghost', onclick: () => ctx.go('customers'), text: 'Back' }));
  const ids = (mem.data || []).map((m) => m.user_id);
  const profs = ids.length ? (await sb.from('profiles').select('user_id, full_name, email, phone').in('user_id', ids)).data || [] : [];
  const pmap = Object.fromEntries(profs.map((p) => [p.user_id, p]));
  const active = (plans.data || []).find((p) => p.status === 'active');

  const changeStatus = () => modal('Change customer status', (body, done) => {
    const sel = el('select', {}, ['pending', 'active', 'past_due', 'canceled'].map((s) => el('option', { value: s, text: s, ...(s === o.status ? { selected: true } : {}) })));
    const why = el('textarea', { rows: '3', placeholder: 'Reason (required, kept in the audit log)' }); const err = el('p', { class: 'err' });
    body.append(el('p', { class: 'muted', text: 'This only changes the label in our system. It does not touch Stripe.' }), field('New status', sel), field('Reason', why), err,
      el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), el('button', { class: 'btn', text: 'Save', onclick: async () => {
        try { await ctx.api('org.setStatus', { org_id: orgId, status: sel.value, reason: why.value }); done(true); } catch (e) { err.textContent = e.message; } } })));
  }).then((ok) => { if (ok) { toast('Status updated'); detail(ctx, root, orgId); } });

  clear(root).append(
    el('div', { class: 'row between' }, el('div', {}, el('button', { class: 'btn ghost tiny', onclick: () => ctx.go('customers'), text: '← Customers' }), el('h1', { text: o.name })),
      el('div', { class: 'row' }, statusPill(o.status), ctx.me.role === 'admin' && el('button', { class: 'btn ghost', onclick: changeStatus, text: 'Change status' }))),
    el('div', { class: 'cols' },
      el('section', { class: 'card' }, el('h2', { text: 'Company' }), kv([
        ['Country', o.country], ['Tax / VAT ID', o.vat_id], ['Address', [o.address_line, [o.postal_code, o.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')],
        ['Voivodeship', o.region], ['Phone', o.phone], ['Stripe customer', o.stripe_customer_id], ['Joined', fmtDate(o.created_at)]])),
      el('section', { class: 'card' }, el('h2', { text: 'People' }), table([
        { label: 'Name', render: (m) => (pmap[m.user_id] || {}).full_name || '-' }, { label: 'Email', render: (m) => (pmap[m.user_id] || {}).email || '-' }, { label: 'Role', key: 'role' }], mem.data || []))),
    el('section', { class: 'card' }, el('h2', { text: 'Plan' }),
      active ? kv([['Current', planSummary(active.config)], ['Monthly', zl(active.monthly_pln)], ['Setup (one-time)', zl(active.once_pln)], ['Since', fmtDate(active.created_at)]]) : el('p', { class: 'muted', text: 'No active plan.' }),
      (plans.data || []).length > 1 && el('details', {}, el('summary', { text: 'Plan history (' + plans.data.length + ')' }), table([
        { label: 'When', render: (p) => fmtDate(p.created_at) }, { label: 'Plan', render: (p) => planSummary(p.config) }, { label: 'Monthly', render: (p) => zl(p.monthly_pln) }, { label: 'Status', render: (p) => statusPill(p.status) }], plans.data))),
    el('section', { class: 'card' }, el('h2', { text: 'Subscription' }), table([
      { label: 'Stripe id', key: 'stripe_subscription_id' }, { label: 'Status', render: (s) => statusPill(s.status) }, { label: 'Renews / ends', render: (s) => fmtDay(s.current_period_end) }], subs.data || [])),
    el('section', { class: 'card' }, el('h2', { text: 'Signed agreements' }), table([
      { label: 'Signed by', key: 'signer_name' }, { label: 'Version', key: 'version' }, { label: 'IP', key: 'ip' }, { label: 'When', render: (a) => fmtDate(a.signed_at) }], agr.data || [])),
    el('section', { class: 'card' }, el('h2', { text: 'Domain orders' }), table([
      { label: 'Domain', key: 'domain' }, { label: 'Status', render: (d) => statusPill(d.status) }, { label: 'Notes', render: (d) => d.notes || '-' }, { label: 'Ordered', render: (d) => fmtDate(d.created_at) }], doms.data || [], () => ctx.go('domains'))),
    el('section', { class: 'card' }, el('h2', { text: 'Requests' }), table([
      { label: 'Subject', key: 'subject' }, { label: 'Status', render: (r) => statusPill(r.status) }, { label: 'Last activity', render: (r) => fmtDate(r.last_message_at) }], reqs.data || [], (r) => ctx.go('requests/' + r.id))));
}

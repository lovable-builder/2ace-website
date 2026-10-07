import { el, clear, table, statusPill, fmtDate, fmtDay, zl, field, kv, askReason, modal, toast } from './ui.js';

const REASONS = ['Support request', 'Billing check', 'Domain order', 'Onboarding help', 'Data correction', 'Other'];
// Storage is sold by the square metre. Plans bought earlier per bin (0.3 m²) or pallet (1.2 m²) are shown as their area.
const planM2 = (c) => (c.m2 != null ? Number(c.m2) : Math.round(Number(c.qty) * (c.storageType === 'shelf' ? 0.3 : 1.2) * 10) / 10);
const planSummary = (c) => { if (!c) return '-'; const on = [c.pkgs && c.pkgs.ful && 'fulfillment (flat)', c.pkgs && c.pkgs.payg && 'fulfilment as you go', c.pkgs && c.pkgs.ret && 'returns (flat)', c.pkgs && c.pkgs.retp && 'returns as you go', c.pkgs && c.pkgs.imp && 'import', c.storeOn && 'storefront'].filter(Boolean); return `${String(planM2(c)).replace(/\.0$/, '')} m²` + (on.length ? ' + ' + on.join(', ') : ''); };

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
  const [org, mem, plans, subs, agr, doms, reqs, shipSet, modeRes, charges] = await Promise.all([
    sb.from('organizations').select('*').eq('id', orgId).maybeSingle(),
    sb.from('members').select('user_id, role').eq('org_id', orgId),
    sb.from('plans').select('*').eq('org_id', orgId).order('created_at', { ascending: false }),
    sb.from('subscriptions').select('*').eq('org_id', orgId).order('updated_at', { ascending: false }),
    sb.from('agreements').select('*').eq('org_id', orgId).order('signed_at', { ascending: false }),
    sb.from('domain_orders').select('*').eq('org_id', orgId).order('created_at', { ascending: false }),
    sb.from('requests').select('id, subject, status, last_message_at').eq('org_id', orgId).order('last_message_at', { ascending: false }),
    sb.from('org_shipping_settings').select('*').eq('org_id', orgId).maybeSingle(),
    sb.rpc('my_fulfil_mode', { p_org: orgId }),
    sb.from('shipping_charges').select('net, status, env').eq('org_id', orgId).in('status', ['pending', 'queued']),
  ]);
  const o = org.data; if (!o) return clear(root).append(el('p', { class: 'err', text: 'Customer not found.' }), el('button', { class: 'btn ghost', onclick: () => ctx.go('customers'), text: 'Back' }));
  const ids = (mem.data || []).map((m) => m.user_id);
  const profs = ids.length ? (await sb.from('profiles').select('user_id, full_name, email, phone').in('user_id', ids)).data || [] : [];
  const pmap = Object.fromEntries(profs.map((p) => [p.user_id, p]));
  const active = (plans.data || []).find((p) => p.status === 'active');
  const ss = shipSet.data || {}, MODE = { full: 'Fulfilment (we do everything)', payg: 'Fulfilment as you go (they prepare labels)', storage: 'Storage only' };
  const unbilled = (charges.data || []).reduce((t, c) => t + Number(c.net), 0);
  const editShipping = () => modal('Shipping and fulfilment settings', (body, done) => {
    const mode = el('select', {}, [['', 'Follow the plan'], ['full', MODE.full], ['payg', MODE.payg], ['storage', MODE.storage]].map(([v, l]) => el('option', { value: v, text: l, ...(v === (ss.fulfil_mode_override || '') ? { selected: true } : {}) })));
    const num = (v, ph) => el('input', { type: 'number', step: 'any', min: '0', value: v == null ? '' : String(v), placeholder: ph });
    const markup = num(ss.markup_percent, 'Default (30)'), cap = num(ss.exposure_cap_net ?? 300, '300'), daily = num(ss.daily_label_cap ?? 10, '10');
    const hAdj = el('input', { type: 'number', step: 'any', min: '-100', max: '500', value: String(ss.handling_adjust_percent ?? 0), placeholder: '0' }), hCap = num(ss.handling_cap_per_m2 ?? 350, '350'), rCap = num(ss.return_cap_per_m2 ?? 150, '150');
    const live = el('input', { type: 'checkbox', ...(ss.usage_billing_live ? { checked: true } : {}) });
    const buying = el('input', { type: 'checkbox', ...(ss.label_buying_enabled ? { checked: true } : {}) }), err = el('p', { class: 'err' });
    body.append(el('p', { class: 'muted', text: 'The fulfilment mode normally follows the plan. Override it only to test. Markup is added to the carrier price (net) and shown on the customer\'s monthly invoice.' }),
      field('Fulfilment mode', mode), field('Shipping markup % (empty = default)', markup), field('Most unpaid shipping at once (zł, net)', cap), field('Most labels per day', daily),
      el('label', { class: 'field' }, el('span', { text: 'May buy labels themselves' }), buying),
      el('p', { class: 'muted', text: 'Handling fee (packing) and return fees follow the tariff under Shipping. The monthly total can never pass the ceiling per m² of the customer\'s space.' }),
      field('Handling fee: discount (-) or surcharge (+) %', hAdj), field('Handling fees: monthly ceiling per m² (zł, net)', hCap), field('Return fees: monthly ceiling per m² (zł, net)', rCap),
      el('label', { class: 'field' }, el('span', { text: 'Live: bill handling and return fees (off = recorded as test, never invoiced)' }), live), err,
      el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), el('button', { class: 'btn', text: 'Save', onclick: async () => {
        try { await ctx.api('org.setShipping', { org_id: orgId, patch: { fulfil_mode_override: mode.value, markup_percent: markup.value, exposure_cap_net: Number(cap.value), daily_label_cap: Number(daily.value), label_buying_enabled: buying.checked, handling_adjust_percent: Number(hAdj.value || 0), handling_cap_per_m2: Number(hCap.value), return_cap_per_m2: Number(rCap.value), usage_billing_live: live.checked } }); done(true); } catch (e) { err.textContent = e.message; } } })));
  }).then((ok) => { if (ok) { toast('Shipping settings saved'); detail(ctx, root, orgId); } });

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
    el('section', { class: 'card' }, el('h2', { text: 'Shipping and fulfilment' }),
      kv([['Mode', (MODE[modeRes.data] || '-') + (ss.fulfil_mode_override ? ' (set by an admin, not the plan)' : '')], ['Shipping markup', ss.markup_percent == null ? 'Default' : Number(ss.markup_percent) + ' %'], ['May buy labels themselves', ss.label_buying_enabled ? 'Yes' : 'No'], ['Handling fee', (Number(ss.handling_adjust_percent || 0) ? (Number(ss.handling_adjust_percent) > 0 ? '+' : '') + Number(ss.handling_adjust_percent) + ' % on the tariff, ' : 'Standard tariff, ') + 'ceiling ' + zl(ss.handling_cap_per_m2 ?? 350) + ' per m² a month'], ['Return fee ceiling', zl(ss.return_cap_per_m2 ?? 150) + ' per m² a month'], ['Handling and return fees', ss.usage_billing_live ? 'Live (billed)' : 'Test (recorded, never invoiced)'], ['Unpaid shipping cap', zl(ss.exposure_cap_net ?? 300) + ' net'], ['Labels waiting to be invoiced', unbilled ? zl(unbilled) + ' net' : 'None']]),
      ctx.me.role === 'admin' && el('div', { class: 'row' }, el('button', { class: 'btn ghost tiny', onclick: editShipping, text: 'Edit' }))),
    el('section', { class: 'card' }, el('h2', { text: 'Subscription' }), table([
      { label: 'Stripe id', key: 'stripe_subscription_id' }, { label: 'Status', render: (s) => statusPill(s.status) }, { label: 'Renews / ends', render: (s) => fmtDay(s.current_period_end) }], subs.data || [])),
    invoicesCard(ctx, orgId),
    el('section', { class: 'card' }, el('h2', { text: 'Signed agreements' }), table([
      { label: 'Signed by', key: 'signer_name' }, { label: 'Version', key: 'version' }, { label: 'IP', key: 'ip' }, { label: 'When', render: (a) => fmtDate(a.signed_at) }], agr.data || [])),
    el('section', { class: 'card' }, el('h2', { text: 'Domain orders' }), table([
      { label: 'Domain', key: 'domain' }, { label: 'Status', render: (d) => statusPill(d.status) }, { label: 'Notes', render: (d) => d.notes || '-' }, { label: 'Ordered', render: (d) => fmtDate(d.created_at) }], doms.data || [], () => ctx.go('domains'))),
    el('section', { class: 'card' }, el('h2', { text: 'Requests' }), table([
      { label: 'Subject', key: 'subject' }, { label: 'Status', render: (r) => statusPill(r.status) }, { label: 'Last activity', render: (r) => fmtDate(r.last_message_at) }], reqs.data || [], (r) => ctx.go('requests/' + r.id))));
}

// Invoices come live from Stripe through admin-api (the browser has no Stripe access).
function invoicesCard(ctx, orgId) {
  const body = el('p', { class: 'muted', text: 'Loading from Stripe…' });
  const card = el('section', { class: 'card' }, el('h2', { text: 'Invoices' }), body);
  ctx.api('org.invoices', { org_id: orgId }).then((r) => {
    if (!r.invoices.length) return clear(body).replaceWith(el('p', { class: 'muted', text: 'No invoices yet.' }));
    const money = (i) => (i.total / 100).toLocaleString('pl-PL', { style: 'currency', currency: (i.currency || 'pln').toUpperCase() });
    body.replaceWith(table([
      { label: 'Number', render: (i) => i.number || i.id },
      { label: 'Date', render: (i) => fmtDay(new Date(i.created * 1000).toISOString()) },
      { label: 'Total', render: money },
      { label: 'Status', render: (i) => statusPill(i.status) },
      { label: '', render: (i) => el('div', { class: 'row' },
        i.hosted_invoice_url && el('a', { href: i.hosted_invoice_url, target: '_blank', rel: 'noopener', text: 'View' }),
        r.customer && el('a', { href: 'https://dashboard.stripe.com/invoices/' + i.id, target: '_blank', rel: 'noopener', text: 'Stripe' }),
        el('button', { class: 'btn ghost tiny', text: 'Email to owner', onclick: async (e) => {
          e.stopPropagation(); e.target.disabled = true;
          try { const x = await ctx.api('invoice.resend', { org_id: orgId, invoice_id: i.id }); toast('Sent to ' + x.to); } catch (err) { toast(err.message, true); }
          e.target.disabled = false; } })) },
    ], r.invoices));
  }).catch((e) => { body.className = 'err'; body.textContent = 'Could not load invoices: ' + e.message; });
  return card;
}

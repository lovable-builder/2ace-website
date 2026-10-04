import { el, clear, table, statusPill, pill, fmtDate, field, toast } from './ui.js';

const STATUSES = ['new', 'open', 'waiting', 'resolved'];
export async function render(ctx, root, params) {
  if (params && params[0]) return detail(ctx, root, params[0]);
  clear(root).append(el('h1', { text: 'Requests' }), el('p', { class: 'muted', text: 'Loading…' }));
  const { data, error } = await ctx.sb.from('requests').select('id, subject, requester_name, requester_email, source, status, priority, assignee, last_message_at, organizations(name)').order('last_message_at', { ascending: false }).limit(500);
  if (error) return clear(root).append(el('h1', { text: 'Requests' }), el('p', { class: 'err', text: 'Could not load: ' + error.message }));
  const who = (id) => (ctx.staff.find((s) => s.user_id === id) || {}).email || '';
  const st = el('select', {}, el('option', { value: 'todo', text: 'Needs attention' }), el('option', { value: '', text: 'All' }), STATUSES.map((s) => el('option', { value: s, text: s })));
  const mine = el('input', { type: 'checkbox' });
  const holder = el('div');
  const draw = () => {
    const rows = data.filter((r) => (st.value === 'todo' ? r.status !== 'resolved' : !st.value || r.status === st.value) && (!mine.checked || r.assignee === ctx.me.id));
    clear(holder).append(table([
      { label: 'Subject', render: (r) => el('strong', { text: r.subject }) },
      { label: 'From', render: (r) => el('div', {}, el('div', { text: r.requester_name || '-' }), el('small', { class: 'muted', text: r.requester_email || '' })) },
      { label: 'Company', render: (r) => (r.organizations && r.organizations.name) || '-' },
      { label: 'Source', key: 'source' }, { label: 'Status', render: (r) => statusPill(r.status) },
      { label: 'Priority', render: (r) => (r.priority === 'normal' ? 'normal' : statusPill(r.priority)) },
      { label: 'Assigned', render: (r) => who(r.assignee) || '-' }, { label: 'Last activity', render: (r) => fmtDate(r.last_message_at) },
    ], rows, (r) => ctx.go('requests/' + r.id)));
  };
  st.addEventListener('change', draw); mine.addEventListener('change', draw); draw();
  clear(root).append(el('h1', { text: 'Requests' }), el('div', { class: 'row' }, st, el('label', { class: 'inline' }, mine, ' Assigned to me')), holder);
}

async function detail(ctx, root, id) {
  clear(root).append(el('p', { class: 'muted', text: 'Loading…' }));
  const [r, m] = await Promise.all([
    ctx.sb.from('requests').select('*, organizations(id, name)').eq('id', id).maybeSingle(),
    ctx.sb.from('request_messages').select('*').eq('request_id', id).order('created_at'),
  ]);
  const q = r.data; if (!q) return clear(root).append(el('p', { class: 'err', text: 'Request not found.' }), el('button', { class: 'btn ghost', onclick: () => ctx.go('requests'), text: 'Back' }));
  const staffName = (uid) => (ctx.staff.find((s) => s.user_id === uid) || {}).email || 'staff';
  const update = async (patch) => { try { await ctx.api('request.update', { request_id: id, ...patch }); toast('Saved'); } catch (e) { toast(e.message, true); } };
  const sel = (opts, cur, on) => el('select', { onchange: (e) => on(e.target.value) }, opts.map(([v, t]) => el('option', { value: v, text: t, ...(v === cur ? { selected: true } : {}) })));
  const thread = el('div', { class: 'thread' }, (m.data || []).map((x) => el('div', { class: 'msg ' + x.direction },
    el('div', { class: 'msg-head' }, pill(x.direction === 'in' ? 'From customer' : x.direction === 'out' ? 'Our reply' : 'Internal note', x.direction === 'note' ? 'warn' : ''), el('small', { class: 'muted', text: (x.direction === 'in' ? (q.requester_name || q.requester_email || '') : staffName(x.author_id)) + ' · ' + fmtDate(x.created_at) })),
    el('div', { class: 'msg-body', text: x.body }))));
  const kind = el('select', {}, el('option', { value: 'reply', text: 'Reply by email to the customer' }), el('option', { value: 'note', text: 'Internal note (customer never sees it)' }), el('option', { value: 'incoming', text: 'Log a message the customer sent us' }));
  const body = el('textarea', { rows: '6', placeholder: 'Write here…' });
  const send = el('button', { class: 'btn', text: 'Send', onclick: async () => {
    send.disabled = true;
    try { await ctx.api('request.message', { request_id: id, kind: kind.value, body: body.value }); toast(kind.value === 'reply' ? 'Reply sent' : 'Saved'); detail(ctx, root, id); }
    catch (e) { toast(e.message, true); send.disabled = false; }
  } });
  clear(root).append(
    el('div', { class: 'row between' }, el('div', {}, el('button', { class: 'btn ghost tiny', onclick: () => ctx.go('requests'), text: '← Requests' }), el('h1', { text: q.subject })),
      q.organizations && el('button', { class: 'btn ghost', onclick: () => ctx.go('customers/' + q.organizations.id), text: 'Open ' + q.organizations.name })),
    el('p', { class: 'muted', text: `${q.requester_name || '-'} · ${q.requester_email || 'no email'} · via ${q.source} · received ${fmtDate(q.created_at)}` }),
    el('div', { class: 'row' },
      field('Status', sel(STATUSES.map((s) => [s, s]), q.status, (v) => update({ status: v }))),
      field('Priority', sel([['low', 'low'], ['normal', 'normal'], ['high', 'high']], q.priority, (v) => update({ priority: v }))),
      field('Assigned to', sel([['', 'Unassigned'], ...ctx.staff.filter((s) => s.active).map((s) => [s.user_id, s.email || s.user_id])], q.assignee || '', (v) => update({ assignee: v || null })))),
    thread, el('section', { class: 'card' }, field('Action', kind), body, el('div', { class: 'row end' }, send)));
}

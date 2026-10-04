import { el, clear, table, fmtDate } from './ui.js';

export async function render(ctx, root) {
  clear(root).append(el('h1', { text: 'Audit log' }), el('p', { class: 'muted', text: 'Loading…' }));
  const { data, error } = await ctx.sb.from('audit_log').select('*').order('at', { ascending: false }).limit(300);
  if (error) return clear(root).append(el('h1', { text: 'Audit log' }), el('p', { class: 'err', text: 'Could not load: ' + error.message }));
  const who = (id) => (ctx.staff.find((s) => s.user_id === id) || {}).email || (id ? id.slice(0, 8) : '-');
  const q = el('input', { type: 'search', placeholder: 'Filter by action, person or reason', class: 'grow' });
  const holder = el('div');
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const rows = data.filter((r) => !t || [r.action, who(r.actor_id), r.reason, r.entity].some((x) => (x || '').toLowerCase().includes(t)));
    clear(holder).append(table([
      { label: 'When', render: (r) => fmtDate(r.at) }, { label: 'Who', render: (r) => who(r.actor_id) }, { label: 'Role', key: 'actor_role' },
      { label: 'Action', render: (r) => el('strong', { text: r.action }) }, { label: 'On', render: (r) => r.entity || '-' },
      { label: 'Reason / change', render: (r) => r.reason || (r.after ? JSON.stringify(r.after).slice(0, 90) : '-') },
    ], rows));
  };
  q.addEventListener('input', draw); draw();
  clear(root).append(el('h1', { text: 'Audit log' }), el('p', { class: 'muted', text: 'Every change staff make, and every time a customer record is opened. Entries cannot be edited or deleted.' }), el('div', { class: 'row' }, q), holder);
}

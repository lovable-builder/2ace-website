import { el, clear, table, statusPill, pill, field, fmtDate, toast, confirmBox } from './ui.js';

const ROLE_HELP = { admin: 'Everything, including staff and billing changes', support: 'Customers, requests, domains', warehouse: 'Stock, inbound, orders, returns (tools arrive in phase B)' };
export async function render(ctx, root) {
  clear(root).append(el('h1', { text: 'Staff' }), el('p', { class: 'muted', text: 'Loading…' }));
  let staff;
  try { staff = (await ctx.api('staff.list')).staff; } catch (e) { return clear(root).append(el('h1', { text: 'Staff' }), el('p', { class: 'err', text: e.message })); }
  const email = el('input', { type: 'email', placeholder: 'colleague@company.com', class: 'grow' });
  const role = el('select', {}, ['support', 'warehouse', 'admin'].map((r) => el('option', { value: r, text: r + ': ' + ROLE_HELP[r] })));
  const invite = el('button', { class: 'btn', text: 'Invite', onclick: async () => {
    invite.disabled = true;
    try { const out = await ctx.api('staff.invite', { email: email.value, role: role.value }); toast(out.invited ? 'Invitation sent' : 'Access granted to the existing account'); render(ctx, root); }
    catch (e) { toast(e.message, true); invite.disabled = false; }
  } });
  const change = async (u, patch, ask) => {
    if (ask && !(await confirmBox(ask.title, ask.text, ask.yes))) return;
    try { await ctx.api('staff.update', { user_id: u.user_id, ...patch }); toast('Saved'); render(ctx, root); } catch (e) { toast(e.message, true); render(ctx, root); }
  };
  clear(root).append(el('h1', { text: 'Staff' }),
    el('section', { class: 'card' }, el('h2', { text: 'Add a team member' }), el('p', { class: 'muted', text: 'They get an email to set a password. Admin and support must also set up an authenticator app on first login.' }), el('div', { class: 'row' }, email, role, invite)),
    table([
      { label: 'Email', render: (u) => el('strong', { text: u.email || u.user_id }) },
      { label: 'Role', render: (u) => (u.user_id === ctx.me.id ? pill(u.role) : el('select', { onchange: (e) => change(u, { role: e.target.value }, { title: 'Change role?', text: `${u.email} will become ${e.target.value}.`, yes: 'Change role' }) }, ['admin', 'support', 'warehouse'].map((r) => el('option', { value: r, text: r, ...(r === u.role ? { selected: true } : {}) })))) },
      { label: 'Access', render: (u) => statusPill(u.active ? 'active' : 'cancelled') },
      { label: 'Added', render: (u) => fmtDate(u.created_at) },
      { label: '', render: (u) => (u.user_id === ctx.me.id ? el('small', { class: 'muted', text: 'you' }) : el('button', { class: 'btn tiny ghost', text: u.active ? 'Deactivate' : 'Reactivate', onclick: () => change(u, { active: !u.active }, u.active ? { title: 'Deactivate this person?', text: `${u.email} loses all admin access immediately.`, yes: 'Deactivate' } : null) })) },
    ], staff));
}

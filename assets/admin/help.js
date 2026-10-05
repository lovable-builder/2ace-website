import { el, clear } from './ui.js';

// The staff manual. The text comes from admin-api (signed-in staff only) and is shown in a sandboxed frame, so its styles stay apart from the panel.
export async function render(ctx, root, params) {
  const which = params && params[0] === 'owner' && ctx.me.role === 'admin' ? 'owner' : 'staff';
  const tabs = el('div', { class: 'row tabs' },
    el('a', { class: 'btn tiny ' + (which === 'staff' ? '' : 'ghost'), href: '#help', text: 'Staff guide' }),
    ctx.me.role === 'admin' && el('a', { class: 'btn tiny ' + (which === 'owner' ? '' : 'ghost'), href: '#help/owner', text: 'Setup and maintenance' }));
  const holder = el('div', {}, el('p', { class: 'muted', text: 'Loading…' }));
  clear(root).append(el('h1', { text: 'Help' }), tabs, holder);
  try {
    ctx.session.help = ctx.session.help || {};
    if (!ctx.session.help[which]) ctx.session.help[which] = (await ctx.api('help.get', { guide: which })).html;
    const frame = el('iframe', { title: which === 'owner' ? 'Setup and maintenance' : 'Staff guide', sandbox: 'allow-scripts allow-popups', style: 'width:100%;height:calc(100vh - 170px);min-height:480px;border:1px solid rgba(11,12,14,.13);border-radius:4px;background:#F5F4F1' });
    frame.srcdoc = ctx.session.help[which];
    clear(holder).append(frame);
  } catch (e) { clear(holder).append(el('p', { class: 'err', text: 'Could not load the guide: ' + e.message })); }
}

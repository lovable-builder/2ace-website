// Tiny UI helpers shared by every admin screen. Everything is built with textContent, never innerHTML with data.
export function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; e.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  return e;
}
export const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
export const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');
export const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
export const zl = (n) => (n == null ? '-' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' zł');
export const pill = (text, kind = '') => el('span', { class: 'pill ' + kind, text });
const STATUS_KIND = { active: 'ok', registered: 'ok', resolved: 'ok', past_due: 'bad', failed: 'bad', canceled: 'muted', cancelled: 'muted', pending: 'warn', new: 'warn', open: 'warn', waiting: 'muted', checkout: 'muted', high: 'bad' };
export const statusPill = (s) => pill(s || '-', STATUS_KIND[s] || '');

export function toast(msg, bad) {
  const t = el('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status', text: msg });
  document.body.append(t); setTimeout(() => t.remove(), bad ? 6000 : 3200);
}

// Modal with arbitrary content; resolves with whatever `done(value)` is called with (null on dismiss).
export function modal(title, build) {
  return new Promise((resolve) => {
    const body = el('div', { class: 'modal-body' });
    const close = (v) => { overlay.remove(); resolve(v ?? null); };
    const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(null); } },
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        el('div', { class: 'modal-head' }, el('strong', { text: title }), el('button', { class: 'x', 'aria-label': 'Close', onclick: () => close(null), text: '×' })), body));
    build(body, close); document.body.append(overlay);
    const f = body.querySelector('input,select,textarea'); if (f) f.focus();
  });
}
export const confirmBox = (title, message, yes = 'Confirm') => modal(title, (body, done) => {
  body.append(el('p', { text: message }), el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }), el('button', { class: 'btn', onclick: () => done(true), text: yes })));
});
export const askReason = (title, options = []) => modal(title, (body, done) => {
  const sel = options.length ? el('select', {}, el('option', { value: '', text: 'Choose a reason' }), options.map((o) => el('option', { value: o, text: o }))) : null;
  const txt = el('textarea', { rows: '3', placeholder: options.length ? 'Details (optional)' : 'Reason' });
  const err = el('p', { class: 'err' });
  body.append(sel, txt, err, el('div', { class: 'row end' },
    el('button', { class: 'btn ghost', onclick: () => done(null), text: 'Cancel' }),
    el('button', { class: 'btn', text: 'Continue', onclick: () => {
      const v = [sel && sel.value, txt.value.trim()].filter(Boolean).join(': ');
      if (v.length < 3) { err.textContent = 'Please give a reason.'; return; }
      done(v);
    } })));
});

export function table(cols, rows, onRow) {
  const t = el('table', { class: 'tbl' });
  t.append(el('thead', {}, el('tr', {}, cols.map((c) => el('th', { text: c.label })))));
  const tb = el('tbody'); t.append(tb);
  if (!rows.length) tb.append(el('tr', {}, el('td', { colspan: String(cols.length), class: 'empty', text: 'Nothing here yet.' })));
  for (const r of rows) tb.append(el('tr', { class: onRow ? 'click' : '', tabindex: onRow ? '0' : null, onclick: onRow ? () => onRow(r) : null, onkeydown: onRow ? (e) => { if (e.key === 'Enter') onRow(r); } : null },
    cols.map((c) => el('td', { 'data-label': c.label || null }, c.render ? c.render(r) : (r[c.key] ?? '-')))));   // data-label lets phones show each row as a labelled card
  return el('div', { class: 'tbl-wrap' }, t);
}
export const field = (label, input) => el('label', { class: 'field' }, el('span', { text: label }), input);
export const kv = (pairs) => el('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [el('dt', { text: k }), el('dd', {}, v == null || v === '' ? '-' : v)]));
export const copyBtn = (text) => el('button', { class: 'btn tiny ghost', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Could not copy', true); } }, text: 'Copy' });

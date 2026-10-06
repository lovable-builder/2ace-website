// The public booking page: anyone (customer or guest, no account) picks a meeting language, a day and a time, and enters their details.
// Also the "manage" view opened from the email link (?t=...): see, move or cancel a booking. Everything shown is built with textContent.
import { I18N, LOCALE, NATIVE } from './i18n.js';

const API = 'https://hvbcmilcjragrcezwzlo.supabase.co/functions/v1/booking';
const LANGS = ['en', 'zh', 'ar'];

const el = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k === 'value') e.value = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; e.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  return e;
};
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

async function api(action, payload) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...(payload || {}) }) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(out.error || 'error'), { status: r.status });
  return out;
}

export async function start(root, opts = {}) {
  const q = new URLSearchParams(opts.search ?? location.search);
  const detectTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Warsaw'; } catch { return 'Europe/Warsaw'; } };
  const guess = () => { const l = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase(); return l.startsWith('zh') ? 'zh' : l.startsWith('ar') ? 'ar' : 'en'; };
  const S = { ui: LANGS.includes(q.get('lang')) ? q.get('lang') : LANGS.includes(store.get('2ace-book-ui')) ? store.get('2ace-book-ui') : guess(), uiChosen: false,
    tz: detectTz(), langs: [], lang: null, minutes: 30, slots: [], day: null, start: null, token: q.get('t') || '', booking: null, mode: 'book', busy: false, err: '', loading: true, form: { name: '', email: '', phone: '', company: '', topic: '' }, done: null, note: '' };
  const t = () => I18N[S.ui];
  const loc = () => LOCALE[S.ui];

  // ---- formatting in the chosen time zone and language ----
  const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: S.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const dayLabel = (iso) => new Intl.DateTimeFormat(loc(), { timeZone: S.tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
  const timeLabel = (iso) => new Intl.DateTimeFormat(loc(), { timeZone: S.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const fullLabel = (iso, mins) => { const rtl = document.documentElement.dir === 'rtl', range = timeLabel(iso) + ' – ' + timeLabel(new Date(Date.parse(iso) + mins * 60000).toISOString()) + ' (' + S.tz + ')';
    return new Intl.DateTimeFormat(loc(), { timeZone: S.tz, dateStyle: 'full' }).format(new Date(iso)) + (rtl ? '، ' : ', ') + (rtl ? '\u2066' + range + '\u2069' : range); };   // the times keep their left to right order inside Arabic text
  const days = () => { const m = new Map(); for (const s of S.slots) { const k = dayKey(s); if (!m.has(k)) m.set(k, []); m.get(k).push(s); } return m; };

  const applyLang = () => {
    document.documentElement.lang = S.ui; document.documentElement.dir = S.ui === 'ar' ? 'rtl' : 'ltr'; document.title = t().pageTitle;
  };
  const setUi = (l) => { S.ui = l; S.uiChosen = true; store.set('2ace-book-ui', l); render(); };
  const say = (msg) => { S.err = msg; render(); };
  const errText = (e) => (e && e.status === 409 ? t().taken : e && e.message && !/^(error|Failed|NetworkError|Load failed)/i.test(e.message) && e.status && e.status < 500 ? e.message : t().error);

  // ---- calendar links (the emails carry the same) ----
  const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const googleUrl = (b) => 'https://calendar.google.com/calendar/render?' + new URLSearchParams({ action: 'TEMPLATE', text: I18N[b.ui_lang || S.ui].pageTitle.split(' | ')[0], dates: stamp(b.starts_at) + '/' + stamp(b.ends_at), details: (b.meeting_link ? b.meeting_link + '\n' : '') + b.ref + '\n' + location.origin + '/book?t=' + S.token }).toString();
  const icsHref = (b) => 'data:text/calendar;charset=utf-8,' + encodeURIComponent(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//2ACE//Booking//EN', 'BEGIN:VEVENT', 'UID:' + b.ref + '@2ace.pl', 'DTSTAMP:' + stamp(new Date().toISOString()), 'DTSTART:' + stamp(b.starts_at), 'DTEND:' + stamp(b.ends_at),
    'SUMMARY:' + I18N[b.ui_lang || S.ui].pageTitle.split(' | ')[0], ...(b.meeting_link ? ['LOCATION:' + b.meeting_link, 'URL:' + b.meeting_link] : []), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n');

  // ---- loading ----
  async function loadSlots() {
    S.slots = []; S.day = null; S.start = null;
    if (!S.lang) return;
    try { const r = await api('slots', { lang: S.lang }); S.slots = r.slots; S.minutes = r.minutes; const first = [...days().keys()][0]; S.day = first || null; } catch (e) { S.err = errText(e); }
    render();
  }
  async function init() {
    try {
      if (S.token) {
        S.mode = 'manage';
        try {
          const r = await api('get', { token: S.token }); S.booking = r.booking; S.canChange = r.can_change; S.minutes = r.minutes;
          if (!q.get('lang') && !store.get('2ace-book-ui')) S.ui = r.booking.ui_lang;
        } catch (e) { S.notFound = true; }
      } else {
        const c = await api('config'); S.langs = c.languages.map((x) => x.lang);
        const want = q.get('meeting');
        S.lang = S.langs.includes(want) ? want : S.langs.length === 1 ? S.langs[0] : S.langs.includes(S.ui) ? S.ui : null;
        if (S.lang) { S.loading = false; render(); await loadSlots(); return; }
      }
    } catch { S.err = t().error; }
    S.loading = false; render();
  }

  // ---- actions ----
  async function submit() {
    const f = S.form;
    if (!S.start) return say(t().errTime);
    if (f.name.trim().length < 2) return say(t().errName);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) return say(t().errEmail);
    S.busy = true; S.err = ''; render();
    try {
      const r = await api('book', { lang: S.lang, ui_lang: S.ui, start: S.start, name: f.name, email: f.email, phone: f.phone, company: f.company, topic: f.topic, tz: S.tz, website: S.hp || '' });
      S.token = r.token; S.done = { ...r.booking, email: f.email.trim(), emailed: r.emailed, ui_lang: S.ui }; S.mode = 'done'; S.busy = false; render(); scrollTo(0, 0);
    } catch (e) { S.busy = false; if (e.status === 409) await loadSlots(); S.err = errText(e); render(); }
  }
  async function move() {
    if (!S.start) return say(t().errTime);
    S.busy = true; S.err = ''; render();
    try { const r = await api('reschedule', { token: S.token, start: S.start }); S.booking = r.booking; S.mode = 'manage'; S.note = t().moved; S.busy = false; S.canChange = true; render(); scrollTo(0, 0); }
    catch (e) { S.busy = false; if (e.status === 409) await loadSlots(); S.err = errText(e); render(); }
  }
  async function cancel(reason) {
    S.busy = true; render();
    try { await api('cancel', { token: S.token, reason }); S.booking = { ...S.booking, status: 'cancelled' }; S.note = t().cancelledDone; S.askCancel = false; S.busy = false; render(); }
    catch (e) { S.busy = false; S.askCancel = false; S.err = errText(e); render(); }
  }

  // ---- pieces ----
  const header = () => el('header', { class: 'top' }, el('a', { class: 'mark', href: '/' }, '2ACE'),
    el('nav', { 'aria-label': t().language }, LANGS.map((l) => el('button', { type: 'button', class: 'lang' + (S.ui === l ? ' on' : ''), lang: l, 'aria-pressed': S.ui === l ? 'true' : 'false', onclick: () => setUi(l), text: NATIVE[l] }))));
  const tzPicker = () => {
    let zones = [S.tz]; try { if (Intl.supportedValuesOf) zones = Intl.supportedValuesOf('timeZone'); } catch { /* old browser */ }
    if (!zones.includes(S.tz)) zones = [S.tz, ...zones];
    return el('p', { class: 'tzline' }, t().tz + ': ', el('select', { 'aria-label': t().tz, onchange: (e) => { S.tz = e.target.value; S.day = [...days().keys()][0] || null; if (S.start) S.start = null; render(); } }, zones.map((z) => el('option', { value: z, text: z, selected: z === S.tz }))));
  };
  const langStep = () => el('section', { class: 'step' }, el('h2', { text: t().stepLang }),
    el('div', { class: 'cards', role: 'radiogroup', 'aria-label': t().stepLang }, S.langs.map((l) => el('button', { type: 'button', class: 'pick' + (S.lang === l ? ' on' : ''), role: 'radio', 'aria-checked': S.lang === l ? 'true' : 'false', 'data-lang': l, onclick: async () => { S.lang = l; S.err = ''; render(); await loadSlots(); } },
      el('b', { lang: l, text: NATIVE[l] }), el('span', { text: I18N[S.ui].meetIn(NATIVE[l]) })))));
  const timeStep = () => {
    const d = days(); const keys = [...d.keys()];
    return el('section', { class: 'step' }, el('h2', { text: t().stepTime }), S.lang && el('p', { class: 'muted', text: t().minutes(S.minutes) }), tzPicker(),
      keys.length ? [
        el('div', { class: 'days', role: 'group', 'aria-label': t().pickDay }, keys.slice(0, 40).map((k) => el('button', { type: 'button', class: 'day' + (S.day === k ? ' on' : ''), 'data-day': k, onclick: () => { S.day = k; S.start = null; render(); }, text: dayLabel(d.get(k)[0]) }))),
        el('div', { class: 'times', role: 'group', 'aria-label': t().pickTime }, (d.get(S.day) || []).map((s) => el('button', { type: 'button', class: 'time' + (S.start === s ? ' on' : ''), 'data-start': s, onclick: () => { S.start = s; S.err = ''; render(); }, text: timeLabel(s) }))),
      ] : el('p', { class: 'note', text: S.loading || S.slotsLoading ? t().loading : t().noSlots }));
  };
  const input = (key, label, type = 'text', extra = {}) => el('label', {}, label, el('input', { type, value: S.form[key], maxlength: key === 'email' ? '200' : '200', autocomplete: { name: 'name', email: 'email', phone: 'tel', company: 'organization' }[key] || 'off', oninput: (e) => { S.form[key] = e.target.value; }, ...extra }));
  const youStep = () => el('section', { class: 'step' }, el('h2', { text: t().stepYou }),
    S.start && el('p', { class: 'sel' }, el('span', { class: 'muted', text: t().selected + ': ' }), el('b', { text: fullLabel(S.start, S.minutes) })),
    el('div', { class: 'grid2' }, input('name', t().name), input('email', t().email, 'email', { inputmode: 'email' })),
    el('div', { class: 'grid2' }, input('phone', t().phone, 'tel'), input('company', t().company)),
    el('label', {}, t().topic, el('textarea', { rows: '3', maxlength: '2000', placeholder: t().topicPh, oninput: (e) => { S.form.topic = e.target.value; } }, S.form.topic)),
    el('div', { class: 'hp', 'aria-hidden': 'true' }, el('label', {}, 'Website', el('input', { type: 'text', tabindex: '-1', autocomplete: 'off', oninput: (e) => { S.hp = e.target.value; } }))),
    el('p', { class: 'muted small' }, t().privacy + ' ', el('a', { href: '/privacy', text: t().privacyLink })),
    el('button', { type: 'button', class: 'btn', id: 'submit', disabled: S.busy || !S.start, onclick: submit, text: S.busy ? t().working : t().submit }));

  const book = () => el('main', {}, el('h1', { text: t().h1 }), el('p', { class: 'lead', text: t().lead }), el('p', { class: 'badge', text: t().noAccount }),
    S.loading ? el('p', { class: 'muted', text: t().loading }) : !S.langs.length ? el('p', { class: 'note', text: t().closed }) : [S.langs.length > 1 && langStep(), S.lang && timeStep(), S.lang && S.start && youStep()],
    S.err && el('p', { class: 'err', role: 'alert', text: S.err }));

  const summary = (b, mins) => el('div', { class: 'card' }, el('dl', {}, el('dt', { text: t().selected }), el('dd', { text: fullLabel(b.starts_at, mins || S.minutes) }),
    el('dt', { text: t().stepLang.replace(/^\d\.\s*/, '') }), el('dd', { lang: b.lang, text: NATIVE[b.lang] }), el('dt', { text: t().ref }), el('dd', { text: b.ref }),
    el('dt', { text: t().link }), el('dd', {}, b.meeting_link ? el('a', { href: b.meeting_link, rel: 'noopener', text: t().join }) : t().noLink)));
  const done = () => { const b = S.done; return el('main', {}, el('h1', { text: t().doneTitle }), el('p', { class: 'lead', text: t().doneText(fullLabel(b.starts_at, S.minutes)) }), summary(b),
    el('p', { class: b.emailed ? 'muted' : 'note', text: b.emailed ? t().emailed(b.email) : t().notEmailed }),
    el('div', { class: 'actions' }, el('a', { class: 'btn', href: googleUrl(b), target: '_blank', rel: 'noopener', text: t().addGoogle }), el('a', { class: 'btn ghost', href: icsHref(b), download: '2ace-call.ics', text: t().ics }),
      el('a', { class: 'btn ghost', href: '/book?t=' + S.token, text: t().manage }))); };
  const manage = () => {
    const b = S.booking;
    if (S.notFound || !b) return el('main', {}, el('h1', { text: t().mTitle }), el('p', { class: 'note', text: t().mNotFound }), el('a', { class: 'btn', href: '/book', text: t().bookAgain }));
    const cancelled = b.status === 'cancelled', started = Date.parse(b.starts_at) <= Date.now();
    if (S.mode === 'moving') return el('main', {}, el('h1', { text: t().reschedule }), timeStep(), S.err && el('p', { class: 'err', role: 'alert', text: S.err }),
      el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn', id: 'move', disabled: S.busy || !S.start, onclick: move, text: S.busy ? t().working : t().move }), el('button', { type: 'button', class: 'btn ghost', onclick: () => { S.mode = 'manage'; S.err = ''; render(); }, text: t().back })));
    return el('main', {}, el('h1', { text: t().mTitle }), S.note && el('p', { class: 'ok', role: 'status', text: S.note }), summary(b, S.minutes),
      cancelled ? [el('p', { class: 'note', text: t().mCancelled }), el('a', { class: 'btn', href: '/book', text: t().bookAgain })]
        : (!S.canChange || started) ? el('p', { class: 'note', text: t().mPast })
        : S.askCancel ? el('div', { class: 'card' }, el('b', { text: t().cancelAsk }), el('label', {}, t().cancelWhy, el('textarea', { id: 'why', rows: '2', maxlength: '500' })),
            el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn danger', id: 'cancel-yes', disabled: S.busy, onclick: () => cancel(document.getElementById('why').value), text: t().cancelYes }), el('button', { type: 'button', class: 'btn ghost', onclick: () => { S.askCancel = false; render(); }, text: t().keep })))
        : el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn', id: 'resched', onclick: async () => { S.mode = 'moving'; S.lang = b.lang; S.start = null; S.err = ''; S.note = ''; render(); await loadSlots(); }, text: t().reschedule }),
            el('button', { type: 'button', class: 'btn ghost', id: 'cancel', onclick: () => { S.askCancel = true; S.note = ''; render(); }, text: t().cancel })),
      S.err && el('p', { class: 'err', role: 'alert', text: S.err }));
  };

  function render() {
    applyLang();
    const body = S.mode === 'done' ? done() : S.mode === 'book' ? book() : manage();
    while (root.firstChild) root.removeChild(root.firstChild);
    root.append(header(), body);
  }
  render(); await init();
  return { state: S };
}

if (typeof document !== 'undefined' && document.getElementById('book-app') && !globalThis.__BOOK_NO_AUTOSTART) start(document.getElementById('book-app'));

import { el, clear, table, pill, modal, toast, kv, fmtDate, field, askReason } from './ui.js';
import { guarded } from './wms.js';

// Appointments: calls booked on 2ace.pl/book by customers and guests. Staff add the meeting link and send it, cancel, and close meetings.
// Admins also set the opening hours, time zone and notified emails for each meeting language. Reads happen here under RLS; every change goes through admin-api.
const LANGS = [['en', 'English'], ['zh', 'Chinese'], ['ar', 'Arabic']];
const DAYS = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [7, 'Sunday']];
const COLS = 'id, ref, lang, ui_lang, starts_at, ends_at, status, name, email, phone, company, topic, customer_tz, meeting_link, link_sent_at, confirmation_sent_at, reminder_24h_sent_at, reminder_1h_sent_at, reschedule_count, cancelled_at, cancelled_by, cancel_reason, staff_notes, created_at';
const KIND = { confirmed: 'ok', cancelled: 'muted', completed: 'muted', no_show: 'bad' };
const inZone = (iso, tz) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso)) + ' (' + tz + ')'; } catch { return fmtDate(iso); } };

// "10:00-14:00, 15:00-18:00" <-> [{from,to}]
export const parseDay = (txt) => String(txt || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const m = /^(\d{1,2}:\d{2})\s*[-–to]+\s*(\d{1,2}:\d{2})$/.exec(x); if (!m) throw new Error(`"${x}" is not a time range. Write it like 10:00-14:00`); return { from: m[1], to: m[2] }; });
export const dayText = (windows, dow) => (windows || []).filter((w) => w.dow === dow).map((w) => w.from + '-' + w.to).join(', ');

export async function render(ctx, root) {
  clear(root).append(el('h1', { text: 'Appointments' }), el('p', { class: 'muted', text: 'Loading…' }));
  const [ap, st, run] = await Promise.all([
    ctx.sb.from('appointments').select(COLS).order('starts_at', { ascending: true }).limit(500),
    ctx.sb.from('booking_settings').select('*'),
    ctx.sb.from('booking_runs').select('ran_at, sent').eq('key', 'reminders').maybeSingle(),
  ]);
  if (ap.error) return clear(root).append(el('h1', { text: 'Appointments' }), el('p', { class: 'err', text: ap.error.message }));
  const all = ap.data || [], settings = st.data || [];
  const isAdmin = ctx.me.role === 'admin';
  let tab = 'upcoming';
  const holder = el('div'), tabs = el('div', { class: 'row' });

  const link = (a) => a.meeting_link ? pill(a.link_sent_at ? 'link sent' : 'link set', a.link_sent_at ? 'ok' : 'warn') : pill('no link', 'bad');
  const show = () => {
    const now = Date.now();
    const rows = all.filter((a) => tab === 'upcoming' ? a.status === 'confirmed' && Date.parse(a.ends_at) >= now : tab === 'past' ? (a.status === 'confirmed' && Date.parse(a.ends_at) < now) || ['completed', 'no_show'].includes(a.status) : a.status === 'cancelled');
    rows.sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at)); if (tab !== 'upcoming') rows.reverse();
    clear(tabs).append(...[['upcoming', 'Upcoming'], ['past', 'Past'], ['cancelled', 'Cancelled']].map(([k, l]) => el('button', { class: 'btn tiny ' + (tab === k ? '' : 'ghost'), text: l + ' (' + all.filter((a) => (k === 'upcoming' ? a.status === 'confirmed' && Date.parse(a.ends_at) >= now : k === 'past' ? (a.status === 'confirmed' && Date.parse(a.ends_at) < now) || ['completed', 'no_show'].includes(a.status) : a.status === 'cancelled')).length + ')', onclick: () => { tab = k; show(); } })));
    clear(holder).append(table([
      { label: 'When', render: (a) => el('strong', { text: fmtDate(a.starts_at) }) }, { label: 'Who', render: (a) => [a.name, el('div', { class: 'muted', text: a.company ? a.company + ' · ' + a.email : a.email })] },
      { label: 'Language', render: (a) => (LANGS.find(([l]) => l === a.lang) || [])[1] || a.lang }, { label: 'Meeting link', render: (a) => (a.status === 'confirmed' ? link(a) : '-') },
      { label: 'Status', render: (a) => pill(a.status === 'confirmed' && Date.parse(a.ends_at) < now ? 'needs closing' : a.status.replace('_', ' '), a.status === 'confirmed' && Date.parse(a.ends_at) < now ? 'warn' : KIND[a.status] || '') }, { label: 'Ref', key: 'ref' },
    ], rows, (a) => detail(a)));
    if (!rows.length) holder.append(el('p', { class: 'muted', text: tab === 'upcoming' ? 'No upcoming calls. Bookings made on 2ace.pl/book appear here.' : 'Nothing here.' }));
  };

  const detail = (a) => modal(a.ref + ' · ' + a.name, (body, done) => {
    const err = el('p', { class: 'err' }), lk = el('input', { type: 'url', placeholder: 'https://meet.google.com/…', value: a.meeting_link || '', 'aria-label': 'Meeting link' });
    const notes = el('textarea', { rows: '3', 'aria-label': 'Internal notes', placeholder: 'Only staff see this', value: a.staff_notes || '' });
    const open = a.status === 'confirmed';
    const act = (btn, name, payload, msg) => guarded(btn, err, async () => { const r = await ctx.api(name, payload); toast(typeof msg === 'function' ? msg(r) : msg); done(true); });
    const save = el('button', { class: 'btn tiny ghost', text: 'Save link', onclick: () => act(save, 'appt.setLink', { id: a.id, link: lk.value }, 'Link saved') });
    const send = el('button', { class: 'btn tiny', text: a.link_sent_at ? 'Save and email the link again' : 'Save and email the link', onclick: () => act(send, 'appt.setLink', { id: a.id, link: lk.value, send: true }, 'Link saved and emailed to ' + a.email) });
    const cancel = el('button', { class: 'btn tiny ghost', text: 'Cancel this booking', onclick: async () => { const why = await askReason('Cancel ' + a.ref + '? The customer is emailed.'); if (why !== null) act(cancel, 'appt.cancel', { id: a.id, reason: why }, 'Cancelled and the customer was told'); } });
    const resend = el('button', { class: 'btn tiny ghost', text: 'Resend confirmation', onclick: () => act(resend, 'appt.resend', { id: a.id }, 'Confirmation sent') });
    const started = Date.parse(a.starts_at) <= Date.now();
    const closeBtns = open && started ? [el('button', { class: 'btn tiny', text: 'Mark as held', onclick: (e) => act(e.target, 'appt.status', { id: a.id, status: 'completed' }, 'Marked as held') }), el('button', { class: 'btn tiny ghost', text: 'No show', onclick: (e) => act(e.target, 'appt.status', { id: a.id, status: 'no_show' }, 'Marked as no show') })] : null;
    const saveNotes = el('button', { class: 'btn tiny ghost', text: 'Save notes', onclick: () => act(saveNotes, 'appt.notes', { id: a.id, notes: notes.value }, 'Notes saved') });
    const L = (LANGS.find(([l]) => l === a.lang) || [])[1] || a.lang;
    body.append(kv([['Status', pill(a.status.replace('_', ' '), KIND[a.status] || '')], ['When (your time)', fmtDate(a.starts_at) + ' – ' + new Date(a.ends_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })], ['When (their time)', inZone(a.starts_at, a.customer_tz)],
      ['Meeting language', L + ' (emails in ' + ((LANGS.find(([l]) => l === a.ui_lang) || [])[1] || a.ui_lang) + ')'], ['Name', a.name], ['Email', el('a', { href: 'mailto:' + a.email, text: a.email })], ['Phone', a.phone], ['Company', a.company], ['Topic', a.topic],
      ['Emails sent', [a.confirmation_sent_at && 'confirmation', a.link_sent_at && 'link', a.reminder_24h_sent_at && '24 h reminder', a.reminder_1h_sent_at && '1 h reminder'].filter(Boolean).join(', ') || 'none yet'], a.reschedule_count ? ['Moved', a.reschedule_count + ' time(s)'] : null,
      a.status === 'cancelled' ? ['Cancelled', (a.cancelled_by === 'staff' ? 'by us' : 'by the customer') + (a.cancel_reason ? ': ' + a.cancel_reason : '')] : null]));
    if (open) body.append(field('Meeting link (Google Meet, Zoom, Teams…)', lk), el('div', { class: 'row' }, save, send), el('p', { class: 'muted small', text: 'The customer gets this link in their language, in the confirmation (if set before) and in the two reminders.' }));
    body.append(field('Internal notes', notes), el('div', { class: 'row' }, saveNotes), err, el('div', { class: 'row end' }, closeBtns, open && resend, open && cancel));
  }).then((changed) => { if (changed) render(ctx, root); });

  // ---- settings (admin) ----
  const settingsCard = () => {
    const wrap = el('section', { class: 'card' }, el('h2', { text: 'Booking settings' }), el('p', { class: 'muted', text: 'One block per meeting language: when that person can be booked (in their own time zone), who is emailed, and an optional default meeting link. A language stays closed until you switch it on.' }));
    for (const [lang, name] of LANGS) {
      const s = settings.find((x) => x.lang === lang) || { lang, enabled: false, tz: 'Europe/Warsaw', host_emails: [], windows: [], slot_minutes: 30, buffer_minutes: 0, notice_hours: 12, horizon_days: 30, default_link: '' };
      const err = el('p', { class: 'err' });
      const en = el('input', { type: 'checkbox', checked: s.enabled ? 'checked' : null }); en.checked = !!s.enabled;
      const f = { tz: el('input', { value: s.tz }), emails: el('input', { value: (s.host_emails || []).join(', '), placeholder: 'who takes the calls, comma separated' }), slot: el('input', { type: 'number', min: '15', max: '120', value: String(s.slot_minutes) }), buf: el('input', { type: 'number', min: '0', max: '120', value: String(s.buffer_minutes) }),
        notice: el('input', { type: 'number', min: '0', max: '720', value: String(s.notice_hours) }), horizon: el('input', { type: 'number', min: '1', max: '120', value: String(s.horizon_days) }), link: el('input', { type: 'url', value: s.default_link || '', placeholder: 'optional, https://…' }) };
      const days = DAYS.map(([d, n]) => [d, n, el('input', { value: dayText(s.windows, d), placeholder: 'closed', 'aria-label': n })]);
      const save = el('button', { class: 'btn tiny', text: 'Save ' + name, onclick: () => guarded(save, err, async () => {
        const windows = days.flatMap(([d, n, inp]) => { try { return parseDay(inp.value).map((w) => ({ dow: d, ...w })); } catch (e) { throw new Error(n + ': ' + e.message); } });
        await ctx.api('booking.saveSettings', { lang, enabled: en.checked, tz: f.tz.value.trim(), host_emails: f.emails.value.split(',').map((x) => x.trim()).filter(Boolean), windows, slot_minutes: Number(f.slot.value), buffer_minutes: Number(f.buf.value), notice_hours: Number(f.notice.value), horizon_days: Number(f.horizon.value), default_link: f.link.value.trim() });
        toast(name + ' saved'); render(ctx, root);
      }) });
      wrap.append(el('details', { open: s.enabled ? 'open' : null }, el('summary', {}, el('strong', { text: name }), ' ', pill(s.enabled ? 'open for booking' : 'closed', s.enabled ? 'ok' : 'muted')),
        el('label', { class: 'check' }, en, ' Open for booking'),
        el('div', { class: 'row' }, field('Time zone', f.tz), field('Emailed when someone books', f.emails)),
        el('div', { class: 'row' }, field('Call length (minutes)', f.slot), field('Break between calls (minutes)', f.buf), field('Minimum notice (hours)', f.notice), field('How far ahead (days)', f.horizon)),
        field('Default meeting link', f.link),
        el('p', { class: 'muted small', text: 'Opening times in the time zone above. Write one or more ranges like 10:00-14:00, 15:00-18:00. Leave a day empty for closed.' }),
        el('div', { class: 'row' }, days.map(([, n, inp]) => field(n, inp))), err, el('div', { class: 'row' }, save)));
    }
    return wrap;
  };

  const ran = run.data ? Date.parse(run.data.ran_at) : 0, mins = ran ? Math.round((Date.now() - ran) / 60000) : null;
  const healthy = mins !== null && mins <= 30;
  clear(root).append(...[el('div', { class: 'row between' }, el('h1', { text: 'Appointments' }), el('a', { class: 'btn ghost tiny', href: '/book', target: '_blank', rel: 'noopener', text: 'Open the booking page ↗' })),
    el('p', { class: 'muted', text: 'Calls booked on 2ace.pl/book by customers and guests. Each booking emails the customer in their language and tells the people taking the call. Reminders go out 24 hours and 1 hour before.' }),
    el('div', { class: 'rule' }, el('b', { text: healthy ? 'Reminders are running' : 'Reminders are not running' }), ' ', pill(healthy ? 'ok' : 'check', healthy ? 'ok' : 'bad'),
      el('p', { class: 'muted', text: ran ? `The reminder job last ran ${mins} minute${mins === 1 ? '' : 's'} ago.` : 'The reminder job has not run yet.' + (all.length ? '' : ' It starts after the database update; see the owner guide.') })),
    settings.some((s) => s.enabled) ? null : el('p', { class: 'note', text: 'No meeting language is open yet, so the booking page shows "not open yet". ' + (isAdmin ? 'Open one under Booking settings below.' : 'An admin opens one under Booking settings.') }),
    tabs, holder, isAdmin ? settingsCard() : null].filter(Boolean));
  show();
}

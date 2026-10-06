import { ROOT } from '../lib/root.mjs';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>', { url: 'https://2ace.pl/admin' });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !x ? '' : '  -> ' + x)); };
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms)); const text = () => document.body.textContent.replace(/\s+/g, ' ');
const { render, parseDay, dayText } = await import('file://' + ROOT + '/assets/admin/appointments.js');
const H = (h) => new Date(Date.now() + h * 3600000).toISOString();
const A = (o) => ({ id: 'a' + Math.random().toString(16).slice(2, 8), ref: 'APT-000001', lang: 'zh', ui_lang: 'zh', starts_at: H(30), ends_at: H(30.5), status: 'confirmed', name: 'Li Wei', email: 'li@example.com', phone: '+86 1', company: 'Acme', topic: 'Storage', customer_tz: 'Asia/Shanghai', meeting_link: null, link_sent_at: null, confirmation_sent_at: H(-1), reminder_24h_sent_at: null, reminder_1h_sent_at: null, reschedule_count: 0, cancelled_at: null, cancelled_by: null, cancel_reason: null, staff_notes: null, created_at: H(-2), ...o });
let DB, calls = [];
const mkSb = () => ({ from: (t) => { const f = []; const q = new Proxy({}, { get(_, k) { if (k === 'then') return (res) => res({ data: DB[t], error: null }); if (k === 'maybeSingle') return () => Promise.resolve({ data: Array.isArray(DB[t]) ? DB[t][0] ?? null : DB[t], error: null }); return () => q; } }); return q; } });
const ctx = (role = 'admin') => ({ sb: mkSb(), me: { role }, api: async (a, p) => { calls.push([a, p]); return { ok: true }; } });
const openRow = async (ref) => { await tick(80); [...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes(ref)).click(); await tick(); return document.querySelector('.modal'); };
const root = () => document.getElementById('root');
const click = async (label, scope = document) => { const b = [...scope.querySelectorAll('button')].find((x) => x.textContent.includes(label)); b.click(); await tick(60); };

ok('parseDay reads ranges and refuses nonsense', JSON.stringify(parseDay('10:00-14:00, 15:00–18:00')) === '[{"from":"10:00","to":"14:00"},{"from":"15:00","to":"18:00"}]' && parseDay('').length === 0 && (() => { try { parseDay('ten'); return false; } catch (e) { return /not a time range/.test(e.message); } })());
ok('dayText writes them back', dayText([{ dow: 1, from: '10:00', to: '14:00' }, { dow: 1, from: '15:00', to: '18:00' }, { dow: 2, from: '09:00', to: '10:00' }], 1) === '10:00-14:00, 15:00-18:00');

DB = { appointments: [A({ ref: 'APT-000001' }), A({ ref: 'APT-000002', lang: 'en', ui_lang: 'en', name: 'Anna Nowak', starts_at: H(5), ends_at: H(5.5), meeting_link: 'https://meet.example.com/x', link_sent_at: H(-1) }), A({ ref: 'APT-000003', status: 'cancelled', cancelled_by: 'customer', cancel_reason: 'Plans changed' }), A({ ref: 'APT-000004', starts_at: H(-5), ends_at: H(-4.5) })],
  booking_settings: [{ lang: 'en', enabled: true, tz: 'Europe/Warsaw', host_emails: ['me@2ace.pl'], windows: [{ dow: 1, from: '10:00', to: '14:00' }, { dow: 3, from: '10:00', to: '12:00' }], slot_minutes: 30, buffer_minutes: 0, notice_hours: 12, horizon_days: 30, default_link: null }, { lang: 'zh', enabled: false, tz: 'Asia/Shanghai', host_emails: [], windows: [], slot_minutes: 30, buffer_minutes: 0, notice_hours: 12, horizon_days: 30, default_link: null }],
  booking_runs: { ran_at: H(-0.1), sent: 1 } };
await render(ctx(), root()); await tick();
ok('upcoming calls are listed soonest first, with who, language and link state', /APT-000002/.test(text()) && /APT-000001/.test(text()) && !/APT-000003/.test(text()) && !/APT-000004/.test(text()) && text().indexOf('APT-000002') < text().indexOf('APT-000001'));
ok('the tabs count what is in them', /Upcoming \(2\)/.test(text()) && /Past \(1\)/.test(text()) && /Cancelled \(1\)/.test(text()));
ok('a call without a link is flagged, one with a sent link is not', [...document.querySelectorAll('tbody tr')].find((r) => /APT-000001/.test(r.textContent)).textContent.includes('no link') && [...document.querySelectorAll('tbody tr')].find((r) => /APT-000002/.test(r.textContent)).textContent.includes('link sent'));
ok('reminders are reported as running when the job ran recently', /Reminders are running/.test(text()));
await click('Past'); ok('a meeting that is over but not closed is flagged for closing', /APT-000004/.test(text()) && /needs closing/.test(text()));
await click('Cancelled'); ok('cancelled bookings are in their own tab', /APT-000003/.test(text()));
await click('Upcoming');

// ---- detail: set and send the link ----
[...document.querySelectorAll('tbody tr')].find((r) => /APT-000001/.test(r.textContent)).click(); await tick();
ok('the detail shows both time zones, the language, the contact and what was emailed', /Asia\/Shanghai/.test(text()) && /Chinese/.test(text()) && /li@example\.com/.test(text()) && /Emails sent\s*confirmation/.test(text()));
{ const m = document.querySelector('.modal'); const i = m.querySelector('input[type=url]'); i.value = 'https://zoom.us/j/123'; calls.length = 0; await click('Save and email the link', m); }
ok('"Save and email" sends the booking, the link and send=true', calls[0]?.[0] === 'appt.setLink' && calls[0][1].link === 'https://zoom.us/j/123' && calls[0][1].send === true && /^[a-z0-9]+$/.test(calls[0][1].id), JSON.stringify(calls));
await tick(80);
[...document.querySelectorAll('tbody tr')].find((r) => /APT-000001/.test(r.textContent)).click(); await tick();
{ const m = document.querySelector('.modal'); m.querySelector('input[type=url]').value = 'https://zoom.us/j/9'; calls.length = 0; await click('Save link', m); }
ok('"Save link" saves without emailing', calls[0]?.[0] === 'appt.setLink' && calls[0][1].send === undefined);
{ const m = await openRow('APT-000001'); calls.length = 0; await click('Resend confirmation', m); } ok('the confirmation can be resent', calls[0]?.[0] === 'appt.resend');
{ const m = await openRow('APT-000001'); calls.length = 0; await click('Cancel this booking', m); const ov = document.querySelectorAll('.modal'); const top = ov[ov.length - 1]; top.querySelector('textarea').value = 'Host is ill'; await click('Continue', top); }
ok('cancelling asks for a reason and then cancels with it', calls.some(([a, p]) => a === 'appt.cancel' && p.reason === 'Host is ill'), JSON.stringify(calls));
await tick(100);
// ---- a started meeting can be closed ----
await click('Past'); [...document.querySelectorAll('tbody tr')].find((r) => /APT-000004/.test(r.textContent)).click(); await tick();
{ const m = document.querySelector('.modal'); calls.length = 0; await click('Mark as held', m); } ok('a meeting that has started can be marked as held', calls[0]?.[0] === 'appt.status' && calls[0][1].status === 'completed');
await tick(80);

// ---- settings: admin only ----
await render(ctx(), root()); await tick();
ok('admin sees the settings of each meeting language, English open and Chinese closed', /Booking settings/.test(text()) && /open for booking/.test(text()) && /closed/.test(text()));
{ const d = [...document.querySelectorAll('details')].find((x) => /Chinese/.test(x.textContent)); const ins = [...d.querySelectorAll('input')];
  const byLabel = (l) => [...d.querySelectorAll('label.field')].find((x) => x.textContent.startsWith(l)).querySelector('input');
  d.querySelector('input[type=checkbox]').checked = true; byLabel('Emailed when someone books').value = 'li@2ace.pl, boss@2ace.pl'; byLabel('Monday').value = '10:00-12:00, 14:00-16:00'; byLabel('Wednesday').value = 'ten';
  calls.length = 0; await click('Save Chinese', d); ok('a bad opening time is refused on the page, naming the day, and nothing is sent', /Wednesday: "ten" is not a time range/.test(d.textContent) && calls.length === 0, d.textContent.slice(-200));
  byLabel('Wednesday').value = ''; await click('Save Chinese', d); const c = calls[0];
  ok('saving sends the language, switch, zone, emails, the windows and the numbers', c?.[0] === 'booking.saveSettings' && c[1].lang === 'zh' && c[1].enabled === true && c[1].tz === 'Asia/Shanghai' && JSON.stringify(c[1].host_emails) === '["li@2ace.pl","boss@2ace.pl"]' && JSON.stringify(c[1].windows) === '[{"dow":1,"from":"10:00","to":"12:00"},{"dow":1,"from":"14:00","to":"16:00"}]' && c[1].slot_minutes === 30 && c[1].horizon_days === 30, JSON.stringify(c)); }
await render(ctx('support'), root()); await tick();
ok('support sees the bookings but not the settings', /APT-000001/.test(text()) && !/Booking settings/.test(text()));
DB.booking_runs = null; DB.booking_settings = []; await render(ctx(), root()); await tick();
ok('with no reminder run and no open language the page says so plainly', /Reminders are not running/.test(text()) && /has not run yet/.test(text()) && /No meeting language is open yet/.test(text()));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

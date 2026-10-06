// deno test supabase/functions/_shared/bookingMail.test.ts
import { customerEmail, hostEmail, googleCalUrl, icsFile, manageUrl, whenText, toBase64, type Appt } from './bookingMail.ts';
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const a: Appt = { id: '11111111-2222-3333-4444-555555555555', ref: 'APT-000007', lang: 'zh', ui_lang: 'zh', starts_at: '2026-10-12T08:00:00.000Z', ends_at: '2026-10-12T08:30:00.000Z', name: 'Li Wei', email: 'li@example.com', customer_tz: 'Asia/Shanghai', meeting_link: null, manage_token: 'tok123', phone: '+86 138', company: 'Acme', topic: 'Storage in Poland' };

Deno.test('times are shown in the reader\'s time zone and language', () => {
  ok(/16:00 – 16:30 \(Asia\/Shanghai\)/.test(whenText(a, 'Asia/Shanghai', 'en')), 'Shanghai sees 16:00');
  ok(/10:00 – 10:30 \(Europe\/Warsaw\)/.test(whenText(a, 'Europe/Warsaw', 'en')), 'Warsaw sees 10:00');
  ok(/2026/.test(whenText(a, 'Asia/Shanghai', 'zh')) && /年/.test(whenText(a, 'Asia/Shanghai', 'zh')), 'Chinese date');
  ok(/2026/.test(whenText(a, 'Africa/Cairo', 'ar')) && /[؀-ۿ]/.test(whenText(a, 'Africa/Cairo', 'ar')) && /11:00 – 11:30/.test(whenText(a, 'Africa/Cairo', 'ar')), 'Arabic date with Latin digits, Cairo is UTC+3 in October');
});
Deno.test('confirmation: each language has its own subject and words, Arabic is right to left, the calendar file is attached', () => {
  const zh = customerEmail('confirmed', a); ok(/预约成功/.test(zh.subject) && /会议语言/.test(zh.html) && /lang="zh"/.test(zh.html) && /dir="ltr"/.test(zh.html), 'chinese');
  const ar = customerEmail('confirmed', { ...a, lang: 'ar', ui_lang: 'ar', customer_tz: 'Africa/Cairo' }); ok(/تم تأكيد/.test(ar.subject) && /dir="rtl"/.test(ar.html) && /العربية/.test(ar.html), 'arabic');
  const en = customerEmail('confirmed', { ...a, lang: 'en', ui_lang: 'en' }); ok(/is booked/.test(en.subject) && /English/.test(en.html), 'english');
  ok(en.attachments.length === 1 && en.attachments[0].filename === 'meeting.ics' && en.attachments[0].content.length > 100, 'ics attached');
  ok(en.html.includes(manageUrl(a)) && en.html.includes('calendar.google.com'), 'manage link and Google Calendar link');
});
Deno.test('the meeting link: shown as a button when set, otherwise the mail promises to send it', () => {
  const none = customerEmail('confirmed', { ...a, ui_lang: 'en' }); ok(/email you the meeting link/.test(none.html) && !/Join the meeting/.test(none.html), 'no link yet');
  const withLink = customerEmail('confirmed', { ...a, ui_lang: 'en', meeting_link: 'https://meet.example.com/abc' }); ok(/Join the meeting/.test(withLink.html) && withLink.html.includes('https://meet.example.com/abc') && !/email you the meeting link/.test(withLink.html), 'link shown');
  const link = customerEmail('link', { ...a, ui_lang: 'en', meeting_link: 'https://meet.example.com/abc' }); ok(/Your meeting link/.test(link.subject) && link.attachments.length === 0, 'link email has no calendar file');
});
Deno.test('reminders and cancellations say what they are; the 1 hour reminder skips the manage link; a cancellation carries the reason', () => {
  const r24 = customerEmail('reminder24', { ...a, ui_lang: 'en' }); ok(/in 24 hours/.test(r24.subject) && r24.html.includes(manageUrl(a)), '24h');
  const r1 = customerEmail('reminder1', { ...a, ui_lang: 'en' }); ok(/in 1 hour/.test(r1.subject) && !r1.html.includes(manageUrl(a)), '1h');
  const c = customerEmail('cancelled', { ...a, ui_lang: 'en', cancel_reason: 'Sorry, we are ill' }); ok(/cancelled/.test(c.subject) && /Sorry, we are ill/.test(c.html) && /Book a new time/.test(c.html) && c.attachments[0].filename === 'cancelled.ics', 'cancelled');
});
Deno.test('everything the visitor typed is escaped in mail', () => {
  const evil = customerEmail('confirmed', { ...a, ui_lang: 'en', name: '<script>alert(1)</script> Bob', cancel_reason: '<b>x</b>' });
  ok(!/<script>/.test(evil.html), 'name escaped');
  const h = hostEmail('new', { ...a, topic: '<img src=x onerror=1>', company: '<i>' }, 'Europe/Warsaw'); ok(!/<img/.test(h.html) && !/<i>/.test(h.html), 'host mail escaped');
});
Deno.test('host mail: both time zones, the language, who booked, and a warning when there is no link yet', () => {
  const h = hostEmail('new', a, 'Europe/Warsaw');
  ok(/New booking: Li Wei \(ZH\) APT-000007/.test(h.subject) && /10:00 – 10:30 \(Europe\/Warsaw\)/.test(h.html) && /16:00 – 16:30 \(Asia\/Shanghai\)/.test(h.html) && /li@example.com/.test(h.html) && /NOT SET YET/.test(h.html) && /admin#appointments/.test(h.html), 'host mail');
  ok(!/NOT SET YET/.test(hostEmail('new', { ...a, meeting_link: 'https://meet.example.com/x' }, 'Europe/Warsaw').html), 'link set');
});
Deno.test('calendar file: UTC times, same UID for the cancellation, valid lines, link as location', () => {
  const f = icsFile({ ...a, ui_lang: 'en', meeting_link: 'https://meet.example.com/abc' });
  ok(/BEGIN:VCALENDAR/.test(f) && /DTSTART:20261012T080000Z/.test(f) && /DTEND:20261012T083000Z/.test(f) && /UID:11111111-2222-3333-4444-555555555555@2ace.pl/.test(f) && /LOCATION:https:\/\/meet.example.com\/abc/.test(f) && /STATUS:CONFIRMED/.test(f) && /END:VCALENDAR/.test(f), 'fields');
  ok(f.split('\r\n').every((l) => l.length <= 75), 'lines are folded at 75');
  const c = icsFile({ ...a, ui_lang: 'en' }, true); ok(/METHOD:CANCEL/.test(c) && /STATUS:CANCELLED/.test(c) && /UID:11111111-2222-3333-4444-555555555555@2ace.pl/.test(c), 'cancel');
  const g = googleCalUrl({ ...a, ui_lang: 'en' }); ok(g.includes('dates=20261012T080000Z%2F20261012T083000Z') && g.startsWith('https://calendar.google.com/'), 'google link');
  ok(atob(toBase64('é中')).length > 0, 'base64 of non-ASCII works');
});

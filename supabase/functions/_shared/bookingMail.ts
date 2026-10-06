// Emails for booked calls, in English, Chinese and Arabic (Arabic is laid out right to left), plus the calendar file (.ics) and the
// "add to Google Calendar" link. Pure functions: they build the message, other code sends it (bookingOps.ts).
import { esc } from './email.ts';
import type { Lang } from './booking.ts';

export type Appt = {
  id: string; ref: string; lang: Lang; ui_lang: Lang; starts_at: string; ends_at: string; name: string; email: string; phone?: string | null; company?: string | null;
  topic?: string | null; customer_tz: string; meeting_link?: string | null; manage_token: string; cancel_reason?: string | null; status?: string;
};
export type Kind = 'confirmed' | 'rescheduled' | 'link' | 'reminder24' | 'reminder1' | 'cancelled';

export const LANG_NAME: Record<Lang, string> = { en: 'English', zh: '中文', ar: 'العربية' };
const LOCALE: Record<Lang, string> = { en: 'en-GB', zh: 'zh-CN', ar: 'ar-EG-u-nu-latn' };

const T = {
  en: {
    hello: (n: string) => `Hello ${n},`,
    title: { confirmed: 'Your call with 2ACE is booked', rescheduled: 'Your call has been moved', link: 'Your meeting link', reminder24: 'Reminder: your call with 2ACE is in 24 hours', reminder1: 'Your call with 2ACE starts in 1 hour', cancelled: 'Your booking was cancelled' },
    intro: { confirmed: 'Thank you for booking a call with 2ACE. Here are the details.', rescheduled: 'Your call has been moved to the new time below.', link: 'Here is the link for your call.', reminder24: 'This is a reminder of your call.', reminder1: 'This is a reminder of your call.', cancelled: 'The booking below was cancelled.' },
    when: 'When', lang: 'Meeting language', ref: 'Reference', link: 'Meeting link', join: 'Join the meeting', reason: 'Reason',
    noLink: 'We will email you the meeting link before the call.', addCal: 'Add to your calendar (Google)', ics: 'The attached file works with Apple, Outlook and other calendars.',
    manage: 'Need to change the time or cancel? Use this link:', again: 'Book a new time', foot: 'Questions? Just reply to this email.', summary: 'Call with 2ACE',
  },
  zh: {
    hello: (n: string) => `${n}，您好，`,
    title: { confirmed: '您与 2ACE 的通话已预约成功', rescheduled: '您的预约时间已更改', link: '您的会议链接', reminder24: '提醒：您与 2ACE 的通话将在 24 小时后开始', reminder1: '您与 2ACE 的通话将在 1 小时后开始', cancelled: '您的预约已取消' },
    intro: { confirmed: '感谢您预约与 2ACE 的通话，详情如下。', rescheduled: '您的通话已改到下面的新时间。', link: '这是您通话的会议链接。', reminder24: '这是对您通话的提醒。', reminder1: '这是对您通话的提醒。', cancelled: '以下预约已取消。' },
    when: '时间', lang: '会议语言', ref: '预约编号', link: '会议链接', join: '加入会议', reason: '原因',
    noLink: '我们会在通话前通过邮件把会议链接发给您。', addCal: '添加到日历（Google）', ics: '附件适用于 Apple、Outlook 等日历。',
    manage: '需要更改时间或取消？请使用此链接：', again: '重新预约', foot: '如有疑问，请直接回复此邮件。', summary: '与 2ACE 通话',
  },
  ar: {
    hello: (n: string) => `مرحباً ${n}،`,
    title: { confirmed: 'تم تأكيد موعدك مع 2ACE', rescheduled: 'تم تغيير موعد مكالمتك', link: 'رابط الاجتماع', reminder24: 'تذكير: موعدك مع 2ACE بعد 24 ساعة', reminder1: 'يبدأ موعدك مع 2ACE بعد ساعة واحدة', cancelled: 'تم إلغاء حجزك' },
    intro: { confirmed: 'شكراً لحجزك مكالمة مع 2ACE. هذه هي التفاصيل.', rescheduled: 'تم نقل مكالمتك إلى الموعد الجديد أدناه.', link: 'هذا هو رابط مكالمتك.', reminder24: 'هذا تذكير بموعد مكالمتك.', reminder1: 'هذا تذكير بموعد مكالمتك.', cancelled: 'تم إلغاء الحجز أدناه.' },
    when: 'الموعد', lang: 'لغة الاجتماع', ref: 'رقم الحجز', link: 'رابط الاجتماع', join: 'انضم إلى الاجتماع', reason: 'السبب',
    noLink: 'سنرسل لك رابط الاجتماع بالبريد الإلكتروني قبل الموعد.', addCal: 'أضف إلى التقويم (Google)', ics: 'الملف المرفق يعمل مع تقويم Apple وOutlook وغيرها.',
    manage: 'تريد تغيير الموعد أو إلغاءه؟ استخدم هذا الرابط:', again: 'احجز موعداً جديداً', foot: 'للاستفسار يمكنك الرد على هذا البريد.', summary: 'مكالمة مع 2ACE',
  },
} as const;

export const SITE = (typeof Deno !== 'undefined' ? Deno.env.get('SITE_URL') : undefined) ?? 'https://2ace.pl';
export const manageUrl = (a: Pick<Appt, 'manage_token'>) => `${SITE}/book?t=${a.manage_token}`;

// "Tuesday, 14 October 2026, 10:00 to 10:30 (Europe/Warsaw)" in the reader's language and time zone.
export function whenText(a: Pick<Appt, 'starts_at' | 'ends_at'>, tz: string, lang: Lang): string {
  const loc = LOCALE[lang];
  const day = new Intl.DateTimeFormat(loc, { timeZone: tz, dateStyle: 'full' }).format(new Date(a.starts_at));
  const t = new Intl.DateTimeFormat(loc, { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const range = `${t.format(new Date(a.starts_at))} – ${t.format(new Date(a.ends_at))} (${tz})`;
  return lang === 'ar' ? `${day}، \u2066${range}\u2069` : `${day}, ${range}`;   // Arabic: keep the times in left to right order
}

const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
export function googleCalUrl(a: Appt): string {
  const t = T[a.ui_lang];
  const details = [a.meeting_link ? `${t.link}: ${a.meeting_link}` : '', `${t.ref}: ${a.ref}`, manageUrl(a)].filter(Boolean).join('\n');
  const q = new URLSearchParams({ action: 'TEMPLATE', text: t.summary, dates: `${stamp(a.starts_at)}/${stamp(a.ends_at)}`, details, ...(a.meeting_link ? { location: a.meeting_link } : {}) });
  return 'https://calendar.google.com/calendar/render?' + q.toString();
}
const icsEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = (line: string) => { const out: string[] = []; let l = line; while (l.length > 73) { out.push(l.slice(0, 73)); l = ' ' + l.slice(73); } out.push(l); return out.join('\r\n'); };
// A calendar file every calendar app opens. A cancellation uses the same UID so the old entry is removed.
export function icsFile(a: Appt, cancelled = false): string {
  const t = T[a.ui_lang];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//2ACE//Booking//EN', 'CALSCALE:GREGORIAN', cancelled ? 'METHOD:CANCEL' : 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${a.id}@2ace.pl`, `DTSTAMP:${stamp(new Date().toISOString())}`, `DTSTART:${stamp(a.starts_at)}`, `DTEND:${stamp(a.ends_at)}`, `SUMMARY:${icsEsc(t.summary)}`,
    `DESCRIPTION:${icsEsc([a.meeting_link ? `${t.link}: ${a.meeting_link}` : t.noLink, `${t.ref}: ${a.ref}`, manageUrl(a)].join('\n'))}`,
    ...(a.meeting_link ? [`LOCATION:${icsEsc(a.meeting_link)}`, `URL:${a.meeting_link}`] : []),
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'SEQUENCE:' + (cancelled ? 2 : 1), 'ORGANIZER;CN=2ACE:mailto:hello@2ace.pl', ...(cancelled ? [] : ['BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(t.summary)}`, 'END:VALARM']), 'END:VEVENT', 'END:VCALENDAR'];
  return lines.map(fold).join('\r\n') + '\r\n';
}
export const toBase64 = (s: string) => { const b = new TextEncoder().encode(s); let bin = ''; for (const x of b) bin += String.fromCharCode(x); return btoa(bin); };

// The shared frame: right to left for Arabic, a font that has Chinese and Arabic glyphs.
function frame(lang: Lang, title: string, body: string): string {
  const rtl = lang === 'ar', t = T[lang];
  return `<div dir="${rtl ? 'rtl' : 'ltr'}" lang="${lang}" style="font-family:Arial,'Noto Sans','Microsoft YaHei','PingFang SC',Tahoma,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0B0C0E;text-align:${rtl ? 'right' : 'left'}">
  <div style="font-weight:800;font-size:22px;letter-spacing:.02em;margin-bottom:20px">2ACE</div>
  <h1 style="font-size:22px;margin:0 0 14px">${esc(title)}</h1>${body}
  <p style="margin-top:28px;font-size:12px;color:#666">${esc(t.foot)}<br>2ACE sp. z o.o., ul. Ostrobramska 101A lok. 301, 04-041 Warszawa. NIP 1133212948. +48 608 180 946.</p></div>`;
}
const row = (k: string, v: string) => `<tr><td style="padding:6px 14px 6px 0;color:#666;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0"><b>${v}</b></td></tr>`;
const button = (href: string, label: string) => `<p style="margin:18px 0"><a href="${esc(href)}" style="background:#E39A2B;color:#0B0C0E;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:3px;display:inline-block">${esc(label)}</a></p>`;

// The email to the person who booked.
export function customerEmail(kind: Kind, a: Appt): { subject: string; html: string; attachments: { filename: string; content: string }[] } {
  const L = a.ui_lang, t = T[L], title = t.title[kind];
  let rows = row(t.when, esc(whenText(a, a.customer_tz, L))) + row(t.lang, esc(LANG_NAME[a.lang])) + row(t.ref, esc(a.ref));
  if (kind === 'cancelled' && a.cancel_reason) rows += row(t.reason, esc(a.cancel_reason));
  let body = `<p>${esc(t.hello(a.name.split(/\s+/)[0]))}</p><p>${esc(t.intro[kind])}</p><table style="border-collapse:collapse;margin:8px 0 4px">${rows}</table>`;
  const attachments: { filename: string; content: string }[] = [];
  if (kind === 'cancelled') {
    body += button(`${SITE}/book`, t.again);
    attachments.push({ filename: 'cancelled.ics', content: toBase64(icsFile(a, true)) });
  } else {
    if (a.meeting_link) body += button(a.meeting_link, t.join) + `<p style="font-size:13px;color:#666;word-break:break-all">${esc(a.meeting_link)}</p>`;
    else if (kind !== 'link') body += `<p>${esc(t.noLink)}</p>`;
    if (kind !== 'link') {
      body += `<p style="font-size:14px"><a href="${esc(googleCalUrl(a))}" style="color:#A8701A">${esc(t.addCal)}</a><br><span style="color:#666">${esc(t.ics)}</span></p>`;
      attachments.push({ filename: 'meeting.ics', content: toBase64(icsFile(a)) });
    }
    if (kind !== 'reminder1') body += `<p style="font-size:14px">${esc(t.manage)}<br><a href="${esc(manageUrl(a))}" style="color:#A8701A;word-break:break-all">${esc(manageUrl(a))}</a></p>`;
  }
  return { subject: `${title} | 2ACE`, html: frame(L, title, body), attachments };
}

// The email to the 2ACE side (always English). `tz` is the host's time zone.
export type HostKind = 'new' | 'rescheduled' | 'cancelled' | 'reminder24' | 'reminder1';
export function hostEmail(kind: HostKind, a: Appt, hostTz: string): { subject: string; html: string } {
  const head = { new: 'New booking', rescheduled: 'Booking moved', cancelled: 'Booking cancelled', reminder24: 'Reminder: call in 24 hours', reminder1: 'Reminder: call in 1 hour' }[kind];
  const rows = [['When (your time)', whenText(a, hostTz, 'en')], ['When (their time)', whenText(a, a.customer_tz, 'en')], ['Language', LANG_NAME[a.lang] + ' (' + { en: 'English', zh: 'Chinese', ar: 'Arabic' }[a.lang] + ')'],
    ['Name', a.name], ['Email', a.email], ['Phone', a.phone || '-'], ['Company', a.company || '-'], ['Topic', a.topic || '-'], ['Reference', a.ref],
    ['Meeting link', a.meeting_link || 'NOT SET YET. Add it in the admin panel under Appointments.'], ...(kind === 'cancelled' && a.cancel_reason ? [['Reason', a.cancel_reason]] : [])];
  const table = `<table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:5px 14px 5px 0;color:#666;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:5px 0"><b style="white-space:pre-wrap">${esc(v)}</b></td></tr>`).join('')}</table>`;
  const body = `${table}<p style="margin-top:16px"><a href="${SITE}/admin#appointments" style="color:#A8701A">Open Appointments in the admin panel</a></p>`;
  return { subject: `${head}: ${a.name} (${a.lang.toUpperCase()}) ${a.ref}`, html: frame('en', head, body) };
}

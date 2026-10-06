// Booking operations that touch the database and send mail. Used by the public `booking` function, the reminder job and the admin panel.
import { admin } from './auth.ts';
import { sendEmail } from './email.ts';
import { customerEmail, hostEmail, type Appt, type HostKind, type Kind } from './bookingMail.ts';
import { isLang, type Lang, type Settings } from './booking.ts';

export const TEAM_INBOX = Deno.env.get('LEAD_NOTIFY_TO') ?? 'hello@2ace.pl';
export const APPT_COLS = 'id, ref, lang, ui_lang, starts_at, ends_at, status, name, email, phone, company, topic, customer_tz, meeting_link, manage_token, cancel_reason, confirmation_sent_at, link_sent_at, reminder_24h_sent_at, reminder_1h_sent_at, created_at, cancelled_at, cancelled_by, staff_notes, reschedule_count';

export async function loadSettings(lang: Lang): Promise<Settings | null> {
  const { data } = await admin.from('booking_settings').select('*').eq('lang', lang).maybeSingle();
  return data ? { ...data, windows: Array.isArray(data.windows) ? data.windows : [], host_emails: data.host_emails ?? [] } as Settings : null;
}
export async function loadAppt(by: { id?: string; token?: string }): Promise<(Appt & Record<string, unknown>) | null> {
  let q = admin.from('appointments').select(APPT_COLS);
  q = by.id ? q.eq('id', by.id) : q.eq('manage_token', by.token ?? '');
  const { data } = await q.maybeSingle();
  return data && isLang(data.lang) ? data as Appt & Record<string, unknown> : null;
}
// Confirmed bookings of a language in the window slots are offered for.
export async function busyFor(lang: Lang, horizonDays: number) {
  const now = Date.now();
  const { data } = await admin.from('appointments').select('starts_at, ends_at').eq('lang', lang).eq('status', 'confirmed')
    .gte('ends_at', new Date(now - 86400000).toISOString()).lte('starts_at', new Date(now + (horizonDays + 2) * 86400000).toISOString());
  return data ?? [];
}

const hostsOf = (s: Settings | null) => [...new Set([...(s?.host_emails ?? []), TEAM_INBOX].map((x) => x.trim().toLowerCase()).filter(Boolean))];

// To the customer, in the language they chose. Returns whether the mail provider accepted it.
export async function mailCustomer(kind: Kind, a: Appt): Promise<boolean> {
  const m = customerEmail(kind, a);
  const s = await loadSettings(a.lang);
  return await sendEmail({ to: a.email, replyTo: s?.host_emails?.[0] ?? TEAM_INBOX, subject: m.subject, html: m.html, attachments: m.attachments });
}
// To the people who will take the call (and the team inbox).
export async function mailHosts(kind: HostKind, a: Appt): Promise<boolean> {
  const s = await loadSettings(a.lang);
  const m = hostEmail(kind, a, s?.tz ?? 'Europe/Warsaw');
  return await sendEmail({ to: hostsOf(s), replyTo: a.email, subject: m.subject, html: m.html });
}

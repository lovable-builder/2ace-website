// Public booking of calls, for customers and guests alike (no account, no login). Visitors never touch the tables: this function
// checks every rule, then uses the service role. Actions: config, slots, book, get, reschedule, cancel.
import { corsHeaders, json } from '../_shared/cors.ts';
import { admin } from '../_shared/auth.ts';
import { availableSlots, cleanBooking, isLang, type Settings } from '../_shared/booking.ts';
import { busyFor, loadAppt, loadSettings, mailCustomer, mailHosts } from '../_shared/bookingOps.ts';

class Bad extends Error { constructor(m: string, public status = 400) { super(m); } }
const publicView = (a: Record<string, unknown>) => ({ ref: a.ref, lang: a.lang, ui_lang: a.ui_lang, status: a.status, starts_at: a.starts_at, ends_at: a.ends_at, name: a.name, tz: a.customer_tz, meeting_link: a.meeting_link ?? null, reschedule_count: a.reschedule_count });
const minutesBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 60000);

async function openSettings(lang: unknown): Promise<Settings> {
  if (!isLang(lang)) throw new Bad('Choose the language of the meeting');
  const s = await loadSettings(lang);
  if (!s || !s.enabled || !s.windows.length) throw new Bad('Booking in this language is not open yet. Please write to hello@2ace.pl.');
  return s;
}
// The requested start must be one of the free slots right now (this is what keeps visitors inside the opening hours).
async function checkSlot(s: Settings, start: unknown, ignoreStart?: string) {
  const iso = typeof start === 'string' && !Number.isNaN(Date.parse(start)) ? new Date(start).toISOString() : '';
  if (!iso) throw new Bad('Choose a time');
  const free = availableSlots(s, await busyFor(s.lang, s.horizon_days), Date.now(), ignoreStart);
  if (!free.includes(iso)) throw new Bad('That time is no longer available. Please choose another.', 409);
  return { start: iso, end: new Date(Date.parse(iso) + s.slot_minutes * 60000).toISOString() };
}
// The database refuses with a sentence meant for people (just taken, already three bookings, already started...).
const rpcFail = (e: { message: string }): never => { throw new Bad(e.message, /just taken|already have/.test(e.message) ? 409 : 400); };

const actions: Record<string, (b: Record<string, unknown>) => Promise<unknown>> = {
  // Which languages can be booked right now, with the length of a call. Nothing private (no emails, no links).
  config: async () => {
    const { data } = await admin.from('booking_settings').select('lang, enabled, windows, slot_minutes, tz');
    return { languages: (data ?? []).filter((r) => r.enabled && Array.isArray(r.windows) && r.windows.length).map((r) => ({ lang: r.lang, minutes: r.slot_minutes })) };
  },
  slots: async (b) => {
    const s = await openSettings(b.lang);
    return { lang: s.lang, minutes: s.slot_minutes, slots: availableSlots(s, await busyFor(s.lang, s.horizon_days), Date.now()) };
  },
  book: async (b) => {
    if (b.website) return { ok: true };                                  // honeypot: bots fill hidden fields
    let c; try { c = cleanBooking(b); } catch (e) { throw new Bad((e as Error).message); }
    const s = await openSettings(c.lang);
    const { start, end } = await checkSlot(s, b.start);
    const { data, error } = await admin.rpc('booking_create', { p_lang: c.lang, p_ui_lang: c.ui_lang, p_start: start, p_end: end, p_buffer: s.buffer_minutes, p_name: c.name, p_email: c.email, p_phone: c.phone, p_company: c.company, p_topic: c.topic, p_tz: c.tz, p_link: s.default_link });
    if (error) rpcFail(error);
    const a = await loadAppt({ id: (data as { id: string }).id });
    if (!a) throw new Bad('Something went wrong, please try again', 500);
    // Mail is best effort: the booking exists either way and is shown on screen.
    const sent = await mailCustomer('confirmed', a);
    await mailHosts('new', a);
    if (sent) await admin.from('appointments').update({ confirmation_sent_at: new Date().toISOString() }).eq('id', a.id);
    return { ok: true, token: a.manage_token, booking: publicView(a), emailed: sent };
  },
  get: async (b) => {
    const a = await loadAppt({ token: String(b.token ?? '') });
    if (!a) throw new Bad('Booking not found', 404);
    const s = await loadSettings(a.lang);
    return { booking: publicView(a), minutes: minutesBetween(a.starts_at, a.ends_at), can_change: a.status === 'confirmed' && Date.parse(a.starts_at) > Date.now() && !!s?.enabled };
  },
  reschedule: async (b) => {
    const a = await loadAppt({ token: String(b.token ?? '') });
    if (!a) throw new Bad('Booking not found', 404);
    if (a.status !== 'confirmed' || Date.parse(a.starts_at) <= Date.now()) throw new Bad('This booking can no longer be moved');
    const s = await openSettings(a.lang);
    const { start, end } = await checkSlot(s, b.start, a.starts_at);
    const { error } = await admin.rpc('booking_reschedule', { p_token: a.manage_token, p_start: start, p_end: end, p_buffer: s.buffer_minutes });
    if (error) rpcFail(error);
    const n = await loadAppt({ id: a.id });
    if (n) { const ok = await mailCustomer('rescheduled', n); await mailHosts('rescheduled', n); if (ok) await admin.from('appointments').update({ confirmation_sent_at: new Date().toISOString() }).eq('id', n.id); }
    return { ok: true, booking: n ? publicView(n) : null };
  },
  cancel: async (b) => {
    const a = await loadAppt({ token: String(b.token ?? '') });
    if (!a) throw new Bad('Booking not found', 404);
    const { error } = await admin.rpc('booking_cancel', { p_token: a.manage_token, p_by: 'customer', p_reason: String(b.reason ?? '').slice(0, 500) });
    if (error) rpcFail(error);
    const n = await loadAppt({ id: a.id });
    if (n) { await mailCustomer('cancelled', n); await mailHosts('cancelled', n); }
    return { ok: true };
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method' }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }
  const act = actions[String(b.action ?? '')];
  if (!act) return json(req, { error: 'unknown action' }, 400);
  try { return json(req, await act(b)); }
  catch (e) {
    if (e instanceof Bad) return json(req, { error: e.message }, e.status);
    console.error('booking', b.action, e);
    return json(req, { error: 'Something went wrong. Please try again, or write to hello@2ace.pl.' }, 500);
  }
});

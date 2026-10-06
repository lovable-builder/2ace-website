// Sends the reminders that are due: one about 24 hours before a call and one about an hour before, to the customer and to the
// people taking the call. Called every 10 minutes by the database (pg_cron). Safe to call by anyone: it only sends what is due, once each,
// and answers with counts. A reminder is marked sent only when the mail provider accepted it, so a failed one is tried again next time.
import { admin } from '../_shared/auth.ts';
import { APPT_COLS, mailCustomer, mailHosts } from '../_shared/bookingOps.ts';
import type { Appt } from '../_shared/bookingMail.ts';

Deno.serve(async () => {
  const now = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
  let sent = 0, skipped = 0, failed = 0;
  const { data } = await admin.from('appointments').select(APPT_COLS).eq('status', 'confirmed').gt('starts_at', iso(now)).lte('starts_at', iso(now + 25 * 3600000)).order('starts_at').limit(100);
  for (const a of (data ?? []) as (Appt & { starts_at: string; created_at: string; reminder_24h_sent_at: string | null; reminder_1h_sent_at: string | null })[]) {
    const left = Date.parse(a.starts_at) - now;
    // 24 hours: only when there is time left for it and the booking was made earlier than that (a fresh booking was just confirmed).
    if (!a.reminder_24h_sent_at && left <= 24 * 3600000) {
      if (left < 90 * 60000 || Date.parse(a.created_at) > Date.parse(a.starts_at) - 24 * 3600000) { await admin.from('appointments').update({ reminder_24h_sent_at: iso(now) }).eq('id', a.id); skipped++; }
      else if (await mailCustomer('reminder24', a)) { await mailHosts('reminder24', a); await admin.from('appointments').update({ reminder_24h_sent_at: iso(now) }).eq('id', a.id); sent++; } else failed++;
    }
    // 1 hour: from 65 minutes before until the start.
    if (!a.reminder_1h_sent_at && left <= 65 * 60000) {
      if (await mailCustomer('reminder1', a)) { await mailHosts('reminder1', a); await admin.from('appointments').update({ reminder_1h_sent_at: iso(now) }).eq('id', a.id); sent++; } else failed++;
    }
  }
  await admin.from('booking_runs').upsert({ key: 'reminders', ran_at: iso(now), sent });
  return new Response(JSON.stringify({ ok: true, sent, skipped, failed }), { headers: { 'Content-Type': 'application/json' } });
});

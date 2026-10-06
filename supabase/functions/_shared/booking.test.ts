// deno test supabase/functions/_shared/booking.test.ts
import { availableSlots, cleanBooking, hm, isLang, isValidTz, localDate, tzOffsetMin, validateWindows, zonedToUtcMs, type Settings } from './booking.ts';
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const base: Settings = { lang: 'en', enabled: true, tz: 'Europe/Warsaw', host_emails: ['a@x.pl'], windows: [{ dow: 1, from: '10:00', to: '12:00' }], slot_minutes: 30, buffer_minutes: 0, notice_hours: 2, horizon_days: 30, default_link: null };
const MON_10_WARSAW = Date.UTC(2026, 9, 5, 8, 0);        // Monday 5 October 2026, 10:00 in Warsaw (summer time, UTC+2)

Deno.test('time zones: Warsaw is +2 in summer and +1 in winter, Shanghai +8, Cairo follows its own rules', () => {
  eq(tzOffsetMin(Date.UTC(2026, 6, 1), 'Europe/Warsaw'), 120, 'summer'); eq(tzOffsetMin(Date.UTC(2026, 0, 15), 'Europe/Warsaw'), 60, 'winter');
  eq(tzOffsetMin(Date.UTC(2026, 6, 1), 'Asia/Shanghai'), 480, 'shanghai');
  eq(new Date(zonedToUtcMs(2026, 10, 12, 10, 0, 'Europe/Warsaw')).toISOString(), '2026-10-12T08:00:00.000Z', 'summer time clock to UTC');
  eq(new Date(zonedToUtcMs(2026, 10, 26, 10, 0, 'Europe/Warsaw')).toISOString(), '2026-10-26T09:00:00.000Z', 'after the clocks go back (25 Oct 2026)');
  eq(new Date(zonedToUtcMs(2026, 10, 12, 10, 0, 'Asia/Shanghai')).toISOString(), '2026-10-12T02:00:00.000Z', 'shanghai clock to UTC');
  eq(localDate(Date.UTC(2026, 9, 5, 23, 30), 'Europe/Warsaw'), { y: 2026, mo: 10, d: 6, dow: 2 }, '23:30 UTC is already Tuesday in Warsaw');
  ok(isValidTz('Asia/Shanghai') && isValidTz('Africa/Cairo') && !isValidTz('Mars/Base') && !isValidTz('') && !isValidTz(5), 'time zone names');
});
Deno.test('hm reads times like 10:00 and refuses nonsense', () => { eq(hm('10:30'), 630, 'ok'); eq(hm('9:05'), 545, 'one digit hour'); eq(hm('24:00'), null, 'no 24'); eq(hm('10:60'), null, 'no 60'); eq(hm('ten'), null, 'text'); });
Deno.test('validateWindows sorts, normalises and refuses overlaps and backwards times', () => {
  eq(validateWindows([{ dow: 2, from: '14:00', to: '16:00' }, { dow: 1, from: '9:00', to: '12:00' }, { dow: 1, from: '13:00', to: '15:00' }]), [{ dow: 1, from: '09:00', to: '12:00' }, { dow: 1, from: '13:00', to: '15:00' }, { dow: 2, from: '14:00', to: '16:00' }], 'sorted');
  for (const bad of [[{ dow: 1, from: '10:00', to: '09:00' }], [{ dow: 8, from: '10:00', to: '11:00' }], [{ dow: 1, from: 'x', to: '11:00' }], [{ dow: 1, from: '10:00', to: '12:00' }, { dow: 1, from: '11:00', to: '13:00' }], 'no']) {
    let threw = false; try { validateWindows(bad); } catch { threw = true; } ok(threw, 'should refuse ' + JSON.stringify(bad));
  }
  eq(validateWindows([]), [], 'empty is allowed (nothing bookable)');
});
Deno.test('slots: only inside opening hours, after the notice period, in the host time zone', () => {
  const s = availableSlots(base, [], MON_10_WARSAW);
  eq(s.slice(0, 4), ['2026-10-12T08:00:00.000Z', '2026-10-12T08:30:00.000Z', '2026-10-12T09:00:00.000Z', '2026-10-12T09:30:00.000Z'], 'first Monday after the notice');
  ok(s.every((x) => new Date(x).getUTCDay() === 1), 'only Mondays');
  ok(s.includes('2026-10-26T09:00:00.000Z') && !s.includes('2026-10-26T08:00:00.000Z'), 'the Monday after the clocks change is still 10:00 local');
  eq(availableSlots({ ...base, notice_hours: 0 }, [], MON_10_WARSAW - 3600000)[0], '2026-10-05T08:00:00.000Z', 'with no notice the same morning is open');
  eq(availableSlots(base, [], MON_10_WARSAW).filter((x) => x.startsWith('2026-10-05')), [], 'inside the notice period nothing is offered');
});
Deno.test('slots: the horizon, a disabled language and empty hours', () => {
  const s = availableSlots({ ...base, horizon_days: 7 }, [], MON_10_WARSAW);
  ok(s.length > 0 && s.every((x) => Date.parse(x) <= MON_10_WARSAW + 7 * 86400000), 'nothing beyond the horizon');
  eq(availableSlots({ ...base, enabled: false }, [], MON_10_WARSAW), [], 'disabled'); eq(availableSlots({ ...base, windows: [] }, [], MON_10_WARSAW), [], 'no hours');
});
Deno.test('slots: a booked time disappears, and a break between calls widens the gap', () => {
  const busy = [{ starts_at: '2026-10-12T08:30:00.000Z', ends_at: '2026-10-12T09:00:00.000Z' }];
  const s = availableSlots(base, busy, MON_10_WARSAW); ok(!s.includes('2026-10-12T08:30:00.000Z') && s.includes('2026-10-12T08:00:00.000Z') && s.includes('2026-10-12T09:00:00.000Z'), 'only that slot is gone');
  const b = availableSlots({ ...base, buffer_minutes: 30 }, busy, MON_10_WARSAW); ok(!b.includes('2026-10-12T08:00:00.000Z') && !b.includes('2026-10-12T09:00:00.000Z') && b.includes('2026-10-12T09:30:00.000Z'), 'buffer of 30 minutes on both sides');
  ok(availableSlots(base, busy, MON_10_WARSAW, '2026-10-12T08:30:00.000Z').includes('2026-10-12T08:30:00.000Z'), 'a booking being moved does not block its own old time');
});
Deno.test('slots: a team in China is offered in its own hours (Shanghai 10:00 is 02:00 UTC)', () => {
  const s = availableSlots({ ...base, lang: 'zh', tz: 'Asia/Shanghai', windows: [{ dow: 3, from: '10:00', to: '11:00' }], slot_minutes: 60 }, [], MON_10_WARSAW);
  eq(s[0], '2026-10-07T02:00:00.000Z', 'Wednesday 10:00 in Shanghai');
});
Deno.test('cleanBooking: trims, lower-cases the email, keeps the chosen languages and refuses bad input with a message', () => {
  const c = cleanBooking({ lang: 'zh', ui_lang: 'ar', name: '  Li Wei ', email: ' LI@Example.COM ', phone: '+48 608 180 946', company: '', topic: 'Storage', tz: 'Asia/Shanghai' });
  eq([c.lang, c.ui_lang, c.name, c.email, c.phone, c.company, c.tz], ['zh', 'ar', 'Li Wei', 'li@example.com', '+48 608 180 946', null, 'Asia/Shanghai'], 'clean');
  eq(cleanBooking({ lang: 'en', name: 'Jo', email: 'a@b.pl', tz: 'Nope/Nope' }).tz, 'Europe/Warsaw', 'unknown time zone falls back'); eq(cleanBooking({ lang: 'en', name: 'Jo', email: 'a@b.pl' }).ui_lang, 'en', 'email language follows the meeting language');
  for (const [b, re] of [[{ lang: 'fr', name: 'Jo', email: 'a@b.pl' }, /language/], [{ lang: 'en', name: 'J', email: 'a@b.pl' }, /name/], [{ lang: 'en', name: 'Jo', email: 'nope' }, /email/], [{ lang: 'en', name: 'Jo', email: 'a@b.pl', phone: 'abc' }, /phone/]] as const) {
    try { cleanBooking(b); throw new Error('should refuse'); } catch (e) { ok(re.test((e as Error).message), (e as Error).message); }
  }
  ok(isLang('zh') && isLang('ar') && isLang('en') && !isLang('pl'), 'languages');
});

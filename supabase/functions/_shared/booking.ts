// Booking calls: opening hours, time zones and free slots. Pure functions, no network, so every rule is tested (booking.test.ts).
export const LANGS = ['en', 'zh', 'ar'] as const;
export type Lang = typeof LANGS[number];
export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as readonly string[]).includes(v);

export type Window = { dow: number; from: string; to: string };           // dow: 1 = Monday ... 7 = Sunday, times are local in the host's time zone
export type Settings = {
  lang: Lang; enabled: boolean; tz: string; host_emails: string[]; windows: Window[]; slot_minutes: number; buffer_minutes: number;
  notice_hours: number; horizon_days: number; default_link: string | null;
};
export type Busy = { starts_at: string; ends_at: string };

export function isValidTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 60) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

// Minutes east of UTC that a time zone is at a given instant (Warsaw is 60 in winter, 120 in summer).
export function tzOffsetMin(ms: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000);
}
// The instant at which the wall clock in `tz` shows this date and time.
export function zonedToUtcMs(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const o1 = tzOffsetMin(guess, tz); let t = guess - o1 * 60000;
  const o2 = tzOffsetMin(t, tz); if (o2 !== o1) t = guess - o2 * 60000;
  return t;
}
// The calendar date and weekday on the wall clock of `tz` at an instant.
export function localDate(ms: number, tz: string): { y: number; mo: number; d: number; dow: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const y = +p.year, mo = +p.month, d = +p.day;
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();             // 0 = Sunday
  return { y, mo, d, dow: wd === 0 ? 7 : wd };
}

export const hm = (s: unknown): number | null => { const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? '').trim()); return m ? +m[1] * 60 + +m[2] : null; };

// Opening hours as saved by an admin: checked, sorted, and never overlapping on the same day.
export function validateWindows(raw: unknown): Window[] {
  if (!Array.isArray(raw)) throw new Error('Opening hours must be a list');
  if (raw.length > 42) throw new Error('Too many opening hours');
  const out: Window[] = raw.map((w) => {
    const dow = Number((w as Window)?.dow), from = hm((w as Window)?.from), to = hm((w as Window)?.to);
    if (!Number.isInteger(dow) || dow < 1 || dow > 7) throw new Error('Pick a weekday from Monday to Sunday');
    if (from === null || to === null) throw new Error('Times look like 10:00');
    if (to <= from) throw new Error('Each opening time must end after it starts');
    const p = (n: number) => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
    return { dow, from: p(from), to: p(to) };
  });
  out.sort((a, b) => a.dow - b.dow || a.from.localeCompare(b.from));
  for (let i = 1; i < out.length; i++) if (out[i].dow === out[i - 1].dow && (hm(out[i].from) as number) < (hm(out[i - 1].to) as number)) throw new Error('Opening times on the same day must not overlap');
  return out;
}

// Free slots, as UTC start instants, oldest first. A slot is free when it lies inside an opening window, is far enough ahead
// (notice) and not too far (horizon), and does not touch another confirmed booking of the same language (plus the buffer).
export function availableSlots(s: Settings, busy: Busy[], nowMs: number, ignoreStart?: string): string[] {
  if (!s.enabled || !s.windows.length) return [];
  const step = s.slot_minutes * 60000, buf = s.buffer_minutes * 60000;
  const earliest = nowMs + s.notice_hours * 3600000, latest = nowMs + s.horizon_days * 86400000;
  const taken = busy.filter((b) => b.starts_at !== ignoreStart).map((b) => [Date.parse(b.starts_at) - buf, Date.parse(b.ends_at) + buf]);
  const out: string[] = [];
  let day = localDate(nowMs, s.tz);
  for (let i = 0; i <= s.horizon_days + 1; i++) {
    const cur = new Date(Date.UTC(day.y, day.mo - 1, day.d + i));
    const y = cur.getUTCFullYear(), mo = cur.getUTCMonth() + 1, d = cur.getUTCDate(), wd = cur.getUTCDay(), dow = wd === 0 ? 7 : wd;
    for (const w of s.windows.filter((x) => x.dow === dow)) {
      const from = hm(w.from) as number, to = hm(w.to) as number;
      for (let t = from; t + s.slot_minutes <= to; t += s.slot_minutes) {
        const start = zonedToUtcMs(y, mo, d, Math.floor(t / 60), t % 60, s.tz), end = start + step;
        if (start < earliest || start > latest) continue;
        if (taken.some(([a, b]) => start < b && end > a)) continue;
        out.push(new Date(start).toISOString());
      }
    }
  }
  return [...new Set(out)].sort();
}

// What a visitor typed, checked. Throws a message that is safe to show.
export type BookingInput = { lang: Lang; ui_lang: Lang; name: string; email: string; phone: string | null; company: string | null; topic: string | null; tz: string };
export function cleanBooking(b: Record<string, unknown>): BookingInput {
  const t = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
  if (!isLang(b.lang)) throw new Error('Choose the language of the meeting');
  const name = t(b.name, 200), email = t(b.email, 200).toLowerCase();
  if (name.length < 2) throw new Error('Please enter your name');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Please enter a valid email address');
  const phone = t(b.phone, 40) || null;
  if (phone && !/^[0-9+()\-.\s]{6,40}$/.test(phone)) throw new Error('The phone number looks wrong');
  return { lang: b.lang, ui_lang: isLang(b.ui_lang) ? b.ui_lang : b.lang, name, email, phone, company: t(b.company, 200) || null, topic: t(b.topic, 2000) || null, tz: isValidTz(b.tz) ? b.tz : 'Europe/Warsaw' };
}

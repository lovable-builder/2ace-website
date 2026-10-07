import { ACE_CONFIG } from '../lib/ace-config.mjs';
import { ROOT } from '../lib/root.mjs';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><body><div id="book-app"></div></body>', { url: 'https://2ace.pl/book' });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, localStorage: dom.window.localStorage, scrollTo: () => {}, __BOOK_NO_AUTOSTART: true });
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !x ? '' : '  -> ' + x)); };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms)); const text = () => document.body.textContent.replace(/\s+/g, ' ');
dom.window.ACE_CONFIG = ACE_CONFIG;
const calls = []; const H = {};
globalThis.fetch = async (u, o) => { const b = JSON.parse(o.body); calls.push(b); const r = (H[b.action] || (() => ({ status: 404, body: { error: 'x' } })))(b); return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body }; };
const { start } = await import('file://' + ROOT + '/assets/book/book.js');
const click = async (sel) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; e.click(); await tick(); };
const btn = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(label));
const typeIn = (label, v) => { const l = [...document.querySelectorAll('label')].find((x) => x.firstChild && x.firstChild.textContent.includes(label)); const i = l.querySelector('input,textarea'); i.value = v; i.dispatchEvent(new window.Event('input', { bubbles: true })); };
const root = () => { const r = document.getElementById('book-app'); while (r.firstChild) r.removeChild(r.firstChild); return r; };
const MON = (h, m = 0) => new Date(Date.UTC(2026, 9, 12, h, m)).toISOString();   // Monday 12 Oct 2026
const SLOTS = [MON(8), MON(8, 30), MON(9), new Date(Date.UTC(2026, 9, 13, 8)).toISOString()];

// ---- closed: nothing is open yet ----
H.config = () => ({ body: { languages: [] } });
let page = await start(root(), { search: '' }); await tick();
ok('when no language is open the page says so honestly and offers email, with no fake times', /Online booking is not open yet/.test(text()) && /hello@2ace\.pl/.test(text()) && !document.querySelector('.time'));
ok('anyone can book: the page says no account is needed, customers and guests alike', /No account needed/.test(text()) && /guests/.test(text()));

// ---- open in three languages ----
H.config = () => ({ body: { languages: [{ lang: 'en', minutes: 30 }, { lang: 'zh', minutes: 30 }, { lang: 'ar', minutes: 30 }] } });
H.slots = (b) => ({ body: { lang: b.lang, minutes: 30, slots: b.lang === 'ar' ? [] : SLOTS } });
calls.length = 0; page = await start(root(), { search: '' }); await tick(80);
ok('the three meeting languages are offered, in their own scripts', ['English', '中文', 'العربية'].every((n) => [...document.querySelectorAll('.pick b')].some((b) => b.textContent === n)));
ok('the language of the browser is chosen for the meeting and its times are loaded', document.querySelector('.pick.on')?.dataset.lang === 'en' && calls.some((c) => c.action === 'slots' && c.lang === 'en') && document.querySelectorAll('.day').length === 2);
{ const sel = document.querySelector('.tzline select'); sel.value = 'Europe/Warsaw'; sel.dispatchEvent(new window.Event('change')); await tick(); }
ok('times are shown in the visitor\'s chosen time zone (08:00 UTC is 10:00 in Warsaw)', [...document.querySelectorAll('.time')].map((b) => b.textContent).join() === '10:00,10:30,11:00', [...document.querySelectorAll('.time')].map((b) => b.textContent).join());
{ const sel = document.querySelector('.tzline select'); sel.value = 'Asia/Shanghai'; sel.dispatchEvent(new window.Event('change')); await tick(); await click('.day'); }
ok('another time zone shows other times (16:00 in Shanghai)', document.querySelector('.time')?.textContent === '16:00');
{ const sel = document.querySelector('.tzline select'); sel.value = 'Europe/Warsaw'; sel.dispatchEvent(new window.Event('change')); await tick(); }
ok('no form is shown before a time is chosen', !document.querySelector('#submit'));
await click('[data-lang="ar"]');
ok('a language with no free times says so, and offers the others', /no free times in this language/.test(text()) && !document.querySelector('.time'));
await click('[data-lang="zh"]'); ok('choosing Chinese loads the Chinese slots', calls.filter((c) => c.action === 'slots').pop().lang === 'zh' && document.querySelectorAll('.time').length === 3);
await click('.time'); ok('choosing a time shows the form with the chosen time in words', !!document.querySelector('#submit') && /Your time: .*10:00/.test(text()), text().slice(-300));

// ---- validation, then booking ----
await click('#submit'); ok('an empty name is refused before anything is sent', /Please enter your name/.test(text()) && !calls.some((c) => c.action === 'book'));
typeIn('Your name', 'Li Wei'); typeIn('Email', 'nope'); await click('#submit'); ok('a bad email is refused before anything is sent', /valid email/.test(text()) && !calls.some((c) => c.action === 'book'));
typeIn('Email', 'li@example.com'); typeIn('Phone', '+86 138 0000 0000'); typeIn('Company', 'Acme'); typeIn('What would you like', 'Storage for 20 m²');
H.book = (b) => ({ body: { ok: true, token: 'tok'.padEnd(64, 'x'), emailed: true, booking: { ref: 'APT-000012', lang: b.lang, ui_lang: b.ui_lang, status: 'confirmed', starts_at: b.start, ends_at: new Date(Date.parse(b.start) + 1800000).toISOString(), name: b.name, tz: b.tz, meeting_link: null, reschedule_count: 0 } } });
await click('#submit'); await tick();
const bk = calls.filter((c) => c.action === 'book').pop();
ok('booking sends the language, the email language, the exact time, the details and the time zone, and an empty honeypot', bk && bk.lang === 'zh' && bk.ui_lang === 'en' && bk.start === MON(8) && bk.name === 'Li Wei' && bk.email === 'li@example.com' && bk.phone === '+86 138 0000 0000' && bk.company === 'Acme' && bk.topic === 'Storage for 20 m²' && bk.tz === 'Europe/Warsaw' && bk.website === '', JSON.stringify(bk));
ok('the confirmation shows the reference, the language and what happens next', /You are booked/.test(text()) && /APT-000012/.test(text()) && /中文/.test(text()) && /sent a confirmation to li@example\.com/.test(text()));
ok('it offers Google Calendar, a calendar file and a link to change or cancel', document.querySelector('a[href^="https://calendar.google.com/"]') && /text\/calendar/.test(document.querySelector('a[download]')?.getAttribute('href') ?? '') && !!document.querySelector('a[href^="/book?t=tok"]'));
ok('without a meeting link the page says it will be emailed', /email you the meeting link/.test(text()));

// ---- a bot ----
await start(root(), { search: '' }); await tick(80); await click('.time'); typeIn('Your name', 'Bot Bot'); typeIn('Email', 'bot@example.com'); { const h = document.querySelector('.hp input'); h.value = 'spam'; h.dispatchEvent(new window.Event('input', { bubbles: true })); }
await click('#submit'); ok('the hidden field is passed on, so the server can drop bots', calls.filter((c) => c.action === 'book').pop().website === 'spam');

// ---- somebody else took the time ----
await start(root(), { search: '' }); await tick(80); await click('.time'); typeIn('Your name', 'Jo Jo'); typeIn('Email', 'jo@example.com');
H.book = () => ({ status: 409, body: { error: 'That time was just taken. Please choose another.' } }); const before = calls.filter((c) => c.action === 'slots').length;
await click('#submit'); await tick(60); ok('a taken time says so and refreshes the free times', /just taken/.test(text()) && calls.filter((c) => c.action === 'slots').length > before && !document.querySelector('#submit'));

// ---- languages of the page itself ----
await click(btn('العربية')); ok('Arabic switches the whole page to right to left', document.documentElement.dir === 'rtl' && document.documentElement.lang === 'ar' && /احجز مكالمة/.test(text()) && /لا حاجة إلى حساب/.test(text()));
await click(btn('中文')); ok('Chinese switches the words and keeps left to right', document.documentElement.dir === 'ltr' && document.documentElement.lang === 'zh' && /预约与 2ACE 通话/.test(text()) && /无需注册账号/.test(text()));
await click(btn('English')); ok('English comes back', document.documentElement.dir === 'ltr' && /Book a call with 2ACE/.test(text()));
ok('the chosen page language is remembered for the next visit', dom.window.localStorage.getItem('2ace-book-ui') === 'en');

// ---- managing a booking from the email link ----
const bkg = (over = {}) => ({ ref: 'APT-000012', lang: 'zh', ui_lang: 'zh', status: 'confirmed', starts_at: new Date(Date.now() + 3 * 86400000).toISOString(), ends_at: new Date(Date.now() + 3 * 86400000 + 1800000).toISOString(), name: 'Li Wei', tz: 'Asia/Shanghai', meeting_link: 'https://meet.example.com/abc', reschedule_count: 0, ...over });
H.get = () => ({ body: { booking: bkg(), minutes: 30, can_change: true } });
dom.window.localStorage.clear(); await start(root(), { search: '?t=tok' }); await tick(80);
ok('the email link opens the booking in the language it was booked in, with its link', document.documentElement.lang === 'zh' && /您的预约/.test(text()) && /APT-000012/.test(text()) && !!document.querySelector('a[href="https://meet.example.com/abc"]'));
await click('#cancel'); ok('cancelling asks first', /确定取消/.test(text()) && !calls.some((c) => c.action === 'cancel'));
H.cancel = () => ({ body: { ok: true } }); { const w = document.getElementById('why'); w.value = '临时有事'; } await click('#cancel-yes'); await tick();
ok('cancelling sends the token and the reason, and says it is done', calls.filter((c) => c.action === 'cancel').pop()?.token === 'tok' && calls.filter((c) => c.action === 'cancel').pop()?.reason === '临时有事' && /您的预约已取消/.test(text()) && /重新预约/.test(text()));
H.get = () => ({ body: { booking: bkg(), minutes: 30, can_change: true } });
await start(root(), { search: '?t=tok&lang=en' }); await tick(80);
H.slots = () => ({ body: { lang: 'zh', minutes: 30, slots: SLOTS } }); H.reschedule = (b) => ({ body: { ok: true, booking: bkg({ starts_at: b.start, ends_at: new Date(Date.parse(b.start) + 1800000).toISOString(), reschedule_count: 1 }) } });
await click('#resched'); await tick(60); ok('choosing another time shows free times for the same language', document.querySelectorAll('.time').length === 3 && calls.filter((c) => c.action === 'slots').pop().lang === 'zh');
await click('.time'); await click('#move'); await tick(); ok('moving sends the token and the new time and confirms', calls.filter((c) => c.action === 'reschedule').pop()?.start === SLOTS[0] && /moved/.test(text()));
H.get = () => ({ body: { booking: bkg({ status: 'cancelled' }), minutes: 30, can_change: false } }); await start(root(), { search: '?t=tok&lang=en' }); await tick(80);
ok('a cancelled booking says so and offers a new one, with no change buttons', /was cancelled/.test(text()) && !document.querySelector('#resched') && !!document.querySelector('a[href="/book"]'));
H.get = () => ({ body: { booking: bkg({ starts_at: new Date(Date.now() - 3600000).toISOString() }), minutes: 30, can_change: false } }); await start(root(), { search: '?t=tok&lang=en' }); await tick(80);
ok('a meeting that has started cannot be changed', /already taken place or started/.test(text()) && !document.querySelector('#resched'));
H.get = () => ({ status: 404, body: { error: 'Booking not found' } }); await start(root(), { search: '?t=wrong&lang=en' }); await tick(80);
ok('a wrong link says the booking was not found', /could not find this booking/.test(text()));
H.get = () => ({ body: { booking: bkg({ ref: '<img src=x onerror=alert(1)>', meeting_link: null }), minutes: 30, can_change: true } }); await start(root(), { search: '?t=tok&lang=en' }); await tick(80);
ok('nothing from the server is ever inserted as markup', !document.querySelector('img') && /<img/.test(text()));

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

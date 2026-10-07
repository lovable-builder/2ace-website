// The browser error reporter (assets/monitor.js): off without a DSN; with one, each new error becomes one envelope, query strings never leave the page.
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from '../lib/root.mjs';
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c || !x ? '' : '  -> ' + x)); };
const src = fs.readFileSync(path.join(ROOT, 'assets', 'monitor.js'), 'utf8');

function page(dsn) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://2ace.pl/book?t=secret-token#x', runScripts: 'outside-only' });
  const w = dom.window, sent = [];
  w.fetch = (url, init) => { sent.push({ url, init }); return Promise.resolve({ ok: true }); };
  w.ACE_CONFIG = { env: 'production', sentryDsn: dsn };
  w.eval(src);
  return { w, sent };
}

{
  const { w, sent } = page('');
  w.dispatchEvent(new w.ErrorEvent('error', { error: new w.Error('boom'), message: 'boom' }));
  ok('without a DSN nothing is sent', sent.length === 0);
  ok('aceReport exists and does nothing', typeof w.aceReport === 'function' && (w.aceReport(new Error('x')), sent.length === 0));
}
{
  const { w, sent } = page('https://pubkey@o1.ingest.sentry.io/77');
  const e = new w.Error('Cannot read things'); e.stack = 'TypeError: Cannot read things\n    at load (https://2ace.pl/assets/book/book.js?v=1:10:5)\n    at https://cdn.example.com/lib.js:1:1';
  w.dispatchEvent(new w.ErrorEvent('error', { error: e, message: e.message }));
  ok('an uncaught error is sent once', sent.length === 1, String(sent.length));
  ok('to the envelope endpoint with the public key', sent[0].url === 'https://o1.ingest.sentry.io/api/77/envelope/?sentry_version=7&sentry_key=pubkey', sent[0].url);
  const [head, item, ev] = sent[0].init.body.split('\n').map((l) => JSON.parse(l));
  ok('the envelope has a header, an event item and the event', head.dsn === 'https://pubkey@o1.ingest.sentry.io/77' && item.type === 'event' && ev.event_id === head.event_id && /^[0-9a-f]{32}$/.test(ev.event_id));
  ok('the error and its message', ev.exception.values[0].value === 'Cannot read things');
  ok('the page URL has no query string or hash', ev.request.url === 'https://2ace.pl/book' && !sent[0].init.body.includes('secret-token'), ev.request.url);
  const fr = ev.exception.values[0].stacktrace.frames;
  ok('frames oldest first, file names without queries, our files marked as the app', fr.length === 2 && fr[1].function === 'load' && fr[1].filename === 'https://2ace.pl/assets/book/book.js' && fr[1].in_app === true && fr[0].in_app === false, JSON.stringify(fr));
  w.dispatchEvent(new w.ErrorEvent('error', { error: e, message: e.message }));
  ok('the same error is not sent twice', sent.length === 1);
  const rej = new w.Event('unhandledrejection'); rej.reason = new w.Error('promise went wrong'); w.dispatchEvent(rej);
  ok('an unhandled promise rejection is sent', sent.length === 2 && sent[1].init.body.includes('promise went wrong'));
  for (let i = 0; i < 20; i++) w.aceReport(new w.Error('different ' + i));
  ok('at most 10 reports per page view', sent.length === 10, String(sent.length));
}
{
  const { w, sent } = page('not a dsn');
  w.aceReport(new Error('x'));
  ok('a malformed DSN switches reporting off', sent.length === 0);
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Error reports from the browser to Sentry (or anything that speaks its envelope format). Off unless config.js has a sentryDsn.
// A report carries the error, its stack, the page path (never the query string: it can hold tokens) and the browser.
// No cookies, no user details, at most 10 reports per page view. window.aceReport(err) reports a caught error by hand.
(function () {
  var cfg = window.ACE_CONFIG || {};
  var m = /^(https?):\/\/([^@/]+)@([^/]+)\/(?:(.*)\/)?(\d+)$/.exec(String(cfg.sentryDsn || '').trim());
  window.aceReport = function () {};
  if (!m || typeof fetch !== 'function') return;
  var url = m[1] + '://' + m[3] + '/' + (m[4] ? m[4] + '/' : '') + 'api/' + m[5] + '/envelope/?sentry_version=7&sentry_key=' + encodeURIComponent(m[2]);
  var left = 10, seen = {};
  var hex = function () { var a = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; }); return Array.prototype.map.call(a, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); };
  var clean = function (u) { return String(u || '').replace(/[?#].*$/, ''); };
  // Chrome "    at fn (url:1:2)" and Firefox/Safari "fn@url:1:2", oldest call first as Sentry wants.
  var frames = function (stack) {
    var out = [];
    String(stack || '').split('\n').forEach(function (l) {
      var x = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(l) || /^\s*(?:(.*?)@)?(.+?):(\d+):(\d+)\s*$/.exec(l);
      if (x) out.push({ function: x[1] || undefined, filename: clean(x[2]), lineno: +x[3], colno: +x[4], in_app: x[2].indexOf(location.origin) === 0 });
    });
    return out.reverse();
  };
  var send = function (err, extra) {
    if (left <= 0) return;
    var e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : (function () { try { return JSON.stringify(err); } catch (x) { return String(err); } })());
    var key = e.name + ':' + e.message;
    if (seen[key]) return;
    seen[key] = 1; left -= 1;
    var id = hex(), now = new Date();
    var ev = { event_id: id, timestamp: now.getTime() / 1000, platform: 'javascript', level: 'error', logger: 'browser', environment: cfg.env || 'production',
      request: { url: location.origin + location.pathname, headers: { 'User-Agent': navigator.userAgent } },
      tags: { page: location.pathname }, extra: extra || undefined,
      exception: { values: [{ type: e.name || 'Error', value: String(e.message).slice(0, 2000), stacktrace: { frames: frames(e.stack) } }] } };
    var body = JSON.stringify({ event_id: id, sent_at: now.toISOString(), dsn: cfg.sentryDsn }) + '\n' + JSON.stringify({ type: 'event' }) + '\n' + JSON.stringify(ev);
    try { fetch(url, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } }).catch(function () {}); } catch (x) { /* never break the page */ }
  };
  window.aceReport = send;
  window.addEventListener('error', function (ev) {
    if (ev.error) send(ev.error);
    else if (ev.message) send(new Error(ev.message + (ev.filename ? ' (' + clean(ev.filename) + ':' + ev.lineno + ')' : '')));
  });
  window.addEventListener('unhandledrejection', function (ev) { send(ev.reason || new Error('Unhandled promise rejection')); });
})();

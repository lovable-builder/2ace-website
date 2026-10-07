// Translates the public website into Polish or Chinese in the browser. English text is the key, as in the customer app
// (/app), and the choice is shared with it: localStorage "ace_lang". ?lang=pl in a link chooses and remembers a language.
//
// Each block of text (a paragraph, heading, list item, button, ...) is looked up whole, with its inline tags written as
// numbered markers, so "Hi <a href=..>there</a>" is the key "Hi <0>there</0>" and its translation can move the link.
// Blocks containing an element with an id (scripts update those) are translated text node by text node instead.
// Text that scripts write later is translated as it appears; "{name}" in a key matches any text there.
// The catalogues are assets/i18n/<lang>.json; scripts/i18n-site.mjs lists every key and tests/ui/i18n.test.mjs checks them.
(function () {
  var LANGS = { en: 'English', pl: 'Polski', zh: '中文' };
  var STORE = 'ace_lang';
  var INLINE = /^(A|ABBR|B|BDI|BR|CITE|CODE|DFN|EM|I|IMG|KBD|MARK|Q|S|SAMP|SMALL|SPAN|STRONG|SUB|SUP|TIME|U|VAR|WBR)$/;
  var VOID = /^(BR|IMG|WBR)$/;
  var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|PRE|SVG|TEMPLATE|IFRAME|CANVAS|VIDEO|AUDIO|SELECT)$/;
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function pick() {
    var q = null;
    try { q = new URLSearchParams(location.search).get('lang'); } catch (e) { /* old browser */ }
    if (q && LANGS[q]) { store(STORE, q); return q; }
    var s = store(STORE);
    if (s && LANGS[s]) return s;
    var n = String((navigator && navigator.language) || 'en').toLowerCase();
    return n.indexOf('pl') === 0 ? 'pl' : n.indexOf('zh') === 0 ? 'zh' : 'en';
  }

  var collecting = !!window.ACE_I18N_COLLECT;   // scripts/i18n-site.mjs: gather the keys instead of translating
  var lang = collecting ? 'en' : pick();
  var cat = {}, patterns = [], keys = collecting ? {} : null, missing = {};
  var done = new WeakMap();   // element or text node -> the text we last wrote, so our own changes are not looked up again

  var norm = function (s) { return s.replace(/\s+/g, ' ').trim(); };
  var hasWords = function (s) { return /[A-Za-z]/.test(s); };
  function fill(s, vars) { return vars ? s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] !== undefined ? String(vars[k]) : m; }) : s; }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function compile() {
    patterns = [];
    for (var k in cat) {
      if (k.indexOf('{') < 0 || !/\{\w+\}/.test(k)) continue;
      var names = [];
      var re = '^' + k.split(/(\{\w+\})/).map(function (part) {
        var m = /^\{(\w+)\}$/.exec(part);
        if (m) { names.push(m[1]); return '(.+?)'; }
        return escRe(part);
      }).join('') + '$';
      patterns.push({ re: new RegExp(re), names: names, key: k });
    }
  }
  // English in, the chosen language out; undefined when there is no translation.
  function lookup(key) {
    if (keys) { keys[key] = 1; return undefined; }
    if (Object.prototype.hasOwnProperty.call(cat, key)) return cat[key];
    for (var i = 0; i < patterns.length; i++) {
      var m = patterns[i].re.exec(key);
      if (!m) continue;
      var vars = {};
      for (var j = 0; j < patterns[i].names.length; j++) vars[patterns[i].names[j]] = m[j + 1];
      return fill(cat[patterns[i].key], vars);
    }
    missing[key] = 1;
    return undefined;
  }
  function t(key, vars) { var v = lang === 'en' ? undefined : lookup(key); return fill(v === undefined ? key : v, vars); }

  function skipped(el) { return SKIP.test(el.nodeName) || el.getAttribute('translate') === 'no' || el.hasAttribute('data-i18n-skip'); }

  // A block whose text can be translated whole: it has text of its own, only inline elements inside, and none of them is one
  // a script looks up by id.
  function isBlock(el) {
    var own = false, kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType === 3) { if (/\S/.test(c.nodeValue)) own = true; }
      else if (c.nodeType === 1) {
        if (!INLINE.test(c.nodeName) || c.id || skipped(c) || (c.nodeName !== 'BR' && c.nodeName !== 'WBR' && c.nodeName !== 'IMG' && !isInline(c))) return false;
      }
    }
    return own;
  }
  function isInline(el) {
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType === 1 && (!INLINE.test(c.nodeName) || c.id || skipped(c) || !isInline(c))) return false;
    }
    return true;
  }
  function serialize(el, list) {
    var out = '', kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.nodeType === 1) {
        var n = list.length; list.push(c);
        out += VOID.test(c.nodeName) ? '<' + n + '/>' : '<' + n + '>' + serialize(c, list) + '</' + n + '>';
      }
    }
    return out;
  }
  // Rebuilds the block from the translation, reusing copies of the original inline elements (links keep their href).
  function render(el, text, list) {
    var frag = document.createDocumentFragment(), stack = [frag], re = /<(\/?)(\d+)(\/?)>/g, last = 0, m;
    function put(s) { if (s) stack[stack.length - 1].appendChild(document.createTextNode(s)); }
    while ((m = re.exec(text))) {
      put(text.slice(last, m.index)); last = re.lastIndex;
      var orig = list[+m[2]];
      if (!orig) continue;
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      var copy = orig.cloneNode(false);
      stack[stack.length - 1].appendChild(copy);
      if (!m[3] && !VOID.test(orig.nodeName)) stack.push(copy);
    }
    put(text.slice(last));
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(frag);
  }

  function doText(node) {
    var raw = node.nodeValue;
    if (done.get(node) === raw || !hasWords(raw)) return;
    var key = norm(raw), v = lookup(key);
    if (v === undefined || v === key) return;
    var lead = /^\s*/.exec(raw)[0], tail = /\s*$/.exec(raw)[0];
    var out = (lead ? ' ' : '') + v + (tail ? ' ' : '');
    done.set(node, out);
    node.nodeValue = out;
  }
  function doAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = el.getAttribute(ATTRS[i]);
      if (!a || !hasWords(a) || done.get(el) === ATTRS[i] + a) continue;
      var v = lookup(norm(a));
      if (v !== undefined) { el.setAttribute(ATTRS[i], v); done.set(el, ATTRS[i] + v); }
    }
    if (el.nodeName === 'OPTION' && hasWords(el.text) && !el.hasAttribute('data-i18n-done')) {
      var o = lookup(norm(el.text));
      if (o !== undefined) { el.text = o; el.setAttribute('data-i18n-done', ''); }
    }
  }
  function walk(el) {
    if (el.nodeType === 3) { if (el.parentNode && el.parentNode.nodeType === 1 && !skipped(el.parentNode)) doText(el); return; }
    if (el.nodeType !== 1 || el.getAttribute('translate') === 'no' || el.hasAttribute('data-i18n-skip')) return;
    if (el.nodeName === 'SELECT') { doAttrs(el); for (var s = 0; s < el.options.length; s++) doAttrs(el.options[s]); return; }
    if (skipped(el)) return;
    doAttrs(el);
    if (el.childNodes.length > 1 && isBlock(el)) {
      var list = [], raw = serialize(el, list), key = norm(raw);
      if (done.get(el) === raw || !hasWords(key)) return;
      var v = lookup(key);
      if (v !== undefined && v !== key) { render(el, v, list); done.set(el, serialize(el, [])); }
      if (list.length) doAttrsDeep(el);
      return;
    }
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
  }
  function doAttrsDeep(el) { var all = el.querySelectorAll('*'); for (var i = 0; i < all.length; i++) doAttrs(all[i]); }

  function translateHead() {
    if (document.title) { var v = lookup(norm(document.title)); if (v !== undefined) document.title = v; }
    var d = document.querySelector('meta[name="description"]');
    if (d && d.content) { var w = lookup(norm(d.content)); if (w !== undefined) d.content = w; }
  }

  // ---- the language menu: in the element marked data-lang-switch, otherwise at the end of the page header's nav ----
  function switcher() {
    if (collecting || document.querySelector('.ace-lang')) return;
    if (document.querySelector('x-dc')) {   // a page drawn by support.js: wait until it is on screen, then add the menu there
      var tries = 0, iv = setInterval(function () {
        if (!document.querySelector('x-dc') && document.querySelector('[data-lang-switch]')) { clearInterval(iv); switcher(); }
        else if (++tries > 100) clearInterval(iv);
      }, 100);
      return;
    }
    var host = document.querySelector('[data-lang-switch]') || document.querySelector('header nav') || document.querySelector('header .nav') || document.querySelector('header');
    var sel = document.createElement('select');
    sel.className = 'ace-lang'; sel.setAttribute('aria-label', 'Language'); sel.setAttribute('translate', 'no');
    for (var k in LANGS) { var o = document.createElement('option'); o.value = k; o.text = LANGS[k]; if (k === lang) o.selected = true; sel.appendChild(o); }
    sel.onchange = function () { setLang(sel.value); };
    if (!host) { sel.className += ' ace-lang-float'; document.body.appendChild(sel); }
    else host.appendChild(sel);
    labelSwitcher();
  }
  // e.g. "the English version is binding" on the legal pages, shown only in a translation
  function showNotes() { var n = document.querySelectorAll('[data-lang-note]'); for (var i = 0; i < n.length; i++) n[i].hidden = false; }
  function labelSwitcher() { var s = document.querySelector('.ace-lang'); if (s && cat.Language) s.setAttribute('aria-label', cat.Language); }
  function setLang(l) {
    if (!LANGS[l]) return;
    store(STORE, l);
    var u = new URL(location.href);
    if (u.searchParams.has('lang')) { u.searchParams.set('lang', l); location.replace(u.toString()); } else location.reload();
  }
  var css = '.ace-lang{font:inherit;font-size:13px;line-height:1.2;margin-left:14px;padding:4px 6px;border:1px solid rgba(128,128,128,.4);border-radius:4px;background:transparent;color:inherit;cursor:pointer;vertical-align:baseline}'
    + '[data-lang-switch] .ace-lang{margin-left:0}.ace-lang option{color:#0B0C0E;background:#fff}.ace-lang-float{position:fixed;right:12px;bottom:12px;z-index:50;margin:0;background:#F5F4F1;color:#0B0C0E}'
    + 'html.ace-i18n-wait body{visibility:hidden}';

  var ready, observer = null;
  function observe() {
    observer = new MutationObserver(function (records) {
      var seen = [];
      for (var i = 0; i < records.length; i++) {
        var r = records[i], target = r.type === 'characterData' ? r.target.parentNode : r.target;
        if (!target || seen.indexOf(target) >= 0) continue;
        seen.push(target);
        if (r.type === 'attributes') doAttrs(target);
        else if (document.contains(target)) walk(target.nodeType === 1 && target.parentNode && target.parentNode.nodeType === 1 && isBlock(target.parentNode) ? target.parentNode : target);
      }
      observer.takeRecords();   // the changes we just made
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function onDom(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }

  if (collecting || lang === 'en') {
    ready = Promise.resolve();
  } else {
    var root = document.documentElement;
    root.lang = lang === 'zh' ? 'zh-Hans' : lang;
    root.classList.add('ace-i18n-wait');
    var reveal = function () { root.classList.remove('ace-i18n-wait'); };
    var timer = setTimeout(reveal, 4000);   // a slow or failed download shows the English page rather than nothing
    var load = fetch('/assets/i18n/' + lang + '.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    ready = new Promise(function (resolve) {
      load.then(function (c) { cat = c; compile(); }, function (e) { if (window.aceReport) window.aceReport(e); })
        .then(function () { onDom(function () { translateHead(); walk(document.body); labelSwitcher(); showNotes(); observe(); clearTimeout(timer); reveal(); resolve(); }); });
    });
  }
  var style = document.createElement('style'); style.textContent = css; (document.head || document.documentElement).appendChild(style);
  onDom(switcher);

  window.aceI18n = {
    lang: lang, langs: LANGS, ready: ready, t: t, setLang: setLang,
    translate: function (el) { if (lang !== 'en' || keys) walk(el || document.body); },
    // for scripts/i18n-site.mjs and the tests
    keys: function () { return keys ? Object.keys(keys) : []; },
    missing: function () { return Object.keys(missing); },
    collectHead: translateHead
  };
})();

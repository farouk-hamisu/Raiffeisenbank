// Raiffeisen Bank — multicurrency display layer (USD / HUF)
// ---------------------------------------------------------------
// The UI language picks the display currency: English -> USD, Hungarian -> HUF.
// UI.money/formatDate/formatDateTime register every rendered string here, and
// FX.refresh() rewrites text nodes (plus translated attributes) whenever the
// language or the exchange rates change — a language switch therefore updates
// all monetary values live, without a page reload.
//
// Rates come from the public exchange_rates table (cached in localStorage);
// APP_CONFIG.usdHufRate is the offline fallback. Non-fiat codes (BTC ...) are
// rendered as quantities and never converted.
(function (global) {
  'use strict';

  var FIAT = { USD: 1, HUF: 1 };
  var PAIRS = ['USD', 'HUF'];
  var RATE_CACHE_KEY = 'rb_rates_v1';
  var MAX_REGISTRY = 800;
  var MAX_ALTERNATION = 600;

  var ATTRS = ['title', 'placeholder', 'alt', 'aria-label', 'aria-placeholder',
               'data-label', 'data-tooltip', 'data-confirm'];
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CODE: 1, PRE: 1 };

  // $ amounts (static HTML, dictionary strings, server text)
  var RE_USD_SYM = /([+-]?)\$\s?(-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)/g;
  // "450.00 USD" / "500 USD" — but never the "1 USD = BTC" style rate labels
  var RE_USD_CODE = /([+-]?)(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s?USD\b(?!\s*=\s*)/g;
  // "486 700 Ft" / "1 234,56 HUF" (Hungarian grouping)
  var RE_HUF = /([+-]?)(\d{1,3}(?:[ \u00A0\u202F]\d{3})+(?:[,.]\d{1,2})?|\d+(?:[,.]\d{1,2})?)\s?(?:Ft|HUF)\b/g;

  var rates = Object.create(null);   // 'USDHUF' -> rate
  var registry = new Map();          // rendered string -> {t:1 money|2 date|3 datetime, ...}
  var regVersion = 0;
  var regCache = { v: -1, re: null };
  var listeners = [];
  var lastKey = null;

  // ---------------------------------------------------------------- rates
  var fallback = (global.APP_CONFIG && Number(APP_CONFIG.usdHufRate)) || 392.5;
  rates.USDHUF = fallback;
  rates.HUFUSD = 1 / fallback;

  function rateKey() {
    return rates.USDHUF + '/' + rates.HUFUSD;
  }

  function normalize() {
    PAIRS.forEach(function (a) {
      PAIRS.forEach(function (b) {
        if (a === b) return;
        var fwd = rates[a + b], rev = rates[b + a];
        if (fwd > 0 && !(rev > 0)) rates[b + a] = 1 / fwd;
        else if (rev > 0 && !(fwd > 0)) rates[a + b] = 1 / rev;
      });
    });
  }

  function applyRateMap(map) {
    var before = rateKey();
    Object.keys(map).forEach(function (k) {
      var v = Number(map[k]);
      if (v > 0) rates[k] = v;
    });
    normalize();
    var after = rateKey();
    try { localStorage.setItem(RATE_CACHE_KEY, JSON.stringify({ USDHUF: rates.USDHUF })); } catch (e) {}
    return before !== after;
  }

  function loadRates() {
    var cfg = global.APP_CONFIG || {};
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !global.fetch) return Promise.resolve(null);
    return fetch(cfg.supabaseUrl + '/rest/v1/exchange_rates?select=base_currency,quote_currency,rate', {
      headers: { apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + cfg.supabaseAnonKey }
    }).then(function (res) {
      return res && res.ok ? res.json() : null;
    }).then(function (rows) {
      if (!rows || !rows.length) return null;
      var map = {};
      var seen = false;
      rows.forEach(function (row) {
        var b = String(row.base_currency || '').toUpperCase();
        var q = String(row.quote_currency || '').toUpperCase();
        var v = Number(row.rate);
        if (!FIAT[b] || !FIAT[q] || !(v > 0)) return;
        map[b + q] = v;
        seen = true;
      });
      if (!seen) return null;
      var changed = applyRateMap(map);
      if (changed) refresh();
      return map;
    }).catch(function () { return null; });
  }

  try {
    var cached = JSON.parse(localStorage.getItem(RATE_CACHE_KEY) || 'null');
    if (cached && Number(cached.USDHUF) > 0) applyRateMap({ USDHUF: Number(cached.USDHUF) });
  } catch (e) {}

  // ------------------------------------------------------------- currency
  function langCode() {
    if (global.I18N && I18N.lang) return I18N.lang();
    var l = document.documentElement && document.documentElement.lang;
    return l === 'hu' ? 'hu' : 'en';
  }

  function displayCurrency() { return langCode() === 'hu' ? 'HUF' : 'USD'; }
  function locale() { return langCode() === 'hu' ? 'hu-HU' : 'en-US'; }
  function isFiat(code) { return !!FIAT[String(code || '').toUpperCase()]; }

  function getRate(from, to) {
    from = String(from || '').toUpperCase();
    to = String(to || '').toUpperCase();
    if (from === to) return 1;
    var direct = rates[from + to];
    if (direct > 0) return direct;
    var a = rates[from + 'USD'];
    var b = rates['USD' + to];
    if (a > 0 && b > 0) return a * b;
    return null;
  }

  function convert(value, from, to) {
    var n = Number(value);
    if (isNaN(n)) return value;
    if (!isFiat(from) || !isFiat(to)) return n;
    var r = getRate(from, to);
    if (r == null) return n;
    return n * r;
  }

  function decimals(code) { return code === 'HUF' ? 0 : 2; }

  function formatMoney(value, code) {
    var n = Number(value) || 0;
    code = String(code || 'USD').toUpperCase();
    if (code === 'USD' || code === 'HUF') {
      try {
        return new Intl.NumberFormat(code === 'HUF' ? 'hu-HU' : 'en-US', {
          style: 'currency', currency: code,
          minimumFractionDigits: decimals(code), maximumFractionDigits: decimals(code)
        }).format(n);
      } catch (e) {}
    }
    var sym = (global.APP_CONFIG && APP_CONFIG.currencySymbols && APP_CONFIG.currencySymbols[code]) || '';
    var num;
    try {
      num = new Intl.NumberFormat(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(n);
    } catch (e) {
      num = n.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 8 });
    }
    return sym ? sym + num : num + ' ' + code;
  }

  // ------------------------------------------------------------- registry
  function register(text, entry) {
    if (!text || registry.has(text)) return;
    registry.set(text, entry);
    regVersion++;
    if (registry.size > MAX_REGISTRY) {
      var stale = [];
      registry.forEach(function (e, k) { if (e.t === 1) stale.push(k); });
      for (var i = 0; i < stale.length && registry.size > MAX_REGISTRY - 100; i++) registry.delete(stale[i]);
      regVersion++;
    }
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function registryRe() {
    if (regCache.v === regVersion) return regCache.re;
    var keys = [];
    registry.forEach(function (e, k) { if (k) keys.push(k); });
    if (keys.length > MAX_ALTERNATION) keys = keys.slice(keys.length - MAX_ALTERNATION);
    keys.sort(function (a, b) { return b.length - a.length; });
    var re = null;
    if (keys.length) {
      try { re = new RegExp(keys.map(escapeRe).join('|'), 'g'); } catch (e) { re = null; }
    }
    regCache = { v: regVersion, re: re };
    return re;
  }

  function reformat(entry) {
    if (!entry) return null;
    if (entry.t === 1) {
      var src = String(entry.c || 'USD').toUpperCase();
      var v = Number(entry.v) || 0;
      if (isFiat(src)) {
        var d = displayCurrency();
        return formatMoney(convert(v, src, d), d);
      }
      return formatMoney(v, src);
    }
    if (entry.t === 2) return formatDate(entry.i);
    if (entry.t === 3) return formatDateTime(entry.i);
    return null;
  }

  // ---------------------------------------------------------- formatters
  function format(value, currency) {
    var n = Number(value) || 0;
    var src = String(currency || 'USD').toUpperCase();
    var text;
    if (isFiat(src)) {
      var d = displayCurrency();
      text = formatMoney(convert(n, src, d), d);
    } else {
      text = formatMoney(n, src);
    }
    register(text, { t: 1, v: n, c: src });
    return text;
  }

  // Formats a value in its own currency (no display-currency conversion) —
  // for figures that are explicitly labelled with their currency in the UI.
  function formatExact(value, currency) {
    return formatMoney(Number(value) || 0, String(currency || 'USD').toUpperCase());
  }

  function formatDate(input) {
    if (!input) return '\u2014';
    var d = new Date(input);
    if (isNaN(d)) return '\u2014';
    var text;
    try {
      text = d.toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
      text = d.toLocaleDateString();
    }
    register(text, { t: 2, i: input });
    return text;
  }

  function formatDateTime(input) {
    if (!input) return '\u2014';
    var d = new Date(input);
    if (isNaN(d)) return '\u2014';
    var text;
    try {
      text = d.toLocaleString(locale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      text = d.toLocaleString();
    }
    register(text, { t: 3, i: input });
    return text;
  }

  // ------------------------------------------------------- text conversion
  function parseUsd(s) {
    var n = parseFloat(String(s).replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }

  function parseHuf(s) {
    var t = String(s).replace(/[\s\u00A0\u202F]/g, '');
    if (/^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, '');
    else if (t.indexOf(',') > -1 && t.indexOf('.') === -1) t = t.replace(',', '.');
    else t = t.replace(/,/g, '');
    var n = parseFloat(t);
    return isNaN(n) ? null : n;
  }

  function patternPass(text) {
    if (text.indexOf('$') === -1 && !/Ft|HUF|USD/.test(text)) return text;
    var out = text;
    var target = displayCurrency();
    if (target === 'HUF') {
      out = out.replace(RE_USD_SYM, function (m, sign, num) {
        var v = parseUsd(num);
        if (v == null) return m;
        if (sign === '-') v = -v;
        var s = formatMoney(convert(v, 'USD', 'HUF'), 'HUF');
        return sign === '+' && v > 0 ? '+' + s : s;
      });
      out = out.replace(RE_USD_CODE, function (m, sign, num) {
        var v = parseUsd(num);
        if (v == null) return m;
        if (sign === '-') v = -v;
        var s = formatMoney(convert(v, 'USD', 'HUF'), 'HUF');
        return sign === '+' && v > 0 ? '+' + s : s;
      });
    } else {
      out = out.replace(RE_HUF, function (m, sign, num) {
        var v = parseHuf(num);
        if (v == null) return m;
        if (sign === '-') v = -v;
        var s = formatMoney(convert(v, 'HUF', 'USD'), 'USD');
        return sign === '+' && v > 0 ? '+' + s : s;
      });
    }
    return out;
  }

  function convertText(text) {
    if (typeof text !== 'string' || !text) return text;
    if (!/\d/.test(text)) return text;
    var out = text;
    var re = registryRe();
    if (re) {
      re.lastIndex = 0;
      if (re.test(out)) {
        re.lastIndex = 0;
        out = out.replace(re, function (m) {
          var f = reformat(registry.get(m));
          return f != null ? f : m;
        });
      }
    }
    return patternPass(out);
  }

  // --------------------------------------------------------------- refresh
  function shouldSkip(el) {
    while (el && el.nodeType === 1) {
      if (SKIP_TAGS[el.tagName]) return true;
      if (el.hasAttribute && el.hasAttribute('data-fx-skip')) return true;
      if (el.isContentEditable) return true;
      el = el.parentNode;
    }
    return false;
  }

  function refresh() {
    if (!document.body) return;
    var walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var data = node.nodeValue;
        if (!data || !data.trim()) return NodeFilter.FILTER_REJECT;
        var p = node.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.tagName === 'INPUT' || p.tagName === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
        if (shouldSkip(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      var next = convertText(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
    }

    var els = document.body.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (shouldSkip(el)) continue;
      for (var a = 0; a < ATTRS.length; a++) {
        var name = ATTRS[a];
        if (!el.hasAttribute(name)) continue;
        var val = el.getAttribute(name);
        if (!val) continue;
        var nv = convertText(val);
        if (nv !== val) el.setAttribute(name, nv);
      }
    }

    var key = displayCurrency() + '|' + rateKey();
    if (lastKey === null) { lastKey = key; return; }
    if (key !== lastKey) { lastKey = key; notify(); }
  }

  // -------------------------------------------------------------- listeners
  function onRefresh(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) {}
    }
  }

  function boot() {
    // i18n.js translates first (it registers after us, so its DOMContentLoaded
    // handler runs first); refresh again once that pass has settled.
    loadRates();
    setTimeout(function () { refresh(); }, 0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.FX = {
    displayCurrency: displayCurrency,
    locale: locale,
    isFiat: isFiat,
    rate: getRate,
    convert: convert,
    format: format,
    formatExact: formatExact,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    convertText: convertText,
    refresh: refresh,
    onRefresh: onRefresh,
    loadRates: loadRates
  };
})(window);

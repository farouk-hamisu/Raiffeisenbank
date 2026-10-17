// Marvin Bank — multicurrency display layer
// ---------------------------------------------------------------
// The display currency is the user's admin-managed preferred currency
// (profiles.preferred_currency) when one is set; otherwise the UI
// language picks it: English -> USD, Hungarian -> HUF.
// UI.money/formatDate/formatDateTime register every rendered string here, and
// FX.refresh() rewrites text nodes (plus translated attributes) whenever the
// language, preferred currency or the exchange rates change — a switch
// therefore updates all monetary values live, without a page reload.
// Conversion is display-only: stored amounts and ledger records never change.
//
// Rates come from the public exchange_rates table (cached in localStorage);
// APP_CONFIG.usdHufRate is the offline USD/HUF fallback. Non-fiat codes
// (BTC ...) are rendered as quantities and never converted.
(function (global) {
  'use strict';

  // Display-convertible fiat currencies supported by the platform.
  var FIAT = { USD: 1, HUF: 1, EUR: 1, GBP: 1, NGN: 1, CAD: 1 };
  var DISP_FIATS = [
    { code: 'USD', name: 'US Dollar', symbol: '$' },
    { code: 'HUF', name: 'Hungarian Forint', symbol: 'Ft' },
    { code: 'EUR', name: 'Euro', symbol: '\u20AC' },
    { code: 'GBP', name: 'British Pound', symbol: '\u00A3' },
    { code: 'NGN', name: 'Nigerian Naira', symbol: '\u20A6' },
    { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$' }
  ];
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
  var RE_HUF = /([+-]?)(\d{1,3}(?:[   ]\d{3})+(?:[,.]\d{1,2})?|\d+(?:[,.]\d{1,2})?)\s?(?:Ft|HUF)\b/g;

  var rates = Object.create(null);   // 'USDHUF' -> rate
  var preferred = null;              // admin-set display currency override
  var registry = new Map();          // rendered string -> {t:1 money|2 date|3 datetime, ...}
  var regVersion = 0;
  var regCache = { v: -1, re: null };
  var listeners = [];
  var lastKey = null;

  // APP_CONFIG is declared with `const` in js/config.js, so it is a lexical
  // global but NOT a window property — read it via a bare identifier.
  function appConfig() {
    if (typeof APP_CONFIG !== 'undefined') return APP_CONFIG;
    return global.APP_CONFIG || {};
  }

  // ---------------------------------------------------------------- rates
  var fallback = Number(appConfig().usdHufRate) || 392.5;
  rates.USDHUF = fallback;
  rates.HUFUSD = 1 / fallback;

  function rateKey() {
    return rates.USDHUF + '/' + rates.HUFUSD;
  }

  function normalize() {
    Object.keys(rates).forEach(function (k) {
      if (k.length !== 6) return; // 'USDEUR' style pair keys only
      var fwd = rates[k];
      if (!(fwd > 0)) return;
      var a = k.slice(0, 3), b = k.slice(3);
      if (!(rates[b + a] > 0)) rates[b + a] = 1 / fwd;
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
    var cfg = appConfig();
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
    }).catch(function (e) {
      if (global.console && console.error) console.error('FX.loadRates failed', e);
      return null;
    });
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

  function displayCurrency() {
    if (preferred && FIAT[preferred]) return preferred;
    return langCode() === 'hu' ? 'HUF' : 'USD';
  }

  // Admin-managed per-user override (profiles.preferred_currency). Null/empty
  // or an unknown code falls back to the language default.
  function setPreferredCurrency(code) {
    code = String(code || '').toUpperCase();
    if (!code || !FIAT[code]) code = null;
    if (code === preferred) return false;
    preferred = code;
    if (global.FX && document.body) refresh();
    return true;
  }

  function fiats() { return DISP_FIATS.slice(); }

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
    if (isFiat(code)) {
      // Stable per-currency formatting: HUF keeps Hungarian style (0 decimals,
      // "Ft"), USD keeps US style; other fiats follow the UI language locale.
      var fmtLocale = code === 'HUF' ? 'hu-HU' : (code === 'USD' ? 'en-US' : locale());
      try {
        return new Intl.NumberFormat(fmtLocale, {
          style: 'currency', currency: code,
          minimumFractionDigits: decimals(code), maximumFractionDigits: decimals(code)
        }).format(n);
      } catch (e) {}
    }
    var sym = (appConfig().currencySymbols && appConfig().currencySymbols[code]) || '';
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
    if (entry.t === 4) return formatTime(entry.i);
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

  function formatTime(input) {
    if (!input) return '\u2014';
    var d = new Date(input);
    if (isNaN(d)) return '\u2014';
    var text;
    try {
      text = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      text = d.toLocaleTimeString();
    }
    register(text, { t: 4, i: input });
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
    function usdReplace(m, sign, num) {
      var v = parseUsd(num);
      if (v == null) return m;
      if (sign === '-') v = -v;
      var s = formatMoney(convert(v, 'USD', target), target);
      return sign === '+' && v > 0 ? '+' + s : s;
    }
    function hufReplace(m, sign, num) {
      var v = parseHuf(num);
      if (v == null) return m;
      if (sign === '-') v = -v;
      var s = formatMoney(convert(v, 'HUF', target), target);
      return sign === '+' && v > 0 ? '+' + s : s;
    }
    if (target !== 'USD') {
      out = out.replace(RE_USD_SYM, usdReplace);
      out = out.replace(RE_USD_CODE, usdReplace);
    }
    if (target !== 'HUF') {
      out = out.replace(RE_HUF, hufReplace);
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

  // Original (pre-conversion) strings, so a display-currency change can
  // re-convert from the source instead of leaving stale converted text.
  var srcNodes = new WeakMap();  // text node -> original string
  var srcAttrs = new WeakMap();  // element  -> { attr: original value }

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
      var cur = node.nodeValue;
      var src = srcNodes.get(node);
      // First sighting, or the node was rewritten externally (e.g. by the
      // i18n translator) — rebase the conversion source on the current text.
      if (src === undefined || node.fxLast !== cur) {
        src = cur;
        if (convertText(src) !== src) srcNodes.set(node, src);
        else srcNodes.delete(node);
      }
      var next = convertText(src);
      node.fxLast = next;
      if (next !== cur) node.nodeValue = next;
    }

    var els = document.body.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (shouldSkip(el)) continue;
      var saved = srcAttrs.get(el);
      for (var a = 0; a < ATTRS.length; a++) {
        var name = ATTRS[a];
        if (!el.hasAttribute(name)) continue;
        var val = el.getAttribute(name);
        if (!val) continue;
        if (!saved) { saved = {}; srcAttrs.set(el, saved); }
        var last = el.fxLastAttrs || (el.fxLastAttrs = {});
        if (saved[name] === undefined || last[name] !== val) saved[name] = val;
        var nv = convertText(saved[name]);
        last[name] = nv;
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
    setPreferredCurrency: setPreferredCurrency,
    fiats: fiats,
    locale: locale,
    isFiat: isFiat,
    rate: getRate,
    convert: convert,
    format: format,
    formatExact: formatExact,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    formatTime: formatTime,
    convertText: convertText,
    refresh: refresh,
    onRefresh: onRefresh,
    loadRates: loadRates
  };
})(window);

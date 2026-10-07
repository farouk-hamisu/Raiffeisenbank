// Raiffeisen Bank — i18n runtime (English ↔ Hungarian)
// ---------------------------------------------------------------
// How it works:
//   * Dictionary: window.LOCALE_HU  (js/locales/hu.js), keyed by the exact
//     English source string (whitespace normalised). Keys containing '*'
//     are patterns: '*' captures a runtime value (amount, name, date...).
//   * On load the whole DOM is walked once and every string is swapped.
//     The original English text is remembered on each node, so switching
//     back to English restores it exactly.
//   * A MutationObserver re-applies translations to JS-injected content
//     (toasts, dialogs, tables, skeletons replaced after fetch…).
//   * If a whole string is not in the dictionary, known English fragments
//     inside it are translated piecewise (covers 'You sent ' + amount + ...).
//   * The language switcher injects itself into the page header when there
//     is one, otherwise it floats at the bottom-right. Changing language
//     persists the choice and reloads so that JS-rendered content
//     (charts, dates, formatted numbers) is regenerated in the new locale.
// ---------------------------------------------------------------
(function () {
  'use strict';

  var STORAGE_KEY = 'rb_lang';
  var ATTRS = ['placeholder', 'title', 'alt', 'aria-label', 'aria-placeholder',
               'aria-description', 'data-label', 'data-tooltip', 'data-confirm'];
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, CODE: 1, PRE: 1 };
  var VALUE_TAGS = { INPUT: 1, BUTTON: 1 };

  var lang = detectLang();
  var dict = null;          // EN -> HU
  var patterns = null;      // [{re, parts, literal, score}]
  var fragExactRe = null;   // piecewise pass 1: whole keys
  var fragPatRe = null;     // piecewise pass 2: pattern keys ('*')
  var applying = false;
  var pending = false;
  var observer = null;

  // ---------------------------------------------------------------- language
  function detectLang() {
    var stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    if (stored === 'en' || stored === 'hu') return stored;
    var nav = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
    return nav.indexOf('hu') === 0 ? 'hu' : 'en';
  }

  function setLang(next, opts) {
    if (next !== 'en' && next !== 'hu') return;
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
    lang = next;
    document.documentElement.lang = next;
    if (!opts || opts.reload !== false) location.reload();
    else apply();
  }

  function toggleLang() { setLang(lang === 'hu' ? 'en' : 'hu'); }

  function locale() { return lang === 'hu' ? 'hu-HU' : 'en-US'; }

  // ------------------------------------------------------------- dictionary
  function ensureDict() {
    if (dict) return dict;
    dict = window.LOCALE_HU || {};
    patterns = [];
    for (var k in dict) {
      if (Object.prototype.hasOwnProperty.call(dict, k) && k.indexOf('*') !== -1) {
        var literal = k.replace(/\*/g, '');
        try {
          patterns.push({
            re: new RegExp('^' + k.split('*').map(escapeRe).join('(.*)') + '$'),
            parts: String(dict[k]).split('*'),
            literal: literal,
            leadStar: k.charAt(0) === '*',
            score: literal.length
          });
        } catch (e) {}
      }
    }
    patterns.sort(function (a, b) { return b.score - a.score; });
    fragExactRe = buildFragmentRe(false);
    fragPatRe = buildFragmentRe(true);
    return dict;
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Alternation over the dictionary so partially composed sentences
  // ('You sent ' + money + ' to ' + name) still get translated.
  // Two passes: whole keys first, pattern keys afterwards — a pattern must
  // never steal a match from a more specific exact key.
  function buildFragmentRe(patternsOnly) {
    var keys = Object.keys(dict).filter(function (k) {
      return patternsOnly ? k.indexOf('*') !== -1 : k.indexOf('*') === -1;
    }).sort(function (a, b) {
      return (b.replace(/\*/g, '').length) - (a.replace(/\*/g, '').length);
    });
    if (!keys.length) return null;
    var alts = keys.map(function (k) {
      return '(?<![A-Za-z0-9])' + k.split('*').map(escapeRe).join('.*?') + '(?![A-Za-z0-9])';
    });
    try { return new RegExp(alts.join('|'), 'g'); } catch (e) { return null; }
  }

  // Whole-string pattern match. `coverage` guards against greedy keys
  // swallowing a long sentence: a leading '*' may only capture a short
  // value (an amount, a count), a literal-heavy key must cover the input.
  function matchPattern(text, coverage) {
    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      var m = p.re.exec(text);
      if (!m) continue;
      if (coverage) {
        if (p.leadStar) {
          if ((m[1] || '').length > 8) continue;
        } else if (p.literal.length * 2 < text.length) {
          continue;
        }
      }
      var out = p.parts[0];
      for (var g = 1; g < p.parts.length; g++) {
        out += (m[g] === undefined ? '' : m[g]) + p.parts[g];
      }
      return out;
    }
    return null;
  }

  function t(src) {
    if (lang === 'en' || src == null) return src;
    ensureDict();
    var s = String(src);
    if (Object.prototype.hasOwnProperty.call(dict, s)) return dict[s];
    var whole = matchPattern(s, true);
    if (whole != null) return whole;
    // pass 1 — recognised whole words/phrases
    if (fragExactRe) {
      fragExactRe.lastIndex = 0;
      s = s.replace(fragExactRe, function (m) {
        return Object.prototype.hasOwnProperty.call(dict, m) ? dict[m] : m;
      });
    }
    // pass 2 — remaining English glued to dynamic values
    if (fragPatRe) {
      fragPatRe.lastIndex = 0;
      s = s.replace(fragPatRe, function (m) {
        var out = matchPattern(m, false);
        return out == null ? m : out;
      });
    }
    return s;
  }

  // ---------------------------------------------------------------- DOM walk
  function shouldSkipElement(el) {
    while (el && el.nodeType === 1) {
      if (SKIP_TAGS[el.tagName]) return true;
      if (el.hasAttribute && el.hasAttribute('data-i18n-skip')) return true;
      if (el.isContentEditable) return true;
      el = el.parentNode;
    }
    return false;
  }

  function translateTextNodes(root) {
    if (!root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var data = node.nodeValue;
        if (!data || !data.trim()) return NodeFilter.FILTER_REJECT;
        if (!/[A-Za-z]/.test(data)) return NodeFilter.FILTER_REJECT;
        var p = node.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.tagName === 'INPUT' || p.tagName === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
        if (shouldSkipElement(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      if (node.__i18nSrc === undefined) node.__i18nSrc = node.nodeValue;
      var raw = node.__i18nSrc;
      var norm = raw.replace(/\s+/g, ' ').trim();
      var out = t(norm);
      if (out === norm) {
        if (node.nodeValue !== raw) node.nodeValue = raw;
      } else {
        var lead = raw.match(/^\s*/)[0];
        var trail = raw.match(/\s*$/)[0];
        var next = lead + out + trail;
        if (node.nodeValue !== next) node.nodeValue = next;
      }
    }
  }

  function translateAttributes(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.nodeType === 1) {
      translateElementAttributes(root);
      var list = root.querySelectorAll('*');
      for (var i = 0; i < list.length; i++) translateElementAttributes(list[i]);
    }
  }

  function translateElementAttributes(el) {
    if (shouldSkipElement(el)) return;
    var changed = false;
    for (var a = 0; a < ATTRS.length; a++) {
      var name = ATTRS[a];
      if (!el.hasAttribute(name)) continue;
      var current = el.getAttribute(name);
      if (current == null || !/[A-Za-z]/.test(current)) continue;
      if (!el.__i18nAttrs) el.__i18nAttrs = {};
      if (el.__i18nAttrs[name] === undefined) el.__i18nAttrs[name] = current;
      var raw = el.__i18nAttrs[name];
      var norm = String(raw).replace(/\s+/g, ' ').trim();
      var out = t(norm);
      var next = out === norm ? raw : raw.match(/^\s*/)[0] + out + raw.match(/\s*$/)[0];
      if (next !== current) { el.setAttribute(name, next); changed = true; }
    }
    // <input type=submit|button> carries its label in `value`
    if (el.tagName === 'INPUT' && VALUE_TAGS[el.tagName] &&
        (el.type === 'submit' || el.type === 'button' || el.type === 'reset') &&
        el.hasAttribute('value') && /[A-Za-z]/.test(el.getAttribute('value') || '')) {
      if (!el.__i18nAttrs) el.__i18nAttrs = {};
      if (el.__i18nAttrs.value === undefined) el.__i18nAttrs.value = el.getAttribute('value');
      var ov = t(el.__i18nAttrs.value);
      if (ov !== el.getAttribute('value')) el.setAttribute('value', ov);
    }
    return changed;
  }

  function translateTitle() {
    var current = document.title;
    if (!current) return;
    var src = document.__i18nSrcTitle;
    if (src === undefined || (current !== document.__i18nAppliedTitle && current !== src)) {
      src = current;
      document.__i18nSrcTitle = src;
    }
    var out = t(src);
    document.__i18nAppliedTitle = out;
    if (current !== out) document.title = out;
  }

  // ------------------------------------------------------------- switcher
  function switcherHtml() {
    return '<button type="button" data-rb-lang="en" lang="en" class="rb-lang-opt' + (lang === 'en' ? ' is-on' : '') +
        '" aria-pressed="' + (lang === 'en') + '" aria-label="English">EN</button>' +
      '<button type="button" data-rb-lang="hu" lang="hu" class="rb-lang-opt' + (lang === 'hu' ? ' is-on' : '') +
        '" aria-pressed="' + (lang === 'hu') + '" aria-label="Magyar">HU</button>';
  }

  function ensureStyles() {
    if (document.getElementById('rb-i18n-style')) return;
    var css = document.createElement('style');
    css.id = 'rb-i18n-style';
    css.textContent = [
      '.rb-lang{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:999px;' +
      'background:#eef1f7;border:1px solid rgba(15,42,86,.10);box-shadow:inset 0 1px 2px rgba(15,42,86,.05);' +
      'flex:0 0 auto;white-space:nowrap;user-select:none;vertical-align:middle}',
      '.rb-lang-opt{appearance:none;-webkit-appearance:none;border:0;background:transparent;cursor:pointer;' +
      'font-family:inherit;font-size:11.5px;font-weight:700;letter-spacing:.06em;line-height:1;color:#5b6b85;' +
      'padding:7px 12px;border-radius:999px;transition:background .16s ease,color .16s ease,box-shadow .16s ease}',
      '.rb-lang-opt:hover{color:#0f2a56;background:rgba(255,255,255,.8)}',
      '.rb-lang-opt.is-on{background:#123a7e;color:#fff;box-shadow:0 1px 3px rgba(18,58,126,.35)}',
      '.rb-lang-opt:focus-visible{outline:2px solid #2f7de1;outline-offset:1px}',
      '.rb-lang-opt:active{transform:translateY(.5px)}',
      '.rb-lang.is-fixed{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:9999;' +
      'background:#fff;border-color:rgba(15,42,86,.14);box-shadow:0 10px 30px rgba(10,30,70,.18)}',
      '.site-nav .rb-lang{display:flex;margin:10px 24px 6px;padding:4px}' +
      '.site-nav .rb-lang .rb-lang-opt{flex:1 1 0;padding:12px 14px;font-size:13px;letter-spacing:.1em}',
      '.app-header .rb-lang{margin-left:auto}',
      '.app-header .hdr-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.site-header.is-tight .container{gap:6px}',
      '.site-header.is-tight .brand img{height:32px}',
      '.site-header.is-tight .site-actions{gap:6px}',
      '.site-header.is-tight .site-actions .btn{padding:6px 9px;font-size:12.5px}',
      '.site-header.is-tight .rb-lang-opt{padding:6px 8px;font-size:11px;letter-spacing:.04em}',
      '@media (min-width:1025px){.site-header.is-tight .site-nav{gap:10px}' +
      '.site-header.is-tight .site-nav a{font-size:13px}}',
      '@media (max-width:640px){.rb-lang-opt{padding:6px 11px;font-size:11px}}',
      '@media (max-width:560px){.site-header.is-tight .container{gap:5px}' +
      '.site-header.is-tight .site-actions{gap:4px}' +
      '.site-header.is-tight .brand img{height:30px}}',
      '@media (max-width:400px){.rb-lang{padding:2px;gap:1px}.rb-lang-opt{padding:6px 8px;font-size:10.5px;' +
      'letter-spacing:.04em}}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(css);
  }

  function rowFits() {
    var row = document.querySelector('.site-header .container');
    return !row || row.scrollWidth <= row.clientWidth + 1;
  }

  function syncTight() {
    var header = document.querySelector('.site-header');
    if (!header) return;
    var row = header.querySelector('.container');
    if (!row) return;
    header.classList.remove('is-tight');
    if (row.scrollWidth > row.clientWidth + 1) header.classList.add('is-tight');
  }

  function pickHost(el) {
    // marketing shell: header row first (relaxed, then compressed), else the nav panel
    var actions = document.querySelector('.site-actions');
    if (actions) {
      var header = document.querySelector('.site-header');
      if (el.parentNode !== actions) actions.appendChild(el);
      header.classList.remove('is-tight');
      if (rowFits()) return actions;
      header.classList.add('is-tight');
      if (rowFits()) return actions;
      var nav = document.getElementById('site-nav');
      if (nav && window.matchMedia && window.matchMedia('(max-width: 1024px)').matches) {
        if (el.parentNode !== nav) nav.appendChild(el);
        syncTight();
        return nav;
      }
      return actions;
    }
    // portal / admin app header
    return document.querySelector('.app-header');
  }

  function ensureSwitcher() {
    ensureStyles();
    var el = document.getElementById('rb-lang-switch');
    if (!el) {
      el = document.createElement('div');
      el.className = 'rb-lang';
      el.id = 'rb-lang-switch';
      el.setAttribute('data-i18n-skip', '1');
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', lang === 'hu' ? 'Nyelvválasztó' : 'Language selector');
      el.innerHTML = switcherHtml();
      el.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-rb-lang]') : null;
        if (!btn) return;
        var next = btn.getAttribute('data-rb-lang');
        if (next && next !== lang) setLang(next);
      });
    }
    var host = pickHost(el);
    if (host) {
      el.classList.remove('is-fixed');
      if (el.parentNode !== host) host.appendChild(el);
    } else {
      el.classList.add('is-fixed');
      if (el.parentNode !== document.body) document.body.appendChild(el);
    }
  }

  // ----------------------------------------------------------------- apply
  function apply() {
    if (!document.body) return;
    applying = true;
    try {
      if (observer) observer.disconnect();
      translateTitle();
      translateTextNodes(document.documentElement);
      translateAttributes(document.documentElement);
      ensureSwitcher();
    } finally {
      applying = false;
      startObserver();
    }
  }

  function schedule() {
    if (applying || pending) return;
    pending = true;
    setTimeout(function () { pending = false; apply(); }, 40);
  }

  function startObserver() {
    if (typeof MutationObserver === 'undefined') return;
    if (!observer) {
      observer = new MutationObserver(function () { schedule(); });
    }
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS.concat(['value'])
    });
  }

  // ---------------------------------------------------------------- public
  window.I18N = {
    lang: function () { return lang; },
    isHu: function () { return lang === 'hu'; },
    t: t,
    setLang: setLang,
    toggleLang: toggleLang,
    locale: locale,
    apply: apply
  };

  document.documentElement.lang = lang;

  function boot() { ensureDict(); apply(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.addEventListener('pageshow', function () { if (!applying) schedule(); });

  // re-place the switcher when crossing the mobile breakpoint (header <-> nav panel)
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      if (document.body) ensureSwitcher();
    }, 150);
  });
})();

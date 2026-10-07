// Raiffeisen Bank — UI helpers (toast, modal, formatters, badges, loading)
(function (global) {
  'use strict';

  // ---------- Toast notifications ----------
  function toast(message, type) {
    type = type || 'info';
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = '<span class="toast-text"></span><button class="toast-close">&times;</button>';
    el.querySelector('.toast-text').textContent = message;
    container.appendChild(el);
    const dismiss = () => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .2s';
      setTimeout(() => el.remove(), 200);
    };
    el.querySelector('.toast-close').addEventListener('click', dismiss);
    setTimeout(dismiss, 5000);
  }

  // ---------- Modal ----------
  function openModal(contentHTML, opts) {
    opts = opts || {};
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop open';
    backdrop.innerHTML =
      '<div class="modal ' + (opts.large ? 'modal-lg' : '') + '">' +
        '<div class="modal-header"><h3 class="modal-title"></h3><button class="modal-close">&times;</button></div>' +
        '<div class="modal-body"></div>' +
        (opts.footer ? '<div class="modal-footer"></div>' : '') +
      '</div>';
    backdrop.querySelector('.modal-title').textContent = opts.title || '';
    backdrop.querySelector('.modal-body').innerHTML = contentHTML;
    if (opts.footer) {
      backdrop.querySelector('.modal-footer').innerHTML = opts.footer;
    }
    const close = () => {
      backdrop.classList.remove('open');
      setTimeout(() => backdrop.remove(), 200);
    };
    backdrop.querySelector('.modal-close').addEventListener('click', close);
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop && opts.dismissable !== false) close();
    });
    document.body.appendChild(backdrop);
    return {
      close,
      el: backdrop,
      body: backdrop.querySelector('.modal-body'),
      footer: backdrop.querySelector('.modal-footer')
    };
  }

  function closeModal() {
    const b = document.querySelector('.modal-backdrop.open');
    if (b) b.remove();
  }

  // ---------- Confirm dialog ----------
  function confirmDialog(message, onConfirm, dangerText) {
    const modal = openModal(
      '<p class="mb-2"></p>',
      { footer: '<button class="btn btn-outline" data-act="cancel">Cancel</button><button class="btn ' + (dangerText ? 'btn-danger' : 'btn-primary') + '" data-act="ok"></button>' }
    );
    modal.body.querySelector('p').textContent = message;
    modal.footer.querySelector('[data-act=ok]').textContent = dangerText || 'Confirm';
    modal.footer.querySelector('[data-act=cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-act=ok]').addEventListener('click', function () {
      modal.close();
      onConfirm();
    });
  }

  // ---------- Security PIN input ----------
  function pinBoxesHTML(idPrefix) {
    let boxes = '';
    for (let i = 0; i < 4; i++) {
      boxes += '<input type="password" class="pin-digit" data-idx="' + i + '" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="PIN digit ' + (i + 1) + '">';
    }
    return '<div class="pin-inputs" id="' + (idPrefix || 'pin-boxes') + '">' + boxes + '</div>';
  }

  // Wires the 4-box masked PIN input. Returns { getPin, clear, focusFirst, setBusy }.
  // opts.onComplete(pin) is called when the 4th digit is entered.
  function mountPinInput(rootEl, opts) {
    opts = opts || {};
    const boxes = rootEl.querySelectorAll('.pin-digit');
    const values = ['', '', '', ''];
    const wrapper = rootEl.closest('.pin-inputs') || rootEl;

    function focusFirst() { if (boxes[0]) { boxes[0].focus(); boxes[0].select(); } }
    function getPin() { return values.join(''); }
    function clear() {
      values.fill('');
      boxes.forEach(function (b) { b.value = ''; b.classList.remove('is-filled'); });
      wrapper.classList.remove('has-error', 'is-shaking');
      focusFirst();
    }
    function error() {
      wrapper.classList.add('has-error');
      wrapper.classList.remove('is-shaking');
      void wrapper.offsetWidth;
      wrapper.classList.add('is-shaking');
    }
    function move(i) { if (i < 4 && boxes[i]) { boxes[i].focus(); boxes[i].select(); } }

    boxes.forEach(function (box, i) {
      box.addEventListener('input', function () {
        let digit = this.value.replace(/\D/g, '');
        if (digit.length > 1) digit = digit.slice(-1);
        this.value = digit;
        values[i] = digit;
        this.classList.toggle('is-filled', !!digit);
        wrapper.classList.remove('has-error');
        if (digit) {
          if (i < 3) move(i + 1);
          else if (opts.onComplete) opts.onComplete(getPin());
        }
      });
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace') {
          e.preventDefault();
          if (this.value !== '') {
            this.value = ''; values[i] = ''; this.classList.remove('is-filled');
          } else if (i > 0) {
            values[i - 1] = ''; boxes[i - 1].value = ''; boxes[i - 1].classList.remove('is-filled');
            move(i - 1);
          }
        }
      });
      box.addEventListener('paste', function (e) {
        e.preventDefault();
        const text = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\D/g, '').slice(0, 4);
        text.split('').forEach(function (ch, j) {
          const idx = i + j;
          if (idx < 4) { boxes[idx].value = ch; values[idx] = ch; boxes[idx].classList.add('is-filled'); }
        });
        wrapper.classList.remove('has-error');
        const ni = Math.min(i + text.length, 4);
        if (ni < 4) move(ni);
        else if (opts.onComplete) opts.onComplete(getPin());
      });
    });

    return { getPin, clear, focusFirst, error, boxes, wrapper };
  }

  // Call customer_verify_pin and translate the status into { ok, message, notSet }.
  async function verifyCustomerPin(pin) {
    const res = await rpc('customer_verify_pin', { p_pin: pin });
    if (res && res.status === 'ok') return { ok: true };
    if (res && res.status === 'locked') {
      return { ok: false, message: 'Too many incorrect attempts. Your PIN is locked. Please try again in about 15 minutes.' };
    }
    if (res && res.status === 'not_set') {
      return { ok: false, message: 'You have not set a security PIN yet.', notSet: true };
    }
    const left = res && typeof res.attempts_left === 'number' ? res.attempts_left : null;
    const msg = left !== null && left > 0
      ? 'Incorrect PIN. ' + left + ' attempt' + (left === 1 ? '' : 's') + ' remaining.'
      : 'Incorrect PIN.';
    return { ok: false, message: msg };
  }

  // Opens a modal PIN entry. opts.verify(pin) -> Promise<{ ok, message }>.
  // Resolves with the entered PIN on success, rejects if the user cancels.
  function promptPin(opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      const icon = (opts.icon && ICONS[opts.icon]) ? ICONS[opts.icon] : (ICONS.shield || '');
      const modal = openModal(
        '<div class="pin-modal">' +
          '<div class="pin-icon">' + icon + '</div>' +
          (opts.subtitle ? '<p class="pin-desc" style="font-weight:600;color:var(--text);margin-bottom:4px">' + escapeHtml(opts.subtitle) + '</p>' : '') +
          '<p class="pin-desc">' + escapeHtml(opts.message || 'Enter your 4-digit security PIN to continue.') + '</p>' +
          pinBoxesHTML('pin-prompt-boxes') +
          '<div class="form-error pin-error" id="pin-prompt-error"></div>' +
        '</div>',
        { title: opts.title || 'Confirm with PIN', footer: '<button class="btn btn-outline" data-act="cancel">Cancel</button>', dismissable: false }
      );
      const errEl = modal.body.querySelector('#pin-prompt-error');
      let busy = false;
      const controller = mountPinInput(modal.body.querySelector('.pin-inputs'), {
        onComplete: function (pin) { void verify(pin); }
      });
      function setError(msg) {
        errEl.textContent = msg || '';
        if (msg) controller.error();
      }
      async function verify(pin) {
        if (busy) return;
        busy = true;
        setError('');
        try {
          const fn = opts.verify || verifyCustomerPin;
          const res = await fn(pin);
          if (res && res.ok) {
            modal.close();
            resolve(pin);
          } else {
            controller.clear();
            setError((res && res.message) || 'Incorrect PIN.');
          }
        } catch (e) {
          controller.clear();
          setError(apiErrorMessage(e));
        } finally {
          busy = false;
        }
      }
      modal.footer.querySelector('[data-act=cancel]').addEventListener('click', function () {
        modal.close();
        reject(new Error('CANCELLED'));
      });
      controller.focusFirst();
    });
  }

  // ---------- Loading ----------
  function loading(el, message) {
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span></span></div>';
    if (message) el.querySelector('span').textContent = message;
  }

  // ---------- Full-page loading screen ----------
  const PageLoader = {
    el: null,
    shown: false,
    _shownAt: 0,
    _hideTimer: null,
    _msgTimer: null,
    _msgIdx: 0,
    messages: [
      'Preparing your workspace',
      'Securing your session',
      'Loading your accounts',
      'Fetching your balances',
      'Syncing latest activity'
    ],

    build() {
      if (this.el && this.el.parentNode) return this.el;
      // reuse a static #page-loader element if present in the page markup
      const existing = document.getElementById('page-loader');
      if (existing) { this.el = existing; return existing; }
      const div = document.createElement('div');
      div.className = 'page-loader';
      div.id = 'page-loader';
      div.setAttribute('role', 'status');
      div.setAttribute('aria-live', 'polite');
      div.innerHTML =
        '<div class="pl-inner">' +
          '<div class="pl-orbit">' +
            '<span class="pl-ring"></span>' +
            '<span class="pl-ring pl-ring--2"></span>' +
            '<span class="pl-ring pl-ring--3"></span>' +
            '<span class="pl-core"></span>' +
          '</div>' +
          '<div class="pl-track"><span class="pl-progress"></span></div>' +
          '<p class="pl-status" id="pl-status">' + this.messages[0] + '</p>' +
        '</div>';
      this.el = div;
      return div;
    },

    show(message) {
      const el = this.build();
      if (!el.parentNode) document.body.appendChild(el);
      this.shown = true;
      this._shownAt = Date.now();
      clearTimeout(this._hideTimer);

      const status = el.querySelector('#pl-status');
      if (status) {
        status.textContent = message || this.messages[0];
        this._msgIdx = 0;
      }
      if (!message) this._startCycle();
      return el;
    },

    _startCycle() {
      clearInterval(this._msgTimer);
      this._msgTimer = setInterval(() => {
        const el = this.el;
        if (!el) return;
        const status = el.querySelector('#pl-status');
        if (!status) return;
        this._msgIdx = (this._msgIdx + 1) % this.messages.length;
        status.classList.add('is-swapping');
        setTimeout(() => {
          status.textContent = this.messages[this._msgIdx];
          status.classList.remove('is-swapping');
        }, 240);
      }, 1800);
    },

    _stopCycle() {
      clearInterval(this._msgTimer);
      this._msgTimer = null;
    },

    hide() {
      if (!this.shown) return;
      this.shown = false;
      this._stopCycle();
      const minWait = Math.max(0, 400 - (Date.now() - this._shownAt));
      this._hideTimer = setTimeout(() => {
        const el = this.el;
        if (!el || !el.parentNode) return;
        el.classList.add('is-hidden');
        el.addEventListener('transitionend', function onEnd() {
          el.removeEventListener('transitionend', onEnd);
          if (el.parentNode) el.parentNode.removeChild(el);
        });
        setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 600);
      }, minWait);
    }
  };

  // ---------- Credit card (realistic, masked-by-default) ----------
  // Deterministic per-seed generator so every user sees their own test digits.
  function hashCode(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function luhnCheckDigit(partial) {
    let sum = 0;
    let even = false;
    for (let i = partial.length - 1; i >= 0; i--) {
      let d = Number(partial[i]);
      if (even) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      even = !even;
    }
    return String((10 - (sum % 10)) % 10);
  }

  function cardDigits(seed) {
    const h = hashCode(String(seed == null ? 'nb' : seed));
    const brand = 'mastercard';
    const prefix = '5';
    let x = h;
    const next = function () {
      x ^= x << 13; x >>>= 0;
      x ^= x >> 17;
      x ^= x << 5; x >>>= 0;
      return x % 10;
    };
    let partial = prefix;
    for (let i = 0; i < 14; i++) partial += next();
    const num = partial + luhnCheckDigit(partial + '0');
    const full = num.replace(/(.{4})/g, '$1 ').trim();
    const masked = '•••• •••• •••• ' + num.slice(-4);
    const cvv = String(100 + (h % 900));
    const mm = String(((h >>> 8) % 12) + 1).padStart(2, '0');
    const yy = String(((h >>> 16) % 9) + 27);
    return { brand, full, masked, cvv, expiry: mm + '/' + yy, last4: num.slice(-4) };
  }

  function cardBrandMark(brand) {
    return '<span class="cf-brandmark is-mastercard"><i></i><i></i></span>';
  }

  // Renders a realistic card face. card may be a DB row (or null for fallback).
  // Single source of truth: when the DB row carries a stored card_number/cvv those
  // values are used (identical everywhere), generated digits are only a fallback.
  function renderCardFace(card, opts) {
    opts = opts || {};
    const uid = (typeof Auth !== 'undefined' && Auth.user && Auth.user.id) || 'guest';
    const seed = (card && card.id) ? String(card.id) : (uid + ':' + (opts.salt || ''));
    const d = cardDigits(seed);
    const brand = (card && card.card_brand) || d.brand;
    const frozen = !!(card && card.status === 'frozen');
    const hasStored = !!(card && card.card_number && /^\d{10,}$/.test(String(card.card_number)));
    const full = hasStored ? String(card.card_number).replace(/(.{4})/g, '$1 ').trim() : d.full;
    const cvv = hasStored ? String(card.cvv || '').padStart(3, '0') : d.cvv;
    const masked = (card && card.masked_number && /[0-9]/.test(card.masked_number)) ? card.masked_number : d.masked;
    const holder = (card && card.card_holder) || opts.holder || 'Card Holder';
    const expiry = (card && card.expiry_month)
      ? card.expiry_month + '/' + String(card.expiry_year).slice(-2)
      : (opts.expiry || d.expiry);
    const faceClass = 'card-face card-face--' + brand + (frozen ? ' is-frozen' : '');
    return '<div class="' + faceClass + '" data-cvv="' + cvv + '">' +
      '<div class="cf-top">' +
        '<span class="cf-issuer">Raiffeisen Bank</span>' +
        '<button class="cf-eye" type="button" aria-label="Show card number and CVV">' +
          ICONS.eye + ICONS.eyeOff +
        '</button>' +
      '</div>' +
      '<div class="cf-chip"><i></i></div>' +
      '<div class="cf-number">' +
        '<span class="cf-num-masked">' + escapeHtml(masked) + '</span>' +
        '<span class="cf-num-full">' + escapeHtml(full) + '</span>' +
      '</div>' +
      '<div class="cf-row">' +
        '<div class="cf-col"><small>Card Holder</small><strong>' + escapeHtml(holder) + '</strong></div>' +
        '<div class="cf-col"><small>Expires</small><strong>' + escapeHtml(expiry) + '</strong></div>' +
        '<div class="cf-col cf-cvv"><small>CVV</small>' +
          '<strong class="cf-cvv-masked">•••</strong><strong class="cf-cvv-full">' + cvv + '</strong></div>' +
      '</div>' +
      cardBrandMark(brand) +
    '</div>';
  }

  // Delegated toggle for the card eye control (works with innerHTML-rendered cards).
  document.addEventListener('click', function (e) {
    const eye = e.target.closest('.cf-eye');
    if (!eye) return;
    const face = eye.closest('.card-face');
    if (!face) return;
    const revealed = face.classList.toggle('is-revealed');
    face.classList.toggle('is-masked', !revealed);
    eye.setAttribute('aria-label', revealed ? 'Hide card number and CVV' : 'Show card number and CVV');
    eye.setAttribute('aria-pressed', revealed ? 'true' : 'false');
  });

  // ---------- Formatters ----------
  const currencySymbols = APP_CONFIG.currencySymbols || { USD: '$' };
  // Active UI locale (js/i18n.js): 'en-US' or 'hu-HU' — dates/numbers follow the language switcher.
  function i18nLocale() {
    return (window.I18N && I18N.locale && I18N.locale()) || 'en-US';
  }

  function money(amount, currency) {
    const n = Number(amount) || 0;
    const sym = currencySymbols[currency] || (currency ? currency + ' ' : '') || '$';
    return sym + n.toLocaleString(i18nLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDate(input) {
    if (!input) return '—';
    const d = new Date(input);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString(i18nLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatDateTime(input) {
    if (!input) return '—';
    const d = new Date(input);
    if (isNaN(d)) return '—';
    return d.toLocaleString(i18nLocale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function timeAgo(input) {
    if (!input) return '—';
    const then = new Date(input).getTime();
    if (isNaN(then)) return '—';
    const secs = Math.floor((Date.now() - then) / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    if (days < 30) return days + 'd ago';
    return formatDate(input);
  }

  function initial(name) {
    if (!name) return 'U';
    return name.split(' ').filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  // ---------- Avatar (profile picture or initials fallback) ----------
  // Central renderer so every surface shows the same image. Appends a cache-busting
  // version derived from the profile's updated_at so a replaced image is refetched.
  // opts: { size: 'lg'|'xl', id }
  function avatar(person, opts) {
    opts = opts || {};
    const name = (person && person.full_name) || 'U';
    const url = person && person.avatar_url;
    const size = opts.size === 'lg' ? ' avatar-lg' : opts.size === 'xl' ? ' avatar-xl' : '';
    const id = opts.id ? ' id="' + opts.id + '"' : '';
    const initials = escapeHtml(initial(name));
    if (!url) {
      return '<span class="avatar' + size + '"' + id + '>' + initials + '</span>';
    }
    const sep = url.indexOf('?') > -1 ? '&' : '?';
    const v = person && person.updated_at ? new Date(person.updated_at).getTime() : Date.now();
    return '<span class="avatar' + size + ' avatar-img"' + id + ' data-initials="' + initials + '">' +
      '<img class="avatar-img-src" src="' + escapeHtml(url) + sep + 'v=' + v + '" alt="' + initials + '" loading="lazy" decoding="async" referrerpolicy="no-referrer">' +
    '</span>';
  }

  // Swaps a failed avatar image back to initials (capture phase; error doesn't bubble).
  document.addEventListener('error', function (e) {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.classList.contains('avatar-img-src')) {
      const holder = img.closest('.avatar-img');
      if (holder) {
        holder.classList.remove('avatar-img');
        holder.innerHTML = holder.getAttribute('data-initials') || 'U';
      }
    }
  }, true);

  // ---------- Badges ----------
  function badge(status) {
    const map = {
      pending: 'badge-pending', processing: 'badge-processing', completed: 'badge-completed',
      active: 'badge-active', failed: 'badge-failed', cancelled: 'badge-cancelled',
      reversed: 'badge-reversed', rejected: 'badge-rejected', frozen: 'badge-frozen',
      blocked: 'badge-blocked', expired: 'badge-expired', under_review: 'badge-under_review',
      approved: 'badge-success', paid: 'badge-success', scheduled: 'badge-info',
      overdue: 'badge-overdue', inactive: 'badge-neutral', suspended: 'badge-failed',
      closed: 'badge-neutral', verified: 'badge-success', opened: 'badge-info',
      awaiting_admin_verification: 'badge-pending', used: 'badge-info', revoked: 'badge-rejected'
    };
    const cls = map[status] || 'badge-neutral';
    const labels = { awaiting_admin_verification: 'Pending verification' };
    const label = labels[status] || String(status || '').replace(/_/g, ' ');
    return '<span class="badge ' + cls + '">' + escapeHtml(label) + '</span>';
  }

  function typeLabel(type) {
    return String(type || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // ---------- Escape ----------
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- Empty state ----------
  function emptyState(message) {
    return '<div class="empty-state"><div class="empty-icon">' + ICONS.inbox + '</div><h3>' + escapeHtml(message || 'No records found') + '</h3></div>';
  }

  // ---------- Error messaging (user-safe) ----------
  function friendlyError(code) {
    const map = {
      INSUFFICIENT_FUNDS: 'Insufficient funds for this transaction.',
      INVALID_ACCOUNT: 'The selected account is invalid or inactive.',
      CURRENCY_MISMATCH: 'The account currency does not match the transaction currency.',
      INVALID_CREDENTIALS: 'Invalid email or password.',
      FORBIDDEN: 'You do not have permission to perform this action.',
      UNAUTHORIZED: 'Your session has expired. Please log in again.',
      EMAIL_EXISTS: 'An account with this email already exists.',
      RATE_NOT_AVAILABLE: 'No exchange rate is currently available for this pair.',
      SAME_CURRENCY: 'Source and destination currency must be different.',
      DEPOSIT_NOT_FOUND: 'Deposit not found.',
      CARD_NOT_FOUND: 'Card not found.',
      TRANSACTION_NOT_FOUND: 'Transaction not found.',
      TRANSFER_NOT_FOUND: 'Transfer not found.',
      LOAN_NOT_FOUND: 'Loan application not found.',
      PRODUCT_NOT_FOUND: 'Loan product not found.',
      CURRENCY_NOT_FOUND: 'Currency not found.',
      CURRENCY_IN_USE: 'Currency cannot be deleted because it is in use.',
      PRODUCT_IN_USE: 'Loan product cannot be deleted because it has applications.',
      REPAYMENT_NOT_FOUND: 'Repayment record not found.',
      TRANSACTION_NOT_COMPLETED: 'Only completed transactions can be reversed.',
      USER_NOT_FOUND: 'User not found.',
      ACCOUNT_NOT_FOUND: 'Account not found.',
      ADMIN_NOT_FOUND: 'Admin user not found.',
      ROLE_NOT_FOUND: 'Role not found.',
      PIN_LOCKED: 'Your PIN is locked due to too many failed attempts. Please try again in about 15 minutes.',
      PIN_NOT_SET: 'You have not set a security PIN yet. Please set one to continue.',
      INVALID_PIN: 'Incorrect PIN. Please try again.',
      INVALID_PIN_FORMAT: 'Your PIN must be exactly 4 digits.',
      INVALID_LIMIT: 'Enter a valid spending limit.',
      CANCELLED: 'Action cancelled.',
      ASSET_NOT_SUPPORTED: 'This cryptocurrency asset is not supported.',
      ASSET_LIMIT: 'The amount is outside the allowed range for this asset.',
      CRYPTO_REQUIRES_BASE_CURRENCY: 'Crypto withdrawals require a base currency (USD) account.',
      OUTGOING_TRANSFERS_DISABLED: 'Outgoing transfers are currently disabled on your account. Contact support for details.',
      REASON_REQUIRED: 'A reason is required to disable outgoing transfers.',
      INVALID_TYPE: 'Invalid transfer type.',
      TRANSFER_NOT_VERIFIABLE: 'This transfer is not awaiting verification.',
      CODE_NOT_FOUND: 'Verification code not found.',
      WITHDRAWAL_NOT_FOUND: 'Withdrawal not found.',
      'Bad Request': 'The request was invalid. Please check your input.'
    };
    return map[code] || 'An unexpected error occurred. Please try again later.';
  }

  function apiErrorMessage(err) {
    if (err && err.message) {
      const code = err.message.split('\n')[0].trim();
      return friendlyError(code);
    }
    if (typeof err === 'string') return friendlyError(err);
    return 'An unexpected error occurred. Please try again.';
  }

  // ---------- RPC helper with proper error handling ----------
  async function rpc(name, params) {
    const { data, error } = await SB.rpc(name, params || {});
    if (error) {
      const code = (error.message || '').split('\n')[0].trim();
      throw new Error(code);
    }
    return data;
  }

  // ---------- Clipboard (secure context + legacy fallback) ----------
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) { /* fall through */ }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  // ---------- Query params ----------
  function qs(key) {
    return new URLSearchParams(window.location.search).get(key);
  }

  // ---------- Transfer verification code entry ----------
  // Opens the admin-issued one-time code modal. Calls onResult(status, payload)
  // after the flow completes (ok or a terminal failure).
  async function verifyTransferCode(transferType, transferId, onResult) {
    let status;
    try {
      status = await rpc('customer_transfer_verification_status', { p_transfer_type: transferType, p_transfer_id: transferId });
    } catch (e) {
      toast(apiErrorMessage(e), 'error');
      return;
    }

    const body =
      '<div class="field">' +
        '<label>One-time verification code</label>' +
        '<input type="text" class="input" id="vc-code" maxlength="8" autocomplete="off" spellcheck="false" autocapitalize="characters" ' +
          'style="text-transform:uppercase;letter-spacing:4px;text-align:center;font-family:ui-monospace,monospace;font-size:18px" placeholder="••••-XXXX">' +
        '<div class="text-muted text-sm" id="vc-hint" style="margin-top:6px"></div>' +
      '</div>' +
      '<div class="form-error" id="vc-error"></div>';

    const modal = openModal(body, {
      title: 'Verify Transfer',
      footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-send>Verify</button>'
    });
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    const send = modal.footer.querySelector('[data-send]');

    const hint = modal.body.querySelector('#vc-hint');
    if (status && status.code_issued) {
      hint.textContent = 'A verification code has been issued (ends ' + (status.code_prefix || '') + '). ' +
        (status.attempts_left != null ? status.attempts_left + ' attempts remaining. ' : '') +
        'Your code will expire at ' + formatDateTime(status.expires_at) + '.';
    } else {
      hint.textContent = 'No verification code has been issued yet. Please contact support to obtain your code.';
    }

    send.addEventListener('click', async function () {
      const input = modal.body.querySelector('#vc-code');
      const code = (input.value || '').trim().toUpperCase();
      const err = modal.body.querySelector('#vc-error');
      err.textContent = '';
      if (!/^[A-Z0-9]{8}$/.test(code)) {
        err.textContent = 'Enter the full 8-character code you received (letters and numbers).';
        return;
      }
      send.disabled = true;
      send.textContent = 'Verifying...';
      try {
        const res = await rpc('customer_verify_transfer', { p_transfer_type: transferType, p_transfer_id: transferId, p_code: code });
        const st = res && res.status;
        if (st === 'ok') {
          toast('Transfer verified. It is now processing.', 'success');
          modal.close();
          if (onResult) onResult('ok', res);
        } else if (st === 'invalid_code') {
          err.textContent = 'Incorrect code.' + (res.attempts_left != null ? ' ' + res.attempts_left + ' attempt(s) remaining.' : '');
          send.disabled = false;
          send.textContent = 'Verify';
          input.value = '';
          input.focus();
        } else if (st === 'attempts_exceeded') {
          err.textContent = 'Too many incorrect attempts. The code has been invalidated. Please contact support for a new code.';
          modal.close();
          if (onResult) onResult('attempts_exceeded', res);
        } else {
          const label = { used: 'This code has already been used.', revoked: 'This code has been revoked.', expired: 'This code has expired.', no_code: 'No verification code has been issued for this transfer yet.', failed_insufficient_funds: 'Verification passed but the transfer could not be processed due to insufficient funds.', invalid_format: 'Enter the full 8-character code.' }[st] || 'The code could not be verified.';
          if (st === 'failed_insufficient_funds' || st === 'used' || st === 'revoked' || st === 'expired' || st === 'no_code') {
            modal.close();
            if (onResult) onResult(st, res);
          } else {
            err.textContent = label;
            send.disabled = false;
            send.textContent = 'Verify';
          }
        }
      } catch (e) {
        err.textContent = apiErrorMessage(e);
        send.disabled = false;
        send.textContent = 'Verify';
      }
    });
    const input = modal.body.querySelector('#vc-code');
    setTimeout(function () { if (input) input.focus(); }, 60);
  }

  // ---------- Transfer progress flow (intl + crypto only) ----------
  // Professional full-flow overlay: submit -> verify (admin-issued code) -> complete.
  // The transaction stays pending until the correct code is verified.
  // opts: { title, subtitle, transferType, submit, transferId, onVerified }
  // When transferId is provided the flow resumes an existing pending transfer
  // (skips submission, jumps straight to the verification step).
  async function fetchTransferRow(transferType, transferId) {
    const tableMap = { crypto_withdrawal: 'crypto_withdrawals', international_transfer: 'international_transfers', local_transfer: 'local_transfers' };
    const table = tableMap[transferType] || 'international_transfers';
    const res = await SB.from(table).select('*').eq('id', transferId).single();
    if (res.error) throw res.error;
    return res.data;
  }

  async function transferFlow(opts) {
    const backdrop = document.createElement('div');
    backdrop.className = 'xflow-backdrop';
    backdrop.innerHTML =
      '<div class="xflow">' +
        '<div class="xflow-head"><div><h3 class="xflow-title"></h3><div class="xflow-sub"></div></div><button class="modal-close" type="button">&times;</button></div>' +
        '<div class="xflow-steps">' +
          '<div class="xf-step active" data-xf-step="1"><span class="num">1</span>Submit</div><div class="xf-line" data-xf-line="1"></div>' +
          '<div class="xf-step" data-xf-step="2"><span class="num">2</span>Verify</div><div class="xf-line" data-xf-line="2"></div>' +
          '<div class="xf-step" data-xf-step="3"><span class="num">3</span>Complete</div>' +
        '</div>' +
        '<div class="xflow-body"></div>' +
      '</div>';
    document.body.appendChild(backdrop);
    const q = function (s) { return backdrop.querySelector(s); };
    const titleEl = q('.xflow-title');
    const subEl = q('.xflow-sub');
    const bodyEl = q('.xflow-body');
    titleEl.textContent = opts.title || 'Transfer';
    subEl.textContent = opts.subtitle || '';

    let pollTimer = null;
    let closed = false;
    const transfer = { type: opts.transferType, id: null, reference: null };

    function setSteps(n) {
      [1, 2, 3].forEach(function (i) {
        q('[data-xf-step="' + i + '"]').classList.toggle('active', i === n);
        q('[data-xf-step="' + i + '"]').classList.toggle('done', i < n);
        const ln = q('[data-xf-line="' + i + '"]');
        if (ln) ln.classList.toggle('done', i < n);
      });
    }

    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

    function close() {
      if (closed) return;
      closed = true;
      stopPoll();
      backdrop.classList.add('is-closing');
      setTimeout(function () { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); }, 180);
      if (opts.onClose) opts.onClose();
    }
    q('.modal-close').addEventListener('click', close);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });

    function renderLoading(text) {
      bodyEl.innerHTML =
        '<div class="xflow-loading">' +
          '<div class="pl-orbit" style="width:76px;height:76px"><span class="pl-ring"></span><span class="pl-ring pl-ring--2"></span><span class="pl-ring pl-ring--3"></span><span class="pl-core"></span></div>' +
          '<p class="pl-status" style="margin:0">' + escapeHtml(text) + '</p>' +
        '</div>';
    }

    function renderAwaiting() {
      bodyEl.innerHTML =
        '<div class="text-center">' +
          '<div><span class="badge badge-pending">Pending verification</span></div>' +
          '<p class="text-muted" style="margin:14px 0 0">Your transfer has been submitted and is awaiting verification. Please contact support to obtain your verification code and complete the transfer.</p>' +
          '<div class="xflow-codebox">' +
            '<input type="text" class="input" maxlength="8" autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="••••-XXXX">' +
            '<button class="btn btn-primary" type="button">Verify</button>' +
          '</div>' +
          '<div class="xflow-hint"></div>' +
          '<div class="form-error"></div>' +
        '</div>';
      const input = q('.xflow-codebox .input');
      const btn = q('.xflow-codebox .btn');
      const hint = q('.xflow-hint');
      const err = q('.form-error');
      setTimeout(function () { input.focus(); }, 60);

      function refreshHint(st) {
        if (!st || !st.code_issued) {
          hint.innerHTML = 'No verification code issued yet. Please contact support to obtain your code.';
          return;
        }
        if (st.status === 'active') {
          hint.innerHTML = 'A verification code has been issued (ends <strong>' + escapeHtml(st.code_prefix || '') + '</strong>). ' +
            (st.attempts_left != null ? '<strong>' + st.attempts_left + '</strong> attempts remaining. ' : '') +
            'Expires ' + formatDateTime(st.expires_at) + '.';
          return;
        }
        const stateLabel = { used: 'already used', revoked: 'revoked', expired: 'expired' }[st.status] || 'invalid';
        hint.innerHTML = 'The latest verification code (ends <strong>' + escapeHtml(st.code_prefix || '') + '</strong>) has been ' + stateLabel + '. ' +
          'The transfer stays pending until a new code is issued.';
      }

      async function pollStatus() {
        if (closed) return;
        try {
          const st = await rpc('customer_transfer_verification_status', { p_transfer_type: transfer.type, p_transfer_id: transfer.id });
          refreshHint(st);
        } catch (e) { /* transient network error - keep polling */ }
      }

      function doVerify() {
        const code = (input.value || '').trim().toUpperCase();
        err.textContent = '';
        if (!/^[A-Z0-9]{8}$/.test(code)) { err.textContent = 'Enter the full 8-character code you received.'; return; }
        btn.disabled = true;
        btn.textContent = 'Verifying...';
        rpc('customer_verify_transfer', { p_transfer_type: transfer.type, p_transfer_id: transfer.id, p_code: code }).then(function (res) {
          const st = res && res.status;
          if (st === 'ok') {
            stopPoll();
            setSteps(3);
            renderDone(res);
            if (opts.onVerified) opts.onVerified(res);
            return;
          }
          // Not verified yet: the transaction stays pending with a clear message.
          if (st === 'invalid_code') {
            err.textContent = 'Incorrect verification code.' + (res.attempts_left != null ? ' ' + res.attempts_left + ' attempt(s) remaining.' : '');
            btn.disabled = false; btn.textContent = 'Verify';
            input.value = ''; input.focus();
            return;
          }
          if (st === 'attempts_exceeded') {
            err.textContent = 'Too many incorrect attempts. The code has been invalidated. Please contact support for a new code.';
            btn.disabled = false; btn.textContent = 'Verify';
            input.value = '';
            return;
          }
          const label = {
            used: 'This code has already been used.',
            revoked: 'This code has been revoked. Please contact support for a new code.',
            expired: 'This code has expired. Please contact support for a new code.',
            no_code: 'No verification code has been issued yet. Please contact support to obtain your code.',
            failed_insufficient_funds: 'Verification passed, but the transfer could not be processed due to insufficient funds at release time.'
          }[st];
          if (label) {
            err.textContent = label;
            btn.disabled = false; btn.textContent = 'Verify';
            input.value = '';
          } else {
            err.textContent = 'The code could not be verified. Please try again.';
            btn.disabled = false; btn.textContent = 'Verify';
          }
        }).catch(function (e) {
          err.textContent = apiErrorMessage(e);
          btn.disabled = false; btn.textContent = 'Verify';
        });
      }

      btn.addEventListener('click', doVerify);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doVerify(); });
      pollStatus();
      pollTimer = setInterval(pollStatus, 4000);
    }

    function renderDone(res) {
      if (transfer.reference) subEl.textContent = transfer.reference;
      bodyEl.innerHTML =
        '<div class="text-center">' +
          '<div class="xflow-icon is-success">✓</div>' +
          '<h3 style="margin:0 0 6px">Transfer completed</h3>' +
          '<p class="text-muted" style="margin:0 0 12px">The verification code was accepted and your transfer has been completed successfully.</p>' +
          '<div><span class="badge badge-completed">Completed</span></div>' +
          '<div class="xflow-actions">' +
            '<a href="transfers.html" class="btn btn-primary">View Transfers</a>' +
            '<a href="dashboard.html" class="btn btn-outline">Back to Dashboard</a>' +
          '</div>' +
        '</div>';
      q('[data-done-close]').addEventListener('click', close);
    }

    function renderError(message) {
      stopPoll();
      bodyEl.innerHTML =
        '<div class="text-center">' +
          '<div class="xflow-icon is-error">!</div>' +
          '<h3 style="margin:0 0 6px">Transfer could not be submitted</h3>' +
          '<p class="text-muted" style="margin:0">' + escapeHtml(message) + '</p>' +
          '<div class="xflow-actions"><button class="btn btn-primary" type="button" data-err-close>Close</button></div>' +
        '</div>';
      q('[data-err-close]').addEventListener('click', close);
    }

    function renderResumeStatus(row) {
      stopPoll();
      const st = row.status;
      const map = {
        processing: { icon: '✓', title: 'Transfer verified', desc: 'This transfer has already been verified and is now processing.', badge: 'badge-processing', label: 'Processing' },
        completed: { icon: '✓', title: 'Transfer completed', desc: 'This transfer has been completed successfully.', badge: 'badge-completed', label: 'Completed' },
        rejected: { icon: '!', title: 'Transfer cancelled', desc: 'This transfer was cancelled by our verification team. No funds were moved.', badge: 'badge-rejected', label: 'Rejected' },
        failed: { icon: '!', title: 'Transfer failed', desc: 'This transfer could not be processed. Please contact support.', badge: 'badge-failed', label: 'Failed' }
      }[st] || { icon: '!', title: 'Transfer closed', desc: 'This transfer is no longer pending verification.', badge: 'badge-neutral', label: String(st || 'closed').replace(/_/g, ' ') };
      bodyEl.innerHTML =
        '<div class="text-center">' +
          '<div class="xflow-icon ' + (map.icon === '✓' ? 'is-success' : 'is-error') + '">' + map.icon + '</div>' +
          '<h3 style="margin:0 0 6px">' + map.title + '</h3>' +
          '<p class="text-muted" style="margin:0 0 12px">' + map.desc + '</p>' +
          '<div><span class="badge ' + map.badge + '">' + escapeHtml(map.label) + '</span></div>' +
          '<div class="xflow-actions">' +
            '<a href="transfers.html" class="btn btn-primary">View Transfers</a>' +
            '<button class="btn btn-outline" type="button" data-done-close>Done</button>' +
          '</div>' +
        '</div>';
      q('[data-done-close]').addEventListener('click', close);
    }

    // Start
    if (opts.transferId) {
      // Resume an existing pending transfer.
      transfer.id = opts.transferId;
      try {
        const row = await fetchTransferRow(opts.transferType, opts.transferId);
        if (closed) return;
        transfer.reference = row.reference || opts.reference || null;
        if (transfer.reference) subEl.textContent = transfer.reference;
        if (row.status !== 'awaiting_admin_verification') {
          renderResumeStatus(row);
          return { close: close };
        }
        setSteps(2);
        renderAwaiting();
      } catch (e) {
        if (closed) return;
        renderError(apiErrorMessage(e));
      }
      return { close: close };
    }

    setSteps(1);
    renderLoading('Submitting your transfer...');
    try {
      const res = await opts.submit();
      if (closed) return;
      transfer.id = res.id;
      transfer.reference = res.reference;
      if (res.reference) subEl.textContent = res.reference;
      setSteps(2);
      renderAwaiting();
    } catch (e) {
      if (closed) return;
      if (e && e.message === 'CANCELLED') { close(); return; }
      renderError(apiErrorMessage(e));
    }
    return { close: close };
  }

  global.UI = {
    toast, openModal, closeModal, confirmDialog, loading,
    money, formatDate, formatDateTime, timeAgo, initial, avatar,
    badge, typeLabel, escapeHtml, emptyState, friendlyError, apiErrorMessage,
    rpc, qs, copyText, formatNumber: money,
    cardDigits, renderCardFace,
    pinBoxesHTML, mountPinInput, verifyCustomerPin, promptPin,
    verifyTransferCode, transferFlow
  };
  global.PageLoader = PageLoader;
})(window);
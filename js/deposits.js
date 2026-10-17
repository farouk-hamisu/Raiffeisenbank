// Marvin Bank — Bitcoin deposits module
(async function () {
  await AppShell.init({ title: 'Deposits' });
  const user = Auth.user;

  function $(id) { return document.getElementById(id); }

  let accounts = [];
  let cfg = {
    address: null,
    network_label: 'Bitcoin (BTC) · native segwit',
    confirmations: 1,
    expiry_minutes: 60,
    min_btc: 0.0001,
    max_btc: 5,
    btc_usd_rate: null
  };
  let backendReady = false;
  let rateUsd = null;
  let active = null;
  let countdownTimer = null;
  let deposits = [];

  function satsOf(btc) { return Math.round(Number(btc) * 100000000); }
  function fmtBtc(sats) { return (Number(sats) / 100000000).toFixed(8); }
  function fmtSats(sats) { return Number(sats).toLocaleString('en-US'); }

  function bip21(amountBtc) {
    if (!cfg.address) return null;
    return 'bitcoin:' + cfg.address + (amountBtc ? '?amount=' + amountBtc : '');
  }

  function renderQr(payload) {
    const el = $('d-qr');
    if (!payload) { el.innerHTML = ''; return; }
    try {
      el.innerHTML = QR.svg(payload, { px: 216, dark: '#0f1b2d', light: '#ffffff' });
    } catch (e) {
      el.innerHTML = '<span class="deposit-qr-error">QR unavailable</span>';
    }
  }

  async function loadConfig() {
    try {
      const c = await UI.rpc('btc_deposit_config');
      if (c && typeof c === 'object') Object.assign(cfg, c);
    } catch (e) { /* migration not applied yet */ }

    backendReady = !!(cfg.address && String(cfg.address).length >= 14);
    if (!backendReady) {
      renderNotEnabled();
      return;
    }

    rateUsd = Number(cfg.btc_usd_rate) > 0 ? Number(cfg.btc_usd_rate) : null;
    if (!rateUsd) {
      try { rateUsd = await BtcPrice.get(); } catch (e) { rateUsd = null; }
    }

    $('d-network').textContent = cfg.network_label || 'Bitcoin (BTC) · native segwit';
    $('d-address').textContent = cfg.address;

    const amountInput = $('d-amount');
    amountInput.min = String(cfg.min_btc);
    amountInput.max = String(cfg.max_btc);
    $('d-amount-hint').textContent = 'Min ' + Number(cfg.min_btc).toFixed(4) + ' BTC · Max ' +
      Number(cfg.max_btc).toFixed(2) + ' BTC';

    renderQr(bip21(null));
    updateQuote();
  }

  function renderNotEnabled() {
    $('d-network').textContent = 'Not enabled';
    $('d-address').textContent = '—';
    $('d-qr').innerHTML = '<span class="deposit-qr-error">—</span>';
    $('d-amount').disabled = true;
    $('d-create').disabled = true;
    $('d-quote').hidden = true;
    const banner = document.querySelector('.deposit-banner');
    if (banner) {
      banner.classList.add('deposit-banner--muted');
      banner.innerHTML = '<div class="deposit-banner-title">Bitcoin deposits are not enabled yet.</div>' +
        '<div>Deposits will become available once the platform update is applied. Your deposit ' +
        'history below is still up to date.</div>';
    }
  }

  function activeAccount() {
    const sel = $('d-account');
    return accounts.find(function (a) { return a.id === sel.value; }) || accounts[0] || null;
  }

  function fiatEstimate(sats) {
    const acc = activeAccount();
    if (!rateUsd || !acc) return '—';
    const usd = (Number(sats) / 100000000) * rateUsd;
    const cur = acc.currency || 'USD';
    let value = usd;
    if (cur !== 'USD' && typeof FX !== 'undefined' && FX.convert) {
      try { value = FX.convert(usd, 'USD', cur); } catch (e) { value = usd; }
    }
    return '≈ ' + UI.money(value, cur);
  }

  function setAmountHint(text, isError) {
    const hint = $('d-amount-hint');
    hint.textContent = text;
    hint.classList.toggle('deposit-hint--error', !!isError);
  }

  function updateQuote() {
    const quote = $('d-quote');
    const createBtn = $('d-create');
    if (!backendReady || active) return;

    const acc = activeAccount();
    const raw = $('d-amount').value;
    const n = Number(raw);
    if (!acc || !raw || !isFinite(n) || n <= 0) {
      quote.hidden = true;
      renderQr(bip21(null));
      createBtn.disabled = !acc;
      return;
    }

    const sats = satsOf(n);
    const btc = Number(fmtBtc(sats));
    let problem = '';
    if (btc < Number(cfg.min_btc)) problem = 'Minimum deposit is ' + Number(cfg.min_btc).toFixed(4) + ' BTC.';
    else if (btc > Number(cfg.max_btc)) problem = 'Maximum deposit is ' + Number(cfg.max_btc).toFixed(2) + ' BTC.';

    if (problem) {
      setAmountHint(problem, true);
      createBtn.disabled = true;
    } else {
      setAmountHint('Min ' + Number(cfg.min_btc).toFixed(4) + ' BTC · Max ' + Number(cfg.max_btc).toFixed(2) + ' BTC', false);
      createBtn.disabled = false;
    }

    quote.hidden = false;
    $('d-quote-send').textContent = fmtBtc(sats) + ' BTC';
    $('d-quote-sats').textContent = fmtSats(sats) + ' sats';
    $('d-quote-fiat').textContent = problem ? '—' : fiatEstimate(sats);
    renderQr(bip21(problem ? null : fmtBtc(sats)));
  }

  function setStatusLabel(deposit) {
    const badge = $('d-active-badge');
    if (deposit.status === 'processing') {
      badge.textContent = 'Payment detected';
      badge.className = 'badge badge-processing';
    } else {
      badge.textContent = 'Awaiting payment';
      badge.className = 'badge badge-awaiting';
    }
  }

  function tickCountdown() {
    if (!active || !active.expires_at) return;
    const el = $('d-countdown');
    const left = Math.floor((new Date(active.expires_at).getTime() - Date.now()) / 1000);
    if (left <= 0) {
      el.textContent = 'Expired';
      el.classList.add('deposit-countdown--expired');
      return;
    }
    el.classList.remove('deposit-countdown--expired');
    const h = Math.floor(left / 3600);
    const m = Math.floor((left % 3600) / 60);
    const s = left % 60;
    const pad = function (v) { return String(v).padStart(2, '0'); };
    el.textContent = 'Expires in ' + (h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s));
  }

  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    tickCountdown();
    countdownTimer = setInterval(tickCountdown, 1000);
  }

  function renderActive() {
    const panel = $('d-active');
    const amountInput = $('d-amount');
    const createBtn = $('d-create');

    if (!active) {
      panel.hidden = true;
      if (backendReady) {
        amountInput.disabled = false;
        updateQuote();
      }
      return;
    }

    panel.hidden = false;
    amountInput.disabled = true;
    createBtn.disabled = true;
    createBtn.textContent = 'Deposit request active';

    setStatusLabel(active);
    $('d-active-btc').textContent = fmtBtc(active.expected_sats || satsOf(active.expected_amount || 0)) + ' BTC';
    $('d-active-ref').textContent = active.reference || '—';
    $('d-active-note').textContent = active.status === 'processing'
      ? 'Your payment was detected and is waiting for confirmations (' +
        (active.confirmations || 0) + ' of ' + (active.required_confirmations || cfg.confirmations || 1) +
        '). Your balance is credited automatically once it is confirmed.'
      : 'Send exactly the amount above to the address on this page. Your balance is credited ' +
        'automatically once the payment reaches the required confirmations.';

    $('d-quote').hidden = true;
    renderQr(bip21(fmtBtc(active.expected_sats || satsOf(active.expected_amount || 0))));
    $('d-qr-caption').textContent = 'Scan to send exactly ' + fmtBtc(active.expected_sats || 0) + ' BTC';
    startCountdown();
  }

  function escapeHtml(str) { return UI.escapeHtml(str); }

  function truncateHash(hash) {
    if (!hash) return '';
    return hash.length > 20 ? hash.slice(0, 10) + '…' + hash.slice(-8) : hash;
  }

  function cryptoExtras(d) {
    let html = '';
    if (d.tx_hash) {
      html += '<div class="deposit-txhash mono" title="' + escapeHtml(d.tx_hash) + '">' +
        '<span>' + escapeHtml(truncateHash(d.tx_hash)) + '</span>' +
        '<button class="btn btn-ghost btn-sm deposit-hash-copy" type="button" data-hash="' +
        escapeHtml(d.tx_hash) + '" title="Copy transaction hash">Copy</button></div>';
    }
    if (d.status === 'processing') {
      html += '<div class="deposit-meta">' +
        (Number(d.confirmations) || 0) + ' of ' +
        (Number(d.required_confirmations) || cfg.confirmations || 1) + ' confirmations</div>';
    } else if (d.status === 'awaiting' && d.expires_at) {
      const left = Math.floor((new Date(d.expires_at).getTime() - Date.now()) / 1000);
      html += '<div class="deposit-meta">' +
        (left > 0 ? 'Expires in ' + expiryText(left) : 'Expired') + '</div>';
    } else if (d.status === 'completed' && d.completed_at) {
      html += '<div class="deposit-meta">Credited ' + escapeHtml(UI.timeAgo(d.completed_at)) + '</div>';
    }
    if (d.monitor_note && d.status === 'failed') {
      html += '<div class="deposit-meta deposit-meta--warn">' + escapeHtml(d.monitor_note) + '</div>';
    }
    return html;
  }

  function expiryText(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = function (v) { return String(v).padStart(2, '0'); };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function historyRow(d) {
    const crypto = d.method === 'crypto';
    const title = crypto ? 'Bitcoin deposit' : UI.typeLabel(d.method) + ' deposit';
    const bits = [escapeHtml(d.reference)];
    if (crypto && d.expected_amount) bits.push(Number(d.expected_amount).toFixed(8) + ' BTC');
    bits.push(escapeHtml(UI.timeAgo(d.created_at)));

    return '<div class="tx-item' + (crypto ? ' deposit-item' : '') + '">' +
      '<div class="tx-icon">' + (crypto ? ICONS.bitcoin : ICONS.deposits) + '</div>' +
      '<div class="tx-info"><div class="tx-title">' + escapeHtml(title) + '</div>' +
      '<div class="tx-sub">' + bits.join(' · ') + '</div>' +
      (crypto ? cryptoExtras(d) : '') + '</div>' +
      '<div class="deposit-item-right"><div class="tx-amount text-success">+' +
      UI.money(d.amount, d.currency) + '</div>' + UI.badge(d.status) + '</div>' +
      '</div>';
  }

  function renderHistory() {
    const el = $('deposit-history');
    if (!deposits.length) {
      el.innerHTML = UI.emptyState('No deposits yet');
      return;
    }
    el.innerHTML = '<div class="tx-list">' + deposits.map(historyRow).join('') + '</div>';
  }

  function pickActive() {
    active = deposits.find(function (d) {
      return d.method === 'crypto' && (d.status === 'awaiting' || d.status === 'processing');
    }) || null;
  }

  async function loadHistory() {
    const el = $('deposit-history');
    try {
      const { data, error } = await SB.from('deposits').select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      deposits = data || [];
      pickActive();
      renderHistory();
      renderActive();
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load deposits');
    }
  }

  async function loadAccounts() {
    const { data, error } = await SB.from('accounts').select('*')
      .eq('user_id', user.id).eq('status', 'active');
    if (error) throw error;
    accounts = data || [];
    const sel = $('d-account');
    sel.innerHTML = accounts.map(function (a) {
      return '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.account_name) +
        ' · ' + escapeHtml(a.account_number) + ' (' + escapeHtml(a.currency) + ')</option>';
    }).join('');
    if (!accounts.length) {
      $('d-create').disabled = true;
      setAmountHint('No active account available.', true);
    }
  }

  $('d-account').addEventListener('change', updateQuote);
  $('d-amount').addEventListener('input', function () {
    $('d-error').textContent = '';
    updateQuote();
  });

  $('d-copy-address').addEventListener('click', async function () {
    const btn = this;
    if (!cfg.address) return;
    const ok = await UI.copyText(cfg.address);
    if (ok) {
      btn.textContent = 'Copied';
      btn.classList.add('deposit-copy--ok');
      setTimeout(function () {
        btn.textContent = 'Copy';
        btn.classList.remove('deposit-copy--ok');
      }, 1600);
    } else {
      UI.toast('Could not copy the address. Please copy it manually.', 'error');
    }
  });

  $('d-create').addEventListener('click', async function () {
    const err = $('d-error');
    const btn = this;
    err.textContent = '';

    const acc = activeAccount();
    const n = Number($('d-amount').value);
    if (!acc) { err.textContent = 'Select an account.'; return; }
    if (!isFinite(n) || n <= 0) { err.textContent = 'Enter a valid deposit amount.'; return; }
    const btc = Number(fmtBtc(satsOf(n)));
    if (btc < Number(cfg.min_btc)) { err.textContent = 'Minimum deposit is ' + Number(cfg.min_btc).toFixed(4) + ' BTC.'; return; }
    if (btc > Number(cfg.max_btc)) { err.textContent = 'Maximum deposit is ' + Number(cfg.max_btc).toFixed(2) + ' BTC.'; return; }

    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Creating request...';
    try {
      const dep = await UI.rpc('create_btc_deposit', {
        p_user_id: user.id,
        p_account_id: acc.id,
        p_amount_btc: btc,
        p_note: null
      });
      UI.toast('Deposit request created. Reference: ' + (dep && dep.reference ? dep.reference : ''), 'success');
      $('d-amount').value = '';
      await loadHistory();
    } catch (e) {
      err.textContent = UI.apiErrorMessage(e);
    } finally {
      btn.textContent = active ? 'Deposit request active' : label;
      btn.disabled = !!active;
    }
  });

  $('d-check').addEventListener('click', async function () {
    const btn = this;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Checking...';
    let reached = true;
    try {
      const settled = SB.functions.invoke('monitor-btc-deposits').then(
        function (r) { return { ok: !(r && r.error) }; },
        function () { return { ok: false }; }
      );
      const winner = await Promise.race([
        settled,
        new Promise(function (resolve) { setTimeout(function () { resolve({ ok: false }); }, 8000); })
      ]);
      reached = winner.ok === true;
    } catch (e) {
      reached = false;
    }
    await loadHistory();
    btn.disabled = false;
    btn.textContent = label;
    if (reached) UI.toast('Deposit status updated', 'success');
    else UI.toast('Status service is unavailable right now. Your history was refreshed.', 'info');
  });

  document.addEventListener('click', async function (e) {
    const btn = e.target.closest ? e.target.closest('.deposit-hash-copy') : null;
    if (!btn) return;
    const hash = btn.getAttribute('data-hash');
    if (!hash) return;
    const ok = await UI.copyText(hash);
    if (ok) {
      const prev = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = prev; }, 1600);
    }
  });

  try {
    await loadConfig();
    await loadAccounts();
    await loadHistory();
    if (backendReady) updateQuote();
  } catch (e) {
    UI.toast(UI.apiErrorMessage(e), 'error');
  }
  PageLoader.hide();
})();

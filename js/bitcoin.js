// marvintlc — Bitcoin balance and USD/BTC swap
(async function () {
  await AppShell.init({ title: 'Bitcoin' });
  const user = Auth.user;
  let btcUsdRate = null;
  let usdAccount = null;
  let btcAccount = null;
  let usdBalance = 0;
  let btcBalance = 0;

  // --- helpers ---
  function $(id) { return document.getElementById(id); }
  function fmtCur(n, c) { return UI.money(n, c); }

  // --- fetch BTC price ---
  async function fetchBtcPrice() {
    const ageEl = $('btc-rate-age');
    try {
      btcUsdRate = await BtcPrice.get();
      if (ageEl) ageEl.textContent = 'Updated just now';
    } catch (e) {
      if (!btcUsdRate && ageEl) ageEl.textContent = 'Price unavailable';
    }
  }

  // --- load accounts and balances ---
  async function loadAccounts() {
    const { data: accounts } = await SB.from('accounts').select('id, account_number, account_name, account_type, currency').eq('user_id', user.id).eq('status', 'active');
    if (!accounts) return;

    usdAccount = accounts.find(function (a) { return a.currency === 'USD'; }) || null;
    btcAccount = accounts.find(function (a) { return a.currency === 'BTC'; }) || null;

    const accIds = accounts.map(function (a) { return a.id; });
    if (!accIds.length) return;

    const { data: bals } = await SB.from('account_balances').select('account_id, available_balance, ledger_balance').in('account_id', accIds);
    if (!bals) return;

    const balMap = {};
    bals.forEach(function (b) { balMap[b.account_id] = b; });

    if (usdAccount && balMap[usdAccount.id]) usdBalance = Number(balMap[usdAccount.id].available_balance) || 0;
    if (btcAccount && balMap[btcAccount.id]) btcBalance = Number(balMap[btcAccount.id].available_balance) || 0;

    // Pick the USD account with the highest balance
    var bestUsd = null, bestUsdBal = -1;
    accounts.filter(function (a) { return a.currency === 'USD'; }).forEach(function (a) {
      var b = balMap[a.id] ? Number(balMap[a.id].available_balance) || 0 : 0;
      if (b > bestUsdBal) { bestUsdBal = b; bestUsd = a; }
    });
    if (bestUsd) { usdAccount = bestUsd; usdBalance = bestUsdBal; }

    // Pick the BTC account with the highest balance
    var bestBtc = null, bestBtcBal = -1;
    accounts.filter(function (a) { return a.currency === 'BTC'; }).forEach(function (a) {
      var b = balMap[a.id] ? Number(balMap[a.id].available_balance) || 0 : 0;
      if (b > bestBtcBal) { bestBtcBal = b; bestBtc = a; }
    });
    if (bestBtc) { btcAccount = bestBtc; btcBalance = bestBtcBal; }
  }

  // --- render BTC balance ---
  function renderBtcBalance() {
    const el = $('btc-balance');
    const usdValue = btcUsdRate ? btcBalance * btcUsdRate : 0;
    el.innerHTML =
      '<div class="balance-breakdown">' +
        '<div class="balance-row">' +
          '<div class="balance-row-icon" style="color:#f7931a"><img src="assets/logos/bitcoin-logo-svgrepo-com.svg" alt="Bitcoin" style="width:28px;height:28px"></div>' +
          '<div class="balance-row-details">' +
            '<div class="balance-row-name">Bitcoin (BTC)</div>' +
            '<div class="balance-row-meta text-muted">' + btcBalance.toFixed(8) + ' BTC</div>' +
          '</div>' +
          '<div class="balance-row-amount">' + fmtCur(usdValue, 'USD') + '</div>' +
        '</div>' +
        '<div class="balance-meta-row text-muted text-sm">' +
          '<span>1 BTC = ' + fmtCur(btcUsdRate || 0, 'USD') + '</span>' +
          '<span>USD Balance: ' + fmtCur(usdBalance, 'USD') + '</span>' +
        '</div>' +
      '</div>';
  }

  // --- render BTC price sidebar ---
  function renderPriceInfo() {
    const el = $('btc-price-info');
    if (!btcUsdRate) { el.innerHTML = '<p class="text-muted">Price unavailable</p>'; return; }
    el.innerHTML =
      '<div class="stat-card">' +
        '<div class="stat-value">' + fmtCur(btcUsdRate, 'USD') + '</div>' +
        '<div class="stat-label">per 1 BTC</div>' +
      '</div>' +
      '<div class="stat-card mt-2">' +
        '<div class="stat-value">' + (1 / btcUsdRate).toFixed(8) + '</div>' +
        '<div class="stat-label">1 USD = BTC</div>' +
      '</div>';
  }

  // --- swap preview ---
  function updateSwap() {
    const fromAmt = parseFloat($('swap-from-amount').value) || 0;
    const toEl = $('swap-to-amount');
    const summaryEl = $('swap-summary');
    const btn = $('swap-btn');
    const toLabel = $('swap-to-label');
    const fromCurrency = $('swap-from-currency').value;

    if (!btcUsdRate || fromAmt <= 0) {
      toEl.value = '';
      summaryEl.innerHTML = '';
      btn.disabled = true;
      btn.textContent = 'Enter Amount';
      return;
    }

    const feePct = 0.25;
    let toAmt, feeUsd;
    if (fromCurrency === 'USD') {
      feeUsd = fromAmt * feePct / 100;
      toAmt = (fromAmt - feeUsd) / btcUsdRate;
      toLabel.textContent = 'BTC';
      btn.textContent = 'Swap USD to BTC';
    } else {
      const usdValue = fromAmt * btcUsdRate;
      feeUsd = usdValue * feePct / 100;
      toAmt = usdValue - feeUsd;
      toLabel.textContent = 'USD';
      btn.textContent = 'Swap BTC to USD';
    }

    toEl.value = fromCurrency === 'USD' ? toAmt.toFixed(8) : toAmt.toFixed(2);
    summaryEl.innerHTML =
      '<div class="swap-row">' +
        '<span class="text-muted">Rate</span>' +
        '<span>1 BTC = ' + fmtCur(btcUsdRate, 'USD') + '</span>' +
      '</div>' +
      '<div class="swap-row">' +
        '<span class="text-muted">Fee</span>' +
        '<span>' + fmtCur(feeUsd, 'USD') + '</span>' +
      '</div>';

    btn.disabled = false;
  }

  // --- execute swap via RPC ---
  async function executeSwap() {
    const btn = $('swap-btn');
    const fromAmt = parseFloat($('swap-from-amount').value) || 0;
    const fromCurrency = $('swap-from-currency').value;
    if (fromAmt <= 0 || !btcUsdRate) return;

    // Determine source account
    const srcAccount = fromCurrency === 'USD' ? usdAccount : btcAccount;
    const dstCurrency = fromCurrency === 'USD' ? 'BTC' : 'USD';
    if (!srcAccount) {
      UI.toast('No ' + fromCurrency + ' account found.', 'error');
      return;
    }

    const pin = await UI.promptPin({
      title: 'Confirm Bitcoin Swap',
      message: 'Enter your 4-digit PIN to authorize swapping ' + fmtCur(fromAmt, fromCurrency) + ' to ' + dstCurrency + '.'
    });
    if (!pin) return;

    btn.disabled = true;
    btn.textContent = 'Processing...';
    try {
      const { data, error } = await SB.rpc('create_currency_swap', {
        p_user_id: user.id,
        p_account_id: srcAccount.id,
        p_from_currency: fromCurrency,
        p_to_currency: dstCurrency,
        p_from_amount: fromAmt,
        p_pin: pin,
        p_rate: btcUsdRate
      });
      if (error) throw error;
      if (data && data.error) throw new Error(data.error);
      UI.toast('Swap completed successfully', 'success');
      $('swap-from-amount').value = '';
      await refreshAll();
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      UI.toast('Swap failed: ' + msg, 'error');
      console.error('Swap RPC error:', e);
    } finally {
      btn.disabled = false;
      updateSwap();
    }
  }

  // --- refresh everything ---
  async function refreshAll() {
    await loadAccounts();
    renderBtcBalance();
    updateSwap();
    await loadBtcHistory();
  }

  // --- load BTC transaction history ---
  async function loadBtcHistory() {
    const el = $('btc-tx-history');
    try {
      const { data: swaps } = await SB.from('transactions')
        .select('reference, amount, currency, fee, direction, type, status, description, created_at')
        .eq('user_id', user.id)
        .eq('type', 'currency_swap')
        .order('created_at', { ascending: false })
        .limit(20);

      const btcSwaps = (swaps || []).filter(function (tx) {
        return tx.currency === 'USD' || tx.currency === 'BTC';
      });

      if (!btcSwaps.length) {
        el.innerHTML = UI.emptyState('No Bitcoin transactions yet');
        return;
      }

      el.innerHTML = '<table class="table mobile-cards"><thead><tr><th>Reference</th><th>Type</th><th>Amount</th><th>Fee</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
        btcSwaps.map(function (tx) {
          const isBuy = tx.currency === 'USD' && tx.direction === 'debit';
          return '<tr>' +
            '<td data-label="Reference">' + UI.escapeHtml(tx.reference) + '</td>' +
            '<td data-label="Type">' + (isBuy ? 'Buy BTC' : 'Sell BTC') + '</td>' +
            '<td data-label="Amount">' + UI.money(tx.amount, tx.currency) + '</td>' +
            '<td data-label="Fee">' + (tx.fee ? UI.money(tx.fee, 'USD') : '-') + '</td>' +
            '<td data-label="Status">' + UI.badge(tx.status) + '</td>' +
            '<td data-label="Date">' + UI.formatDateTime(tx.created_at) + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    } catch (e) {
      el.innerHTML = UI.emptyState('Unable to load transactions');
    }
  }

  // --- events ---
  $('swap-from-currency').addEventListener('change', function () {
    $('swap-to-label').textContent = this.value === 'USD' ? 'BTC' : 'USD';
    updateSwap();
  });
  $('swap-from-amount').addEventListener('input', updateSwap);
  $('swap-reverse').addEventListener('click', function () {
    const sel = $('swap-from-currency');
    sel.value = sel.value === 'USD' ? 'BTC' : 'USD';
    $('swap-to-label').textContent = sel.value === 'USD' ? 'BTC' : 'USD';
    updateSwap();
  });
  $('swap-btn').addEventListener('click', executeSwap);
  $('refresh-btc-rate').addEventListener('click', async function () {
    this.disabled = true;
    await fetchBtcPrice();
    renderPriceInfo();
    await refreshAll();
    this.disabled = false;
  });

  // --- init ---
  await fetchBtcPrice();
  await loadAccounts();
  renderPriceInfo();
  renderBtcBalance();
  updateSwap();
  await loadBtcHistory();
  PageLoader.hide();
})();

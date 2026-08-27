// marvintlc — Currency swap module
(async function () {
  await AppShell.init({ title: 'Currency Swap' });
  const user = Auth.user;

  let currencies = [];
  let accounts = [];
  let balances = {};
  let currentRate = null;

  async function load() {
    try {
      const [curRes, accRes] = await Promise.all([
        SB.from('currencies').select('code, symbol, name').eq('enabled', true).order('code'),
        SB.from('accounts').select('*').eq('user_id', user.id).eq('status', 'active')
      ]);
      if (curRes.error) throw curRes.error;
      if (accRes.error) throw accRes.error;
      currencies = curRes.data || [];
      accounts = accRes.data || [];

      const balRes = await SB.from('account_balances').select('*').in('account_id', accounts.map(function (a) { return a.id; }));
      if (balRes.error) throw balRes.error;
      balances = {};
      (balRes.data || []).forEach(function (b) { balances[b.account_id] = b; });

      const options = currencies.map(function (c) {
        return '<option value="' + c.code + '">' + c.code + ' — ' + UI.escapeHtml(c.name) + ' (' + c.symbol + ')</option>';
      }).join('');
      document.getElementById('s-from').innerHTML = options;
      document.getElementById('s-to').innerHTML = options;
      if (currencies[0]) document.getElementById('s-from').value = currencies[0].code;
      if (currencies[1]) document.getElementById('s-to').value = currencies[1].code;

      updateTag();
      refreshReview();
      loadHistory();
      fetchRate();
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function updateTag() {
    const from = document.getElementById('s-from').value;
    const c = currencies.find(function (x) { return x.code === from; });
    document.getElementById('s-tag').textContent = c ? c.symbol : from;
    document.getElementById('s-tag').dataset.cur = from;
  }

  function sourceAccount() {
    const from = document.getElementById('s-from').value;
    return accounts.find(function (a) { return a.currency === from && balances[a.id]; });
  }

  function destAccount() {
    const to = document.getElementById('s-to').value;
    return accounts.find(function (a) { return a.currency === to; });
  }

  async function fetchRate() {
    const from = document.getElementById('s-from').value;
    const to = document.getElementById('s-to').value;
    if (from === to) {
      document.getElementById('s-rate').textContent = 'Select different currencies';
      currentRate = null;
      refreshReview();
      return;
    }
    const { data, error } = await SB.from('exchange_rates').select('*').eq('base_currency', from).eq('quote_currency', to).maybeSingle();
    if (error || !data) {
      document.getElementById('s-rate').textContent = 'Rate not available';
      currentRate = null;
      refreshReview();
      return;
    }
    currentRate = data;
    document.getElementById('s-rate').textContent = '1 ' + from + ' = ' + data.rate + ' ' + to;
    calc();
  }

  function calc() {
    const amount = Number(document.getElementById('s-amount').value) || 0;
    const from = document.getElementById('s-from').value;
    const to = document.getElementById('s-to').value;
    if (!currentRate || !amount) {
      document.getElementById('s-result').textContent = '—';
      document.getElementById('s-fee').textContent = '—';
      document.getElementById('s-debit').textContent = '—';
      return null;
    }
    const feePct = Number(currentRate.fee_percent) || 0;
    const fee = Math.round(amount * feePct) / 100;
    const debit = amount + fee;
    const result = Math.round((amount - fee) * Number(currentRate.rate) * 100) / 100;
    document.getElementById('s-fee').textContent = UI.money(fee, from);
    document.getElementById('s-debit').textContent = UI.money(debit, from);
    document.getElementById('s-result').textContent = UI.money(result, to);
    return { fee: fee, debit: debit, result: result, from: from, to: to };
  }

  // Show source balance + destination account availability.
  function refreshReview() {
    const from = document.getElementById('s-from').value;
    const to = document.getElementById('s-to').value;
    const acc = sourceAccount();
    const dest = destAccount();
    document.getElementById('s-available').textContent = acc
      ? UI.money(balances[acc.id].available_balance, from)
      : 'No active ' + from + ' account';
    document.getElementById('s-dest').textContent = dest
      ? 'Credited to your ' + to + ' account'
      : 'A new ' + to + ' account will be created';
  }

  document.getElementById('s-from').addEventListener('change', function () { updateTag(); fetchRate(); refreshReview(); });
  document.getElementById('s-to').addEventListener('change', function () { fetchRate(); refreshReview(); });
  document.getElementById('s-amount').addEventListener('input', calc);

  document.getElementById('s-submit').addEventListener('click', function () {
    const err = document.getElementById('s-error');
    err.textContent = '';
    const btn = this;
    const from = document.getElementById('s-from').value;
    const to = document.getElementById('s-to').value;
    const amount = Number(document.getElementById('s-amount').value);
    if (from === to) { err.textContent = 'Source and destination currencies must be different.'; return; }
    if (!amount || amount <= 0) { err.textContent = 'Enter a valid amount.'; return; }
    if (!currentRate) { err.textContent = 'Exchange rate unavailable for this pair.'; return; }

    const account = sourceAccount();
    if (!account) { err.textContent = 'You need an active ' + from + ' account to swap from this currency.'; return; }

    const quote = calc();
    const bal = Number(balances[account.id].available_balance) || 0;
    if (quote && quote.debit > bal) {
      err.textContent = 'Insufficient funds: ' + UI.money(quote.debit, from) + ' needed (incl. fee), ' + UI.money(bal, from) + ' available.';
      return;
    }

    UI.confirmDialog(
      'Swap ' + UI.money(amount, from) + ' to ' + UI.money(quote.result, to) +
      ' at rate ' + currentRate.rate + ' (fee ' + UI.money(quote.fee, from) + ')?',
      async function () {
        try {
          const pin = await UI.promptPin({
            title: 'Confirm Currency Swap',
            message: 'Enter your 4-digit security PIN to authorize this currency swap.'
          });
          btn.disabled = true;
          btn.textContent = 'Processing...';
          const swap = await UI.rpc('create_currency_swap', {
            p_user_id: user.id,
            p_account_id: account.id,
            p_from_currency: from,
            p_to_currency: to,
            p_from_amount: amount,
            p_pin: pin
          });
          UI.toast('Swap completed. Reference: ' + swap.reference, 'success');
          btn.disabled = false;
          btn.textContent = 'Review Swap';
          document.getElementById('s-amount').value = '';
          document.getElementById('s-error').textContent = '';
          await load();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = 'Review Swap';
          if (e && e.message !== 'CANCELLED') err.textContent = UI.apiErrorMessage(e);
        }
      }, 'Confirm Swap'
    );
  });

  async function loadHistory() {
    const el = document.getElementById('swap-history');
    try {
      const { data, error } = await SB.from('currency_swaps').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
      if (error) throw error;
      if (!data.length) { el.innerHTML = UI.emptyState('No swaps yet'); return; }
      el.innerHTML = '<div class="tx-list">' + data.map(function (s) {
        return '<div class="tx-item">' +
          '<div class="tx-icon">' + ICONS.swap + '</div>' +
          '<div class="tx-info"><div class="tx-title">' + s.from_currency + ' → ' + s.to_currency + '</div>' +
          '<div class="tx-sub">' + UI.escapeHtml(s.reference) + ' · ' + UI.timeAgo(s.created_at) + ' · rate ' + s.rate + '</div></div>' +
          '<div style="text-align:right;white-space:nowrap"><div class="tx-amount">' + UI.money(s.from_amount, s.from_currency) + '</div>' +
          '<span class="text-sm text-success">→ ' + UI.money(s.to_amount, s.to_currency) + '</span> ' + UI.badge(s.status) + '</div>' +
        '</div>';
      }).join('') + '</div>';
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load swap history');
    }
  }

  await load();
  PageLoader.hide();
})();
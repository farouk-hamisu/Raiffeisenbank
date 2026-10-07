// Raiffeisen Bank — Deposits module
(async function () {
  await AppShell.init({ title: 'Deposits' });
  const user = Auth.user;

  let accounts = [];

  async function loadAccounts() {
    const { data, error } = await SB.from('accounts').select('*').eq('user_id', user.id).eq('status', 'active');
    if (error) throw error;
    accounts = data || [];
    const sel = document.getElementById('d-account');
    sel.innerHTML = accounts.map(function (a) {
      return '<option value="' + a.id + '">' + UI.escapeHtml(a.account_name) + ' · ' + UI.escapeHtml(a.account_number) + ' (' + UI.escapeHtml(a.currency) + ')</option>';
    }).join('');
    if (accounts[0]) setTag(accounts[0].currency);
    sel.addEventListener('change', function () {
      const acc = accounts.find(function (a) { return a.id === sel.value; });
      if (acc) setTag(acc.currency);
    });
  }

  function setTag(cur) {
    document.getElementById('d-currency-tag').textContent = (APP_CONFIG.currencySymbols[cur] || cur);
    document.getElementById('d-currency-tag').dataset.cur = cur;
  }

  async function loadHistory() {
    const el = document.getElementById('deposit-history');
    try {
      const { data, error } = await SB.from('deposits').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
      if (error) throw error;
      if (!data.length) { el.innerHTML = UI.emptyState('No deposits yet'); return; }
      el.innerHTML = '<div class="tx-list">' + data.map(function (d) {
        return '<div class="tx-item">' +
          '<div class="tx-icon">' + ICONS.deposits + '</div>' +
          '<div class="tx-info"><div class="tx-title">' + UI.escapeHtml(UI.typeLabel(d.method)) + ' deposit</div>' +
          '<div class="tx-sub">' + UI.escapeHtml(d.reference) + ' · ' + UI.timeAgo(d.created_at) + '</div></div>' +
          '<div style="text-align:right;white-space:nowrap"><div class="tx-amount text-success">+' + UI.money(d.amount, d.currency) + '</div>' + UI.badge(d.status) + '</div>' +
        '</div>';
      }).join('') + '</div>';
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load deposits');
    }
  }

  document.getElementById('d-submit').addEventListener('click', async function () {
    const err = document.getElementById('d-error');
    err.textContent = '';
    const btn = this;
    const accountId = document.getElementById('d-account').value;
    const amount = Number(document.getElementById('d-amount').value);
    const method = document.getElementById('d-method').value;
    const note = document.getElementById('d-note').value.trim();
    if (!accountId) { err.textContent = 'Select an account.'; return; }
    if (!amount || amount <= 0) { err.textContent = 'Enter a valid deposit amount.'; return; }
const acc = accounts.find(function (a) { return a.id === accountId; });
      try {
        const pin = await UI.promptPin({
          title: 'Confirm Deposit',
          message: 'Enter your 4-digit security PIN to submit this deposit of ' + UI.money(amount, acc.currency) + '.'
        });
        btn.disabled = true;
        btn.textContent = 'Submitting...';
        const data = await UI.rpc('create_customer_deposit', {
          p_user_id: user.id,
          p_account_id: accountId,
          p_amount: amount,
          p_currency: acc.currency,
          p_method: method,
          p_note: note || null,
          p_pin: pin
        });
        UI.toast('Deposit submitted for review. Reference: ' + data.reference, 'success');
        btn.disabled = false;
        btn.textContent = 'Submit Deposit';
        document.getElementById('d-amount').value = '';
        document.getElementById('d-note').value = '';
        loadHistory();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Submit Deposit';
        if (e && e.message !== 'CANCELLED') err.textContent = UI.apiErrorMessage(e);
      }
    });

  try {
    await loadAccounts();
    await loadHistory();
  } catch (e) {
    UI.toast(UI.apiErrorMessage(e), 'error');
  }
  PageLoader.hide();
})();
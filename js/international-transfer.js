// marvintlc — International transfer module
(async function () {
  await AppShell.init({ title: 'International Transfer' });
  const user = Auth.user;

  const state = { step: 1, accounts: [], balances: {}, beneficiary: null, fee: 15 };

  function showStep(n) {
    state.step = n;
    [1, 2, 3].forEach(function (s) {
      const el = document.getElementById('step-' + s);
      el.classList.toggle('hide', s !== n);
      document.querySelectorAll('.step-pill[data-step="' + s + '"]').forEach(function (p) {
        p.classList.toggle('active', s === n);
        p.classList.toggle('done', s < n);
      });
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function load() {
    try {
      // Check outgoing transfers enabled
      const profile = await Auth.fetchProfile();
      const banner = document.getElementById('outgoing-banner');
      if (profile.outgoing_transfers_enabled === false) {
        banner.classList.remove('hide');
        document.getElementById('outgoing-banner-reason').textContent =
          (profile.outgoing_transfers_disabled_reason ? 'Reason: ' + profile.outgoing_transfers_disabled_reason : 'Please contact support for details.');
      } else {
        banner.classList.add('hide');
      }

      const [accRes, benRes] = await Promise.all([
        SB.from('accounts').select('*').eq('user_id', user.id).eq('status', 'active'),
        SB.from('beneficiaries').select('*').eq('user_id', user.id).eq('is_international', true)
      ]);
      if (accRes.error) throw accRes.error;
      if (benRes.error) throw benRes.error;

      state.accounts = accRes.data || [];

      const balRes = await SB.from('account_balances').select('*').in('account_id', state.accounts.map(function (a) { return a.id; }));
      if (balRes.error) throw balRes.error;
      (balRes.data || []).forEach(function (b) { state.balances[b.account_id] = b; });

      const sel = document.getElementById('beneficiary-select');
      sel.innerHTML = '<option value="">Select a saved international beneficiary...</option>' + (benRes.data || []).map(function (b) {
        return '<option value="' + b.id + '">' + UI.escapeHtml(b.name) + ' · ' + UI.escapeHtml(b.country || '') + '</option>';
      }).join('');

      const fromSel = document.getElementById('t-from');
      fromSel.innerHTML = state.accounts.map(function (a) {
        return '<option value="' + a.id + '">' + UI.escapeHtml(a.account_name) + ' · ' + UI.escapeHtml(a.currency) + '</option>';
      }).join('');

      const curSel = document.getElementById('r-currency');
      curSel.innerHTML = '<option value="USD">USD ($)</option>';
      curSel.value = 'USD';

      // fee
      const settingsRes = await SB.from('system_settings').select('value').eq('key', 'intl_transfer_fee');
      if (!settingsRes.error && settingsRes.data && settingsRes.data.length) {
        state.fee = Number(settingsRes.data[0].value) || 15;
      }
      document.getElementById('t-fee').textContent = UI.money(state.fee, 'USD');

      document.getElementById('t-from').addEventListener('change', updateBalance);
      updateBalance();
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function updateBalance() {
    const fromId = document.getElementById('t-from').value;
    const acc = state.accounts.find(function (a) { return a.id === fromId; });
    const b = state.balances[fromId];
    if (acc && b) {
      document.getElementById('t-balance').textContent = UI.money(b.available_balance, acc.currency);
      document.getElementById('t-currency-tag').textContent = (APP_CONFIG.currencySymbols[acc.currency] || acc.currency);
      document.getElementById('t-currency-tag').dataset.cur = acc.currency;
    }
  }

  document.getElementById('beneficiary-select').addEventListener('change', function () {
    const id = this.value;
    if (!id) return;
    SB.from('beneficiaries').select('*').eq('id', id).single().then(function (res) {
      if (res.error) return;
      const b = res.data;
      document.getElementById('r-name').value = b.name || '';
      document.getElementById('r-bank').value = b.bank_name || '';
      document.getElementById('r-account').value = b.account_number || '';
      document.getElementById('r-swift').value = b.swift_code || '';
      document.getElementById('r-country').value = b.country || '';
      document.getElementById('r-currency').value = b.currency || 'EUR';
      state.beneficiary = b;
    });
  });

  document.getElementById('step1-next').addEventListener('click', function () {
    const err = document.getElementById('step1-error');
    err.textContent = '';
    const name = document.getElementById('r-name').value.trim();
    const bank = document.getElementById('r-bank').value.trim();
    const account = document.getElementById('r-account').value.trim();
    const swift = document.getElementById('r-swift').value.trim();
    const country = document.getElementById('r-country').value.trim();
    const currency = document.getElementById('r-currency').value;
    if (!name || !bank || !account || !swift || !country) { err.textContent = 'Please complete all recipient details.'; return; }
    state.beneficiary = { name, bank, account, swift, country, currency };
    document.getElementById('rv-name').textContent = name;
    document.getElementById('rv-bank').textContent = bank;
    document.getElementById('rv-account').textContent = account;
    document.getElementById('rv-swift').textContent = swift;
    document.getElementById('rv-country').textContent = country;
    showStep(2);
  });

  document.getElementById('t-amount').addEventListener('input', function () {
    const amt = Number(this.value) || 0;
    const cur = document.getElementById('t-currency-tag').dataset.cur || 'USD';
    document.getElementById('t-total').textContent = UI.money(amt + state.fee, cur);
  });

  document.getElementById('step2-next').addEventListener('click', function () {
    const err = document.getElementById('step2-error');
    err.textContent = '';
    const fromId = document.getElementById('t-from').value;
    const amount = Number(document.getElementById('t-amount').value);
    if (!fromId) { err.textContent = 'Select an account.'; return; }
    if (!amount || amount <= 0) { err.textContent = 'Enter a valid amount.'; return; }
    const b = state.balances[fromId];
    if (b && (amount + state.fee) > Number(b.available_balance)) { err.textContent = 'Insufficient funds for the amount plus transfer fee.'; return; }
    const acc = state.accounts.find(function (a) { return a.id === fromId; });
    document.getElementById('rv-from').textContent = acc.account_name + ' · ' + acc.currency;
    document.getElementById('rv-amount').textContent = UI.money(amount, acc.currency);
    document.getElementById('rv-fee').textContent = UI.money(state.fee, acc.currency);
    document.getElementById('rv-purpose').textContent = document.getElementById('t-purpose').value.trim() || '—';
    showStep(3);
  });

  document.getElementById('step2-back').addEventListener('click', function () { showStep(1); });

  document.getElementById('step3-next').addEventListener('click', async function () {
    const btn = this;
    const fromId = document.getElementById('t-from').value;
    const amount = Number(document.getElementById('t-amount').value);
    const acc = state.accounts.find(function (a) { return a.id === fromId; });
    const purpose = document.getElementById('t-purpose').value.trim();
    const requestId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('req-' + Date.now() + '-' + Math.floor(Math.random() * 1e9));
    try {
      const pin = await UI.promptPin({
        title: 'Confirm International Transfer',
        message: 'Enter your 4-digit security PIN to authorize this transfer of ' + UI.money(amount, acc.currency) + ' to ' + state.beneficiary.name + ' (' + state.beneficiary.country + ').'
      });
      btn.disabled = true;
      btn.textContent = 'Submitting...';
      await UI.transferFlow({
        title: 'International Transfer',
        subtitle: state.beneficiary.name + ' · ' + UI.money(amount, acc.currency),
        transferType: 'international_transfer',
        submit: function () {
          return UI.rpc('create_international_transfer', {
            p_user_id: user.id,
            p_from_account_id: fromId,
            p_recipient_name: state.beneficiary.name,
            p_recipient_bank: state.beneficiary.bank,
            p_recipient_account_number: state.beneficiary.account,
            p_swift_code: state.beneficiary.swift,
            p_recipient_country: state.beneficiary.country,
            p_amount: amount,
            p_currency: acc.currency,
            p_purpose: purpose || null,
            p_pin: pin,
            p_request_id: requestId
          });
        }
      });
      btn.disabled = false;
      btn.textContent = 'Confirm & Submit';
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Confirm & Submit';
      if (e && e.message !== 'CANCELLED') UI.toast(UI.apiErrorMessage(e), 'error');
    }
  });

  document.getElementById('step3-back').addEventListener('click', function () { showStep(2); });

  await load();
  PageLoader.hide();
})();
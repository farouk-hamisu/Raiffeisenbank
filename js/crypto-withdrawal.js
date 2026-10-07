// Raiffeisen Bank — Crypto withdrawal module
(async function () {
  await AppShell.init({ title: 'Crypto Withdrawal' });
  const user = Auth.user;

  const state = { accounts: [], balances: {}, assets: [], fee: 1, btcPrice: null };

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

      // Fetch live BTC price
      state.btcPrice = await BtcPrice.get();

      const [accRes, curRes, assetRes, feeRes] = await Promise.all([
        SB.from('accounts').select('*').eq('user_id', user.id).eq('status', 'active'),
        SB.from('currencies').select('code').eq('is_base', true),
        SB.from('crypto_assets').select('*').eq('is_enabled', true).order('asset'),
        SB.from('system_settings').select('value').eq('key', 'crypto_withdrawal_fee')
      ]);
      if (accRes.error) throw accRes.error;
      if (curRes.error) throw curRes.error;
      if (assetRes.error) throw assetRes.error;
      if (feeRes.error) throw feeRes.error;

      const base = (curRes.data && curRes.data[0] && curRes.data[0].code) || 'USD';
      state.accounts = (accRes.data || []).filter(function (a) { return a.currency === base || a.currency === 'BTC'; });
      state.assets = assetRes.data || [];
      state.fee = (feeRes.data && feeRes.data[0]) ? Number(feeRes.data[0].value) || 1 : 1;

      const balRes = await SB.from('account_balances').select('*').in('account_id', state.accounts.map(function (a) { return a.id; }));
      if (balRes.error) throw balRes.error;
      (balRes.data || []).forEach(function (b) { state.balances[b.account_id] = b; });

      const accSel = document.getElementById('w-account');
      accSel.innerHTML = state.accounts.length
        ? state.accounts.map(function (a) {
            return '<option value="' + a.id + '" data-currency="' + a.currency + '">' + UI.escapeHtml(a.account_name) + ' · ' + UI.escapeHtml(a.currency) + '</option>';
          }).join('')
        : '<option value="">No accounts available</option>';

      const assetSel = document.getElementById('w-asset');
      assetSel.innerHTML = state.assets.map(function (a) {
        var liveRate = (a.asset === 'BTC') ? state.btcPrice : Number(a.rate_usd);
        return '<option value="' + a.asset + ':' + a.network + '" data-asset="' + a.asset + '" data-network="' + a.network + '" data-min="' + a.min_amount + '" data-max="' + a.max_amount + '" data-rate="' + liveRate + '">' +
          UI.escapeHtml(a.asset_label) + ' · ' + UI.escapeHtml(a.network_label) + ' (' + a.asset + '/' + a.network + ')</option>';
      }).join('');

      document.getElementById('w-account').addEventListener('change', updateBalance);
      updateBalance();
      updatePreview();
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function selectedAsset() {
    const o = document.getElementById('w-asset').options[document.getElementById('w-asset').selectedIndex];
    return o && o.value ? {
      asset: o.getAttribute('data-asset'),
      network: o.getAttribute('data-network'),
      min: Number(o.getAttribute('data-min')),
      max: Number(o.getAttribute('data-max')),
      rate: Number(o.getAttribute('data-rate'))
    } : null;
  }

  function updateBalance() {
    const fromId = document.getElementById('w-account').value;
    const acc = state.accounts.find(function (a) { return a.id === fromId; });
    const b = state.balances[fromId];
    const el = document.getElementById('w-balance');
    if (acc && b) {
      el.textContent = UI.money(b.available_balance, acc.currency);
    } else {
      el.textContent = '—';
    }
  }

  function updatePreview() {
    const asset = selectedAsset();
    const amount = Number(document.getElementById('w-amount').value) || 0;
    const accId = document.getElementById('w-account').value;
    const acc = state.accounts.find(function (a) { return a.id === accId; });
    const isBtcAccount = acc && acc.currency === 'BTC';
    document.getElementById('w-asset-tag').textContent = asset ? asset.asset : '—';
    document.getElementById('w-rate').textContent = asset ? '1 ' + asset.asset + ' = $' + Number(asset.rate).toLocaleString(undefined, {maximumFractionDigits: 2}) : '—';
    document.getElementById('w-fee').textContent = UI.money(state.fee, 'USD');
    if (isBtcAccount) {
      const total = amount + state.fee;
      document.getElementById('w-total').textContent = total.toFixed(8) + ' ' + acc.currency;
    } else {
      const fiat = asset ? (amount * asset.rate) : 0;
      document.getElementById('w-total').textContent = UI.money(fiat + state.fee, 'USD');
    }
  }

  document.getElementById('w-asset').addEventListener('change', updatePreview);
  document.getElementById('w-amount').addEventListener('input', updatePreview);

  document.getElementById('w-submit').addEventListener('click', async function () {
    const btn = this;
    const err = document.getElementById('w-error');
    err.textContent = '';

    const acc = state.accounts.find(function (a) { return a.id === document.getElementById('w-account').value; });
    const asset = selectedAsset();
    const wallet = document.getElementById('w-wallet').value.trim();
    const amount = Number(document.getElementById('w-amount').value);
    if (!acc) { err.textContent = 'Select an account to withdraw from.'; return; }
    if (!asset) { err.textContent = 'Select a cryptocurrency asset.'; return; }
    if (!wallet) { err.textContent = 'Enter the recipient wallet address.'; return; }
    if (!amount || amount <= 0) { err.textContent = 'Enter a valid amount.'; return; }
    if (amount < asset.min || amount > asset.max) { err.textContent = 'Amount must be between ' + asset.min + ' and ' + asset.max + ' ' + asset.asset + '.'; return; }
    const b = state.balances[acc.id];
    const accCurrency = acc.currency || 'USD';
    if (accCurrency === 'BTC') {
      if (b && amount > Number(b.available_balance)) { err.textContent = 'Insufficient BTC balance.'; return; }
    } else {
      if (b && (amount * asset.rate + state.fee) > Number(b.available_balance)) { err.textContent = 'Insufficient funds for the amount plus fee.'; return; }
    }

    const requestId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('req-' + Date.now() + '-' + Math.floor(Math.random() * 1e9));
    try {
      const pin = await UI.promptPin({
        title: 'Confirm Crypto Withdrawal',
        message: 'Enter your 4-digit security PIN to authorize the withdrawal of ' + amount + ' ' + asset.asset + ' to ' + wallet + '.'
      });
      btn.disabled = true;
      btn.textContent = 'Submitting...';
      await UI.transferFlow({
        title: 'Crypto Withdrawal',
        subtitle: amount + ' ' + asset.asset + ' → ' + wallet,
        transferType: 'crypto_withdrawal',
        submit: function () {
          return UI.rpc('create_crypto_withdrawal', {
            p_user_id: user.id,
            p_from_account_id: acc.id,
            p_asset: asset.asset,
            p_network: asset.network,
            p_wallet_address: wallet,
            p_amount: amount,
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

  await load();
  PageLoader.hide();
})();
// Marvin Bank — Transfers hub: local, international transfers + crypto withdrawals
(async function () {
  await AppShell.init({ title: 'Transfers' });
  const user = Auth.user;

  function renderLocal(rows) {
    const el = document.getElementById('local-table');
    if (!rows.length) { el.innerHTML = UI.emptyState('No local transfers yet'); return; }
    el.innerHTML = '<table class="table mobile-cards"><thead><tr><th>Reference</th><th>Recipient</th><th>Amount</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>' +
      rows.map(function (t) {
        const actions = [];
        if (t.status === 'awaiting_admin_verification') {
          actions.push('<button class="btn btn-primary btn-sm" data-verify="local_transfer:' + t.id + '" data-title="Local Transfer" data-sub="' + UI.escapeHtml(t.recipient_name + ' · ' + UI.money(t.amount, t.currency)) + '">Enter Code</button>');
        }
        actions.push(receiptButton('local_transfer', t));
        return '<tr><td data-label="Reference">' + UI.escapeHtml(t.reference) + '</td>' +
          '<td data-label="Recipient">' + UI.escapeHtml(t.recipient_name) + '</td>' +
          '<td data-label="Amount">' + UI.money(t.amount, t.currency) + '</td>' +
          '<td data-label="Status">' + UI.badge(t.status) + '</td>' +
          '<td data-label="Date">' + UI.formatDateTime(t.created_at) + '</td>' +
          '<td data-label="">' + actions.filter(Boolean).join(' ') + '</td></tr>';
      }).join('') + '</tbody></table>';
    bindActions(el);
  }

  function renderIntl(rows) {
    const el = document.getElementById('intl-table');
    if (!rows.length) { el.innerHTML = UI.emptyState('No international transfers yet'); return; }
    el.innerHTML = '<table class="table mobile-cards"><thead><tr><th>Reference</th><th>Recipient</th><th>Country</th><th>Amount</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>' +
      rows.map(function (t) {
        const actions = [];
        if (t.status === 'awaiting_admin_verification') {
          actions.push('<button class="btn btn-primary btn-sm" data-verify="international_transfer:' + t.id + '" data-title="International Transfer" data-sub="' + UI.escapeHtml(t.recipient_name + ' · ' + UI.money(t.amount, t.currency)) + '">Enter Code</button>');
        }
        actions.push(receiptButton('international_transfer', t));
        return '<tr><td data-label="Reference">' + UI.escapeHtml(t.reference) + '</td>' +
          '<td data-label="Recipient">' + UI.escapeHtml(t.recipient_name) + '</td>' +
          '<td data-label="Country">' + UI.escapeHtml(t.recipient_country) + '</td>' +
          '<td data-label="Amount">' + UI.money(t.amount, t.currency) + '</td>' +
          '<td data-label="Status">' + UI.badge(t.status) + '</td>' +
          '<td data-label="Date">' + UI.formatDateTime(t.created_at) + '</td>' +
          '<td data-label="">' + actions.filter(Boolean).join(' ') + '</td></tr>';
      }).join('') + '</tbody></table>';
    bindActions(el);
  }

  function renderCrypto(rows) {
    const el = document.getElementById('crypto-table');
    if (!rows.length) { el.innerHTML = UI.emptyState('No crypto withdrawals yet'); return; }
    el.innerHTML = '<table class="table mobile-cards"><thead><tr><th>Reference</th><th>Asset</th><th>Network</th><th>Amount</th><th>Debited</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>' +
      rows.map(function (t) {
        const actions = [];
        if (t.status === 'awaiting_admin_verification') {
          actions.push('<button class="btn btn-primary btn-sm" data-verify="crypto_withdrawal:' + t.id + '" data-title="Crypto Withdrawal" data-sub="' + UI.escapeHtml(t.amount + ' ' + t.asset + ' · ' + t.network) + '">Enter Code</button>');
        }
        actions.push(receiptButton('crypto_withdrawal', t));
        return '<tr><td data-label="Reference">' + UI.escapeHtml(t.reference) + '</td>' +
          '<td data-label="Asset">' + UI.escapeHtml(t.asset) + '</td>' +
          '<td data-label="Network">' + UI.escapeHtml(t.network) + '</td>' +
          '<td data-label="Amount">' + UI.money(t.amount, t.asset) + '</td>' +
          '<td data-label="Debited">' + UI.money(t.amount_fiat, t.currency) + (t.fee ? ' + ' + UI.money(t.fee, t.currency) + ' fee' : '') + '</td>' +
          '<td data-label="Status">' + UI.badge(t.status) + '</td>' +
          '<td data-label="Date">' + UI.formatDateTime(t.created_at) + '</td>' +
          '<td data-label="">' + actions.filter(Boolean).join(' ') + '</td></tr>';
      }).join('') + '</tbody></table>';
    bindActions(el);
  }

  function receiptButton(type, t) {
    if (t.status !== 'completed' && t.status !== 'processing') return '';
    return '<button class="btn btn-outline btn-sm" data-receipt="' + type + ':' + t.id + '">Receipt</button>';
  }

  function openReceipt(type, t) {
    const typeLabel = { local_transfer: 'Local Transfer', international_transfer: 'International Transfer', crypto_withdrawal: 'Crypto Withdrawal' }[type] || 'Transfer';
    const recipient = type === 'crypto_withdrawal'
      ? t.asset + ' (' + t.network + ') → ' + t.wallet_address
      : t.recipient_name;
    const rows = [
      ['Reference', UI.escapeHtml(t.reference)],
      ['Date', UI.escapeHtml(UI.formatDateTime(t.created_at))],
      ['Type', typeLabel],
      ['Recipient', UI.escapeHtml(recipient)]
    ];
    if (type === 'crypto_withdrawal') {
      rows.push(['Amount', UI.money(t.amount, t.asset)]);
      rows.push(['Debited', UI.money(t.amount_fiat, t.currency)]);
    } else {
      rows.push(['Amount', UI.money(t.amount, t.currency)]);
    }
    if (Number(t.fee) > 0) rows.push(['Fee', UI.money(t.fee, t.currency)]);
    if (t.description) rows.push(['Description', UI.escapeHtml(t.description)]);
    rows.push(['Status', UI.badge(t.status)]);

    const modal = UI.openModal(
      '<div class="review-panel" style="margin-bottom:0"><div class="detail-grid">' +
        rows.map(function (r) {
          return '<div class="detail-item"><div class="k">' + r[0] + '</div><div class="v">' + r[1] + '</div></div>';
        }).join('') +
      '</div></div>',
      { title: 'Transfer Receipt', footer: '<button class="btn btn-primary" data-close>Close</button>' }
    );
    modal.footer.querySelector('[data-close]').addEventListener('click', modal.close);
  }

  function bindActions(el) {
    el.querySelectorAll('[data-verify]').forEach(function (b) {
      b.addEventListener('click', function () {
        const parts = b.getAttribute('data-verify').split(':');
        UI.transferFlow({
          title: b.getAttribute('data-title') || 'Transfer',
          subtitle: b.getAttribute('data-sub') || '',
          transferType: parts[0],
          transferId: parts[1],
          onVerified: function () { load(); }
        });
      });
    });
    el.querySelectorAll('[data-receipt]').forEach(function (b) {
      b.addEventListener('click', function () {
        const parts = b.getAttribute('data-receipt').split(':');
        const tableMap = { local_transfer: 'local_transfers', international_transfer: 'international_transfers', crypto_withdrawal: 'crypto_withdrawals' };
        SB.from(tableMap[parts[0]]).select('*').eq('id', parts[1]).single().then(function (res) {
          if (res.error) { UI.toast(UI.apiErrorMessage(res.error), 'error'); return; }
          openReceipt(parts[0], res.data);
        });
      });
    });
  }

  async function load() {
    try {
      const profile = await Auth.fetchProfile();
      const banner = document.getElementById('outgoing-banner');
      if (profile.outgoing_transfers_enabled === false) {
        banner.classList.remove('hide');
        document.getElementById('outgoing-banner-reason').textContent =
          (profile.outgoing_transfers_disabled_reason ? 'Reason: ' + profile.outgoing_transfers_disabled_reason : 'Please contact support for details.');
      } else {
        banner.classList.add('hide');
      }

      const [local, intl, crypto] = await Promise.all([
        SB.from('local_transfers').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
        SB.from('international_transfers').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
        SB.from('crypto_withdrawals').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50)
      ]);
      if (local.error) throw local.error;
      if (intl.error) throw intl.error;
      if (crypto.error) throw crypto.error;
      renderLocal(local.data || []);
      renderIntl(intl.data || []);
      renderCrypto(crypto.data || []);
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  await load();
  PageLoader.hide();
})();
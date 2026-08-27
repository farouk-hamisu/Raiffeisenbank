// marvintlc — Admin customer detail module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Customer Details');

  const id = UI.qs('id');
  if (!id) { window.location.href = 'users.html'; return; }

  let data = null;
  let activeTab = 'profile';

  async function load() {
    try {
      data = await adminApi('admin_get_user', { p_user_id: id });
      renderMasthead();
      renderTab(activeTab);
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function renderMasthead() {
    const p = data.profile;
    document.getElementById('masthead').innerHTML =
      '<div class="customer-masthead">' +
        UI.avatar(p) +
        '<div><h2>' + UI.escapeHtml(p.full_name) + '</h2>' +
        '<div class="cm-meta">' + UI.escapeHtml(p.email) + ' · ' + UI.escapeHtml(p.phone || 'No phone') + ' · joined ' + UI.formatDate(p.created_at) + '</div></div>' +
        '<div class="cm-actions">' +
          '<span class="badge ' + (p.status === 'active' ? 'badge-success' : p.status === 'suspended' ? 'badge-failed' : 'badge-neutral') + '">' + UI.escapeHtml(p.status) + '</span>' +
          UI.badge(p.kyc_status) +
          (p.status === 'suspended'
            ? '<button class="btn btn-success btn-sm" data-act="activate">Activate</button>'
            : '<button class="btn btn-gold btn-sm" data-act="suspend">Suspend</button>') +
          '<button class="btn btn-outline btn-sm" data-act="notify">Notify</button>' +
          '<button class="btn btn-outline btn-sm" data-act="account">+ Account</button>' +
        '</div>' +
      '</div>';
    document.querySelector('[data-act=suspend]').addEventListener('click', function () {
      UI.confirmDialog('Suspend this customer?', async function () {
        try { await adminApi('admin_suspend_user', { p_user_id: id }); UI.toast('Suspended.', 'success'); load(); } catch (e) { UI.toast(UI.apiErrorMessage(e), 'error'); }
      }, 'Suspend');
    });
    document.querySelector('[data-act=activate]').addEventListener('click', async function () {
      try { await adminApi('admin_activate_user', { p_user_id: id }); UI.toast('Activated.', 'success'); load(); } catch (e) { UI.toast(UI.apiErrorMessage(e), 'error'); }
    });
    document.querySelector('[data-act=notify]').addEventListener('click', function () {
      const modal = UI.openModal(
        '<div class="field"><label>Title</label><input type="text" class="input" id="nt-title"></div>' +
        '<div class="field"><label>Message</label><textarea class="textarea" id="nt-msg"></textarea></div>' +
        '<div class="field"><label>Type</label><select class="select" id="nt-type"><option>system</option><option>account</option><option>transfer</option><option>deposit</option><option>loan</option><option>card</option><option>security</option></select></div>' +
        '<div class="form-error" id="nt-error"></div>',
        { title: 'Send Notification', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-send>Send</button>' }
      );
      modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
      modal.footer.querySelector('[data-send]').addEventListener('click', async function () {
        try {
          await adminApi('admin_send_notification', {
            p_user_id: id,
            p_title: document.getElementById('nt-title').value.trim(),
            p_message: document.getElementById('nt-msg').value.trim(),
            p_type: document.getElementById('nt-type').value
          });
          UI.toast('Notification sent.', 'success');
          modal.close();
        } catch (e) { document.getElementById('nt-error').textContent = UI.apiErrorMessage(e); }
      });
    });
    document.querySelector('[data-act=account]').addEventListener('click', function () { openAccount(); });
  }

  function openAccount() {
    const modal = UI.openModal(
      '<div class="field"><label>Account type</label><select class="select" id="a-type"><option value="checking">Checking</option><option value="savings">Savings</option></select></div>' +
      '<div class="field"><label>Currency</label><select class="select" id="a-currency"><option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="NGN">NGN</option><option value="CAD">CAD</option></select></div>' +
      '<div class="field"><label>Account number</label><input type="text" class="input" id="a-number" placeholder="Leave blank to auto-generate"></div>' +
      '<div class="form-error" id="a-error"></div>',
      { title: 'Open Account', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Open Account</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      const err = document.getElementById('a-error');
      err.textContent = '';
      let number = document.getElementById('a-number').value.trim();
      if (!number) {
        number = '48' + String(Math.floor(Math.random() * 1e14)).padStart(14, '0');
      }
      try {
        await adminApi('admin_create_account', {
          p_user_id: id, p_account_type: document.getElementById('a-type').value,
          p_currency: document.getElementById('a-currency').value, p_account_number: number, p_status: 'active'
        });
        UI.toast('Account opened.', 'success');
        modal.close();
        load();
      } catch (e) { err.textContent = UI.apiErrorMessage(e); }
    });
  }

  function renderTab(tab) {
    activeTab = tab;
    document.querySelectorAll('#customer-tabs button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    const el = document.getElementById('tab-content');
    const t = { profile: renderProfile, accounts: renderAccounts, transactions: renderTransactions, transfers: renderTransfers, deposits: renderDeposits, cards: renderCards, swaps: renderSwaps, loans: renderLoans, notifications: renderNotifications }[tab];
    el.innerHTML = t();
  }

  function renderProfile() {
    const p = data.profile;
    let html = '';
    if (p.outgoing_transfers_enabled !== undefined) {
      const enabled = p.outgoing_transfers_enabled !== false;
      html += '<div class="card mb-3">' +
        '<h3 class="card-title mb-2">Outgoing transfers</h3>' +
        '<p class="text-muted mb-2">' +
          (enabled
            ? 'This customer can send international transfers and crypto withdrawals.'
            : 'Outgoing transfers are disabled. Reason: ' + UI.escapeHtml(p.outgoing_transfers_disabled_reason || 'not provided') + '.') +
        '</p>' +
        (enabled
          ? '<button class="btn btn-danger btn-sm" data-outgoing-disable>Disable outgoing transfers</button>'
          : '<button class="btn btn-success btn-sm" data-outgoing-enable>Enable outgoing transfers</button>') +
      '</div>';
    }
    html += '<div class="card"><h3 class="card-title mb-3">Personal information</h3>' +
      '<div class="detail-grid">' +
        '<div class="detail-item"><div class="k">Full name</div><div class="v">' + UI.escapeHtml(p.full_name || '—') + '</div></div>' +
        '<div class="detail-item"><div class="k">Email</div><div class="v">' + UI.escapeHtml(p.email || '—') + '</div></div>' +
        '<div class="detail-item"><div class="k">Phone</div><div class="v">' + UI.escapeHtml(p.phone || '—') + '</div></div>' +
        '<div class="detail-item"><div class="k">Date of birth</div><div class="v">' + (p.date_of_birth ? UI.formatDate(p.date_of_birth) : '—') + '</div></div>' +
        '<div class="detail-item"><div class="k">Address</div><div class="v">' + UI.escapeHtml(p.address || '—') + '</div></div>' +
        '<div class="detail-item"><div class="k">City</div><div class="v">' + UI.escapeHtml(p.city || '—') + '</div></div>' +
        '<div class="detail-item"><div class="k">Country</div><div class="v">' + UI.escapeHtml(p.country || '—') + '</div></div>' +
        '<div class="detail-item"><div class="k">Status</div><div class="v">' + UI.badge(p.status) + '</div></div>' +
        '<div class="detail-item"><div class="k">KYC</div><div class="v">' + UI.badge(p.kyc_status) + '</div></div>' +
        '<div class="detail-item"><div class="k">Member since</div><div class="v">' + UI.formatDateTime(p.created_at) + '</div></div>' +
      '</div></div>';
    return html;
  }

  function outgoingModal(disable) {
    const modal = UI.openModal(
      disable
        ? '<div class="field"><label>Reason for disabling</label><textarea class="textarea" id="og-reason" placeholder="e.g. Fraud review"></textarea></div><div class="form-error" id="og-error"></div>'
        : '<p class="mb-2">Re-enable international transfers and crypto withdrawals for this customer?</p><div class="form-error" id="og-error"></div>',
      { title: disable ? 'Disable outgoing transfers' : 'Enable outgoing transfers', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn ' + (disable ? 'btn-danger' : 'btn-success') + '" data-save>' + (disable ? 'Disable' : 'Enable') + '</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      try {
        await adminApi('admin_toggle_outgoing_transfers', {
          p_user_id: id,
          p_enabled: !disable,
          p_reason: disable ? (document.getElementById('og-reason').value.trim() || null) : null
        });
        UI.toast('Outgoing transfers ' + (disable ? 'disabled.' : 'enabled.'), 'success');
        modal.close();
        load();
      } catch (e) { document.getElementById('og-error').textContent = UI.apiErrorMessage(e); }
    });
  }

  function renderAccounts() {
    const rows = data.accounts || [];
    if (!rows.length) return UI.emptyState('No accounts');
    return '<div class="card"><div class="table-wrap"><table class="table mobile-cards"><thead><tr><th>Account</th><th>Type</th><th>Currency</th><th>Balance</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (a) {
        return '<tr><td data-label="Account"><div class="cell-main">' + UI.escapeHtml(a.account_name) + '</div><div class="cell-sub">' + UI.escapeHtml(a.account_number) + '</div></td>' +
          '<td data-label="Type">' + UI.escapeHtml(a.account_type) + '</td>' +
          '<td data-label="Currency">' + UI.escapeHtml(a.currency) + '</td>' +
          '<td data-label="Balance">' + UI.money(a.ledger_balance || 0, a.currency) + '</td>' +
          '<td data-label="Status">' + UI.badge(a.status) + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            (a.status === 'suspended' || a.status === 'inactive'
              ? '<button class="row-action success" data-acc-activate="' + a.id + '" title="Activate">' + ICONS.play + '</button>'
              : '<button class="row-action" data-acc-suspend="' + a.id + '" title="Suspend">' + ICONS.pause + '</button>') +
          '</div></td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  function renderTransactions() {
    const rows = data.transactions || [];
    if (!rows.length) return UI.emptyState('No transactions');
    return '<div class="card"><div class="table-wrap"><table class="table mobile-cards"><thead><tr><th>Reference</th><th>Type</th><th>Direction</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
      rows.map(function (t) {
        return '<tr><td data-label="Reference">' + UI.escapeHtml(t.reference) + '</td>' +
          '<td data-label="Type">' + UI.typeLabel(t.type) + '</td>' +
          '<td data-label="Direction">' + UI.escapeHtml(t.direction) + '</td>' +
          '<td data-label="Amount" class="' + (t.direction === 'credit' ? 'amount-credit' : 'amount-debit') + '">' + UI.money(t.amount, t.currency) + '</td>' +
          '<td data-label="Status">' + UI.badge(t.status) + '</td>' +
          '<td data-label="Date">' + UI.formatDateTime(t.created_at) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  function renderTransfers() {
    let html = '';
    const local = (data.local_transfers || []);
    const intl = (data.international_transfers || []);
    if (!local.length && !intl.length) return UI.emptyState('No transfers');
    html += '<div class="card mb-3"><h3 class="card-title mb-2">Local transfers</h3>' +
      (local.length ? '<div class="table-wrap"><table class="table mobile-cards"><thead><tr><th>Reference</th><th>Recipient</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
        local.map(function (t) { return '<tr><td data-label="Reference">' + UI.escapeHtml(t.reference) + '</td><td data-label="Recipient">' + UI.escapeHtml(t.recipient_name) + '</td><td data-label="Amount">' + UI.money(t.amount, t.currency) + '</td><td data-label="Status">' + UI.badge(t.status) + '</td><td data-label="Date">' + UI.formatDateTime(t.created_at) + '</td></tr>'; }).join('') +
        '</tbody></table></div>' : UI.emptyState('No local transfers')) + '</div>';
    html += '<div class="card"><h3 class="card-title mb-2">International transfers</h3>' +
      (intl.length ? '<div class="table-wrap"><table class="table mobile-cards"><thead><tr><th>Reference</th><th>Recipient</th><th>Country</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
        intl.map(function (t) { return '<tr><td data-label="Reference">' + UI.escapeHtml(t.reference) + '</td><td data-label="Recipient">' + UI.escapeHtml(t.recipient_name) + '</td><td data-label="Country">' + UI.escapeHtml(t.recipient_country) + '</td><td data-label="Amount">' + UI.money(t.amount, t.currency) + '</td><td data-label="Status">' + UI.badge(t.status) + '</td><td data-label="Date">' + UI.formatDateTime(t.created_at) + '</td></tr>'; }).join('') +
        '</tbody></table></div>' : UI.emptyState('No international transfers')) + '</div>';
    return html;
  }

  function renderDeposits() {
    const rows = data.deposits || [];
    if (!rows.length) return UI.emptyState('No deposits');
    return '<div class="card"><div class="table-wrap"><table class="table mobile-cards"><thead><tr><th>Reference</th><th>Method</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
      rows.map(function (d) {
        return '<tr><td data-label="Reference">' + UI.escapeHtml(d.reference) + '</td><td data-label="Method">' + UI.escapeHtml(d.method) + '</td><td data-label="Amount">' + UI.money(d.amount, d.currency) + '</td><td data-label="Status">' + UI.badge(d.status) + '</td><td data-label="Date">' + UI.formatDateTime(d.created_at) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  function renderCards() {
    const rows = data.cards || [];
    if (!rows.length) return UI.emptyState('No cards');
    return '<div class="grid-auto">' + rows.map(function (c) {
      return '<div class="card">' + UI.renderCardFace(c) +
        '<div class="flex-between mt-2">' + UI.badge(c.status) + '<span class="text-sm text-muted">' + UI.escapeHtml(c.card_type) + '</span></div>' +
        '<div class="flex gap-1 mt-2">' +
          (c.status === 'active'
            ? '<button class="btn btn-gold btn-sm" data-card-freeze="' + c.id + '">Freeze</button>'
            : '<button class="btn btn-success btn-sm" data-card-active="' + c.id + '">Unfreeze</button>') +
          '<button class="btn btn-danger btn-sm" data-card-block="' + c.id + '">Block</button>' +
        '</div></div>';
    }).join('') + '</div>';
  }

  function renderSwaps() {
    const rows = data.swaps || [];
    if (!rows.length) return UI.emptyState('No currency swaps');
    return '<div class="card"><div class="table-wrap"><table class="table mobile-cards"><thead><tr><th>Reference</th><th>Pair</th><th>From</th><th>To</th><th>Rate</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
      rows.map(function (s) { return '<tr><td data-label="Reference">' + UI.escapeHtml(s.reference) + '</td><td data-label="Pair">' + s.from_currency + '→' + s.to_currency + '</td><td data-label="From">' + UI.money(s.from_amount, s.from_currency) + '</td><td data-label="To">' + UI.money(s.to_amount, s.to_currency) + '</td><td data-label="Rate">' + s.rate + '</td><td data-label="Status">' + UI.badge(s.status) + '</td><td data-label="Date">' + UI.formatDateTime(s.created_at) + '</td></tr>'; }).join('') +
      '</tbody></table></div></div>';
  }

  function renderLoans() {
    const rows = data.loans || [];
    if (!rows.length) return UI.emptyState('No loan applications');
    return '<div class="card"><div class="table-wrap"><table class="table mobile-cards"><thead><tr><th>Reference</th><th>Amount</th><th>Term</th><th>Status</th><th>Applied</th></tr></thead><tbody>' +
      rows.map(function (l) { return '<tr><td data-label="Reference">' + UI.escapeHtml(l.reference) + '</td><td data-label="Amount">' + UI.money(l.amount, l.currency) + '</td><td data-label="Term">' + l.term_months + ' mo · ' + l.interest_rate + '%</td><td data-label="Status">' + UI.badge(l.status) + '</td><td data-label="Applied">' + UI.formatDateTime(l.created_at) + '</td></tr>'; }).join('') +
      '</tbody></table></div></div>';
  }

  function renderNotifications() {
    const rows = data.notifications || [];
    if (!rows.length) return UI.emptyState('No notifications');
    return '<div class="card"><div class="notif-list">' + rows.map(function (n) {
      return '<div class="notif-item ' + (n.is_read ? '' : 'unread') + '"><div class="notif-icon">' + icon('bell') + '</div>' +
        '<div><div class="notif-title">' + UI.escapeHtml(n.title) + '</div><div class="notif-msg">' + UI.escapeHtml(n.message) + '</div><div class="notif-time">' + UI.formatDateTime(n.created_at) + '</div></div></div>';
    }).join('') + '</div></div>';
  }

  document.querySelectorAll('#customer-tabs button').forEach(function (b) {
    b.addEventListener('click', function () { renderTab(b.getAttribute('data-tab')); });
  });

  // delegated handlers for account/card actions
  document.getElementById('tab-content').addEventListener('click', async function (e) {
    const suspend = e.target.closest('[data-acc-suspend]');
    const activate = e.target.closest('[data-acc-activate]');
    const freeze = e.target.closest('[data-card-freeze]');
    const active = e.target.closest('[data-card-active]');
    const block = e.target.closest('[data-card-block]');
    const disableOut = e.target.closest('[data-outgoing-disable]');
    const enableOut = e.target.closest('[data-outgoing-enable]');
    try {
      if (suspend) {
        await adminApi('admin_change_account_status', { p_account_id: suspend.getAttribute('data-acc-suspend'), p_status: 'suspended' });
        UI.toast('Account suspended.', 'success'); load();
      } else if (activate) {
        await adminApi('admin_change_account_status', { p_account_id: activate.getAttribute('data-acc-activate'), p_status: 'active' });
        UI.toast('Account activated.', 'success'); load();
      } else if (freeze) {
        await adminApi('admin_update_card', { p_card_id: freeze.getAttribute('data-card-freeze'), p_status: 'frozen' });
        UI.toast('Card frozen.', 'success'); load();
      } else if (active) {
        await adminApi('admin_update_card', { p_card_id: active.getAttribute('data-card-active'), p_status: 'active' });
        UI.toast('Card unfrozen.', 'success'); load();
      } else if (block) {
        await adminApi('admin_update_card', { p_card_id: block.getAttribute('data-card-block'), p_status: 'blocked' });
        UI.toast('Card blocked.', 'success'); load();
      } else if (disableOut) {
        outgoingModal(true);
      } else if (enableOut) {
        outgoingModal(false);
      }
    } catch (err) {
      UI.toast(UI.apiErrorMessage(err), 'error');
    }
  });

  await load();
  PageLoader.hide();
})();
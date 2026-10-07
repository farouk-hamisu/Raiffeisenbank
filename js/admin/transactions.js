// Raiffeisen Bank — Admin transactions module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Transactions');

  const PAGE = 12;
  let page = 1;

  const STATUSES = ['pending', 'processing', 'completed', 'failed', 'cancelled', 'reversed'];
  const TYPES = ['deposit', 'withdrawal', 'local_transfer', 'international_transfer', 'currency_swap', 'loan_disbursement', 'loan_repayment', 'fee', 'interest', 'reversal', 'adjustment'];

  function fill() {
    document.getElementById('f-status').innerHTML = '<option value="">All statuses</option>' + STATUSES.map(function (s) { return '<option value="' + s + '">' + UI.typeLabel(s) + '</option>'; }).join('');
    document.getElementById('f-type').innerHTML = '<option value="">All types</option>' + TYPES.map(function (t) { return '<option value="' + t + '">' + UI.typeLabel(t) + '</option>'; }).join('');
  }

  async function load() {
    const el = document.getElementById('tx-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading transactions...</span></div>';
    try {
      const res = await adminApi('admin_list_transactions', {
        p_search: document.getElementById('f-search').value.trim(),
        p_status: document.getElementById('f-status').value || null,
        p_type: document.getElementById('f-type').value || null,
        p_currency: document.getElementById('f-currency').value || null,
        p_limit: PAGE, p_offset: (page - 1) * PAGE
      });
      render(res.rows || []);
      renderPagination(res.total || 0);
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load transactions');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function render(rows) {
    const el = document.getElementById('tx-table');
    if (!rows.length) { el.innerHTML = UI.emptyState('No transactions found'); return; }
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Reference</th><th>User</th><th>Type</th><th>Direction</th><th>Amount</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (t) {
        return '<tr><td data-label="Reference"><span class="cell-main">' + UI.escapeHtml(t.reference) + '</span></td>' +
          '<td data-label="User">' + UI.escapeHtml(t.user_email || t.user_name || '—') + '</td>' +
          '<td data-label="Type">' + UI.typeLabel(t.type) + '</td>' +
          '<td data-label="Direction">' + UI.escapeHtml(t.direction) + '</td>' +
          '<td data-label="Amount" class="' + (t.direction === 'credit' ? 'amount-credit' : 'amount-debit') + '">' + UI.money(t.amount, t.currency) + '</td>' +
          '<td data-label="Status">' + UI.badge(t.status) + '</td>' +
          '<td data-label="Date">' + UI.formatDateTime(t.created_at) + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            '<button class="row-action" data-view="' + t.id + '" title="View">' + ICONS.eye + '</button>' +
            (t.status === 'completed'
              ? '<button class="row-action danger" data-reverse="' + t.id + '" title="Reverse">' + ICONS.arrowDown + '</button>'
              : '<button class="row-action" data-status="' + t.id + '" title="Update status">' + ICONS.edit + '</button>') +
          '</div></td></tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () {
        const t = rows.find(function (x) { return x.id === b.getAttribute('data-view'); });
        UI.openModal(
          '<div class="detail-grid">' +
            '<div class="detail-item"><div class="k">Reference</div><div class="v">' + UI.escapeHtml(t.reference) + '</div></div>' +
            '<div class="detail-item"><div class="k">Status</div><div class="v">' + UI.badge(t.status) + '</div></div>' +
            '<div class="detail-item"><div class="k">User</div><div class="v">' + UI.escapeHtml(t.user_email || '—') + '</div></div>' +
            '<div class="detail-item"><div class="k">Type</div><div class="v">' + UI.typeLabel(t.type) + '</div></div>' +
            '<div class="detail-item"><div class="k">Amount</div><div class="v">' + UI.money(t.amount, t.currency) + '</div></div>' +
            '<div class="detail-item"><div class="k">Fee</div><div class="v">' + UI.money(t.fee || 0, t.currency) + '</div></div>' +
            '<div class="detail-item"><div class="k">Sender</div><div class="v">' + UI.escapeHtml(t.sender || '—') + '</div></div>' +
            '<div class="detail-item"><div class="k">Recipient</div><div class="v">' + UI.escapeHtml(t.recipient || '—') + '</div></div>' +
            '<div class="detail-item"><div class="k">Description</div><div class="v">' + UI.escapeHtml(t.description || '—') + '</div></div>' +
            '<div class="detail-item"><div class="k">Created</div><div class="v">' + UI.formatDateTime(t.created_at) + '</div></div>' +
          '</div>',
          { title: 'Transaction Details' }
        );
      });
    });
    el.querySelectorAll('[data-status]').forEach(function (b) {
      b.addEventListener('click', function () {
        const t = rows.find(function (x) { return x.id === b.getAttribute('data-status'); });
        updateStatus(t);
      });
    });
    el.querySelectorAll('[data-reverse]').forEach(function (b) {
      b.addEventListener('click', function () {
        const id = b.getAttribute('data-reverse');
        UI.confirmDialog('Reverse this transaction? The funds will be returned to the customer\'s account and an audit entry created.', async function () {
          try {
            await adminApi('admin_reverse_transaction', { p_tx_id: id });
            UI.toast('Transaction reversed.', 'success');
            load();
          } catch (e) { UI.toast(UI.apiErrorMessage(e), 'error'); }
        }, 'Reverse');
      });
    });
  }

  function updateStatus(t) {
    const modal = UI.openModal(
      '<div class="field"><label>New status</label><select class="select" id="st-status">' +
        STATUSES.map(function (s) { return '<option value="' + s + '"' + (s === t.status ? ' selected' : '') + '>' + UI.typeLabel(s) + '</option>'; }).join('') +
      '</select></div><div class="form-error" id="st-error"></div>',
      { title: 'Update Status — ' + t.reference, footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Update</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      try {
        await adminApi('admin_update_transaction_status', { p_tx_id: t.id, p_status: document.getElementById('st-status').value });
        UI.toast('Status updated.', 'success');
        modal.close();
        load();
      } catch (e) { document.getElementById('st-error').textContent = UI.apiErrorMessage(e); }
    });
  }

  function renderPagination(total) {
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const el = document.getElementById('pagination');
    let html = '<button data-p="' + (page - 1) + '" ' + (page <= 1 ? 'disabled' : '') + '>‹</button>';
    for (let i = 1; i <= pages; i++) html += '<button data-p="' + i + '" class="' + (i === page ? 'active' : '') + '">' + i + '</button>';
    html += '<button data-p="' + (page + 1) + '" ' + (page >= pages ? 'disabled' : '') + '>›</button>';
    el.innerHTML = html;
    el.querySelectorAll('button[data-p]').forEach(function (b) {
      b.addEventListener('click', function () { page = Number(b.getAttribute('data-p')); load(); });
    });
  }

  document.getElementById('btn-create').addEventListener('click', function () {
    const modal = UI.openModal(
      '<div class="field"><label>Customer email</label><input type="email" class="input" id="t-email" placeholder="customer@example.com"></div>' +
      '<div class="field"><label>Type</label><select class="select" id="t-type">' + TYPES.map(function (t) { return '<option value="' + t + '">' + UI.typeLabel(t) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Direction</label><select class="select" id="t-direction"><option value="credit">Credit</option><option value="debit">Debit</option></select></div>' +
      '<div class="field"><label>Amount</label><input type="number" class="input" id="t-amount" min="0.01" step="0.01"></div>' +
      '<div class="field"><label>Currency</label><select class="select" id="t-currency"><option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="NGN">NGN</option><option value="CAD">CAD</option></select></div>' +
      '<div class="field"><label>Description</label><input type="text" class="input" id="t-desc"></div>' +
      '<div class="form-error" id="t-error"></div>',
      { title: 'Create Transaction', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Create</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      const err = document.getElementById('t-error');
      err.textContent = '';
      const email = document.getElementById('t-email').value.trim();
      const amount = Number(document.getElementById('t-amount').value);
      if (!email) { err.textContent = 'Customer email is required.'; return; }
      if (!amount || amount <= 0) { err.textContent = 'Enter a valid amount.'; return; }
      try {
        const user = await adminApi('admin_list_users', { p_search: email, p_limit: 1, p_offset: 0 });
        if (!user.rows.length) { err.textContent = 'No customer found.'; return; }
        const uid = user.rows[0].id;
        const acc = await adminApi('admin_list_accounts', { p_search: email, p_currency: document.getElementById('t-currency').value, p_limit: 1, p_offset: 0 });
        if (!acc.rows.length) { err.textContent = 'No matching account found for that currency.'; return; }
        await adminApi('admin_create_transaction', {
          p_user_id: uid, p_account_id: acc.rows[0].id,
          p_type: document.getElementById('t-type').value,
          p_direction: document.getElementById('t-direction').value,
          p_amount: amount, p_currency: document.getElementById('t-currency').value,
          p_description: document.getElementById('t-desc').value.trim() || null
        });
        UI.toast('Transaction created.', 'success');
        modal.close();
        load();
      } catch (e) { err.textContent = UI.apiErrorMessage(e); }
    });
  });

  ['f-search', 'f-status', 'f-type', 'f-currency'].forEach(function (id) {
    const el = document.getElementById(id);
    el.addEventListener('input', function () { page = 1; load(); });
    el.addEventListener('change', function () { page = 1; load(); });
  });

  fill();
  await load();
  PageLoader.hide();
})();
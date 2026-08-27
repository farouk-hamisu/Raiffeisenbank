// marvintlc — Admin accounts module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Accounts');

  const PAGE = 12;
  let page = 1;

  async function load() {
    const el = document.getElementById('accounts-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading accounts...</span></div>';
    try {
      const res = await adminApi('admin_list_accounts', {
        p_search: document.getElementById('f-search').value.trim(),
        p_status: document.getElementById('f-status').value || null,
        p_currency: document.getElementById('f-currency').value || null,
        p_limit: PAGE, p_offset: (page - 1) * PAGE
      });
      render(res.rows || []);
      renderPagination(res.total || 0);
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load accounts');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function render(rows) {
    const el = document.getElementById('accounts-table');
    if (!rows.length) { el.innerHTML = UI.emptyState('No accounts found'); return; }
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Account</th><th>Owner</th><th>Type</th><th>Currency</th><th>Available</th><th>Ledger</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (a) {
        return '<tr><td data-label="Account"><div class="cell-main">' + UI.escapeHtml(a.account_name) + '</div><div class="cell-sub">' + UI.escapeHtml(a.account_number) + '</div></td>' +
          '<td data-label="Owner">' + UI.escapeHtml(a.owner_name || '—') + '</td>' +
          '<td data-label="Type">' + UI.escapeHtml(a.account_type) + '</td>' +
          '<td data-label="Currency">' + UI.escapeHtml(a.currency) + '</td>' +
          '<td data-label="Available">' + UI.money(a.available_balance || 0, a.currency) + '</td>' +
          '<td data-label="Ledger">' + UI.money(a.ledger_balance || 0, a.currency) + '</td>' +
          '<td data-label="Status">' + UI.badge(a.status) + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            '<button class="row-action" data-edit="' + a.id + '" title="Edit">' + ICONS.edit + '</button>' +
            (a.status === 'suspended' || a.status === 'inactive'
              ? '<button class="row-action success" data-status="' + a.id + '" data-val="active" title="Activate">' + ICONS.play + '</button>'
              : '<button class="row-action" data-status="' + a.id + '" data-val="suspended" title="Suspend">' + ICONS.pause + '</button>') +
          '</div></td></tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        const a = rows.find(function (x) { return x.id === b.getAttribute('data-edit'); });
        editAccount(a);
      });
    });
    el.querySelectorAll('[data-status]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const val = b.getAttribute('data-val');
        try {
          await adminApi('admin_change_account_status', { p_account_id: b.getAttribute('data-status'), p_status: val });
          UI.toast('Account status updated to ' + val + '.', 'success');
          load();
        } catch (e) { UI.toast(UI.apiErrorMessage(e), 'error'); }
      });
    });
  }

  function editAccount(a) {
    const modal = UI.openModal(
      '<div class="field"><label>Account name</label><input type="text" class="input" id="e-name" value="' + UI.escapeHtml(a.account_name) + '"></div>' +
      '<div class="field"><label>Type</label><select class="select" id="e-type"><option value="checking"' + (a.account_type === 'checking' ? ' selected' : '') + '>Checking</option><option value="savings"' + (a.account_type === 'savings' ? ' selected' : '') + '>Savings</option></select></div>' +
      '<div class="field"><label>Status</label><select class="select" id="e-status"><option value="active"' + (a.status === 'active' ? ' selected' : '') + '>Active</option><option value="inactive"' + (a.status === 'inactive' ? ' selected' : '') + '>Inactive</option><option value="suspended"' + (a.status === 'suspended' ? ' selected' : '') + '>Suspended</option><option value="closed"' + (a.status === 'closed' ? ' selected' : '') + '>Closed</option></select></div>' +
      '<div class="form-error" id="e-error"></div>',
      { title: 'Edit Account', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      try {
        await adminApi('admin_update_account', {
          p_account_id: a.id,
          p_account_type: document.getElementById('e-type').value,
          p_status: document.getElementById('e-status').value
        });
        UI.toast('Account updated.', 'success');
        modal.close();
        load();
      } catch (e) { document.getElementById('e-error').textContent = UI.apiErrorMessage(e); }
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
      '<div class="field"><label>Customer email</label><input type="email" class="input" id="c-email" placeholder="customer@example.com"></div>' +
      '<div class="field"><label>Account type</label><select class="select" id="c-type"><option value="checking">Checking</option><option value="savings">Savings</option></select></div>' +
      '<div class="field"><label>Currency</label><select class="select" id="c-currency"><option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="NGN">NGN</option><option value="CAD">CAD</option></select></div>' +
      '<div class="field"><label>Account number</label><input type="text" class="input" id="c-number" placeholder="Leave blank to auto-generate"></div>' +
      '<div class="form-error" id="c-error"></div>',
      { title: 'Create Account', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Create</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      const err = document.getElementById('c-error');
      err.textContent = '';
      const email = document.getElementById('c-email').value.trim();
      if (!email) { err.textContent = 'Customer email is required.'; return; }
      try {
        const user = await adminApi('admin_list_users', { p_search: email, p_limit: 1, p_offset: 0 });
        if (!user.rows.length) { err.textContent = 'No customer found with that email.'; return; }
        const uid = user.rows[0].id;
        let number = document.getElementById('c-number').value.trim();
        if (!number) number = '48' + String(Math.floor(Math.random() * 1e14)).padStart(14, '0');
        await adminApi('admin_create_account', {
          p_user_id: uid, p_account_type: document.getElementById('c-type').value,
          p_currency: document.getElementById('c-currency').value, p_account_number: number, p_status: 'active'
        });
        UI.toast('Account created.', 'success');
        modal.close();
        load();
      } catch (e) { err.textContent = UI.apiErrorMessage(e); }
    });
  });

  ['f-search', 'f-status', 'f-currency'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', function () { page = 1; load(); });
    document.getElementById(id).addEventListener('change', function () { page = 1; load(); });
  });

  await load();
  PageLoader.hide();
})();
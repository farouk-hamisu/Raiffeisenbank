// Raiffeisen Bank — Admin users module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Users');

  const PAGE = 12;
  let page = 1;
  let total = 0;

  async function load() {
    const el = document.getElementById('users-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading users...</span></div>';
    try {
      const search = document.getElementById('f-search').value.trim();
      const status = document.getElementById('f-status').value || null;
      const res = await adminApi('admin_list_users', {
        p_search: search, p_status: status, p_limit: PAGE, p_offset: (page - 1) * PAGE
      });
      total = res.total || 0;
      render(res.rows || []);
      renderPagination();
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load users');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function render(rows) {
    const el = document.getElementById('users-table');
    if (!rows.length) { el.innerHTML = UI.emptyState('No users found'); return; }
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Customer</th><th>Status</th><th>KYC</th><th>Accounts</th><th>Total balance</th><th>Transfers</th><th>Joined</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (u) {
        const transfersEnabled = u.outgoing_transfers_enabled !== false;
        return '<tr data-id="' + u.id + '" class="row-link">' +
          '<td data-label="Customer"><div class="flex gap-1">' + UI.avatar(u) + '<div><div class="cell-main">' + UI.escapeHtml(u.full_name || '—') + '</div><div class="cell-sub">' + UI.escapeHtml(u.email) + '</div></div></div></td>' +
          '<td data-label="Status">' + UI.badge(u.status) + '</td>' +
          '<td data-label="KYC">' + UI.badge(u.kyc_status) + '</td>' +
          '<td data-label="Accounts">' + u.account_count + '</td>' +
          '<td data-label="Total balance">' + UI.money(u.total_balance, 'USD') + '</td>' +
          '<td data-label="Transfers"><button class="btn btn-sm ' + (transfersEnabled ? 'btn-success' : 'btn-failed') + '" data-toggle-transfers="' + u.id + '" data-enabled="' + transfersEnabled + '">' + (transfersEnabled ? 'Enabled' : 'Disabled') + '</button></td>' +
          '<td data-label="Joined">' + UI.formatDate(u.created_at) + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            '<button class="row-action" data-view="' + u.id + '" title="View">' + ICONS.eye + '</button>' +
            '<button class="row-action" data-edit="' + u.id + '" title="Edit">' + ICONS.edit + '</button>' +
            (u.status === 'suspended'
              ? '<button class="row-action success" data-activate="' + u.id + '" title="Activate">' + ICONS.play + '</button>'
              : '<button class="row-action" data-suspend="' + u.id + '" title="Suspend">' + ICONS.pause + '</button>') +
            '<button class="row-action danger" data-del="' + u.id + '" title="Delete">' + ICONS.trash + '</button>' +
          '</div></td></tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('tr[data-id]').forEach(function (tr) {
      tr.addEventListener('click', function (e) {
        if (e.target.closest('.row-action')) return;
        window.location.href = 'customer.html?id=' + tr.getAttribute('data-id');
      });
    });
    el.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        window.location.href = 'customer.html?id=' + b.getAttribute('data-view');
      });
    });
    el.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        const u = rows.find(function (x) { return x.id === b.getAttribute('data-edit'); });
        editUser(u);
      });
    });
    el.querySelectorAll('[data-suspend]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        const id = b.getAttribute('data-suspend');
        UI.confirmDialog('Suspend this customer? Their accounts and cards will be frozen.', async function () {
          try {
            await adminApi('admin_suspend_user', { p_user_id: id });
            UI.toast('Customer suspended.', 'success');
            load();
          } catch (err) { UI.toast(UI.apiErrorMessage(err), 'error'); }
        }, 'Suspend');
      });
    });
    el.querySelectorAll('[data-activate]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        const id = b.getAttribute('data-activate');
        UI.confirmDialog('Activate this customer?', async function () {
          try {
            await adminApi('admin_activate_user', { p_user_id: id });
            UI.toast('Customer activated.', 'success');
            load();
          } catch (err) { UI.toast(UI.apiErrorMessage(err), 'error'); }
        }, 'Activate');
      });
    });
    el.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        const id = b.getAttribute('data-del');
        UI.confirmDialog('Delete this customer permanently? This cannot be undone.', async function () {
          try {
            await adminApi('admin_delete_user', { p_user_id: id });
            UI.toast('Customer deleted.', 'success');
            load();
          } catch (err) { UI.toast(UI.apiErrorMessage(err), 'error'); }
        }, 'Delete');
      });
    });
    el.querySelectorAll('[data-toggle-transfers]').forEach(function (b) {
      b.addEventListener('click', async function (e) {
        e.stopPropagation();
        const id = b.getAttribute('data-toggle-transfers');
        const currentlyEnabled = b.getAttribute('data-enabled') === 'true';
        const action = currentlyEnabled ? 'disable' : 'enable';
        UI.confirmDialog('Are you sure you want to ' + action + ' outgoing transfers for this customer?', async function () {
          try {
            await adminApi('admin_toggle_outgoing_transfers', {
              p_user_id: id,
              p_enabled: !currentlyEnabled,
              p_reason: currentlyEnabled ? 'Disabled by admin' : null
            });
            UI.toast('Transfers ' + action + 'd.', 'success');
            load();
          } catch (err) { UI.toast(UI.apiErrorMessage(err), 'error'); }
        }, action.charAt(0).toUpperCase() + action.slice(1));
      });
    });
  }

  function renderPagination() {
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const el = document.getElementById('pagination');
    let html = '<button data-p="' + (page - 1) + '" ' + (page <= 1 ? 'disabled' : '') + '>‹</button>';
    for (let i = 1; i <= pages; i++) {
      html += '<button data-p="' + i + '" class="' + (i === page ? 'active' : '') + '">' + i + '</button>';
    }
    html += '<button data-p="' + (page + 1) + '" ' + (page >= pages ? 'disabled' : '') + '>›</button>';
    el.innerHTML = html;
    el.querySelectorAll('button[data-p]').forEach(function (b) {
      b.addEventListener('click', function () { page = Number(b.getAttribute('data-p')); load(); });
    });
  }

  function editUser(u) {
    const modal = UI.openModal(
      '<div class="form-grid">' +
        '<div class="field span-2"><label>Full name</label><input type="text" class="input" id="u-name" value="' + UI.escapeHtml(u.full_name || '') + '"></div>' +
        '<div class="field"><label>Phone</label><input type="text" class="input" id="u-phone" value="' + UI.escapeHtml(u.phone || '') + '"></div>' +
        '<div class="field"><label>Status</label><select class="select" id="u-status"><option value="active"' + (u.status === 'active' ? ' selected' : '') + '>Active</option><option value="pending"' + (u.status === 'pending' ? ' selected' : '') + '>Pending</option><option value="suspended"' + (u.status === 'suspended' ? ' selected' : '') + '>Suspended</option><option value="closed"' + (u.status === 'closed' ? ' selected' : '') + '>Closed</option></select></div>' +
        '<div class="field"><label>KYC status</label><select class="select" id="u-kyc"><option value="pending"' + (u.kyc_status === 'pending' ? ' selected' : '') + '>Pending</option><option value="verified"' + (u.kyc_status === 'verified' ? ' selected' : '') + '>Verified</option><option value="rejected"' + (u.kyc_status === 'rejected' ? ' selected' : '') + '>Rejected</option></select></div>' +
        '<div class="field"><label>Address</label><input type="text" class="input" id="u-address" value="' + UI.escapeHtml(u.address || '') + '"></div>' +
        '<div class="field"><label>City</label><input type="text" class="input" id="u-city" value="' + UI.escapeHtml(u.city || '') + '"></div>' +
        '<div class="field"><label>Country</label><input type="text" class="input" id="u-country" value="' + UI.escapeHtml(u.country || '') + '"></div>' +
      '</div><div class="form-error" id="u-error"></div>',
      { title: 'Edit Customer', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      const err = document.getElementById('u-error');
      err.textContent = '';
      const btn = this;
      btn.disabled = true;
      try {
        await adminApi('admin_update_user', {
          p_user_id: u.id,
          p_full_name: document.getElementById('u-name').value.trim() || null,
          p_phone: document.getElementById('u-phone').value.trim() || null,
          p_status: document.getElementById('u-status').value,
          p_kyc_status: document.getElementById('u-kyc').value,
          p_address: document.getElementById('u-address').value.trim() || null,
          p_city: document.getElementById('u-city').value.trim() || null,
          p_country: document.getElementById('u-country').value.trim() || null
        });
        UI.toast('Customer updated.', 'success');
        modal.close();
        load();
      } catch (e) {
        btn.disabled = false;
        err.textContent = UI.apiErrorMessage(e);
      }
    });
  }

  document.getElementById('btn-create').addEventListener('click', function () {
    const modal = UI.openModal(
      '<div class="form-grid">' +
        '<div class="field span-2"><label>Full name</label><input type="text" class="input" id="c-name"></div>' +
        '<div class="field"><label>Email</label><input type="email" class="input" id="c-email"></div>' +
        '<div class="field"><label>Temporary password</label><input type="text" class="input" id="c-password" value="Welcome@123"></div>' +
        '<div class="field"><label>Phone</label><input type="text" class="input" id="c-phone"></div>' +
        '<div class="field"><label>Status</label><select class="select" id="c-status"><option value="active">Active</option><option value="pending">Pending</option><option value="suspended">Suspended</option></select></div>' +
      '</div><div class="form-error" id="c-error"></div>',
      { title: 'Create Customer', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Create User</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      const err = document.getElementById('c-error');
      err.textContent = '';
      const btn = this;
      const email = document.getElementById('c-email').value.trim();
      const password = document.getElementById('c-password').value;
      const name = document.getElementById('c-name').value.trim();
      if (!email || !password || !name) { err.textContent = 'Name, email and password are required.'; return; }
      btn.disabled = true;
      btn.textContent = 'Creating...';
      try {
        await adminApi('admin_create_user', {
          p_email: email, p_password: password, p_full_name: name,
          p_phone: document.getElementById('c-phone').value.trim() || null,
          p_status: document.getElementById('c-status').value
        });
        UI.toast('Customer created.', 'success');
        modal.close();
        load();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Create User';
        err.textContent = UI.apiErrorMessage(e);
      }
    });
  });

  document.getElementById('f-search').addEventListener('input', function () { page = 1; load(); });
  document.getElementById('f-status').addEventListener('change', function () { page = 1; load(); });

  await load();
  PageLoader.hide();
})();
// marvintlc — Admin settings module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Settings');

  const ROLES = ['super_admin', 'admin', 'support', 'auditor'];

  async function loadAdmins() {
    const el = document.getElementById('admins-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading administrators...</span></div>';
    try {
      const admins = await adminApi('admin_list_admins');
      if (!admins.length) { el.innerHTML = UI.emptyState('No administrators'); return; }
      el.innerHTML = '<table class="table mobile-cards">' +
        '<thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
        admins.map(function (a) {
          return '<tr><td data-label="Name"><span class="cell-main">' + UI.escapeHtml(a.full_name || '—') + '</span></td>' +
            '<td data-label="Email">' + UI.escapeHtml(a.email) + '</td>' +
            '<td data-label="Role"><span class="badge badge-gold">' + UI.escapeHtml(a.role) + '</span></td>' +
            '<td data-label="Status">' + (a.status === 'active' ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-failed">Suspended</span>') + '</td>' +
            '<td data-label="Actions"><button class="row-action" data-edit="' + a.id + '" title="Edit">' + ICONS.edit + '</button></td></tr>';
        }).join('') +
        '</tbody></table>';

      el.querySelectorAll('[data-edit]').forEach(function (b) {
        b.addEventListener('click', function () {
          const a = admins.find(function (x) { return x.id === b.getAttribute('data-edit'); });
          const modal = UI.openModal(
            '<div class="field"><label>Full name</label><input type="text" class="input" id="e-name" value="' + UI.escapeHtml(a.full_name || '') + '"></div>' +
            '<div class="field"><label>Role</label><select class="select" id="e-role">' + ROLES.map(function (r) { return '<option value="' + r + '"' + (r === a.role ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select></div>' +
            '<div class="field"><label>Status</label><select class="select" id="e-status"><option value="active"' + (a.status === 'active' ? ' selected' : '') + '>Active</option><option value="suspended"' + (a.status === 'suspended' ? ' selected' : '') + '>Suspended</option></select></div>' +
            '<div class="field"><label>New password (leave blank to keep)</label><input type="password" class="input" id="e-pass"></div>' +
            '<div class="form-note">You are editing <b>' + UI.escapeHtml(a.email) + '</b>. Changing your own role or status may revoke access immediately.</div>' +
            '<div class="form-error" id="e-error"></div>',
            { title: 'Edit Administrator', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>' }
          );
          modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
          modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
            try {
              await adminApi('admin_update_admin', {
                p_admin_id: a.id,
                p_full_name: document.getElementById('e-name').value.trim(),
                p_role_name: document.getElementById('e-role').value,
                p_status: document.getElementById('e-status').value,
                p_password: document.getElementById('e-pass').value
              });
              UI.toast('Administrator updated.', 'success');
              modal.close();
              loadAdmins();
            } catch (e) { document.getElementById('e-error').textContent = UI.apiErrorMessage(e); }
          });
        });
      });
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load administrators');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function renderSettings(settings) {
    const el = document.getElementById('settings-form');
    const keys = ['bank_name', 'currency', 'local_transfer_fee', 'intl_transfer_fee', 'swap_fee_percent', 'maintenance_mode'];
    const labels = {
      bank_name: 'Bank name', currency: 'Default currency',
      local_transfer_fee: 'Local transfer fee (flat)', intl_transfer_fee: 'International transfer fee (flat)',
      swap_fee_percent: 'Currency swap fee %', maintenance_mode: 'Maintenance mode'
    };
    el.innerHTML = keys.map(function (k) {
      const val = settings[k];
      const v = val === undefined || val === null ? '' : val;
      if (k === 'maintenance_mode') {
        return '<div class="field"><label>' + labels[k] + '</label><select class="select" data-key="' + k + '"><option value="true"' + (String(v) === 'true' ? ' selected' : '') + '>On</option><option value="false"' + (String(v) === 'false' ? ' selected' : '') + '>Off</option></select></div>';
      }
      return '<div class="field"><label>' + labels[k] + '</label><input type="text" class="input" data-key="' + k + '" value="' + UI.escapeHtml(typeof v === 'string' ? v.replace(/"/g, '') : v) + '"></div>';
    }).join('');
  }

  async function loadSettings() {
    const el = document.getElementById('settings-form');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading settings...</span></div>';
    try {
      const settings = await adminApi('admin_get_settings');
      renderSettings(settings || {});
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load settings');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  document.getElementById('btn-add-admin').addEventListener('click', function () {
    const modal = UI.openModal(
      '<div class="field"><label>Full name</label><input type="text" class="input" id="a-name"></div>' +
      '<div class="field"><label>Email</label><input type="email" class="input" id="a-email"></div>' +
      '<div class="field"><label>Role</label><select class="select" id="a-role">' + ROLES.map(function (r) { return '<option value="' + r + '">' + r + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Password</label><input type="password" class="input" id="a-pass"></div>' +
      '<div class="form-error" id="a-error"></div>',
      { title: 'Add Administrator', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Add</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      const err = document.getElementById('a-error');
      err.textContent = '';
      try {
        await adminApi('admin_create_admin', {
          p_email: document.getElementById('a-email').value.trim(),
          p_password: document.getElementById('a-pass').value,
          p_full_name: document.getElementById('a-name').value.trim(),
          p_role_name: document.getElementById('a-role').value,
          p_status: 'active'
        });
        UI.toast('Administrator added.', 'success');
        modal.close();
        loadAdmins();
      } catch (e) { err.textContent = UI.apiErrorMessage(e); }
    });
  });

  document.getElementById('btn-save-settings').addEventListener('click', async function () {
    const err = document.getElementById('settings-error');
    err.textContent = '';
    try {
      const inputs = document.querySelectorAll('#settings-form [data-key]');
      for (const el of inputs) {
        const key = el.getAttribute('data-key');
        let val = el.value.trim();
        if (key === 'bank_name' || key === 'currency') val = '"' + val + '"';
        if (['local_transfer_fee', 'intl_transfer_fee', 'swap_fee_percent'].includes(key)) val = String(Number(val) || 0);
        await adminApi('admin_update_setting', { p_key: key, p_value: JSON.parse(val) });
      }
      UI.toast('Settings saved.', 'success');
      loadSettings();
    } catch (e) { err.textContent = UI.apiErrorMessage(e); }
  });

  await loadAdmins();
  await loadSettings();
  PageLoader.hide();
})();
// Raiffeisen Bank — Admin notifications module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Notifications');

  const PAGE = 12;
  let page = 1;

  async function load() {
    const el = document.getElementById('notifs-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading notifications...</span></div>';
    try {
      const res = await adminApi('admin_list_notifications', { p_limit: PAGE, p_offset: (page - 1) * PAGE });
      render(res.rows || []);
      const pages = Math.max(1, Math.ceil((res.total || 0) / PAGE));
      const pag = document.getElementById('pagination');
      let html = '<button data-p="' + (page - 1) + '" ' + (page <= 1 ? 'disabled' : '') + '>‹</button>';
      for (let i = 1; i <= pages; i++) html += '<button data-p="' + i + '" class="' + (i === page ? 'active' : '') + '">' + i + '</button>';
      html += '<button data-p="' + (page + 1) + '" ' + (page >= pages ? 'disabled' : '') + '>›</button>';
      pag.innerHTML = html;
      pag.querySelectorAll('button[data-p]').forEach(function (b) {
        b.addEventListener('click', function () { page = Number(b.getAttribute('data-p')); load(); });
      });
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load notifications');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function render(rows) {
    const el = document.getElementById('notifs-table');
    if (!rows.length) { el.innerHTML = UI.emptyState('No notifications sent'); return; }
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Title</th><th>Recipient</th><th>Type</th><th>Read</th><th>Date</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (n) {
        const isGlobal = n.is_global;
        return '<tr><td data-label="Title"><span class="cell-main">' + UI.escapeHtml(n.title) + '</span><div class="cell-sub">' + UI.escapeHtml(n.message) + '</div></td>' +
          '<td data-label="Recipient">' + (isGlobal ? '<span class="badge badge-gold">Global</span>' : (UI.escapeHtml(n.user_email) || '—')) + '</td>' +
          '<td data-label="Type">' + UI.escapeHtml(n.type) + '</td>' +
          '<td data-label="Read">' + (n.is_read ? '<span class="badge badge-success">Read</span>' : '<span class="badge">Unread</span>') + '</td>' +
          '<td data-label="Date">' + UI.formatDateTime(n.created_at) + '</td>' +
          '<td data-label="Actions"><button class="row-action danger" data-del="' + n.id + '" title="Delete">' + ICONS.trash + '</button></td></tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        const id = b.getAttribute('data-del');
        UI.confirmDialog('Delete this notification?', async function () {
          try {
            await adminApi('admin_delete_notification', { p_notif_id: id });
            UI.toast('Notification deleted.', 'success');
            load();
          } catch (e) { UI.toast(UI.apiErrorMessage(e), 'error'); }
        }, 'Delete');
      });
    });
  }

  document.getElementById('n-scope').addEventListener('change', function () {
    document.getElementById('n-email-wrap').style.display = this.value === 'user' ? '' : 'none';
  });

  document.getElementById('btn-send').addEventListener('click', async function () {
    const err = document.getElementById('n-error');
    err.textContent = '';
    const scope = document.getElementById('n-scope').value;
    const title = document.getElementById('n-title').value.trim();
    const message = document.getElementById('n-message').value.trim();
    const type = document.getElementById('n-type').value;
    if (!title || !message) { err.textContent = 'Title and message are required.'; return; }
    try {
      if (scope === 'global') {
        await adminApi('admin_send_global_notification', { p_title: title, p_message: message, p_type: type });
        UI.toast('Global notification sent.', 'success');
      } else {
        const email = document.getElementById('n-email').value.trim();
        if (!email) { err.textContent = 'Enter the customer email.'; return; }
        const user = await adminApi('admin_list_users', { p_search: email, p_limit: 1, p_offset: 0 });
        if (!user.rows.length) { err.textContent = 'No customer found.'; return; }
        await adminApi('admin_send_notification', { p_user_id: user.rows[0].id, p_title: title, p_message: message, p_type: type });
        UI.toast('Notification sent.', 'success');
      }
      document.getElementById('n-title').value = '';
      document.getElementById('n-message').value = '';
      load();
    } catch (e) { err.textContent = UI.apiErrorMessage(e); }
  });

  await load();
  PageLoader.hide();
})();
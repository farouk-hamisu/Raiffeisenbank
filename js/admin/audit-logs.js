// Raiffeisen Bank — Admin audit logs module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Audit Logs');

  const PAGE = 15;
  let page = 1;

  async function load() {
    const el = document.getElementById('audit-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading audit logs...</span></div>';
    try {
      const res = await adminApi('admin_list_audit_logs', {
        p_search: document.getElementById('f-search').value.trim(),
        p_limit: PAGE, p_offset: (page - 1) * PAGE
      });
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
      el.innerHTML = UI.emptyState('Could not load audit logs');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function render(rows) {
    const el = document.getElementById('audit-table');
    if (!rows.length) { el.innerHTML = UI.emptyState('No audit entries found'); return; }
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Action</th><th>Resource</th><th>Admin</th><th>Resource ID</th><th>Changes</th><th>Date</th></tr></thead><tbody>' +
      rows.map(function (a) {
        return '<tr><td data-label="Action"><span class="cell-main">' + UI.escapeHtml(a.action) + '</span></td>' +
          '<td data-label="Resource">' + UI.escapeHtml(a.resource) + '</td>' +
          '<td data-label="Admin">' + UI.escapeHtml(a.admin_name || a.admin_email || 'system') + '</td>' +
          '<td data-label="Resource ID">' + UI.escapeHtml(a.resource_id || '—') + '</td>' +
          '<td data-label="Changes">' + (a.previous_value || a.new_value ? '<button class="row-action" data-view="' + a.id + '" title="View diff">' + ICONS.eye + '</button>' : '—') + '</td>' +
          '<td data-label="Date">' + UI.formatDateTime(a.created_at) + '</td></tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () {
        const a = rows.find(function (x) { return x.id === b.getAttribute('data-view'); });
        UI.openModal(
          '<div class="detail-grid">' +
            '<div class="detail-item"><div class="k">Action</div><div class="v">' + UI.escapeHtml(a.action) + '</div></div>' +
            '<div class="detail-item"><div class="k">Resource</div><div class="v">' + UI.escapeHtml(a.resource) + '</div></div>' +
            '<div class="detail-item"><div class="k">Resource ID</div><div class="v">' + UI.escapeHtml(a.resource_id || '—') + '</div></div>' +
            '<div class="detail-item"><div class="k">Admin</div><div class="v">' + UI.escapeHtml(a.admin_email || '—') + '</div></div>' +
            '<div class="detail-item"><div class="k">Previous</div><div class="v json-preview">' + (a.previous_value ? UI.escapeHtml(JSON.stringify(a.previous_value)) : '—') + '</div></div>' +
            '<div class="detail-item"><div class="k">New</div><div class="v json-preview">' + (a.new_value ? UI.escapeHtml(JSON.stringify(a.new_value)) : '—') + '</div></div>' +
          '</div>',
          { title: 'Audit Entry' }
        );
      });
    });
  }

  document.getElementById('f-search').addEventListener('input', function () { page = 1; load(); });

  await load();
  PageLoader.hide();
})();
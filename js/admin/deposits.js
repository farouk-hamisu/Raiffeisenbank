// marvintlc — Admin deposits module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Deposits');

  const PAGE = 12;
  let page = 1;
  const STATUSES = ['pending', 'processing', 'completed', 'failed', 'rejected'];

  document.getElementById('f-status').innerHTML = '<option value="">All statuses</option>' + STATUSES.map(function (s) { return '<option value="' + s + '">' + UI.typeLabel(s) + '</option>'; }).join('');

  async function load() {
    const el = document.getElementById('deposits-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading deposits...</span></div>';
    try {
      const res = await adminApi('admin_list_deposits', {
        p_search: document.getElementById('f-search').value.trim(),
        p_status: document.getElementById('f-status').value || null,
        p_limit: PAGE, p_offset: (page - 1) * PAGE
      });
      render(res.rows || []);
      renderPagination(res.total || 0);
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load deposits');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function render(rows) {
    const el = document.getElementById('deposits-table');
    if (!rows.length) { el.innerHTML = UI.emptyState('No deposits found'); return; }
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Reference</th><th>User</th><th>Method</th><th>Amount</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (d) {
        return '<tr><td data-label="Reference"><span class="cell-main">' + UI.escapeHtml(d.reference) + '</span></td>' +
          '<td data-label="User">' + UI.escapeHtml(d.user_email || '—') + '</td>' +
          '<td data-label="Method">' + UI.escapeHtml(d.method) + '</td>' +
          '<td data-label="Amount" class="amount-credit">' + UI.money(d.amount, d.currency) + '</td>' +
          '<td data-label="Status">' + UI.badge(d.status) + '</td>' +
          '<td data-label="Date">' + UI.formatDateTime(d.created_at) + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            '<button class="row-action" data-view="' + d.id + '" title="View">' + ICONS.eye + '</button>' +
            (['pending', 'processing'].includes(d.status)
              ? '<button class="row-action success" data-status="' + d.id + '" data-val="completed" title="Approve">' + ICONS.check + '</button>' +
                '<button class="row-action danger" data-status="' + d.id + '" data-val="rejected" title="Reject">' + ICONS.x + '</button>'
              : '') +
          '</div></td></tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () {
        const d = rows.find(function (x) { return x.id === b.getAttribute('data-view'); });
        UI.openModal(
          '<div class="detail-grid">' +
            '<div class="detail-item"><div class="k">Reference</div><div class="v">' + UI.escapeHtml(d.reference) + '</div></div>' +
            '<div class="detail-item"><div class="k">Status</div><div class="v">' + UI.badge(d.status) + '</div></div>' +
            '<div class="detail-item"><div class="k">User</div><div class="v">' + UI.escapeHtml(d.user_email || '—') + '</div></div>' +
            '<div class="detail-item"><div class="k">Method</div><div class="v">' + UI.escapeHtml(d.method) + '</div></div>' +
            '<div class="detail-item"><div class="k">Amount</div><div class="v">' + UI.money(d.amount, d.currency) + '</div></div>' +
            '<div class="detail-item"><div class="k">Note</div><div class="v">' + UI.escapeHtml(d.note || '—') + '</div></div>' +
            '<div class="detail-item"><div class="k">Created</div><div class="v">' + UI.formatDateTime(d.created_at) + '</div></div>' +
          '</div>',
          { title: 'Deposit Details' }
        );
      });
    });
    el.querySelectorAll('[data-status]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const val = b.getAttribute('data-val');
        const label = val === 'completed' ? 'Approve this deposit and credit the customer\'s account?' : 'Reject this deposit?';
        UI.confirmDialog(label, async function () {
          try {
            await adminApi('admin_update_deposit', { p_deposit_id: b.getAttribute('data-status'), p_status: val });
            UI.toast('Deposit ' + (val === 'completed' ? 'approved and credited.' : 'rejected.'), 'success');
            load();
          } catch (e) { UI.toast(UI.apiErrorMessage(e), 'error'); }
        }, val === 'completed' ? 'Approve Deposit' : 'Reject Deposit');
      });
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

  document.getElementById('f-search').addEventListener('input', function () { page = 1; load(); });
  document.getElementById('f-status').addEventListener('change', function () { page = 1; load(); });

  await load();
  PageLoader.hide();
})();
// marvintlc — Admin transfers module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Transfers');

  const PAGE = 12;
  let page = 1;
  let kind = 'local';
  const STATUSES = ['pending', 'processing', 'completed', 'failed', 'cancelled', 'reversed'];

  document.getElementById('f-status').innerHTML = '<option value="">All statuses</option>' + STATUSES.map(function (s) { return '<option value="' + s + '">' + UI.typeLabel(s) + '</option>'; }).join('');

  async function load() {
    const el = document.getElementById('transfer-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading transfers...</span></div>';
    try {
      const search = document.getElementById('f-search').value.trim();
      const status = document.getElementById('f-status').value || null;
      const fn = kind === 'local' ? 'admin_list_local_transfers' : 'admin_list_intl_transfers';
      const res = await adminApi(fn, { p_search: search, p_status: status, p_limit: PAGE, p_offset: (page - 1) * PAGE });
      render(res.rows || []);
      renderPagination(res.total || 0);
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load transfers');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function render(rows) {
    const el = document.getElementById('transfer-table');
    if (!rows.length) { el.innerHTML = UI.emptyState('No transfers found'); return; }
    const isIntl = kind === 'intl';
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Reference</th><th>Recipient</th>' + (isIntl ? '<th>Country</th>' : '<th>Bank</th>') + '<th>Amount</th><th>Fee</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (t) {
        return '<tr><td data-label="Reference"><span class="cell-main">' + UI.escapeHtml(t.reference) + '</span></td>' +
          '<td data-label="Recipient">' + UI.escapeHtml(t.recipient_name) + '<div class="cell-sub">' + UI.escapeHtml(t.user_email || '') + '</div></td>' +
          (isIntl ? '<td data-label="Country">' + UI.escapeHtml(t.recipient_country) + '</td>' : '<td data-label="Bank">' + UI.escapeHtml(t.recipient_bank || '—') + '</td>') +
          '<td data-label="Amount">' + UI.money(t.amount, t.currency) + '</td>' +
          '<td data-label="Fee">' + UI.money(t.fee || 0, t.currency) + '</td>' +
          '<td data-label="Status">' + UI.badge(t.status) + '</td>' +
          '<td data-label="Date">' + UI.formatDateTime(t.created_at) + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            '<button class="row-action" data-view="' + t.id + '" title="View">' + ICONS.eye + '</button>' +
            '<button class="row-action" data-status="' + t.id + '" title="Update status">' + ICONS.edit + '</button>' +
          '</div></td></tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () {
        const t = rows.find(function (x) { return x.id === b.getAttribute('data-view'); });
        const fields = [
          ['Reference', t.reference], ['Recipient', t.recipient_name],
          isIntl ? ['Bank', t.recipient_bank] : ['Bank', t.recipient_bank || '—'],
          ['Account', t.recipient_account_number],
          isIntl ? ['SWIFT/BIC', t.swift_code || '—'] : null,
          isIntl ? ['Country', t.recipient_country] : null,
          ['Amount', UI.money(t.amount, t.currency)], ['Fee', UI.money(t.fee || 0, t.currency)],
          ['Status', UI.badge(t.status)], ['Description', t.description || t.purpose || '—'],
          ['Created', UI.formatDateTime(t.created_at)], isIntl ? ['Delivery', UI.formatDate(t.estimated_delivery)] : null
        ].filter(Boolean).map(function (f) {
          return '<div class="detail-item"><div class="k">' + f[0] + '</div><div class="v">' + UI.escapeHtml(f[1]) + '</div></div>';
        }).join('');
        UI.openModal('<div class="detail-grid">' + fields + '</div>', { title: 'Transfer Details' });
      });
    });
    el.querySelectorAll('[data-status]').forEach(function (b) {
      b.addEventListener('click', function () {
        const t = rows.find(function (x) { return x.id === b.getAttribute('data-status'); });
        updateStatus(t);
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
        const fn = kind === 'local' ? 'admin_update_local_transfer' : 'admin_update_intl_transfer';
        await adminApi(fn, { p_transfer_id: t.id, p_status: document.getElementById('st-status').value });
        UI.toast('Transfer status updated.', 'success');
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

  document.getElementById('f-search').addEventListener('input', function () { page = 1; load(); });
  document.getElementById('f-status').addEventListener('change', function () { page = 1; load(); });
  document.getElementById('f-kind').addEventListener('change', function () {
    kind = this.value;
    page = 1;
    load();
  });

  await load();
  PageLoader.hide();
})();
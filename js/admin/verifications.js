// Raiffeisen Bank — Admin transfer verifications module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Verifications');

  async function load() {
    const elIntl = document.getElementById('verify-intl');
    const elLocal = document.getElementById('verify-local');
    const elCrypto = document.getElementById('verify-crypto');
    elIntl.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading...</span></div>';
    elLocal.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading...</span></div>';
    elCrypto.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading...</span></div>';
    try {
      const res = await adminApi('admin_list_transfer_verifications', {});
      renderIntl(res.international || []);
      renderCrypto(res.crypto || []);
      renderLocal(res.local || []);
    } catch (e) {
      const msg = UI.apiErrorMessage(e);
      elIntl.innerHTML = UI.emptyState('Error: ' + msg);
      elLocal.innerHTML = '';
      elCrypto.innerHTML = '';
      UI.toast(msg, 'error');
    }
  }

  function codeInfo(t) {
    const issued = t.code_id && (t.code_status === 'active' || t.code_status === 'used' || t.code_status === 'revoked' || t.code_status === 'expired');
    return { issued: !!issued, status: t.code_status, prefix: t.code_prefix, attempts: t.code_attempts, max: t.code_max_attempts, expires: t.code_expires_at, id: t.code_id };
  }

  function renderIntl(rows) {
    const el = document.getElementById('verify-intl');
    if (!rows.length) { el.innerHTML = UI.emptyState('No international transfers awaiting verification'); return; }
    el.innerHTML = '<div class="table-wrap"><table class="table mobile-cards"><thead><tr><th>Reference</th><th>Recipient</th><th>User</th><th>Amount</th><th>Code</th><th>Date</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (t) {
        const c = codeInfo(t);
        return '<tr><td data-label="Reference"><span class="cell-main">' + UI.escapeHtml(t.reference) + '</span></td>' +
          '<td data-label="Recipient">' + UI.escapeHtml(t.recipient_name) + '</td>' +
          '<td data-label="User">' + UI.escapeHtml(t.user_name || t.user_email || '') + '</td>' +
          '<td data-label="Amount">' + UI.money(t.amount, t.currency) + '</td>' +
          '<td data-label="Code">' + (c.issued ? '<span class="badge ' + (c.status === 'active' ? 'badge-success' : 'badge-neutral') + '">' + (c.prefix || c.status) + '</span>' : '<span class="text-muted">—</span>') + '</td>' +
          '<td data-label="Date">' + UI.formatDateTime(t.created_at) + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            '<button class="row-action" data-approve="' + t.id + '" title="Approve (issue code)">' + ICONS.check + '</button>' +
            '<button class="row-action" data-reject="' + t.id + '" title="Reject">' + ICONS.x + '</button>' +
            (c.issued && c.status === 'active' ? '<button class="row-action" data-revoke="' + c.id + '" title="Revoke code">' + ICONS.pause + '</button>' : '') +
            '<button class="row-action" data-history="' + t.id + '" title="History">' + ICONS.list + '</button>' +
          '</div></td></tr>';
      }).join('') + '</tbody></table></div>';
    bind(rows, 'international_transfer');
  }

  function renderCrypto(rows) {
    const el = document.getElementById('verify-crypto');
    if (!rows.length) { el.innerHTML = UI.emptyState('No crypto withdrawals awaiting verification'); return; }
    el.innerHTML = '<div class="table-wrap"><table class="table mobile-cards"><thead><tr><th>Reference</th><th>Asset</th><th>Network</th><th>Amount</th><th>Debited</th><th>User</th><th>Code</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (t) {
        const c = codeInfo(t);
        return '<tr><td data-label="Reference"><span class="cell-main">' + UI.escapeHtml(t.reference) + '</span></td>' +
          '<td data-label="Asset">' + UI.escapeHtml(t.asset) + '</td>' +
          '<td data-label="Network">' + UI.escapeHtml(t.network) + '</td>' +
          '<td data-label="Amount">' + UI.money(t.amount, t.asset) + '</td>' +
          '<td data-label="Debited">' + UI.money(t.amount_fiat, t.currency) + '</td>' +
          '<td data-label="User">' + UI.escapeHtml(t.user_name || t.user_email || '') + '</td>' +
          '<td data-label="Code">' + (c.issued ? '<span class="badge ' + (c.status === 'active' ? 'badge-success' : 'badge-neutral') + '">' + (c.prefix || c.status) + '</span>' : '<span class="text-muted">—</span>') + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            '<button class="row-action" data-approve="' + t.id + '" title="Approve (issue code)">' + ICONS.check + '</button>' +
            '<button class="row-action" data-reject="' + t.id + '" title="Reject">' + ICONS.x + '</button>' +
            (c.issued && c.status === 'active' ? '<button class="row-action" data-revoke="' + c.id + '" title="Revoke code">' + ICONS.pause + '</button>' : '') +
            '<button class="row-action" data-history="' + t.id + '" title="History">' + ICONS.list + '</button>' +
          '</div></td></tr>';
      }).join('') + '</tbody></table></div>';
    bind(rows, 'crypto_withdrawal');
  }

  function renderLocal(rows) {
    const el = document.getElementById('verify-local');
    if (!rows.length) { el.innerHTML = UI.emptyState('No local transfers awaiting verification'); return; }
    el.innerHTML = '<div class="table-wrap"><table class="table mobile-cards"><thead><tr><th>Reference</th><th>Recipient</th><th>Amount</th><th>User</th><th>Code</th><th>Date</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (t) {
        const c = codeInfo(t);
        return '<tr><td data-label="Reference"><span class="cell-main">' + UI.escapeHtml(t.reference) + '</span></td>' +
          '<td data-label="Recipient">' + UI.escapeHtml(t.recipient_name) + '</td>' +
          '<td data-label="Amount">' + UI.money(t.amount, t.currency) + '</td>' +
          '<td data-label="User">' + UI.escapeHtml(t.user_name || t.user_email || '') + '</td>' +
          '<td data-label="Code">' + (c.issued ? '<span class="badge ' + (c.status === 'active' ? 'badge-success' : 'badge-neutral') + '">' + (c.prefix || c.status) + '</span>' : '<span class="text-muted">—</span>') + '</td>' +
          '<td data-label="Date">' + UI.formatDateTime(t.created_at) + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            '<button class="row-action" data-approve="' + t.id + '" title="Approve (issue code)">' + ICONS.check + '</button>' +
            '<button class="row-action" data-reject="' + t.id + '" title="Reject">' + ICONS.x + '</button>' +
            (c.issued && c.status === 'active' ? '<button class="row-action" data-revoke="' + c.id + '" title="Revoke code">' + ICONS.pause + '</button>' : '') +
            '<button class="row-action" data-history="' + t.id + '" title="History">' + ICONS.list + '</button>' +
          '</div></td></tr>';
      }).join('') + '</tbody></table></div>';
    bind(rows, 'local_transfer');
  }

  function bind(rows, type) {
    document.querySelectorAll('[data-approve]').forEach(function (b) {
      b.addEventListener('click', function () {
        approve(type, b.getAttribute('data-approve'));
      });
    });
    document.querySelectorAll('[data-reject]').forEach(function (b) {
      b.addEventListener('click', function () {
        reject(type, b.getAttribute('data-reject'));
      });
    });
    document.querySelectorAll('[data-revoke]').forEach(function (b) {
      b.addEventListener('click', function () {
        revoke(b.getAttribute('data-revoke'));
      });
    });
    document.querySelectorAll('[data-history]').forEach(function (b) {
      b.addEventListener('click', function () {
        history(type, b.getAttribute('data-history'));
      });
    });
  }

  async function approve(type, id) {
    try {
      const res = await adminApi('admin_approve_transfer', { p_transfer_type: type, p_transfer_id: id });
      const modal = UI.openModal(
        '<div class="text-center">' +
          '<div class="text-muted mb-2">Share this one-time code with the customer (ends ' + UI.escapeHtml(res.code_prefix || '') + '):</div>' +
          '<div style="font-size:30px;letter-spacing:6px;font-family:ui-monospace,monospace;font-weight:700" id="code-display">' + UI.escapeHtml(res.code) + '</div>' +
          '<div class="text-muted text-sm mt-2">Expires ' + UI.formatDateTime(res.expires_at) + ' · single use · shown only once</div>' +
          '<div class="form-error" id="code-error"></div>' +
        '</div>',
        { title: 'Verification code issued', footer: '<button class="btn btn-outline" data-cancel>Close</button><button class="btn btn-primary" data-copy>Copy Code</button>' }
      );
      modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
      modal.footer.querySelector('[data-copy]').addEventListener('click', async function () {
        const ok = await UI.copyText(res.code);
        if (ok) UI.toast('Code copied.', 'success');
        else document.getElementById('code-error').textContent = 'Could not copy automatically — copy the code above manually.';
      });
      load();
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function reject(type, id) {
    const modal = UI.openModal(
      '<div class="field"><label>Rejection reason <span class="text-muted">(optional)</span></label><textarea class="textarea" id="rej-reason" placeholder="e.g. Unverifiable beneficiary details"></textarea></div>' +
      '<div class="form-error" id="rej-error"></div>',
      { title: 'Reject transfer', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-danger" data-send>Reject</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-send]').addEventListener('click', async function () {
      try {
        await adminApi('admin_reject_transfer', {
          p_transfer_type: type,
          p_transfer_id: id,
          p_reason: document.getElementById('rej-reason').value.trim() || null
        });
        UI.toast('Transfer rejected.', 'success');
        modal.close();
        load();
      } catch (e) { document.getElementById('rej-error').textContent = UI.apiErrorMessage(e); }
    });
  }

  async function revoke(codeId) {
    try {
      await adminApi('admin_revoke_transfer_code', { p_code_id: codeId });
      UI.toast('Code revoked.', 'success');
      load();
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  async function history(type, id) {
    try {
      const h = await adminApi('admin_transfer_verification_history', { p_transfer_type: type, p_transfer_id: id });
      const t = h.transfer || {};
      const codes = h.codes || [];
      const logs = h.logs || [];
      const body =
        '<div class="detail-grid mb-3">' +
          '<div class="detail-item"><div class="k">Reference</div><div class="v">' + UI.escapeHtml(t.reference || '—') + '</div></div>' +
          '<div class="detail-item"><div class="k">Status</div><div class="v">' + UI.badge(t.status) + '</div></div>' +
          '<div class="detail-item"><div class="k">Created</div><div class="v">' + UI.formatDateTime(t.created_at) + '</div></div>' +
        '</div>' +
        '<h4 style="margin:0 0 6px">Codes</h4>' +
        (codes.length ? '<div class="detail-grid mb-3">' + codes.map(function (c) {
          return '<div class="detail-item"><div class="k">' + UI.formatDateTime(c.created_at) + ' · ' + UI.badge(c.status) + '</div>' +
            '<div class="v">' + UI.escapeHtml(c.code_prefix || '—') + (c.used_at ? ' · used ' + UI.formatDateTime(c.used_at) : '') +
            (c.attempts ? ' · ' + c.attempts + '/' + c.max_attempts + ' attempts' : '') +
            (c.created_by ? ' · by ' + UI.escapeHtml(c.created_by) : '') + '</div></div>';
        }).join('') + '</div>' : '<p class="text-muted">No codes issued</p>') +
        '<h4 style="margin:0 0 6px">Logs</h4>' +
        (logs.length ? '<div class="detail-grid">' + logs.map(function (l) {
          return '<div class="detail-item"><div class="k">' + UI.formatDateTime(l.created_at) + '</div><div class="v">' + UI.escapeHtml(l.event) + (l.details ? ' — ' + UI.escapeHtml(String(l.details).replace(/_/g, ' ')) : '') + '</div></div>';
        }).join('') + '</div>' : '<p class="text-muted">No logs</p>');
      UI.openModal(body, { title: 'Verification history — ' + (t.reference || ''), large: true });
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  document.getElementById('btn-refresh').addEventListener('click', load);

  await load();
  PageLoader.hide();
})();
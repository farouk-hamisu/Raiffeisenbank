// Raiffeisen Bank — Admin loans module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Loans');

  const PAGE = 10;
  let page = 1;
  const APP_STATUSES = ['pending', 'under_review', 'approved', 'rejected', 'active', 'completed', 'cancelled'];

  document.getElementById('f-status').innerHTML = '<option value="">All statuses</option>' + APP_STATUSES.map(function (s) { return '<option value="' + s + '">' + UI.typeLabel(s) + '</option>'; }).join('');

  async function load() {
    await Promise.all([loadProducts(), loadApps(), loadRepays()]);
  }

  async function loadProducts() {
    const el = document.getElementById('products-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading products...</span></div>';
    try {
      const products = await adminApi('admin_list_loan_products');
      if (!products.length) { el.innerHTML = UI.emptyState('No loan products'); return; }
      el.innerHTML = '<table class="table mobile-cards">' +
        '<thead><tr><th>Name</th><th>Range</th><th>Rate</th><th>Term</th><th>Enabled</th><th>Actions</th></tr></thead><tbody>' +
        products.map(function (p) {
          return '<tr><td data-label="Name"><span class="cell-main">' + UI.escapeHtml(p.name) + '</span><div class="cell-sub">' + UI.escapeHtml(p.description || '') + '</div></td>' +
            '<td data-label="Range">' + UI.money(p.min_amount, 'USD') + ' – ' + UI.money(p.max_amount, 'USD') + '</td>' +
            '<td data-label="Rate">' + p.interest_rate + '%</td>' +
            '<td data-label="Term">' + p.term_months + ' mo</td>' +
            '<td data-label="Enabled">' + (p.enabled ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-failed">No</span>') + '</td>' +
            '<td data-label="Actions"><div class="row-actions">' +
              '<button class="row-action" data-edit="' + p.id + '" title="Edit">' + ICONS.edit + '</button>' +
              '<button class="row-action danger" data-del="' + p.id + '" title="Delete">' + ICONS.trash + '</button>' +
            '</div></td></tr>';
        }).join('') +
        '</tbody></table>';

      el.querySelectorAll('[data-edit]').forEach(function (b) {
        b.addEventListener('click', function () {
          const p = products.find(function (x) { return x.id === b.getAttribute('data-edit'); });
          const modal = UI.openModal(
            '<div class="field"><label>Name</label><input type="text" class="input" id="e-name" value="' + UI.escapeHtml(p.name) + '"></div>' +
            '<div class="field"><label>Description</label><input type="text" class="input" id="e-desc" value="' + UI.escapeHtml(p.description || '') + '"></div>' +
            '<div class="form-grid"><div class="field"><label>Min amount</label><input type="number" class="input" id="e-min" value="' + p.min_amount + '"></div>' +
            '<div class="field"><label>Max amount</label><input type="number" class="input" id="e-max" value="' + p.max_amount + '"></div></div>' +
            '<div class="form-grid"><div class="field"><label>Interest rate %</label><input type="number" class="input" id="e-rate" step="0.01" value="' + p.interest_rate + '"></div>' +
            '<div class="field"><label>Term (months)</label><input type="number" class="input" id="e-term" value="' + p.term_months + '"></div></div>' +
            '<div class="field"><label>Enabled</label><select class="select" id="e-enabled"><option value="true"' + (p.enabled ? ' selected' : '') + '>Yes</option><option value="false"' + (!p.enabled ? ' selected' : '') + '>No</option></select></div>' +
            '<div class="form-error" id="e-error"></div>',
            { title: 'Edit Loan Product', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>' }
          );
          modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
          modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
            try {
              await adminApi('admin_update_loan_product', {
                p_product_id: p.id,
                p_name: document.getElementById('e-name').value.trim(),
                p_description: document.getElementById('e-desc').value.trim() || null,
                p_min_amount: Number(document.getElementById('e-min').value),
                p_max_amount: Number(document.getElementById('e-max').value),
                p_interest_rate: Number(document.getElementById('e-rate').value),
                p_term_months: Number(document.getElementById('e-term').value),
                p_enabled: document.getElementById('e-enabled').value === 'true'
              });
              UI.toast('Product updated.', 'success');
              modal.close();
              loadProducts();
            } catch (e) { document.getElementById('e-error').textContent = UI.apiErrorMessage(e); }
          });
        });
      });
      el.querySelectorAll('[data-del]').forEach(function (b) {
        b.addEventListener('click', function () {
          const id = b.getAttribute('data-del');
          UI.confirmDialog('Delete this loan product?', async function () {
            try {
              await adminApi('admin_delete_loan_product', { p_product_id: id });
              UI.toast('Product deleted.', 'success');
              loadProducts();
            } catch (e) { UI.toast(UI.apiErrorMessage(e), 'error'); }
          }, 'Delete');
        });
      });
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load products');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  async function loadApps() {
    const el = document.getElementById('apps-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading applications...</span></div>';
    try {
      const res = await adminApi('admin_list_loan_applications', {
        p_search: document.getElementById('f-search').value.trim(),
        p_status: document.getElementById('f-status').value || null,
        p_limit: PAGE, p_offset: (page - 1) * PAGE
      });
      const rows = res.rows || [];
      if (!rows.length) { el.innerHTML = UI.emptyState('No applications found'); return; }
      el.innerHTML = '<table class="table mobile-cards">' +
        '<thead><tr><th>Reference</th><th>User</th><th>Product</th><th>Amount</th><th>Term</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead><tbody>' +
        rows.map(function (a) {
          return '<tr><td data-label="Reference"><span class="cell-main">' + UI.escapeHtml(a.reference) + '</span></td>' +
            '<td data-label="User">' + UI.escapeHtml(a.user_name) + '<div class="cell-sub">' + UI.escapeHtml(a.user_email) + '</div></td>' +
            '<td data-label="Product">' + UI.escapeHtml(a.product_name) + '</td>' +
            '<td data-label="Amount">' + UI.money(a.amount, a.currency) + '</td>' +
            '<td data-label="Term">' + a.term_months + ' mo</td>' +
            '<td data-label="Status">' + UI.badge(a.status) + '</td>' +
            '<td data-label="Date">' + UI.formatDateTime(a.created_at) + '</td>' +
            '<td data-label="Actions"><div class="row-actions">' +
              '<button class="row-action" data-view="' + a.id + '" title="View">' + ICONS.eye + '</button>' +
              '<button class="row-action" data-status="' + a.id + '" title="Update status">' + ICONS.edit + '</button>' +
            '</div></td></tr>';
        }).join('') +
        '</tbody></table>';

      el.querySelectorAll('[data-view]').forEach(function (b) {
        b.addEventListener('click', function () {
          const a = rows.find(function (x) { return x.id === b.getAttribute('data-view'); });
          const fd = a.form_data || {};
          let formSection = '';
          if (fd.full_name || fd.employment_status || fd.annual_income) {
            formSection =
              '<h4 style="margin:12px 0 6px">Application Details</h4>' +
              '<div class="detail-grid">' +
                (fd.full_name ? '<div class="detail-item"><div class="k">Full name</div><div class="v">' + UI.escapeHtml(fd.full_name) + '</div></div>' : '') +
                (fd.date_of_birth ? '<div class="detail-item"><div class="k">Date of birth</div><div class="v">' + UI.escapeHtml(fd.date_of_birth) + '</div></div>' : '') +
                (fd.phone ? '<div class="detail-item"><div class="k">Phone</div><div class="v">' + UI.escapeHtml(fd.phone) + '</div></div>' : '') +
                (fd.address ? '<div class="detail-item"><div class="k">Address</div><div class="v">' + UI.escapeHtml(fd.address + ', ' + (fd.city || '') + ', ' + (fd.state || '') + ' ' + (fd.zip || '')) + '</div></div>' : '') +
                (fd.employment_status ? '<div class="detail-item"><div class="k">Employment</div><div class="v">' + UI.escapeHtml(fd.employment_status) + '</div></div>' : '') +
                (fd.employer_name ? '<div class="detail-item"><div class="k">Employer</div><div class="v">' + UI.escapeHtml(fd.employer_name) + '</div></div>' : '') +
                (fd.annual_income ? '<div class="detail-item"><div class="k">Annual income</div><div class="v">' + UI.money(fd.annual_income, 'USD') + '</div></div>' : '') +
                (fd.credit_score ? '<div class="detail-item"><div class="k">Credit score</div><div class="v">' + fd.credit_score + '</div></div>' : '') +
              '</div>';
          }
          UI.openModal(
            '<div class="detail-grid">' +
              '<div class="detail-item"><div class="k">Reference</div><div class="v">' + UI.escapeHtml(a.reference) + '</div></div>' +
              '<div class="detail-item"><div class="k">Status</div><div class="v">' + UI.badge(a.status) + '</div></div>' +
              '<div class="detail-item"><div class="k">User</div><div class="v">' + UI.escapeHtml(a.user_name) + ' (' + UI.escapeHtml(a.user_email) + ')</div></div>' +
              '<div class="detail-item"><div class="k">Product</div><div class="v">' + UI.escapeHtml(a.product_name) + '</div></div>' +
              '<div class="detail-item"><div class="k">Amount</div><div class="v">' + UI.money(a.amount, a.currency) + '</div></div>' +
              '<div class="detail-item"><div class="k">Term</div><div class="v">' + a.term_months + ' months</div></div>' +
              '<div class="detail-item"><div class="k">Rate</div><div class="v">' + a.interest_rate + '%</div></div>' +
              '<div class="detail-item"><div class="k">Monthly</div><div class="v">' + UI.money(a.monthly_payment, a.currency) + '</div></div>' +
              '<div class="detail-item"><div class="k">Purpose</div><div class="v">' + UI.escapeHtml(a.purpose || '—') + '</div></div>' +
              (a.declined_reason ? '<div class="detail-item"><div class="k">Declined reason</div><div class="v">' + UI.escapeHtml(a.declined_reason) + '</div></div>' : '') +
              '<div class="detail-item"><div class="k">Submitted</div><div class="v">' + (a.submitted_at ? UI.formatDateTime(a.submitted_at) : UI.formatDateTime(a.created_at)) + '</div></div>' +
              '<div class="detail-item"><div class="k">Disbursed</div><div class="v">' + (a.disbursed_at ? UI.formatDateTime(a.disbursed_at) : '—') + '</div></div>' +
            '</div>' +
            formSection,
            { title: 'Loan Application — ' + a.reference, large: true }
          );
        });
      });
      el.querySelectorAll('[data-status]').forEach(function (b) {
        b.addEventListener('click', function () {
          const a = rows.find(function (x) { return x.id === b.getAttribute('data-status'); });
          const modal = UI.openModal(
            '<div class="field"><label>Status</label><select class="select" id="a-status">' +
              APP_STATUSES.map(function (s) { return '<option value="' + s + '"' + (s === a.status ? ' selected' : '') + '>' + UI.typeLabel(s) + '</option>'; }).join('') +
            '</select></div>' +
            '<div class="field"><label>Admin note</label><textarea class="input" id="a-note" rows="2"></textarea></div>' +
            '<div class="form-note">Setting status to <b>active</b> disburses the loan into the customer\'s account.</div>' +
            '<div class="form-error" id="a-error"></div>',
            { title: 'Update Application — ' + a.reference, footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Update</button>' }
          );
          modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
          modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
            try {
              await adminApi('admin_update_loan_application', {
                p_loan_id: a.id,
                p_status: document.getElementById('a-status').value,
                p_admin_note: document.getElementById('a-note').value.trim() || null
              });
              UI.toast('Application updated.', 'success');
              modal.close();
              loadApps();
            } catch (e) { document.getElementById('a-error').textContent = UI.apiErrorMessage(e); }
          });
        });
      });

      const pages = Math.max(1, Math.ceil((res.total || 0) / PAGE));
      const pag = document.getElementById('apps-pagination');
      let html = '<button data-p="' + (page - 1) + '" ' + (page <= 1 ? 'disabled' : '') + '>‹</button>';
      for (let i = 1; i <= pages; i++) html += '<button data-p="' + i + '" class="' + (i === page ? 'active' : '') + '">' + i + '</button>';
      html += '<button data-p="' + (page + 1) + '" ' + (page >= pages ? 'disabled' : '') + '>›</button>';
      pag.innerHTML = html;
      pag.querySelectorAll('button[data-p]').forEach(function (b) {
        b.addEventListener('click', function () { page = Number(b.getAttribute('data-p')); loadApps(); });
      });
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load applications');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  async function loadRepays() {
    const el = document.getElementById('repays-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading repayments...</span></div>';
    try {
      const reps = await adminApi('admin_list_loan_repayments');
      if (!reps.length) { el.innerHTML = UI.emptyState('No repayments found'); return; }
      el.innerHTML = '<table class="table mobile-cards">' +
        '<thead><tr><th>Loan</th><th>User</th><th>Amount</th><th>Due</th><th>Paid</th><th>Status</th></tr></thead><tbody>' +
        reps.map(function (r) {
          return '<tr><td data-label="Loan"><span class="cell-main">' + UI.escapeHtml(r.loan_reference) + '</span></td>' +
            '<td data-label="User">' + UI.escapeHtml(r.user_name) + '<div class="cell-sub">' + UI.escapeHtml(r.user_email) + '</div></td>' +
            '<td data-label="Amount">' + UI.money(r.amount, r.currency) + '</td>' +
            '<td data-label="Due">' + UI.formatDate(r.due_date) + '</td>' +
            '<td data-label="Paid">' + (r.paid_at ? UI.formatDateTime(r.paid_at) : '—') + '</td>' +
            '<td data-label="Status">' + UI.badge(r.status) + '</td></tr>';
        }).join('') +
        '</tbody></table>';
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load repayments');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  document.getElementById('btn-add-product').addEventListener('click', function () {
    const modal = UI.openModal(
      '<div class="field"><label>Name</label><input type="text" class="input" id="n-name"></div>' +
      '<div class="field"><label>Description</label><input type="text" class="input" id="n-desc"></div>' +
      '<div class="form-grid"><div class="field"><label>Min amount</label><input type="number" class="input" id="n-min" value="500"></div>' +
      '<div class="field"><label>Max amount</label><input type="number" class="input" id="n-max" value="100000"></div></div>' +
      '<div class="form-grid"><div class="field"><label>Interest rate %</label><input type="number" class="input" id="n-rate" step="0.01" value="5"></div>' +
      '<div class="field"><label>Term (months)</label><input type="number" class="input" id="n-term" value="12"></div></div>' +
      '<div class="form-error" id="n-error"></div>',
      { title: 'Add Loan Product', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Add</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      const err = document.getElementById('n-error');
      err.textContent = '';
      try {
        await adminApi('admin_create_loan_product', {
          p_name: document.getElementById('n-name').value.trim(),
          p_description: document.getElementById('n-desc').value.trim() || null,
          p_min_amount: Number(document.getElementById('n-min').value),
          p_max_amount: Number(document.getElementById('n-max').value),
          p_interest_rate: Number(document.getElementById('n-rate').value),
          p_term_months: Number(document.getElementById('n-term').value),
          p_enabled: true
        });
        UI.toast('Product added.', 'success');
        modal.close();
        loadProducts();
      } catch (e) { err.textContent = UI.apiErrorMessage(e); }
    });
  });

  document.getElementById('f-search').addEventListener('input', function () { page = 1; loadApps(); });
  document.getElementById('f-status').addEventListener('change', function () { page = 1; loadApps(); });

  await load();
  PageLoader.hide();
})();
// marvintlc — Admin cards module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Cards');

  const PAGE = 12;
  let page = 1;
  const STATUSES = ['active', 'frozen', 'blocked', 'expired'];

  document.getElementById('f-status').innerHTML = '<option value="">All statuses</option>' + STATUSES.map(function (s) { return '<option value="' + s + '">' + UI.typeLabel(s) + '</option>'; }).join('');

  async function load() {
    const el = document.getElementById('cards-table');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading cards...</span></div>';
    try {
      const res = await adminApi('admin_list_cards', {
        p_search: document.getElementById('f-search').value.trim(),
        p_status: document.getElementById('f-status').value || null,
        p_limit: PAGE, p_offset: (page - 1) * PAGE
      });
      render(res.rows || []);
      renderPagination(res.total || 0);
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load cards');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function render(rows) {
    const el = document.getElementById('cards-table');
    if (!rows.length) { el.innerHTML = UI.emptyState('No cards found'); return; }
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Card</th><th>Holder</th><th>User</th><th>Type</th><th>Limit</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (c) {
        return '<tr><td data-label="Card"><span class="cell-main">' + UI.escapeHtml(c.masked_number) + '</span><div class="cell-sub">' + c.expiry_month + '/' + String(c.expiry_year).slice(-2) + ' · ' + UI.escapeHtml(c.card_brand) + '</div></td>' +
          '<td data-label="Holder">' + UI.escapeHtml(c.card_holder) + '</td>' +
          '<td data-label="User">' + UI.escapeHtml(c.user_email || '—') + '</td>' +
          '<td data-label="Type">' + UI.escapeHtml(c.card_type) + '</td>' +
          '<td data-label="Limit">' + UI.money(c.spending_limit, 'USD') + '</td>' +
          '<td data-label="Status">' + UI.badge(c.status) + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            '<button class="row-action" data-status="' + c.id + '" title="Update status">' + ICONS.edit + '</button>' +
            (c.status === 'active'
              ? '<button class="row-action" data-freeze="' + c.id + '" title="Freeze">' + ICONS.pause + '</button>'
              : c.status === 'frozen'
                ? '<button class="row-action success" data-unfreeze="' + c.id + '" title="Unfreeze">' + ICONS.play + '</button>' : '') +
          '</div></td></tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-status]').forEach(function (b) {
      b.addEventListener('click', function () {
        const c = rows.find(function (x) { return x.id === b.getAttribute('data-status'); });
        const modal = UI.openModal(
          '<div class="field"><label>Status</label><select class="select" id="st-status">' +
            STATUSES.map(function (s) { return '<option value="' + s + '"' + (s === c.status ? ' selected' : '') + '>' + UI.typeLabel(s) + '</option>'; }).join('') +
          '</select></div>' +
          '<div class="field"><label>Spending limit (USD)</label><input type="number" class="input" id="st-limit" value="' + c.spending_limit + '"></div>' +
          '<div class="form-error" id="st-error"></div>',
          { title: 'Update Card', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>' }
        );
        modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
        modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
          try {
            await adminApi('admin_update_card', {
              p_card_id: c.id,
              p_status: document.getElementById('st-status').value,
              p_spending_limit: Number(document.getElementById('st-limit').value) || null
            });
            UI.toast('Card updated.', 'success');
            modal.close();
            load();
          } catch (e) { document.getElementById('st-error').textContent = UI.apiErrorMessage(e); }
        });
      });
    });
    el.querySelectorAll('[data-freeze]').forEach(function (b) {
      b.addEventListener('click', async function () {
        try { await adminApi('admin_update_card', { p_card_id: b.getAttribute('data-freeze'), p_status: 'frozen' }); UI.toast('Card frozen.', 'success'); load(); } catch (e) { UI.toast(UI.apiErrorMessage(e), 'error'); }
      });
    });
    el.querySelectorAll('[data-unfreeze]').forEach(function (b) {
      b.addEventListener('click', async function () {
        try { await adminApi('admin_update_card', { p_card_id: b.getAttribute('data-unfreeze'), p_status: 'active' }); UI.toast('Card unfrozen.', 'success'); load(); } catch (e) { UI.toast(UI.apiErrorMessage(e), 'error'); }
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

  document.getElementById('btn-create').addEventListener('click', function () {
    const modal = UI.openModal(
      '<div class="field"><label>Customer email</label><input type="email" class="input" id="c-email"></div>' +
      '<div class="field"><label>Card type</label><select class="select" id="c-type"><option value="debit">Debit</option><option value="credit">Credit</option><option value="virtual">Virtual</option></select></div>' +
      '<div class="field"><label>Brand</label><select class="select" id="c-brand"><option value="mastercard">Mastercard</option><option value="visa">Visa</option></select></div>' +
      '<div class="field"><label>Expiry month</label><input type="number" class="input" id="c-month" min="1" max="12" value="12"></div>' +
      '<div class="field"><label>Expiry year</label><input type="number" class="input" id="c-year" value="' + (new Date().getFullYear() + 4) + '"></div>' +
      '<div class="field"><label>Spending limit</label><input type="number" class="input" id="c-limit" value="10000"></div>' +
      '<div class="form-error" id="c-error"></div>',
      { title: 'Issue Card', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Issue</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      const err = document.getElementById('c-error');
      err.textContent = '';
      const email = document.getElementById('c-email').value.trim();
      if (!email) { err.textContent = 'Customer email is required.'; return; }
      try {
        const user = await adminApi('admin_list_users', { p_search: email, p_limit: 1, p_offset: 0 });
        if (!user.rows.length) { err.textContent = 'No customer found.'; return; }
        const uid = user.rows[0].id;
        const acc = await adminApi('admin_list_accounts', { p_search: email, p_currency: 'USD', p_limit: 1, p_offset: 0 });
        if (!acc.rows.length) { err.textContent = 'Customer has no USD account.'; return; }
        await adminApi('admin_create_card', {
          p_user_id: uid, p_account_id: acc.rows[0].id,
          p_card_type: document.getElementById('c-type').value,
          p_card_brand: document.getElementById('c-brand').value,
          p_expiry_month: Number(document.getElementById('c-month').value),
          p_expiry_year: Number(document.getElementById('c-year').value),
          p_spending_limit: Number(document.getElementById('c-limit').value) || 10000,
          p_status: 'active'
        });
        UI.toast('Card issued.', 'success');
        modal.close();
        load();
      } catch (e) { err.textContent = UI.apiErrorMessage(e); }
    });
  });

  document.getElementById('f-search').addEventListener('input', function () { page = 1; load(); });
  document.getElementById('f-status').addEventListener('change', function () { page = 1; load(); });

  await load();
  PageLoader.hide();
})();
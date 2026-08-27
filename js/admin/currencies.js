// marvintlc — Admin currencies & exchange rates module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Currencies');

  async function load() {
    try {
      const data = await adminApi('admin_list_currencies');
      renderCurrencies(data);
      renderRates(data);
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function renderCurrencies(list) {
    const el = document.getElementById('currencies-table');
    if (!list.length) { el.innerHTML = UI.emptyState('No currencies'); return; }
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Code</th><th>Name</th><th>Symbol</th><th>Base</th><th>Enabled</th><th>Actions</th></tr></thead><tbody>' +
      list.map(function (c) {
        const cur = c.currency;
        return '<tr><td data-label="Code"><span class="cell-main">' + UI.escapeHtml(cur.code) + '</span></td>' +
          '<td data-label="Name">' + UI.escapeHtml(cur.name) + '</td>' +
          '<td data-label="Symbol">' + UI.escapeHtml(cur.symbol) + '</td>' +
          '<td data-label="Base">' + (cur.is_base ? '<span class="badge badge-gold">Base</span>' : '—') + '</td>' +
          '<td data-label="Enabled">' + (cur.enabled ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-failed">No</span>') + '</td>' +
          '<td data-label="Actions"><div class="row-actions">' +
            '<button class="row-action" data-edit-cur="' + cur.code + '" title="Edit">' + ICONS.edit + '</button>' +
            '<button class="row-action danger" data-del-cur="' + cur.code + '" title="Delete">' + ICONS.trash + '</button>' +
          '</div></td></tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-edit-cur]').forEach(function (b) {
      b.addEventListener('click', function () {
        const c = list.find(function (x) { return x.currency.code === b.getAttribute('data-edit-cur'); }).currency;
        const modal = UI.openModal(
          '<div class="field"><label>Name</label><input type="text" class="input" id="e-name" value="' + UI.escapeHtml(c.name) + '"></div>' +
          '<div class="field"><label>Symbol</label><input type="text" class="input" id="e-symbol" value="' + UI.escapeHtml(c.symbol) + '"></div>' +
          '<div class="field"><label>Enabled</label><select class="select" id="e-enabled"><option value="true"' + (c.enabled ? ' selected' : '') + '>Yes</option><option value="false"' + (!c.enabled ? ' selected' : '') + '>No</option></select></div>' +
          '<div class="form-error" id="e-error"></div>',
          { title: 'Edit Currency', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>' }
        );
        modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
        modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
          try {
            await adminApi('admin_update_currency', {
              p_code: c.code,
              p_name: document.getElementById('e-name').value.trim() || null,
              p_symbol: document.getElementById('e-symbol').value.trim() || null,
              p_enabled: document.getElementById('e-enabled').value === 'true'
            });
            UI.toast('Currency updated.', 'success');
            modal.close();
            load();
          } catch (e) { document.getElementById('e-error').textContent = UI.apiErrorMessage(e); }
        });
      });
    });
    el.querySelectorAll('[data-del-cur]').forEach(function (b) {
      b.addEventListener('click', function () {
        const code = b.getAttribute('data-del-cur');
        UI.confirmDialog('Delete currency ' + code + '?', async function () {
          try {
            await adminApi('admin_delete_currency', { p_code: code });
            UI.toast('Currency deleted.', 'success');
            load();
          } catch (e) { UI.toast(UI.apiErrorMessage(e), 'error'); }
        }, 'Delete');
      });
    });
  }

  function renderRates(list) {
    const el = document.getElementById('rates-table');
    let rows = [];
    list.forEach(function (c) {
      (c.rates || []).forEach(function (r) {
        rows.push({ base: c.currency.code, quote: r.quote_currency, rate: r.rate, fee: r.fee_percent });
      });
    });
    if (!rows.length) { el.innerHTML = UI.emptyState('No exchange rates configured'); return; }
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Pair</th><th>Rate</th><th>Fee %</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td data-label="Pair"><span class="cell-main">' + r.base + ' / ' + r.quote + '</span></td>' +
          '<td data-label="Rate">' + r.rate + '</td>' +
          '<td data-label="Fee %">' + r.fee + '%</td>' +
          '<td data-label="Actions"><button class="row-action" data-edit-rate="' + r.base + '" data-quote="' + r.quote + '" title="Edit">' + ICONS.edit + '</button></td></tr>';
      }).join('') +
      '</tbody></table>';

    el.querySelectorAll('[data-edit-rate]').forEach(function (b) {
      b.addEventListener('click', function () {
        const r = rows.find(function (x) { return x.base === b.getAttribute('data-edit-rate') && x.quote === b.getAttribute('data-quote'); });
        const modal = UI.openModal(
          '<div class="field"><label>Rate (1 ' + r.base + ' = ? ' + r.quote + ')</label><input type="number" class="input" id="r-rate" step="0.00000001" value="' + r.rate + '"></div>' +
          '<div class="field"><label>Fee percent</label><input type="number" class="input" id="r-fee" step="0.01" value="' + r.fee + '"></div>' +
          '<div class="form-error" id="r-error"></div>',
          { title: 'Edit Rate — ' + r.base + '/' + r.quote, footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>' }
        );
        modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
        modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
          try {
            await adminApi('admin_set_exchange_rate', {
              p_base: r.base, p_quote: r.quote,
              p_rate: Number(document.getElementById('r-rate').value),
              p_fee_percent: Number(document.getElementById('r-fee').value) || 0
            });
            UI.toast('Exchange rate updated.', 'success');
            modal.close();
            load();
          } catch (e) { document.getElementById('r-error').textContent = UI.apiErrorMessage(e); }
        });
      });
    });
  }

  document.getElementById('btn-add-cur').addEventListener('click', function () {
    const modal = UI.openModal(
      '<div class="field"><label>Code</label><input type="text" class="input" id="c-code" placeholder="e.g. JPY" maxlength="3"></div>' +
      '<div class="field"><label>Name</label><input type="text" class="input" id="c-name"></div>' +
      '<div class="field"><label>Symbol</label><input type="text" class="input" id="c-symbol"></div>' +
      '<div class="field"><label>Enabled</label><select class="select" id="c-enabled"><option value="true">Yes</option><option value="false">No</option></select></div>' +
      '<div class="form-error" id="c-error"></div>',
      { title: 'Add Currency', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Add</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-save]').addEventListener('click', async function () {
      const err = document.getElementById('c-error');
      err.textContent = '';
      try {
        await adminApi('admin_create_currency', {
          p_code: document.getElementById('c-code').value.trim(),
          p_name: document.getElementById('c-name').value.trim(),
          p_symbol: document.getElementById('c-symbol').value.trim() || '$',
          p_enabled: document.getElementById('c-enabled').value === 'true'
        });
        UI.toast('Currency added.', 'success');
        modal.close();
        load();
      } catch (e) { err.textContent = UI.apiErrorMessage(e); }
    });
  });

  await load();
  PageLoader.hide();
})();
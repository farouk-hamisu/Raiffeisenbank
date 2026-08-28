// marvintlc — Transactions module
(async function () {
  await AppShell.init({ title: 'Transactions' });
  const user = Auth.user;

  const PAGE = APP_CONFIG.pageSize || 10;
  let currentPage = 1;
  let totalRows = 0;
  const sort = { key: 'created_at', dir: 'desc' };

  const TYPES = ['deposit', 'withdrawal', 'local_transfer', 'international_transfer', 'currency_swap', 'loan_disbursement', 'loan_repayment', 'fee', 'interest', 'reversal', 'adjustment'];
  const STATUSES = ['pending', 'processing', 'completed', 'failed', 'cancelled', 'reversed'];

  function populateFilters() {
    const typeSel = document.getElementById('f-type');
    typeSel.innerHTML = '<option value="">All types</option>' + TYPES.map(function (t) {
      return '<option value="' + t + '">' + UI.typeLabel(t) + '</option>';
    }).join('');
    const statusSel = document.getElementById('f-status');
    statusSel.innerHTML = '<option value="">All statuses</option>' + STATUSES.map(function (s) {
      return '<option value="' + s + '">' + UI.typeLabel(s) + '</option>';
    }).join('');

    // apply URL q param
    const q = UI.qs('q');
    if (q) document.getElementById('f-search').value = q;
  }

  async function load(page) {
    currentPage = page || 1;
    const myRequest = ++requestId;
    const search = document.getElementById('f-search').value.trim();
    const type = document.getElementById('f-type').value;
    const status = document.getElementById('f-status').value;
    const from = document.getElementById('f-from').value;
    const to = document.getElementById('f-to').value;

    const tableEl = document.getElementById('tx-table');
    tableEl.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading transactions...</span></div>';

    try {
      let query = SB.from('transactions').select('*', { count: 'exact' }).eq('user_id', user.id);
      if (search) query = query.or('reference.ilike.%' + search + '%,recipient.ilike.%' + search + '%,sender.ilike.%' + search + '%,description.ilike.%' + search + '%');
      if (type) query = query.eq('type', type);
      if (status) query = query.eq('status', status);
      if (from) query = query.gte('created_at', from + 'T00:00:00');
      if (to) query = query.lte('created_at', to + 'T23:59:59');

      const fromIdx = (currentPage - 1) * PAGE;
      query = query.order(sort.key, { ascending: sort.dir === 'asc' }).range(fromIdx, fromIdx + PAGE - 1);

      const { data, count, error } = await query;
      if (myRequest !== requestId) return; // stale response, discard
      if (error) throw error;
      totalRows = count || 0;
      render(data || []);
      renderPagination();
    } catch (e) {
      tableEl.innerHTML = UI.emptyState('Could not load transactions');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function render(txs) {
    const el = document.getElementById('tx-table');
    if (!txs.length) { el.innerHTML = UI.emptyState('No transactions found'); return; }
    el.innerHTML =
      '<table class="table mobile-cards">' +
        '<thead><tr>' +
          '<th class="sortable" data-k="reference">Reference <span class="sort-arrow">↕</span></th>' +
          '<th>Date</th>' +
          '<th>Type</th>' +
          '<th>Description</th>' +
          '<th>Counterparty</th>' +
          '<th class="sortable" data-k="amount">Amount <span class="sort-arrow">↕</span></th>' +
          '<th>Status</th>' +
          '<th></th>' +
        '</tr></thead><tbody>' +
        txs.map(function (t) {
          return '<tr class="row-link" data-id="' + t.id + '">' +
            '<td data-label="Reference"><span class="cell-main">' + UI.escapeHtml(t.reference) + '</span></td>' +
            '<td data-label="Date">' + UI.formatDate(t.created_at) + '</td>' +
            '<td data-label="Type"><span class="cell-main">' + UI.typeLabel(t.type) + '</span></td>' +
            '<td data-label="Description" class="text-muted">' + UI.escapeHtml(t.description || '—') + '</td>' +
            '<td data-label="Counterparty">' + UI.escapeHtml(t.recipient || t.sender || '—') + '</td>' +
            '<td data-label="Amount" class="' + (t.direction === 'credit' ? 'amount-credit' : 'amount-debit') + '">' + (t.direction === 'credit' ? '+' : '-') + UI.money(t.amount, t.currency) + '</td>' +
            '<td data-label="Status">' + UI.badge(t.status) + '</td>' +
            '<td data-label=""><div class="row-actions"><button class="row-action" data-view="' + t.id + '" title="View">' + ICONS.eye + '</button></div></td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>';

    el.querySelectorAll('[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const tx = txs.find(function (t) { return t.id === btn.getAttribute('data-view'); });
        showDetails(tx);
      });
    });
    el.querySelectorAll('tr.row-link').forEach(function (tr) {
      tr.addEventListener('click', function () {
        const tx = txs.find(function (t) { return t.id === tr.getAttribute('data-id'); });
        if (tx) showDetails(tx);
      });
    });
  }

  function showDetails(t) {
    UI.openModal(
      '<div class="detail-grid">' +
        '<div class="detail-item"><div class="k">Reference</div><div class="v">' + UI.escapeHtml(t.reference) + '</div></div>' +
        '<div class="detail-item"><div class="k">Status</div><div class="v">' + UI.badge(t.status) + '</div></div>' +
        '<div class="detail-item"><div class="k">Type</div><div class="v">' + UI.typeLabel(t.type) + '</div></div>' +
        '<div class="detail-item"><div class="k">Direction</div><div class="v">' + UI.escapeHtml(t.direction) + '</div></div>' +
        '<div class="detail-item"><div class="k">Amount</div><div class="v">' + UI.money(t.amount, t.currency) + '</div></div>' +
        '<div class="detail-item"><div class="k">Fee</div><div class="v">' + UI.money(t.fee || 0, t.currency) + '</div></div>' +
        '<div class="detail-item"><div class="k">Date</div><div class="v">' + UI.formatDateTime(t.created_at) + '</div></div>' +
        '<div class="detail-item"><div class="k">Currency</div><div class="v">' + UI.escapeHtml(t.currency) + '</div></div>' +
        '<div class="detail-item"><div class="k">Sender</div><div class="v">' + UI.escapeHtml(t.sender || '—') + '</div></div>' +
        '<div class="detail-item"><div class="k">Recipient</div><div class="v">' + UI.escapeHtml(t.recipient || '—') + '</div></div>' +
        '<div class="detail-item span-2"><div class="k">Description</div><div class="v">' + UI.escapeHtml(t.description || '—') + '</div></div>' +
      '</div>',
      { title: 'Transaction Details' }
    );
  }

  function renderPagination() {
    const pages = Math.max(1, Math.ceil(totalRows / PAGE));
    const el = document.getElementById('pagination');
    let html = '<button data-p="' + (currentPage - 1) + '" ' + (currentPage <= 1 ? 'disabled' : '') + '>‹</button>';
    for (let i = 1; i <= pages; i++) {
      html += '<button data-p="' + i + '" class="' + (i === currentPage ? 'active' : '') + '">' + i + '</button>';
    }
    html += '<button data-p="' + (currentPage + 1) + '" ' + (currentPage >= pages ? 'disabled' : '') + '>›</button>';
    el.innerHTML = html;
    el.querySelectorAll('button[data-p]').forEach(function (b) {
      b.addEventListener('click', function () { load(Number(b.getAttribute('data-p'))); });
    });
  }

  // sortable headers
  document.getElementById('tx-table').addEventListener('click', function (e) {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const k = th.getAttribute('data-k');
    if (sort.key === k) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
    else { sort.key = k; sort.dir = 'desc'; }
    load(currentPage);
  });

  let searchDebounce = null;
  let requestId = 0;

  ['f-type', 'f-status', 'f-from', 'f-to'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', function () { load(1); });
  });
  document.getElementById('f-search').addEventListener('input', function () {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function () { load(1); }, 300);
  });
  document.getElementById('f-reset').addEventListener('click', function () {
    ['f-search', 'f-type', 'f-status', 'f-from', 'f-to'].forEach(function (id) { document.getElementById(id).value = ''; });
    load(1);
  });

  populateFilters();
  await load(1);
  PageLoader.hide();
})();
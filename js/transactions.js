// Marvin Bank — Transactions module
(async function () {
  await AppShell.init({ title: 'Transactions' });

  const PAGE = APP_CONFIG.pageSize || 10;
  let currentPage = 1;
  let totalRows = 0;
  let hasBalanceAfter = false;
  const sort = { key: 'created_at', dir: 'desc' };

  const TYPES = ['deposit', 'withdrawal', 'local_transfer', 'international_transfer', 'currency_swap', 'loan_disbursement', 'loan_repayment', 'fee', 'interest', 'reversal', 'adjustment'];
  const STATUSES = ['pending', 'processing', 'completed', 'failed', 'cancelled', 'reversed'];

  // A statement's counterparty is the other side of the trade: money coming
  // in has a sender, money going out has a recipient.
  function counterparty(t) {
    if (t.direction === 'credit') return t.sender ? { label: 'From', name: t.sender } : null;
    return t.recipient ? { label: 'To', name: t.recipient } : null;
  }

  function populateFilters() {
    document.getElementById('f-type').innerHTML = '<option value="">All types</option>' + TYPES.map(function (t) {
      return '<option value="' + t + '">' + UI.typeLabel(t) + '</option>';
    }).join('');
    document.getElementById('f-status').innerHTML = '<option value="">All statuses</option>' + STATUSES.map(function (s) {
      return '<option value="' + s + '">' + UI.typeLabel(s) + '</option>';
    }).join('');

    const q = UI.qs('q');
    if (q) document.getElementById('f-search').value = q;
  }

  async function load(page) {
    currentPage = page || 1;
    const myRequest = ++requestId;
    const from = document.getElementById('f-from').value;
    const to = document.getElementById('f-to').value;

    const tableEl = document.getElementById('tx-table');
    tableEl.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading transactions...</span></div>';

    try {
      // Balance-after is computed in SQL over the whole ledger (see migration
      // 029) so the running figure is correct regardless of page size. Until
      // that migration is applied, fall back to the plain transactions query
      // and simply show no balance column.
      let res;
      try {
        res = await UI.rpc('customer_transaction_history', {
          p_search: document.getElementById('f-search').value.trim(),
          p_type: document.getElementById('f-type').value || null,
          p_status: document.getElementById('f-status').value || null,
          p_from: from ? from + 'T00:00:00' : null,
          p_to: to ? to + 'T23:59:59' : null,
          p_sort: sort.key,
          p_dir: sort.dir,
          p_limit: PAGE,
          p_offset: (currentPage - 1) * PAGE
        });
        hasBalanceAfter = true;
      } catch (rpcErr) {
        if (!/could not find|not find the function|does not exist|schema cache/i.test(String(rpcErr && rpcErr.message))) throw rpcErr;
        res = await legacyLoad(from, to);
      }
      if (myRequest !== requestId) return; // stale response, discard
      totalRows = res.total || 0;
      render(res.rows || []);
      renderPagination();
    } catch (e) {
      tableEl.innerHTML = UI.emptyState('Could not load transactions');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  // Pre-migration-029 path: no balance-after available.
  async function legacyLoad(from, to) {
    let query = SB.from('transactions').select('*', { count: 'exact' }).eq('user_id', Auth.user.id);
    const search = document.getElementById('f-search').value.trim();
    if (search) query = query.or('reference.ilike.%' + search + '%,recipient.ilike.%' + search + '%,sender.ilike.%' + search + '%,description.ilike.%' + search + '%');
    const type = document.getElementById('f-type').value;
    const status = document.getElementById('f-status').value;
    if (type) query = query.eq('type', type);
    if (status) query = query.eq('status', status);
    if (from) query = query.gte('created_at', from + 'T00:00:00');
    if (to) query = query.lte('created_at', to + 'T23:59:59');
    const fromIdx = (currentPage - 1) * PAGE;
    query = query.order(sort.key, { ascending: sort.dir === 'asc' }).range(fromIdx, fromIdx + PAGE - 1);
    const { data, count, error } = await query;
    if (error) throw error;
    return { rows: (data || []).map(function (t) { return Object.assign({}, t, { balance_after: null }); }), total: count || 0 };
  }

  function render(txs) {
    const el = document.getElementById('tx-table');
    if (!txs.length) { el.innerHTML = UI.emptyState('No transactions found'); return; }
    el.innerHTML =
      '<table class="table mobile-cards">' +
        '<thead><tr>' +
          '<th class="sortable" data-k="created_at">Date <span class="sort-arrow">↕</span></th>' +
          '<th>Description</th>' +
          '<th class="sortable" data-k="type">Type <span class="sort-arrow">↕</span></th>' +
          '<th class="sortable" data-k="reference">Reference <span class="sort-arrow">↕</span></th>' +
          '<th class="sortable" data-k="amount">Amount <span class="sort-arrow">↕</span></th>' +
          '<th class="sortable" data-k="status">Status <span class="sort-arrow">↕</span></th>' +
          (hasBalanceAfter ? '<th class="sortable num" data-k="balance_after">Balance after <span class="sort-arrow">↕</span></th>' : '') +
          '<th></th>' +
        '</tr></thead><tbody>' +
        txs.map(function (t) {
          const cp = counterparty(t);
          const credit = t.direction === 'credit';
          const bal = t.balance_after;
          return '<tr class="row-link" data-id="' + t.id + '">' +
            '<td data-label="Date"><div class="cell-main">' + UI.formatDate(t.created_at) + '</div><div class="cell-sub">' + UI.formatTime(t.created_at) + '</div></td>' +
            '<td data-label="Description"><div class="cell-main">' + UI.escapeHtml(t.description || UI.typeLabel(t.type)) + '</div>' +
              (cp ? '<div class="cell-sub">' + cp.label + ' ' + UI.escapeHtml(cp.name) + '</div>' : '') + '</td>' +
            '<td data-label="Type"><div class="cell-main">' + (credit ? 'Credit' : 'Debit') + '</div><div class="cell-sub">' + UI.typeLabel(t.type) + '</div></td>' +
            '<td data-label="Reference"><span class="mono">' + UI.escapeHtml(t.reference) + '</span></td>' +
            '<td data-label="Amount" class="' + (credit ? 'amount-credit' : 'amount-debit') + '">' + (credit ? '+' : '−') + UI.money(t.amount, t.currency) + '</td>' +
            '<td data-label="Status">' + UI.badge(t.status) + '</td>' +
            (hasBalanceAfter ? '<td data-label="Balance after" class="num">' + (bal === null || bal === undefined ? '—' : UI.money(bal, t.account_currency || t.currency)) + '</td>' : '') +
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
    const cp = counterparty(t);
    const credit = t.direction === 'credit';
    const bal = t.balance_after;
    UI.openModal(
      '<div class="detail-grid">' +
        '<div class="detail-item"><div class="k">Reference</div><div class="v mono">' + UI.escapeHtml(t.reference) + '</div></div>' +
        '<div class="detail-item"><div class="k">Status</div><div class="v">' + UI.badge(t.status) + '</div></div>' +
        '<div class="detail-item"><div class="k">Direction</div><div class="v">' + (credit ? 'Credit' : 'Debit') + '</div></div>' +
        '<div class="detail-item"><div class="k">Type</div><div class="v">' + UI.typeLabel(t.type) + '</div></div>' +
        '<div class="detail-item"><div class="k">Amount</div><div class="v ' + (credit ? 'amount-credit' : 'amount-debit') + '">' + (credit ? '+' : '−') + UI.money(t.amount, t.currency) + '</div></div>' +
        '<div class="detail-item"><div class="k">Fee</div><div class="v">' + UI.money(t.fee || 0, t.currency) + '</div></div>' +
        '<div class="detail-item"><div class="k">Balance after</div><div class="v">' + (bal === null || bal === undefined ? '—' : UI.money(bal, t.account_currency || t.currency)) + '</div></div>' +
        '<div class="detail-item"><div class="k">Date</div><div class="v">' + UI.formatDateTime(t.created_at) + '</div></div>' +
        (cp ? '<div class="detail-item span-2"><div class="k">' + cp.label + '</div><div class="v">' + UI.escapeHtml(cp.name) + '</div></div>' : '') +
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
    else { sort.key = k; sort.dir = k === 'created_at' || k === 'balance_after' || k === 'amount' ? 'desc' : 'asc'; }
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

// Raiffeisen Bank — Admin dashboard module
(async function () {
  const admin = await AdminAuth.requireAuth();
  if (!admin) return;
  renderAdminShell('Dashboard');

  async function load() {
    try {
      const stats = await adminApi('admin_get_stats');
      renderStats(stats);
      renderCharts();
      renderAudit();
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function renderStats(s) {
    const el = document.getElementById('stats-grid');
    const cards = [
      { label: 'Total Customers', value: s.total_customers, icon: 'users', color: 'as-blue' },
      { label: 'Active Customers', value: s.active_customers, icon: 'userPlus', color: 'as-green' },
      { label: 'Suspended', value: s.suspended_customers, icon: 'users', color: 'as-red' },
      { label: 'Total Accounts', value: s.total_accounts, icon: 'wallet', color: 'as-amber' },
      { label: 'Total Balances', value: UI.money(s.total_balances, 'USD'), icon: 'money', color: 'as-green' },
      { label: 'Transactions', value: s.total_transactions, icon: 'transactions', color: 'as-blue' },
      { label: 'Pending Tx', value: s.pending_transactions, icon: 'clock', color: 'as-amber' },
      { label: 'Failed/Cancelled', value: s.failed_transactions, icon: 'alert', color: 'as-red' },
      { label: 'Deposits', value: s.total_deposits, icon: 'deposits', color: 'as-blue' },
      { label: 'Pending Deposits', value: s.pending_deposits, icon: 'clock', color: 'as-amber' },
      { label: 'Local Transfers', value: s.local_transfers, icon: 'send', color: 'as-blue' },
      { label: 'International Transfers', value: s.international_transfers, icon: 'globe', color: 'as-blue' },
      { label: 'Active Cards', value: s.active_cards, icon: 'cards', color: 'as-green' },
      { label: 'Frozen Cards', value: s.frozen_cards, icon: 'pause', color: 'as-amber' },
      { label: 'Loan Applications', value: s.loan_applications, icon: 'loans', color: 'as-blue' },
      { label: 'Active Loans', value: s.active_loans, icon: 'loans', color: 'as-green' }
    ];
    el.innerHTML = '<div class="admin-stats">' + cards.map(function (c) {
      return '<div class="admin-stat"><div class="as-icon ' + c.color + '">' + icon(c.icon) + '</div>' +
        '<div><div class="as-value">' + c.value + '</div><div class="as-label">' + c.label + '</div></div></div>';
    }).join('') + '</div>';
  }

  async function renderCharts() {
    // RLS-safe volume + status data via the admin RPC (direct queries are blocked for admins).
    let chart;
    try {
      chart = await adminApi('admin_get_chart_data');
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
      return;
    }

    const months = chart.months || [];
    if (months.length && document.getElementById('vol-chart')) {
      const labels = months.map(function (m) { return m.month; });
      const credits = months.map(function (m) { return Number(m.credits) || 0; });
      const debits = months.map(function (m) { return Number(m.debits) || 0; });
      Charts.lineChart(document.getElementById('vol-chart'), labels, [
        { data: credits, color: '#2f7de1' },
        { data: debits, color: '#1a9e5a' }
      ]);
    }

    const counts = chart.status_breakdown || {};
    const items = Object.keys(counts).map(function (k) { return { label: k, value: counts[k] }; });
    const canvas = document.getElementById('status-chart');
    if (canvas && items.length) {
      const colors = ['#1a9e5a', '#2f7de1', '#d98e1f', '#d64045', '#7c8aa0', '#123a7e'];
      Charts.doughnutChart(canvas, items, { colors: colors });
      document.getElementById('status-legend').innerHTML = items.map(function (it, i) {
        return '<span class="lg"><span class="swatch" style="background:' + colors[i % colors.length] + '"></span> ' + it.label + ' (' + it.value + ')</span>';
      }).join('');
    }
  }

  async function renderAudit() {
    const el = document.getElementById('recent-audit');
    try {
      const res = await adminApi('admin_list_audit_logs', { p_limit: 8, p_offset: 0 });
      if (!res.rows.length) { el.innerHTML = UI.emptyState('No admin activity yet'); return; }
      el.innerHTML = '<div class="tx-list">' + res.rows.map(function (a) {
        return '<div class="tx-item">' +
          '<div class="tx-icon">' + icon('list') + '</div>' +
          '<div class="tx-info"><div class="tx-title"><span class="audit-action ' + a.action + '">' + UI.escapeHtml(a.action) + '</span> · ' + UI.escapeHtml(a.resource) + '</div>' +
          '<div class="tx-sub">' + UI.escapeHtml(a.admin_email || 'unknown') + ' · ' + UI.timeAgo(a.created_at) + (a.resource_id ? ' · ' + UI.escapeHtml(a.resource_id) : '') + '</div></div></div>';
      }).join('') + '</div>';
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load activity');
    }
  }

  await load();
  PageLoader.hide();
})();
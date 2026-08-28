// marvintlc — Customer dashboard module
(async function () {
  const profile = await AppShell.init({ title: 'Dashboard' });
  if (!profile) return;

  const user = Auth.user;
  const state = { accounts: [], balances: {}, cards: [], loans: [], repayments: [], btcUsdRate: null, btcBalance: 0 };

  // ---------------- Load data ----------------
  async function loadData() {
    const [accountsRes, txRes, cardsRes, loansRes, repayRes, notifRes] = await Promise.all([
      SB.from('accounts').select('*').eq('user_id', user.id).order('created_at'),
      SB.from('transactions').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(6),
      SB.from('cards').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(3),
      SB.from('loan_applications').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
      SB.from('loan_repayments').select('*').eq('user_id', user.id),
      SB.from('notifications').select('*').or('user_id.eq.' + user.id + ',is_global.eq.true').order('created_at', { ascending: false }).limit(4)
    ]);

    state.accounts = accountsRes.error ? [] : (accountsRes.data || []);
    state.cards = cardsRes.error ? [] : (cardsRes.data || []);
    state.loans = loansRes.error ? [] : (loansRes.data || []);
    state.repayments = repayRes.error ? [] : (repayRes.data || []);

    if (accountsRes.error) UI.toast('Could not load accounts: ' + UI.apiErrorMessage(accountsRes.error), 'error');
    if (txRes.error) UI.toast('Could not load transactions: ' + UI.apiErrorMessage(txRes.error), 'error');
    if (cardsRes.error) UI.toast('Could not load cards: ' + UI.apiErrorMessage(cardsRes.error), 'error');
    if (loansRes.error) UI.toast('Could not load loans: ' + UI.apiErrorMessage(loansRes.error), 'error');
    if (repayRes.error) UI.toast('Could not load repayments: ' + UI.apiErrorMessage(repayRes.error), 'error');
    if (notifRes.error) UI.toast('Could not load notifications: ' + UI.apiErrorMessage(notifRes.error), 'error');

    let balData = [];
    if (state.accounts.length) {
      const balRes = await SB.from('account_balances').select('*').in('account_id', state.accounts.map(function (a) { return a.id; }));
      if (!balRes.error) balData = balRes.data || [];
      else UI.toast('Could not load balances: ' + UI.apiErrorMessage(balRes.error), 'error');
    }
    balData.forEach(function (b) { state.balances[b.account_id] = b; });

    // Fetch BTC price
    await fetchBtcPrice();
    // Load BTC balance from accounts
    loadBtcBalance();

    renderWelcome();
    renderBalances();
    renderPendingVerifications();
    renderTransactions(txRes.error ? [] : (txRes.data || []));
    renderCards();
    renderLoans();
    renderNotifications(notifRes.error ? [] : (notifRes.data || []));
    renderChart(txRes.error ? [] : (txRes.data || []));
  }

  // ---------------- BTC price ----------------
  async function fetchBtcPrice() {
    try {
      state.btcUsdRate = await BtcPrice.get();
    } catch (e) {
      try {
        const r = await SB.from('exchange_rates').select('rate').eq('base_currency', 'BTC').eq('quote_currency', 'USD').single();
        if (r.data) state.btcUsdRate = parseFloat(r.data.rate);
      } catch (_) {}
    }
  }

  // ---------------- BTC balance from account_balances ----------------
  function loadBtcBalance() {
    let btcHeld = 0;
    state.accounts.forEach(function (a) {
      if (a.currency === 'BTC') {
        const b = state.balances[a.id];
        if (b) btcHeld += Number(b.available_balance) || 0;
      }
    });
    state.btcBalance = btcHeld;
  }

  // ---------------- Balances ----------------
  function totalBalanceConverted() {
    let t = 0;
    state.accounts.forEach(function (a) {
      const b = state.balances[a.id];
      if (!b) return;
      t += Number(b.ledger_balance) || 0;
    });
    return t;
  }

  function availableBalanceConverted() {
    let t = 0;
    state.accounts.forEach(function (a) {
      const b = state.balances[a.id];
      if (!b) return;
      t += Number(b.available_balance) || 0;
    });
    return t;
  }

  function savingsBalance() {
    let t = 0;
    state.accounts.filter(function (a) { return a.account_type === 'savings'; }).forEach(function (a) {
      const b = state.balances[a.id];
      if (!b) return;
      t += Number(b.ledger_balance) || 0;
    });
    return t;
  }

  function checkingBalance() {
    let t = 0;
    state.accounts.filter(function (a) { return a.account_type === 'checking'; }).forEach(function (a) {
      const b = state.balances[a.id];
      if (!b) return;
      t += Number(b.ledger_balance) || 0;
    });
    return t;
  }

  function btcUsdValue() {
    return state.btcBalance * (state.btcUsdRate || 0);
  }

  // ---------------- Rendering ----------------
  function renderWelcome() {
    const root = document.getElementById('page-root');
    const existing = root.querySelector('.welcome-banner');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.className = 'welcome-banner';
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    banner.innerHTML =
      '<div class="flex gap-2">' + UI.avatar(profile, { size: 'lg' }) + '<div><h2>' + greeting + ', ' + UI.escapeHtml((profile.full_name || '').split(' ')[0] || 'there') + '</h2>' +
      '<p>Here is what is happening with your money today.</p></div></div>' +
      '<a href="transactions.html" class="btn btn-gold btn-sm">View Transactions</a>';
    root.insertBefore(banner, root.firstChild);
  }

  function renderBalances() {
    const el = document.getElementById('balance-cards');
    const primary = state.cards[0];
    const savingsCount = state.accounts.filter(function (a) { return a.account_type === 'savings'; }).length;
    const checkingCount = state.accounts.filter(function (a) { return a.account_type === 'checking'; }).length;
    const holder = primary ? primary.card_holder : (profile.full_name || 'Card Holder');

    // Build per-account breakdown
    let breakdownRows = '';
    state.accounts.forEach(function (a) {
      const b = state.balances[a.id];
      if (!b) return;
      const num = a.account_number ? a.account_number.slice(-4) : '????';
      const typeLabel = a.account_type === 'savings' ? 'Savings' : a.account_type === 'checking' ? 'Current' : a.account_type;
      breakdownRows += '<div class="breakdown-row">' +
        '<span class="acct-label">' + UI.escapeHtml(a.account_name) + ' <span class="text-muted">(****' + num + ') &middot; ' + typeLabel + '</span></span>' +
        '<span class="acct-bal">' + UI.money(b.available_balance, a.currency) + '</span></div>';
    });

    // BTC balance row
    let btcRow = '';
    if (state.btcBalance > 0 || state.btcUsdRate) {
      btcRow = '<div class="breakdown-row">' +
        '<span class="acct-label" style="color:#f7931a"><img src="assets/logos/bitcoin-logo-svgrepo-com.svg" alt="Bitcoin" style="width:20px;height:20px;vertical-align:middle;margin-right:4px"> Bitcoin (BTC)</span>' +
        '<span class="acct-bal">' + state.btcBalance.toFixed(8) + ' BTC &asymp; ' + UI.money(btcUsdValue(), 'USD') + '</span></div>';
    }

    el.innerHTML =
      '<div class="balance-cards">' +
        '<div class="balance-card primary-balance cc-balance">' +
          (primary ? UI.renderCardFace(primary, { holder: holder }) : '') +
          '<div class="bc-bottom">' +
            '<div class="bc-label">Total Balance</div>' +
            '<div class="bc-amount">' + UI.money(totalBalanceConverted() + btcUsdValue(), 'USD') + '</div>' +
            '<div class="bc-sub">' + state.accounts.length + ' account(s) + Bitcoin</div>' +
          '</div>' +
        '</div>' +
        '<div class="balance-card"><div class="bc-label">Available Balance</div><div class="bc-amount">' + UI.money(availableBalanceConverted(), 'USD') + '</div><div class="bc-sub">Ready to spend</div></div>' +
        '<div class="balance-card"><div class="bc-label">Savings</div><div class="bc-amount">' + UI.money(savingsBalance(), 'USD') + '</div><div class="bc-sub">' + savingsCount + ' savings account(s)</div></div>' +
        '<div class="balance-card"><div class="bc-label">Current</div><div class="bc-amount">' + UI.money(checkingBalance(), 'USD') + '</div><div class="bc-sub">' + checkingCount + ' current account(s)</div></div>' +
      '</div>' +
      (breakdownRows || btcRow ? '<div class="balance-breakdown">' + breakdownRows + btcRow + '</div>' : '');
  }

  function renderPendingVerifications() {
    const card = document.getElementById('pending-verification-card');
    const el = document.getElementById('pending-verifications');
    Promise.all([
      SB.from('international_transfers').select('*').eq('user_id', user.id).eq('status', 'awaiting_admin_verification').order('created_at', { ascending: false }).limit(10),
      SB.from('crypto_withdrawals').select('*').eq('user_id', user.id).eq('status', 'awaiting_admin_verification').order('created_at', { ascending: false }).limit(10),
      SB.from('transactions').select('*').eq('user_id', user.id).eq('status', 'awaiting_admin_verification').eq('type', 'local_transfer').order('created_at', { ascending: false }).limit(10)
    ]).then(function (res) {
      const intl = res[0].error ? [] : (res[0].data || []);
      const crypto = res[1].error ? [] : (res[1].data || []);
      const local = res[2].error ? [] : (res[2].data || []);
      const rows = [
        intl.map(function (t) {
          return { type: 'international_transfer', id: t.id, reference: t.reference, title: 'International transfer to ' + UI.escapeHtml(t.recipient_name || 'recipient'), sub: UI.money(t.amount, t.currency) + ' \u00b7 ' + UI.timeAgo(t.created_at), icon: 'intlTransfer' };
        }),
        crypto.map(function (t) {
          return { type: 'crypto_withdrawal', id: t.id, reference: t.reference, title: 'Crypto withdrawal \u00b7 ' + UI.escapeHtml(t.asset) + ' (' + UI.escapeHtml(t.network) + ')', sub: UI.money(t.amount_fiat, t.currency) + ' \u00b7 ' + UI.timeAgo(t.created_at), icon: 'transactions' };
        }),
        local.map(function (t) {
          return { type: 'local_transfer', id: t.id, reference: t.reference, title: 'Local transfer to ' + UI.escapeHtml(t.recipient || 'recipient'), sub: UI.money(t.amount, t.currency) + ' \u00b7 ' + UI.timeAgo(t.created_at), icon: 'localTransfer' };
        })
      ].reduce(function (a, b) { return a.concat(b); }, []);

      if (!rows.length) {
        if (card) card.classList.add('hide');
        return;
      }
      if (card) card.classList.remove('hide');
      el.innerHTML = '<div class="tx-list">' + rows.map(function (t) {
        return '<div class="tx-item">' +
          '<div class="tx-icon">' + icon(t.icon) + '</div>' +
          '<div class="tx-info" style="min-width:0"><div class="tx-title">' + t.title + '</div>' +
          '<div class="tx-sub">' + t.sub + ' \u00b7 ' + UI.badge('awaiting_admin_verification') + '</div></div>' +
          '<button class="btn btn-primary btn-sm" data-resume="' + t.type + ':' + t.id + '">Enter Code</button>' +
        '</div>';
      }).join('') + '</div>';

      el.querySelectorAll('[data-resume]').forEach(function (b) {
        b.addEventListener('click', function () {
          const parts = b.getAttribute('data-resume').split(':');
          const row = rows.find(function (r) { return r.type === parts[0] && String(r.id) === parts[1]; });
          const titles = { international_transfer: 'International Transfer', crypto_withdrawal: 'Crypto Withdrawal', local_transfer: 'Local Transfer' };
          UI.transferFlow({
            title: titles[parts[0]] || 'Transfer',
            subtitle: row ? row.title : '',
            transferType: parts[0],
            transferId: parts[1],
            onVerified: function () { renderPendingVerifications(); }
          });
        });
      });
    }).catch(function (e) {
      console.warn('Pending verifications could not be loaded.', e);
    });
  }

  const TX_ICONS = { deposit: 'deposits', local_transfer: 'localTransfer', international_transfer: 'intlTransfer', currency_swap: 'swap', loan_disbursement: 'loans', loan_repayment: 'loans', withdrawal: 'transactions', fee: 'percent', interest: 'trendingUp', reversal: 'arrowDown', adjustment: 'edit' };

  function txIcon(type) {
    return icon(TX_ICONS[type] || 'transactions');
  }

  function renderTransactions(txs) {
    const el = document.getElementById('recent-tx');
    if (!txs.length) { el.innerHTML = UI.emptyState('No transactions yet'); return; }
    el.innerHTML = '<div class="tx-list">' + txs.map(function (t) {
      const amount = (t.direction === 'credit' ? '+' : '-') + UI.money(t.amount, t.currency);
      const cls = t.direction === 'credit' ? 'text-success' : '';
      return '<div class="tx-item">' +
        '<div class="tx-icon">' + txIcon(t.type) + '</div>' +
        '<div class="tx-info"><div class="tx-title">' + UI.escapeHtml(t.recipient || t.sender || UI.typeLabel(t.type)) + '</div>' +
        '<div class="tx-sub">' + UI.typeLabel(t.type) + ' \u00b7 ' + UI.timeAgo(t.created_at) + ' \u00b7 ' + UI.badge(t.status) + '</div></div>' +
        '<div class="tx-amount ' + cls + '">' + amount + '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function renderCards() {
    const el = document.getElementById('card-showcase');
    if (!state.cards.length) {
      el.innerHTML = '<div class="empty-state" style="padding:24px"><p>No cards issued yet.</p><a href="cards.html" class="btn btn-primary btn-sm mt-2">Manage Cards</a></div>';
      return;
    }
    const c = state.cards[0];
    el.innerHTML =
      UI.renderCardFace(c) +
      '<div class="flex-between mt-2"><span class="badge ' + (c.status === 'active' ? 'badge-success' : c.status === 'frozen' ? 'badge-frozen' : 'badge-failed') + '">' + UI.escapeHtml(c.status) + '</span><span class="text-sm text-muted">Limit ' + UI.money(c.spending_limit, 'USD') + '</span></div>' +
      '<div class="card-actions mt-2"><a href="cards.html" class="btn btn-outline btn-sm w-100">Manage Card</a></div>';
  }

  function renderLoans() {
    const el = document.getElementById('loan-summary');
    const active = state.loans.filter(function (l) { return l.status === 'active'; });
    const pending = state.loans.filter(function (l) { return ['pending', 'under_review'].includes(l.status); });
    if (!active.length && !pending.length) {
      el.innerHTML = '<div class="empty-state" style="padding:20px"><p class="text-sm">You have no active loans.</p><a href="loans.html" class="btn btn-primary btn-sm mt-2">Explore Loans</a></div>';
      return;
    }
    let html = '';
    active.forEach(function (l) {
      const reps = state.repayments.filter(function (r) { return r.loan_application_id === l.id; });
      const paid = reps.filter(function (r) { return r.status === 'paid'; }).length;
      const total = Math.max(reps.length, 1);
      const pct = Math.min(100, (paid / total) * 100);
      html += '<div class="flex-between mb-1"><span class="font-bold">' + UI.escapeHtml(l.reference) + '</span><span class="badge badge-success">Active</span></div>' +
        '<div class="text-sm text-muted mb-1">Outstanding: <strong class="text-primary">' + UI.money(Number(l.monthly_payment) * 1, l.currency) + '</strong> monthly</div>' +
        '<div class="progress"><div style="width:' + pct + '%"></div></div>' +
        '<div class="progress-label"><span>' + paid + '/' + (reps.length || '\u2014') + ' paid</span><span>' + Math.round(pct) + '%</span></div>';
    });
    if (pending.length) {
      html += '<div class="flex-between mt-3"><span class="text-sm font-bold">Pending applications</span><span class="badge badge-warning">' + pending.length + '</span></div>';
    }
    el.innerHTML = html;
  }

  function renderNotifications(list) {
    const el = document.getElementById('notif-summary');
    if (!list.length) { el.innerHTML = UI.emptyState('No notifications'); return; }
    const icons = { transfer: 'localTransfer', deposit: 'deposits', loan: 'loans', card: 'cards', swap: 'swap', security: 'shield', account: 'wallet', system: 'bell' };
    el.innerHTML = '<div class="notif-list">' + list.map(function (n) {
      return '<div class="notif-item ' + (n.is_read ? '' : 'unread') + '">' +
        '<div class="notif-icon">' + icon(icons[n.type] || 'bell') + '</div>' +
        '<div style="min-width:0"><div class="notif-title">' + UI.escapeHtml(n.title) + '</div>' +
        '<div class="notif-msg">' + UI.escapeHtml(n.message) + '</div><div class="notif-time">' + UI.timeAgo(n.created_at) + '</div></div></div>';
    }).join('') + '</div>';
  }

  function renderChart(txs) {
    const now = new Date();
    const labels = [], income = [], spend = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      labels.push(d.toLocaleDateString('en-US', { month: 'short' }));
      const inc = txs.filter(function (t) {
        const td = new Date(t.created_at);
        return t.direction === 'credit' && td.getMonth() === d.getMonth() && td.getFullYear() === d.getFullYear();
      }).reduce(function (s, t) { return s + Number(t.amount); }, 0);
      const sp = txs.filter(function (t) {
        const td = new Date(t.created_at);
        return t.direction === 'debit' && td.getMonth() === d.getMonth() && td.getFullYear() === d.getFullYear();
      }).reduce(function (s, t) { return s + Number(t.amount); }, 0);
      income.push(inc); spend.push(sp);
    }

    const canvas = document.getElementById('flow-chart');
    if (canvas) Charts.lineChart(canvas, labels, [
      { data: income, color: '#2f7de1' },
      { data: spend, color: '#1a9e5a' }
    ]);
  }

  try {
    await loadData();
  } catch (e) {
    console.error(e);
    UI.toast('Failed to load your dashboard: ' + UI.apiErrorMessage(e), 'error');
  }
  PageLoader.hide();
})();

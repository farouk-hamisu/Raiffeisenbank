// Raiffeisen Bank — Customer dashboard module (simplified)
(async function () {
  const profile = await AppShell.init({ title: 'Dashboard' });
  if (!profile) return;

  const user = Auth.user;
  const state = { accounts: [], balances: {}, cards: [], btcUsdRate: null, btcBalance: 0 };

  // ---------------- Load data ----------------
  async function loadData() {
    const [accountsRes, txRes, cardsRes] = await Promise.all([
      SB.from('accounts').select('*').eq('user_id', user.id).order('created_at'),
      SB.from('transactions').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(5),
      SB.from('cards').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(1)
    ]);

    state.accounts = accountsRes.error ? [] : (accountsRes.data || []);
    state.cards = cardsRes.error ? [] : (cardsRes.data || []);

    if (accountsRes.error) UI.toast('Could not load accounts: ' + UI.apiErrorMessage(accountsRes.error), 'error');
    if (txRes.error) UI.toast('Could not load transactions: ' + UI.apiErrorMessage(txRes.error), 'error');
    if (cardsRes.error) UI.toast('Could not load cards: ' + UI.apiErrorMessage(cardsRes.error), 'error');

    let balData = [];
    if (state.accounts.length) {
      const balRes = await SB.from('account_balances').select('*').in('account_id', state.accounts.map(function (a) { return a.id; }));
      if (!balRes.error) balData = balRes.data || [];
      else UI.toast('Could not load balances: ' + UI.apiErrorMessage(balRes.error), 'error');
    }
    balData.forEach(function (b) { state.balances[b.account_id] = b; });

    await fetchBtcPrice();
    loadBtcBalance();

    renderHeader();
    renderBalance();
    renderCardPreview();
    renderTransactions(txRes.error ? [] : (txRes.data || []));
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

  // ---------------- BTC balance ----------------
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

  // ---------------- Calculations ----------------
  function totalBalance() {
    let t = 0;
    state.accounts.forEach(function (a) {
      const b = state.balances[a.id];
      if (!b) return;
      t += Number(b.ledger_balance) || 0;
    });
    return t + btcUsdValue();
  }

  function btcUsdValue() {
    return state.btcBalance * (state.btcUsdRate || 0);
  }

  // ---------------- Rendering ----------------
  function renderHeader() {
    const avatarEl = document.getElementById('dash-avatar');
    const greetingEl = document.getElementById('dash-greeting-text');
    const nameEl = document.getElementById('dash-user-name');

    const firstName = (profile.full_name || '').split(' ')[0] || 'there';
    const initials = firstName.charAt(0).toUpperCase();
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    // Show profile picture if available, otherwise show initials
    if (profile.avatar_url) {
      avatarEl.innerHTML = '<img src="' + UI.escapeHtml(profile.avatar_url) + '" alt="Profile" style="width:100%;height:100%;border-radius:50%;object-fit:cover">';
    } else {
      avatarEl.textContent = initials;
    }
    
    nameEl.textContent = firstName;
    greetingEl.textContent = greeting;
  }

  function renderBalance() {
    const balanceEl = document.getElementById('dash-total-balance');
    const changeEl = document.getElementById('dash-balance-change');

    balanceEl.textContent = UI.money(totalBalance(), 'USD');

    // Calculate weekly change from recent transactions
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    let weeklyChange = 0;

    state.accounts.forEach(function (a) {
      const b = state.balances[a.id];
      if (!b) return;
      weeklyChange += Number(b.ledger_balance) || 0;
    });

    const changeText = weeklyChange >= 0
      ? '+' + UI.money(weeklyChange, 'USD') + ' this week'
      : '-' + UI.money(Math.abs(weeklyChange), 'USD') + ' this week';

    const changeClass = weeklyChange >= 0 ? 'dash-change-positive' : 'dash-change-negative';
    changeEl.innerHTML = '<span class="' + changeClass + '">' + changeText + '</span>';
  }

  function renderCardPreview() {
    const el = document.getElementById('dash-card-preview');
    const card = state.cards[0];

    if (!card) {
      el.innerHTML = '<div class="dash-card-bank">Raiffeisen Bank</div><div class="dash-card-number">No card issued</div><div class="dash-card-status" style="color:var(--muted);background:var(--surface-2)">Inactive</div>';
      return;
    }

    const lastFour = card.card_number ? card.card_number.slice(-4) : '••••';
    const statusClass = card.status === 'active' ? 'success' : card.status === 'frozen' ? 'warning' : 'danger';

    el.innerHTML = '<div class="dash-card-bank">Raiffeisen Bank</div><div class="dash-card-number">•••• •••• •••• ' + lastFour + '</div><div class="dash-card-status badge-' + statusClass + '">' + UI.escapeHtml(card.status) + '</div>';
  }

  function renderTransactions(txs) {
    const el = document.getElementById('dash-transactions');
    if (!txs.length) {
      el.innerHTML = '<div class="dash-empty">No transactions yet</div>';
      return;
    }

    const TX_ICONS = {
      deposit: 'deposits',
      local_transfer: 'localTransfer',
      international_transfer: 'intlTransfer',
      currency_swap: 'swap',
      loan_disbursement: 'loans',
      loan_repayment: 'loans',
      withdrawal: 'transactions',
      fee: 'percent',
      interest: 'trendingUp',
      reversal: 'arrowDown',
      adjustment: 'edit'
    };

    el.innerHTML = '<div class="dash-tx-list">' + txs.map(function (t) {
      const amount = (t.direction === 'credit' ? '+' : '-') + UI.money(t.amount, t.currency);
      const amountClass = t.direction === 'credit' ? 'credit' : 'debit';
      const iconName = TX_ICONS[t.type] || 'transactions';
      const title = UI.escapeHtml(t.recipient || t.sender || UI.typeLabel(t.type));
      const sub = UI.typeLabel(t.type) + ' · ' + UI.timeAgo(t.created_at);

      return '<div class="dash-tx-item">' +
        '<div class="dash-tx-icon">' + icon(iconName) + '</div>' +
        '<div class="dash-tx-info"><div class="dash-tx-title">' + title + '</div>' +
        '<div class="dash-tx-sub">' + sub + '</div></div>' +
        '<div class="dash-tx-amount ' + amountClass + '">' + amount + '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  try {
    await loadData();
  } catch (e) {
    console.error(e);
    UI.toast('Failed to load your dashboard: ' + UI.apiErrorMessage(e), 'error');
  }
  PageLoader.hide();
})();
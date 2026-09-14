// marvintlc — App shell: sidebar, header, notifications, active states, mobile nav.

const NAV_ITEMS = [
  { label: 'Dashboard', icon: 'dashboard', href: 'dashboard.html' },
  { label: 'Transactions', icon: 'transactions', href: 'transactions.html' },
  { label: 'Cards', icon: 'cards', href: 'cards.html' },
  { label: 'Local Transfer', icon: 'localTransfer', href: 'local-transfer.html' },
  { label: 'International Transfer', icon: 'intlTransfer', href: 'international-transfer.html' },
  { label: 'Transfers', icon: 'send', href: 'transfers.html' },
  { label: 'Crypto Withdrawal', icon: 'globe', href: 'crypto-withdrawal.html' },
  { label: 'Deposits', icon: 'deposits', href: 'deposits.html' },
  { label: 'Bitcoin', icon: 'bitcoin', href: 'bitcoin.html' },
  { label: 'Loans', icon: 'loans', href: 'loans.html' }
];

const AppShell = {
  profile: null,
  unread: 0,

  refreshAvatar() {
    const el = document.getElementById('hdr-avatar');
    if (!el || !this.profile) return;
    const wrap = document.createElement('span');
    wrap.innerHTML = UI.avatar(this.profile, { id: 'hdr-avatar' });
    el.replaceWith(wrap.firstChild);
  },

  bottomNavItems() {
    return [
      { label: 'Dashboard', icon: 'dashboard', href: 'dashboard.html' },
      { label: 'Loans', icon: 'loans', href: 'loans.html' },
      { label: 'Cards', icon: 'cards', href: 'cards.html' },
      { label: 'Profile', icon: 'profile', href: 'profile.html' }
    ];
  },

  bottomNavHTML() {
    const current = window.location.pathname.split('/').pop();
    const blue = {};
    const items = this.bottomNavItems().map(function (it) {
      const active = current === it.href ? 'active' : '';
      const cls = blue[it.href] ? 'is-blue' : '';
      return '<a href="' + it.href + '" class="' + active + ' ' + cls + '">' + icon(it.icon) + '<span>' + it.label + '</span></a>';
    }).join('');
    return '<nav class="bottom-nav" id="bottom-nav" aria-label="Quick navigation">' + items + '</nav>';
  },

  async init(options) {
    options = options || {};
    PageLoader.show();
    const user = await Auth.init();
    if (!user) {
      window.location.href = 'login.html';
      return null;
    }
    try {
      this.profile = await Auth.fetchProfile();
    } catch (e) {
      console.error('Failed to load profile', e);
      this.profile = { full_name: user.email || 'User', email: user.email || '' };
    }

    // Security PIN guard: existing accounts without a PIN must set one first.
    try {
      const hasPin = await UI.rpc('customer_has_pin', {});
      if (hasPin === false) {
        window.location.href = 'setup-pin.html';
        return null;
      }
    } catch (e) {
      console.error('Failed to check security PIN', e);
    }

    const pageRoot = document.getElementById('page-root');

    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.innerHTML = this.sidebarHTML() + '<div class="app-main">' + this.headerHTML() + '<div class="app-content" id="app-content"></div></div><div class="sidebar-backdrop" id="sidebar-backdrop"></div>' + this.bottomNavHTML();

    document.body.innerHTML = '';
    document.body.appendChild(shell);
    PageLoader.show();

    // move page content into app-content
    const contentEl = document.getElementById('app-content');
    if (pageRoot) contentEl.appendChild(pageRoot);
    else if (options.content) contentEl.innerHTML = options.content;

    this.bindEvents();

    return this.profile;
  },

  sidebarHTML() {
    const items = NAV_ITEMS.map(function (it) {
      const active = window.location.pathname.split('/').pop() === it.href ? 'active' : '';
      return '<a href="' + it.href + '" class="' + active + '">' + icon(it.icon) + '<span>' + it.label + '</span></a>';
    }).join('');
    return '<aside class="sidebar" id="sidebar">' +
      '<div class="brand"><img src="' + window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + 'assets/logos/logo.svg" alt="marvintlc"></div>' +
      '<nav class="side-nav">' + items +
      '<div class="nav-label">Account</div>' +
      '<a href="profile.html"><span class="icon">' + ICONS.profile + '</span><span>Profile</span></a>' +
      '<a href="settings.html"><span class="icon">' + ICONS.settings + '</span><span>Settings</span></a>' +
      '<a href="#" id="nav-logout"><span class="icon">' + ICONS.logout + '</span><span>Log Out</span></a>' +
      '</nav>' +
      '<div class="sidebar-foot">marvintlc<br>&copy; ' + new Date().getFullYear() + ' All rights reserved.</div>' +
      '</aside>';
  },

  headerHTML() {
    return '<header class="app-header">' +
      '<button class="menu-btn" id="menu-btn" aria-label="Menu">' + icon('menu') + '</button>' +
      '<div class="spacer"></div>' +
      '<a href="help.html" class="hdr-help-btn" aria-label="Help">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>' +
      '</a>' +
      '</header>';
  },

  bindEvents() {
    const menuBtn = document.getElementById('menu-btn');
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (menuBtn) menuBtn.addEventListener('click', function () {
      sidebar.classList.toggle('open');
      backdrop.classList.toggle('open');
    });
    if (backdrop) backdrop.addEventListener('click', function () {
      sidebar.classList.remove('open');
      backdrop.classList.remove('open');
    });

    // header logout
    const navLogout = document.getElementById('nav-logout');
    if (navLogout) navLogout.addEventListener('click', function (e) { e.preventDefault(); Auth.logout(); });
  },

};
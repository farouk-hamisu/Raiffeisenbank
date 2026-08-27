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
  { label: 'Currency Swap', icon: 'swap', href: 'currency-swap.html' },
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
      { label: 'Transactions', icon: 'transactions', href: 'transactions.html' },
      { label: 'Cards', icon: 'cards', href: 'cards.html' },
      { label: 'Transfer', icon: 'localTransfer', href: 'local-transfer.html' },
      { label: 'Loans', icon: 'loans', href: 'loans.html' }
    ];
  },

  bottomNavHTML() {
    const current = window.location.pathname.split('/').pop();
    const blue = { 'cards.html': true };
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
    this.loadNotifications();

    // Keep title in sync
    if (options.title) {
      const t = document.getElementById('hdr-title');
      if (t) t.textContent = options.title;
    }
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
    const name = (this.profile && this.profile.full_name) || 'User';
    const email = (this.profile && this.profile.email) || '';
    return '<header class="app-header">' +
      '<button class="menu-btn" id="menu-btn" aria-label="Menu">' + icon('menu') + '</button>' +
      '<div class="hdr-title" id="hdr-title">Overview</div>' +
      '<div class="hdr-search"><span class="icon">' + ICONS.search + '</span><input type="search" class="input" id="hdr-search" placeholder="Search transactions..."></div>' +
      '<div class="spacer"></div>' +
      '<button class="notif-bell" id="notif-bell" aria-label="Notifications">' + icon('bell') + '<span class="dot" id="notif-dot" style="display:none"></span></button>' +
      '<div class="dropdown" id="user-menu">' +
        '<div class="user-chip">' + UI.avatar(this.profile, { id: 'hdr-avatar' }) + '<span class="user-chip-name"><strong style="font-size:13px">' + UI.escapeHtml(name) + '</strong><br><small class="text-muted text-xs">' + UI.escapeHtml(email) + '</small></span></div>' +
        '<div class="dropdown-menu">' +
          '<a href="profile.html">' + icon('profile') + ' My Profile</a>' +
          '<a href="settings.html">' + icon('settings') + ' Settings</a>' +
          '<div class="dropdown-divider"></div>' +
          '<button class="danger-item" id="hdr-logout">' + icon('logout') + ' Log Out</button>' +
        '</div>' +
      '</div>' +
      '<div class="notif-panel" id="notif-panel"><div class="np-head">Notifications <a href="notifications.html" class="text-sm">View all</a></div><div id="notif-list" style="min-height:80px"><div class="loading-block"><div class="spinner spinner-sm"></div></div></div><div class="np-foot"><a href="notifications.html" class="text-sm">Open Notification Center</a></div></div>' +
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

    // user menu dropdown
    const um = document.getElementById('user-menu');
    document.getElementById('user-menu').addEventListener('click', function (e) {
      e.stopPropagation();
      this.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (um && !um.contains(e.target)) um.classList.remove('open');
    });

    // header logout
    const hdrLogout = document.getElementById('hdr-logout');
    if (hdrLogout) hdrLogout.addEventListener('click', function () { Auth.logout(); });
    const navLogout = document.getElementById('nav-logout');
    if (navLogout) navLogout.addEventListener('click', function (e) { e.preventDefault(); Auth.logout(); });

    // notifications
    const bell = document.getElementById('notif-bell');
    const panel = document.getElementById('notif-panel');
    if (bell) bell.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (panel && !panel.contains(e.target) && e.target !== bell) panel.classList.remove('open');
    });

    // header search -> transactions page
    const search = document.getElementById('hdr-search');
    if (search) search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && search.value.trim()) {
        window.location.href = 'transactions.html?q=' + encodeURIComponent(search.value.trim());
      }
    });
  },

  async loadNotifications() {
    try {
      const { data, error } = await SB.from('notifications')
        .select('id,title,message,type,is_read,created_at')
        .or('user_id.eq.' + Auth.user.id + ',is_global.eq.true')
        .order('created_at', { ascending: false })
        .limit(8);
      if (error) throw error;
      const unread = (await SB.from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', Auth.user.id)
        .eq('is_read', false)).count || 0;
      this.unread = unread;
      const dot = document.getElementById('notif-dot');
      if (dot) dot.style.display = unread > 0 ? 'block' : 'none';

      const listEl = document.getElementById('notif-list');
      if (!listEl) return;
      if (!data || !data.length) {
        listEl.innerHTML = UI.emptyState('You have no notifications');
        return;
      }
      const icons = { transfer: 'localTransfer', deposit: 'deposits', loan: 'loans', card: 'cards', swap: 'swap', security: 'shield', account: 'wallet', system: 'bell' };
      listEl.innerHTML = '<div class="notif-list">' + data.map(function (n) {
        return '<div class="notif-item ' + (n.is_read ? '' : 'unread') + '" data-id="' + n.id + '">' +
          '<div class="notif-icon">' + icon(icons[n.type] || 'bell') + '</div>' +
          '<div style="min-width:0;flex:1"><div class="notif-title">' + UI.escapeHtml(n.title) + '</div>' +
          '<div class="notif-msg">' + UI.escapeHtml(n.message) + '</div>' +
          '<div class="notif-time">' + UI.timeAgo(n.created_at) + '</div></div></div>';
      }).join('') + '</div>';
      listEl.querySelectorAll('.notif-item.unread').forEach(function (item) {
        item.addEventListener('click', function () {
          const id = item.getAttribute('data-id');
          SB.from('notifications').update({ is_read: true }).eq('id', id).then(function () {
            item.classList.remove('unread');
          });
        });
      });
    } catch (e) {
      const listEl = document.getElementById('notif-list');
      if (listEl) listEl.innerHTML = UI.emptyState('Notifications unavailable');
    }
  }
};
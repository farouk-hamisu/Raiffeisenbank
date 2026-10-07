// Raiffeisen Bank — Admin authentication & API helpers
// Admin sessions use a server-issued token stored in localStorage.
// All data access goes through SECURITY DEFINER RPCs that validate the token.

const AdminAuth = {
  token: localStorage.getItem('nb_admin_token') || null,
  admin: null,

  async login(email, password) {
    const { data, error } = await SB.rpc('admin_login', { p_email: email, p_password: password });
    if (error) throw new Error((error.message || '').split('\n')[0].trim());
    this.token = data.token;
    this.admin = data.admin;
    localStorage.setItem('nb_admin_token', this.token);
    return data;
  },

  async validate() {
    if (!this.token) return null;
    try {
      const { data, error } = await SB.rpc('admin_validate', { p_token: this.token });
      if (error) return null;
      this.admin = data;
      return data;
    } catch (e) {
      return null;
    }
  },

  async logout() {
    if (this.token) {
      try { await SB.rpc('admin_logout', { p_token: this.token }); } catch (e) { /* ignore */ }
    }
    this.token = null;
    this.admin = null;
    localStorage.removeItem('nb_admin_token');
    window.location.href = 'login.html';
  },

  async requireAuth() {
    PageLoader.show();
    const a = await this.validate();
    if (!a) {
      window.location.href = 'login.html';
      return null;
    }
    return a;
  },

  can(perm) {
    if (!this.admin) return false;
    if (this.admin.role === 'super_admin') return true;
    return (this.admin.permissions || []).includes(perm);
  }
};

// RPC helper with token injection + friendly errors
async function adminApi(name, params) {
  const token = AdminAuth.token;
  const p = Object.assign({}, params || {});
  // functions expect p_token
  if (!('p_token' in p)) p.p_token = token;
  const { data, error } = await SB.rpc(name, p);
  if (error) {
    const code = (error.message || '').split('\n')[0].trim();
    throw new Error(code);
  }
  return data;
}

// Admin shell (sidebar + header)
const ADMIN_NAV = [
  { label: 'Dashboard', icon: 'dashboard', href: 'dashboard.html' },
  { label: 'Users', icon: 'users', href: 'users.html' },
  { label: 'Accounts', icon: 'wallet', href: 'accounts.html' },
  { label: 'Transactions', icon: 'transactions', href: 'transactions.html' },
  { label: 'Transfers', icon: 'send', href: 'transfers.html' },
  { label: 'Verifications', icon: 'shield', href: 'verifications.html' },
  { label: 'Deposits', icon: 'deposits', href: 'deposits.html' },
  { label: 'Cards', icon: 'cards', href: 'cards.html' },
  { label: 'Currencies', icon: 'swap', href: 'currencies.html' },
  { label: 'Loans', icon: 'loans', href: 'loans.html' },
  { label: 'Notifications', icon: 'notifications', href: 'notifications.html' },
  { label: 'Audit Logs', icon: 'list', href: 'audit-logs.html' },
  { label: 'Settings', icon: 'settings', href: 'settings.html' }
];

function renderAdminShell(title) {
  const current = window.location.pathname.split('/').pop();
  const items = ADMIN_NAV.map(function (it) {
    const active = current === it.href ? 'active' : '';
    return '<a href="' + it.href + '" class="' + active + '">' + icon(it.icon) + '<span>' + it.label + '</span></a>';
  }).join('');

  const bottomItems = ADMIN_NAV.slice(0, 5).map(function (it) {
    const active = current === it.href ? 'active' : '';
    const cls = (it.href === 'accounts.html') ? 'is-blue' : '';
    return '<a href="' + it.href + '" class="' + active + ' ' + cls + '">' + icon(it.icon) + '<span>' + it.label + '</span></a>';
  }).join('');

  const shell = document.createElement('div');
  shell.className = 'app-shell';
  shell.innerHTML =
    '<aside class="sidebar admin-sidebar" id="admin-sidebar">' +
      '<div class="brand"><img src="../assets/logos/logo-light.svg" alt="Raiffeisen Bank"></div>' +
      '<div class="side-nav" style="padding:10px 12px"><div class="nav-label" style="color:#8295b8">Admin Portal</div>' +
        items +
        '<div class="nav-label">Account</div>' +
        '<a href="#" id="admin-logout"><span class="icon">' + ICONS.logout + '</span><span>Log Out</span></a>' +
      '</div>' +
      '<div class="sidebar-foot">Signed in as <strong style="color:#cdd8ee" id="admin-name">' + UI.escapeHtml(AdminAuth.admin ? AdminAuth.admin.full_name : 'Admin') + '</strong><br>Role: ' + UI.escapeHtml(AdminAuth.admin ? AdminAuth.admin.role : '') + '</div>' +
    '</aside>' +
    '<div class="app-main">' +
      '<header class="app-header">' +
        '<button class="menu-btn" id="admin-menu-btn">' + icon('menu') + '</button>' +
        '<div class="hdr-title" id="admin-title">' + UI.escapeHtml(title || 'Admin') + '</div>' +
        '<div class="spacer"></div>' +
        '<span class="badge ' + (AdminAuth.admin && AdminAuth.admin.role === 'super_admin' ? 'badge-gold' : 'badge-info') + '">' + UI.escapeHtml(AdminAuth.admin ? AdminAuth.admin.role : '') + '</span>' +
      '</header>' +
      '<div class="app-content" id="admin-content"></div>' +
    '</div>' +
    '<div class="sidebar-backdrop" id="admin-backdrop"></div>' +
    '<nav class="bottom-nav" id="admin-bottom-nav" aria-label="Quick navigation">' + bottomItems + '</nav>';

  const pageRoot = document.getElementById('page-root');
  document.body.innerHTML = '';
  document.body.appendChild(shell);
  PageLoader.show();

  if (pageRoot) document.getElementById('admin-content').appendChild(pageRoot);

  document.getElementById('admin-menu-btn').addEventListener('click', function () {
    document.getElementById('admin-sidebar').classList.toggle('open');
    document.getElementById('admin-backdrop').classList.toggle('open');
  });
  document.getElementById('admin-backdrop').addEventListener('click', function () {
    document.getElementById('admin-sidebar').classList.remove('open');
    document.getElementById('admin-backdrop').classList.remove('open');
  });
  document.getElementById('admin-logout').addEventListener('click', function (e) {
    e.preventDefault();
    AdminAuth.logout();
  });
}
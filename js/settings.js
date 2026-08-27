// marvintlc — Settings module
(async function () {
  const profile = await AppShell.init({ title: 'Settings' });
  if (!profile) return;
  const user = Auth.user;

  const PREFS = [
    ['transfers', 'Transfer activity'],
    ['deposits', 'Deposits'],
    ['loans', 'Loans'],
    ['cards', 'Card activity'],
    ['swaps', 'Currency swaps'],
    ['security', 'Security alerts'],
    ['marketing', 'Product updates']
  ];

  document.getElementById('sec-email').textContent = user.email || profile.email || '—';
  document.getElementById('sec-uid').textContent = user.id || '—';

  // last sign in
  SB.auth.getSession().then(function (res) {
    if (res.data.session) {
      document.getElementById('sec-last').textContent = UI.formatDateTime(res.data.session.user.last_sign_in_at || res.data.session.expires_at);
    }
  });

  function renderPrefs() {
    const el = document.getElementById('pref-list');
    const prefs = profile.notification_prefs || {};
    el.innerHTML = PREFS.map(function (pair) {
      const key = pair[0], label = pair[1];
      const checked = prefs[key] !== false;
      return '<div class="flex-between mb-2"><span class="text-sm font-bold">' + label + '</span>' +
        '<label class="switch"><input type="checkbox" data-pref="' + key + '" ' + (checked ? 'checked' : '') + '><span class="track"></span></label></div>';
    }).join('');
  }

  document.getElementById('pref-save').addEventListener('click', async function () {
    const prefs = {};
    document.querySelectorAll('[data-pref]').forEach(function (cb) {
      prefs[cb.getAttribute('data-pref')] = cb.checked;
    });
    try {
      await Auth.updateProfile({ notification_prefs: prefs });
      UI.toast('Notification preferences saved.', 'success');
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  });

  document.getElementById('pw-save').addEventListener('click', async function () {
    const err = document.getElementById('pw-error');
    err.textContent = '';
    const btn = this;
    const current = document.getElementById('pw-current').value;
    const next = document.getElementById('pw-new').value;
    const confirm = document.getElementById('pw-confirm').value;
    if (!current || !next) { err.textContent = 'Enter your current and new password.'; return; }
    if (next.length < 8) { err.textContent = 'New password must be at least 8 characters.'; return; }
    if (next !== confirm) { err.textContent = 'New passwords do not match.'; return; }

    // verify current password
    btn.disabled = true;
    btn.textContent = 'Updating...';
    try {
      const { error: signErr } = await SB.auth.signInWithPassword({ email: user.email, password: current });
      if (signErr) { err.textContent = 'Current password is incorrect.'; btn.disabled = false; btn.textContent = 'Update Password'; return; }
      await Auth.updatePassword(next);
      UI.toast('Password updated successfully.', 'success');
      ['pw-current', 'pw-new', 'pw-confirm'].forEach(function (id) { document.getElementById(id).value = ''; });
    } catch (e) {
      err.textContent = UI.apiErrorMessage(e);
    }
    btn.disabled = false;
    btn.textContent = 'Update Password';
  });

  document.querySelectorAll('.toggle-pw').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const input = document.getElementById(btn.getAttribute('data-target'));
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.textContent = input.type === 'password' ? '👁' : '🙈';
    });
  });

  document.getElementById('sec-signout').addEventListener('click', function () {
    UI.confirmDialog('Log out of all sessions?', function () { Auth.logout(); }, 'Log Out');
  });

  renderPrefs();
  PageLoader.hide();
})();
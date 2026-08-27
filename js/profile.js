// marvintlc — Profile module
(async function () {
  const profile = await AppShell.init({ title: 'Profile' });
  if (!profile) return;
  const user = Auth.user;

  const fields = ['full_name', 'phone', 'date_of_birth', 'address', 'city', 'country'];

  function populate() {
    document.getElementById('p-name').value = profile.full_name || '';
    document.getElementById('p-email').value = profile.email || user.email || '';
    document.getElementById('p-phone').value = profile.phone || '';
    document.getElementById('p-dob').value = profile.date_of_birth || '';
    document.getElementById('p-address').value = profile.address || '';
    document.getElementById('p-city').value = profile.city || '';
    document.getElementById('p-country').value = profile.country || '';
    document.getElementById('p-since').textContent = UI.formatDate(profile.created_at);
    document.getElementById('p-kyc').innerHTML = UI.badge(profile.kyc_status || 'pending');
    renderPfp();
  }

  function renderPfp() {
    const wrap = document.getElementById('pfp-wrap');
    if (wrap) wrap.innerHTML = UI.avatar(profile, { size: 'xl', id: 'pfp' });
    const removeBtn = document.getElementById('avatar-remove');
    if (removeBtn) removeBtn.style.display = profile.avatar_url ? '' : 'none';
  }

  async function loadAccounts() {
    const el = document.getElementById('p-accounts');
    try {
      const { data, error } = await SB.from('accounts').select('*').eq('user_id', user.id).order('created_at');
      if (error) throw error;
      if (!data.length) { el.innerHTML = UI.emptyState('No accounts'); return; }
      el.innerHTML = '<div class="tx-list">' + data.map(function (a) {
        return '<div class="tx-item"><div class="tx-icon">' + ICONS.wallet + '</div>' +
          '<div class="tx-info"><div class="tx-title">' + UI.escapeHtml(a.account_name) + ' (' + UI.escapeHtml(UI.typeLabel(a.account_type)) + ')</div>' +
          '<div class="tx-sub">' + UI.escapeHtml(a.account_number) + ' · ' + UI.escapeHtml(a.currency) + '</div></div>' +
          UI.badge(a.status) + '</div>';
      }).join('') + '</div>';
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load accounts');
    }
  }

  document.getElementById('p-save').addEventListener('click', async function () {
    const err = document.getElementById('p-error');
    err.textContent = '';
    const btn = this;
    const payload = {};
    fields.forEach(function (f) {
      const el = document.getElementById('p-' + f);
      if (el) payload[f] = el.value.trim() || null;
    });
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      await Auth.updateProfile(payload);
      UI.toast('Profile updated successfully.', 'success');
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
      err.textContent = UI.apiErrorMessage(e);
    }
  });

  // Avatar upload
  document.getElementById('avatar-input').addEventListener('change', async function () {
    const file = this.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { UI.toast('Image must be under 2MB.', 'warning'); return; }
    const ext = file.name.split('.').pop();
    const path = user.id + '/avatar.' + ext;
    UI.toast('Uploading...', 'info');
    try {
      const { error: upErr } = await SB.storage.from('avatars').upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      const { data: urlData } = SB.storage.from('avatars').getPublicUrl(path);
      const updated = await Auth.updateProfile({ avatar_url: urlData.publicUrl });
      profile.avatar_url = updated.avatar_url;
      profile.updated_at = updated.updated_at;
      renderPfp();
      AppShell.refreshAvatar();
      UI.toast('Photo updated.', 'success');
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  });

  // Avatar remove
  document.getElementById('avatar-remove').addEventListener('click', async function () {
    const btn = this;
    btn.disabled = true;
    try {
      const updated = await Auth.updateProfile({ avatar_url: null });
      profile.avatar_url = updated.avatar_url;
      profile.updated_at = updated.updated_at;
      renderPfp();
      AppShell.refreshAvatar();
      UI.toast('Photo removed.', 'success');
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  populate();
  await loadAccounts();
  PageLoader.hide();
})();
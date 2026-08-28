// marvintlc — Notifications module
(async function () {
  await AppShell.init({ title: 'Notifications' });
  const user = Auth.user;
  const PAGE = 12;
  let page = 1;
  let total = 0;

  const TYPE_ICONS = { transfer: 'localTransfer', deposit: 'deposits', loan: 'loans', card: 'cards', swap: 'swap', security: 'shield', account: 'wallet', system: 'bell' };

  async function load() {
    const el = document.getElementById('notif-main-list');
    el.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading notifications...</span></div>';
    try {
      let query = SB.from('notifications').select('*', { count: 'exact' })
        .or('user_id.eq.' + user.id + ',is_global.eq.true');
      const type = document.getElementById('f-type').value;
      const read = document.getElementById('f-read').value;
      if (type) query = query.eq('type', type);
      if (read === 'unread') query = query.eq('is_read', false);
      if (read === 'read') query = query.eq('is_read', true);
      const from = (page - 1) * PAGE;
      const { data, count, error } = await query.order('created_at', { ascending: false }).range(from, from + PAGE - 1);
      if (error) throw error;
      total = count || 0;
      render(data || []);
      renderPagination();
    } catch (e) {
      UI.toast(UI.apiErrorMessage(e), 'error');
      el.innerHTML = UI.emptyState('Could not load notifications');
    }
  }

  function render(list) {
    const el = document.getElementById('notif-main-list');
    if (!list.length) { el.innerHTML = UI.emptyState('No notifications'); return; }
    el.innerHTML = '<div class="notif-list">' + list.map(function (n) {
      return '<div class="notif-item ' + (n.is_read ? '' : 'unread') + '" data-id="' + n.id + '">' +
        '<div class="notif-icon">' + icon(TYPE_ICONS[n.type] || 'bell') + '</div>' +
        '<div style="min-width:0;flex:1">' +
          '<div class="flex-between"><div class="notif-title">' + UI.escapeHtml(n.title) + '</div>' +
          '<span class="badge badge-neutral text-xs">' + UI.escapeHtml(n.type) + '</span></div>' +
          '<div class="notif-msg">' + UI.escapeHtml(n.message) + '</div>' +
          '<div class="notif-time">' + UI.formatDateTime(n.created_at) + '</div>' +
        '</div>' +
        '<div class="row-actions">' +
          '<button class="row-action" data-mark="' + n.id + '" title="' + (n.is_read ? 'Mark unread' : 'Mark read') + '">' + ICONS.check + '</button>' +
          '<button class="row-action danger" data-del="' + n.id + '" title="Delete">' + ICONS.trash + '</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';

    el.querySelectorAll('[data-mark]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const id = btn.getAttribute('data-mark');
        const item = list.find(function (n) { return n.id === id; });
        const { error } = await SB.from('notifications').update({ is_read: !item.is_read }).eq('id', id).eq('user_id', user.id);
        if (error) { UI.toast(UI.apiErrorMessage(error), 'error'); return; }
        load();
      });
    });
    el.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const id = btn.getAttribute('data-del');
        UI.confirmDialog('Delete this notification?', async function () {
          const { error } = await SB.from('notifications').delete().eq('id', id).eq('user_id', user.id);
          if (error) { UI.toast(UI.apiErrorMessage(error), 'error'); return; }
          load();
        }, 'Delete');
      });
    });
  }

  function renderPagination() {
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const el = document.getElementById('pagination');
    if (pages <= 1) { el.innerHTML = ''; return; }
    let html = '<button data-p="' + (page - 1) + '" ' + (page <= 1 ? 'disabled' : '') + '>‹</button>';
    for (let i = 1; i <= pages; i++) {
      html += '<button data-p="' + i + '" class="' + (i === page ? 'active' : '') + '">' + i + '</button>';
    }
    html += '<button data-p="' + (page + 1) + '" ' + (page >= pages ? 'disabled' : '') + '>›</button>';
    el.innerHTML = html;
    el.querySelectorAll('button[data-p]').forEach(function (b) {
      b.addEventListener('click', function () { page = Number(b.getAttribute('data-p')); load(); });
    });
  }

  document.getElementById('f-type').addEventListener('change', function () { page = 1; load(); });
  document.getElementById('f-read').addEventListener('change', function () { page = 1; load(); });
  document.getElementById('mark-all').addEventListener('click', async function () {
    const { error } = await SB.from('notifications').update({ is_read: true }).eq('user_id', user.id).eq('is_read', false);
    if (error) { UI.toast(UI.apiErrorMessage(error), 'error'); return; }
    UI.toast('All notifications marked as read.', 'success');
    load();
  });

  await load();
  PageLoader.hide();
})();
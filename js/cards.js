// Raiffeisen Bank — Cards module
(async function () {
  await AppShell.init({ title: 'Cards' });
  const user = Auth.user;

  async function load() {
    const listEl = document.getElementById('cards-list');
    listEl.innerHTML = '<div class="loading-block"><div class="spinner"></div><span>Loading your cards...</span></div>';
    try {
      const { data, error } = await SB.from('cards').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
      if (error) throw error;
      renderCards(data || []);

      const cids = (data || []).map(function (c) { return c.id; });
      if (!cids.length) {
        document.getElementById('card-tx').innerHTML = UI.emptyState('No card activity yet');
        return;
      }
      const txRes = await SB.from('card_transactions').select('*').in('card_id', cids).eq('user_id', user.id).order('created_at', { ascending: false }).limit(20);
      if (txRes.error) throw txRes.error;
      renderCardTx(txRes.data || []);
    } catch (e) {
      listEl.innerHTML = UI.emptyState('Could not load cards');
      UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  // Builds a card manager panel: status header, realistic face, action toolbar.
  function renderCards(cards) {
    const el = document.getElementById('cards-list');
    if (!cards.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">' + ICONS.cards + '</div><h3>No cards yet</h3><p class="text-sm">Contact support to request your first card.</p></div>';
      return;
    }
    el.innerHTML = '<div class="card-grid">' + cards.map(function (c) {
      const isFrozen = c.status === 'frozen';
      return '<div class="card-item" data-id="' + c.id + '">' +
        '<div class="card-item-head">' +
          '<span class="badge ' + (c.status === 'active' ? 'badge-success' : c.status === 'frozen' ? 'badge-frozen' : 'badge-failed') + '">' + UI.escapeHtml(c.status) + '</span>' +
          '<span class="text-sm text-muted">' + UI.escapeHtml(UI.typeLabel(c.card_type)) + ' · ' + UI.escapeHtml(c.card_brand) + '</span>' +
        '</div>' +
        UI.renderCardFace(c) +
        '<div class="card-item-meta">' +
          '<div class="flex-between text-sm"><span class="text-muted">Spending limit</span><strong>' + UI.money(c.spending_limit, 'USD') + '</strong></div>' +
          '<div class="flex-between text-sm"><span class="text-muted">Last 4</span><strong>•••• ' + UI.escapeHtml(String(c.card_number || '').slice(-4) || '••••') + '</strong></div>' +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="btn btn-outline btn-sm" data-act="copy-number" data-id="' + c.id + '">' + ICONS.copy + '<span>Copy number</span></button>' +
          '<button class="btn btn-outline btn-sm" data-act="copy-cvv" data-id="' + c.id + '">' + ICONS.copy + '<span>Copy CVV</span></button>' +
          (isFrozen
            ? '<button class="btn btn-success btn-sm" data-act="unfreeze" data-id="' + c.id + '">' + ICONS.play + '<span>Unfreeze</span></button>'
            : '<button class="btn btn-gold btn-sm" data-act="freeze" data-id="' + c.id + '">' + ICONS.pause + '<span>Freeze</span></button>') +
          '<button class="btn btn-ghost btn-sm" data-act="limit" data-id="' + c.id + '">' + ICONS.settings + '<span>Limit</span></button>' +
          '<button class="btn btn-ghost btn-sm" data-act="details" data-id="' + c.id + '">' + ICONS.info + '<span>Details</span></button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';

    el.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const act = btn.getAttribute('data-act');
        const card = cards.find(function (c) { return c.id === btn.getAttribute('data-id'); });
        if (!card) return;
        if (act === 'copy-number') copyNumber(btn, card);
        else if (act === 'copy-cvv') copyCvv(btn, card);
        else if (act === 'freeze') freeze(btn, card);
        else if (act === 'unfreeze') unfreeze(btn, card);
        else if (act === 'limit') editLimit(card);
        else if (act === 'details') showDetails(card);
      });
    });
  }

  // Per-action feedback: mark the button as busy (spinner), then success/error.
  function setButtonBusy(btn, busy, busyLabel) {
    if (busy) {
      btn.dataset.restore = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner spinner-sm"></span><span>' + (busyLabel || 'Working...') + '</span>';
    } else {
      btn.disabled = false;
      if (btn.dataset.restore) btn.innerHTML = btn.dataset.restore;
      delete btn.dataset.restore;
    }
  }

  function flashButton(btn, ok, okLabel) {
    if (ok) {
      const restore = btn.dataset.restore || btn.innerHTML;
      btn.innerHTML = ICONS.check + '<span>' + okLabel + '</span>';
      setTimeout(function () { btn.innerHTML = restore; }, 1600);
    }
  }

  function cardDigitsOf(card) {
    return { number: String(card.card_number || '').replace(/\s+/g, ''), cvv: String(card.cvv || '') };
  }

  async function copyNumber(btn, card) {
    const d = cardDigitsOf(card);
    const value = d.number || UI.cardDigits(card.id).full.replace(/\s+/g, '');
    if (!value) { UI.toast('Card number is unavailable.', 'error'); return; }
    setButtonBusy(btn, true, 'Copying...');
    const ok = await UI.copyText(value);
    setButtonBusy(btn, false);
    if (ok) { flashButton(btn, true, 'Copied'); UI.toast('Card number copied.', 'success'); }
    else { UI.toast('Could not copy. Select the number manually.', 'error'); }
  }

  async function copyCvv(btn, card) {
    const d = cardDigitsOf(card);
    const value = d.cvv || UI.cardDigits(card.id).cvv;
    if (!value) { UI.toast('CVV is unavailable.', 'error'); return; }
    setButtonBusy(btn, true, 'Copying...');
    const ok = await UI.copyText(value);
    setButtonBusy(btn, false);
    if (ok) { flashButton(btn, true, 'Copied'); UI.toast('CVV copied.', 'success'); }
    else { UI.toast('Could not copy. Select the CVV manually.', 'error'); }
  }

  async function freeze(btn, card) {
    UI.confirmDialog('Freeze this card? No new transactions will be accepted until you unfreeze it.', async function () {
      try {
        const pin = await UI.promptPin({
          title: 'Freeze Card',
          message: 'Enter your 4-digit security PIN to freeze this card.'
        });
        setButtonBusy(btn, true, 'Freezing...');
        await UI.rpc('customer_freeze_card', { p_user_id: user.id, p_card_id: card.id, p_pin: pin });
        UI.toast('Card frozen.', 'success');
        load();
      } catch (e) {
        setButtonBusy(btn, false);
        if (e && e.message !== 'CANCELLED') UI.toast(UI.apiErrorMessage(e), 'error');
      }
    }, 'Freeze Card');
  }

  async function unfreeze(btn, card) {
    try {
      const pin = await UI.promptPin({
        title: 'Unfreeze Card',
        message: 'Enter your 4-digit security PIN to reactivate this card.'
      });
      setButtonBusy(btn, true, 'Unfreezing...');
      await UI.rpc('customer_unfreeze_card', { p_user_id: user.id, p_card_id: card.id, p_pin: pin });
      UI.toast('Card unfrozen.', 'success');
      load();
    } catch (e) {
      setButtonBusy(btn, false);
      if (e && e.message !== 'CANCELLED') UI.toast(UI.apiErrorMessage(e), 'error');
    }
  }

  function editLimit(card) {
    const modal = UI.openModal(
      '<div class="field"><label>Spending limit (USD)</label><input type="number" class="input" id="limit-input" min="0" value="' + card.spending_limit + '"></div>' +
      '<div class="form-error" id="limit-error"></div>',
      { title: 'Update Spending Limit', footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>' }
    );
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    const saveBtn = modal.footer.querySelector('[data-save]');
    saveBtn.addEventListener('click', async function () {
      const val = Number(document.getElementById('limit-input').value);
      if (!val || val < 0) { document.getElementById('limit-error').textContent = 'Enter a valid limit.'; return; }
      try {
        const pin = await UI.promptPin({
          title: 'Update Spending Limit',
          message: 'Enter your 4-digit security PIN to update this card\'s spending limit to ' + UI.money(val, 'USD') + '.'
        });
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        await UI.rpc('customer_set_card_limit', { p_user_id: user.id, p_card_id: card.id, p_limit: val, p_pin: pin });
        UI.toast('Spending limit updated.', 'success');
        modal.close();
        load();
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        if (e && e.message !== 'CANCELLED') UI.toast(UI.apiErrorMessage(e), 'error');
      }
    });
  }

  function showDetails(c) {
    UI.openModal(
      '<div class="detail-grid">' +
        '<div class="detail-item"><div class="k">Card number</div><div class="v">' + UI.escapeHtml(c.masked_number) + '</div></div>' +
        '<div class="detail-item"><div class="k">Card holder</div><div class="v">' + UI.escapeHtml(c.card_holder) + '</div></div>' +
        '<div class="detail-item"><div class="k">Type</div><div class="v">' + UI.typeLabel(c.card_type) + '</div></div>' +
        '<div class="detail-item"><div class="k">Brand</div><div class="v">' + UI.escapeHtml(c.card_brand) + '</div></div>' +
        '<div class="detail-item"><div class="k">Expiry</div><div class="v">' + c.expiry_month + '/' + c.expiry_year + '</div></div>' +
        '<div class="detail-item"><div class="k">Status</div><div class="v">' + UI.badge(c.status) + '</div></div>' +
        '<div class="detail-item"><div class="k">Spending limit</div><div class="v">' + UI.money(c.spending_limit, 'USD') + '</div></div>' +
        '<div class="detail-item"><div class="k">Issued</div><div class="v">' + UI.formatDate(c.created_at) + '</div></div>' +
      '</div>',
      { title: 'Card Details', footer: '<button class="btn btn-outline" data-cancel>Close</button>' }
    ).footer.querySelector('[data-cancel]').addEventListener('click', function () {
      document.querySelector('.modal-backdrop.open') && document.querySelector('.modal-backdrop.open').remove();
    });
  }

  function renderCardTx(list) {
    const el = document.getElementById('card-tx');
    if (!list.length) { el.innerHTML = UI.emptyState('No card activity yet'); return; }
    el.innerHTML = '<table class="table mobile-cards">' +
      '<thead><tr><th>Merchant</th><th>Type</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
      list.map(function (t) {
        return '<tr><td data-label="Merchant"><span class="cell-main">' + UI.escapeHtml(t.merchant) + '</span></td>' +
          '<td data-label="Type">' + UI.typeLabel(t.type) + '</td>' +
          '<td data-label="Amount" class="amount-debit">' + UI.money(t.amount, t.currency) + '</td>' +
          '<td data-label="Status">' + UI.badge(t.status) + '</td>' +
          '<td data-label="Date">' + UI.formatDate(t.created_at) + '</td></tr>';
      }).join('') +
      '</tbody></table>';
  }

  await load();
  PageLoader.hide();
})();
// marvintlc — Security PIN setup / change for existing accounts.
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', async function () {
    const user = await Auth.init();
    if (!user) {
      window.location.href = 'login.html';
      return;
    }

    let hasPin = false;
    try {
      hasPin = await UI.rpc('customer_has_pin', {});
    } catch (e) {
      hasPin = false;
    }

    const title = document.getElementById('sp-title');
    const sub = document.getElementById('sp-sub');
    const currentField = document.getElementById('current-field');
    const newLabel = document.getElementById('new-label');
    if (hasPin) {
      title.textContent = 'Change your security PIN';
      sub.textContent = 'Enter your current PIN first, then choose a new one';
      currentField.style.display = '';
      newLabel.textContent = 'New PIN';
    }

    document.getElementById('pin-current').innerHTML = UI.pinBoxesHTML('sp-pin-current');
    document.getElementById('pin-new').innerHTML = UI.pinBoxesHTML('sp-pin-new');
    document.getElementById('pin-confirm').innerHTML = UI.pinBoxesHTML('sp-pin-confirm');

    const currentCtl = UI.mountPinInput(document.getElementById('pin-current').querySelector('.pin-inputs'), {});
    const newCtl = UI.mountPinInput(document.getElementById('pin-new').querySelector('.pin-inputs'), {});
    const confirmCtl = UI.mountPinInput(document.getElementById('pin-confirm').querySelector('.pin-inputs'), {});

    document.getElementById('pin-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      const errEl = document.getElementById('sp-error');
      const curErr = document.getElementById('pin-current-error');
      const newErr = document.getElementById('pin-new-error');
      const confErr = document.getElementById('pin-confirm-error');
      errEl.textContent = '';
      curErr.textContent = '';
      newErr.textContent = '';
      confErr.textContent = '';

      const current = currentCtl.getPin();
      const next = newCtl.getPin();
      const confirm = confirmCtl.getPin();

      if (hasPin && !/^[0-9]{4}$/.test(current)) { curErr.textContent = 'Enter your current 4-digit PIN.'; currentCtl.focusFirst(); return; }
      if (!/^[0-9]{4}$/.test(next)) { newErr.textContent = 'Your PIN must be exactly 4 digits.'; newCtl.focusFirst(); return; }
      if (next !== confirm) { confErr.textContent = 'PINs do not match.'; confirmCtl.clear(); confirmCtl.focusFirst(); return; }

      const btn = document.getElementById('sp-btn');
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        await UI.rpc('set_customer_pin', { p_pin: next, p_current_pin: hasPin ? current : null });
        UI.toast(hasPin ? 'Security PIN updated.' : 'Security PIN set. Your account is now protected.', 'success');
        const nextPage = new URLSearchParams(window.location.search).get('next');
        window.location.href = nextPage || 'dashboard.html';
      } catch (err2) {
        btn.disabled = false;
        btn.textContent = 'Save PIN';
        errEl.textContent = UI.apiErrorMessage(err2);
      }
    });

    document.getElementById('sp-back').addEventListener('click', function () {
      window.location.href = 'dashboard.html';
    });

    (hasPin ? currentCtl : newCtl).focusFirst();
  });
})();
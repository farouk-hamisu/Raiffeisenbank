// marvintlc — Loans module
(async function () {
  await AppShell.init({ title: 'Loans' });
  const user = Auth.user;

  let accounts = [];
  let eligible = false;
  let totalBalance = 0;

  function calcMonthly(amount, ratePct, months) {
    const r = ratePct / 100 / 12;
    if (r === 0) return amount / months;
    return amount * r / (1 - Math.pow(1 + r, -months));
  }

  async function loadEligibility() {
    const el = document.getElementById('eligibility');
    const accRes = await SB.from('accounts').select('id, currency').eq('user_id', user.id);
    accounts = accRes.data || [];
    let total = 0;
    if (accounts.length) {
      const balRes = await SB.from('account_balances').select('ledger_balance').in('account_id', accounts.map(function (a) { return a.id; }));
      (balRes.data || []).forEach(function (b) { total += Number(b.ledger_balance); });
    }
    totalBalance = total;
    eligible = total >= 1000;
    el.innerHTML =
      '<div class="flex-between">' +
        '<div><div class="text-sm text-muted">Loan eligibility check</div>' +
        '<div class="font-bold mt-1">Total account balance: ' + UI.money(total, 'USD') + '</div>' +
        '<div class="text-sm mt-1">Minimum eligibility threshold: ' + UI.money(1000, 'USD') + '</div></div>' +
        '<div>' + (eligible ? '<span class="badge badge-success">✓ Eligible</span>' : '<span class="badge badge-failed">Not yet eligible</span>') + '</div>' +
      '</div>';
  }

  async function loadProducts() {
    const el = document.getElementById('products');
    try {
      const { data, error } = await SB.from('loan_products').select('*').eq('enabled', true);
      if (error) throw error;
      if (!data.length) { el.innerHTML = UI.emptyState('No loan products available'); return; }
      el.innerHTML = data.map(function (p) {
        return '<div class="loan-product">' +
          '<h3>' + UI.escapeHtml(p.name) + '</h3>' +
          '<p class="text-muted text-sm" style="min-height:40px">' + UI.escapeHtml(p.description || '') + '</p>' +
          '<div class="rate">' + p.interest_rate + '%<span> APR</span></div>' +
          '<div class="text-sm text-muted">' + UI.money(p.min_amount, 'USD') + ' – ' + UI.money(p.max_amount, 'USD') + ' · up to ' + p.term_months + ' months</div>' +
          '<button class="btn btn-primary btn-sm mt-2" data-apply="' + p.id + '" ' + (eligible ? '' : 'disabled') + '>Apply</button>' +
        '</div>';
      }).join('');
      el.querySelectorAll('[data-apply]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const p = data.find(function (x) { return x.id === btn.getAttribute('data-apply'); });
          openApply(p);
        });
      });
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load loan products');
    }
  }

  function openApply(product) {
    const modal = UI.openModal(
      '<div class="field"><label>Loan amount</label>' +
        '<div class="amount-field"><input type="number" class="input" id="la-amount" min="' + product.min_amount + '" max="' + product.max_amount + '" value="' + product.min_amount + '"><span class="currency-tag">$</span></div></div>' +
      '<div class="field"><label>Term (months)</label><select class="select" id="la-term">' +
        [6, 12, 24, 36, 48, 60, 72, 84].filter(function (m) { return m <= product.term_months; }).map(function (m) { return '<option value="' + m + '">' + m + ' months</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>Purpose</label><input type="text" class="input" id="la-purpose" placeholder="What is this loan for?"></div>' +
      '<div class="review-panel"><div class="detail-grid">' +
        '<div class="detail-item"><div class="k">Interest rate</div><div class="v">' + product.interest_rate + '% APR</div></div>' +
        '<div class="detail-item"><div class="k">Est. monthly payment</div><div class="v" id="la-monthly">—</div></div>' +
        '<div class="detail-item"><div class="k">Range</div><div class="v">' + UI.money(product.min_amount, 'USD') + ' – ' + UI.money(product.max_amount, 'USD') + '</div></div>' +
        '<div class="detail-item"><div class="k">Product</div><div class="v">' + UI.escapeHtml(product.name) + '</div></div>' +
      '</div></div>' +
      '<div class="form-error" id="la-error"></div>',
      { title: 'Apply — ' + product.name, footer: '<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-submit>Submit Application</button>' }
    );
    const recalc = function () {
      const amount = Number(document.getElementById('la-amount').value) || 0;
      const term = Number(document.getElementById('la-term').value) || product.term_months;
      const monthly = calcMonthly(amount, Number(product.interest_rate), term);
      document.getElementById('la-monthly').textContent = UI.money(monthly, 'USD');
    };
    document.getElementById('la-amount').addEventListener('input', recalc);
    document.getElementById('la-term').addEventListener('change', recalc);
    recalc();
    modal.footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    modal.footer.querySelector('[data-submit]').addEventListener('click', async function () {
      const err = document.getElementById('la-error');
      err.textContent = '';
      const btn = this;
      const amount = Number(document.getElementById('la-amount').value);
      const term = Number(document.getElementById('la-term').value);
      const purpose = document.getElementById('la-purpose').value.trim();
      if (!amount || amount < Number(product.min_amount) || amount > Number(product.max_amount)) {
        err.textContent = 'Amount must be between ' + UI.money(product.min_amount, 'USD') + ' and ' + UI.money(product.max_amount, 'USD') + '.';
        return;
      }
      const monthly = calcMonthly(amount, Number(product.interest_rate), term);
      try {
        const pin = await UI.promptPin({
          title: 'Confirm Loan Application',
          message: 'Enter your 4-digit security PIN to submit this loan application for ' + UI.money(amount, 'USD') + '.'
        });
        btn.disabled = true;
        btn.textContent = 'Submitting...';
        const data = await UI.rpc('submit_loan_application', {
          p_user_id: user.id,
          p_product_id: product.id,
          p_amount: amount,
          p_term_months: term,
          p_purpose: purpose || null,
          p_pin: pin
        });
        UI.toast('Loan application submitted. Reference: ' + data.reference, 'success');
        modal.close();
        loadApplications();
        loadActiveLoans();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Submit Application';
        if (e && e.message !== 'CANCELLED') err.textContent = UI.apiErrorMessage(e);
      }
    });
  }

  async function loadApplications() {
    const el = document.getElementById('applications');
    try {
      const { data, error } = await SB.from('loan_applications').select('*, loan_products(name)').eq('user_id', user.id).order('created_at', { ascending: false });
      if (error) throw error;
      if (!data.length) { el.innerHTML = UI.emptyState('You have no loan applications'); return; }
      el.innerHTML = '<table class="table mobile-cards">' +
        '<thead><tr><th>Reference</th><th>Product</th><th>Amount</th><th>Monthly</th><th>Term</th><th>Status</th><th>Applied</th></tr></thead><tbody>' +
        data.map(function (l) {
          return '<tr><td data-label="Reference"><span class="cell-main">' + UI.escapeHtml(l.reference) + '</span></td>' +
            '<td data-label="Product">' + UI.escapeHtml(l.loan_products ? l.loan_products.name : '—') + '</td>' +
            '<td data-label="Amount">' + UI.money(l.amount, l.currency) + '</td>' +
            '<td data-label="Monthly">' + UI.money(l.monthly_payment, l.currency) + '</td>' +
            '<td data-label="Term">' + l.term_months + ' mo</td>' +
            '<td data-label="Status">' + UI.badge(l.status) + '</td>' +
            '<td data-label="Applied">' + UI.formatDate(l.created_at) + '</td></tr>';
        }).join('') +
        '</tbody></table>';
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load applications');
    }
  }

  async function loadActiveLoans() {
    const el = document.getElementById('active-loans');
    try {
      const { data, error } = await SB.from('loan_applications').select('*').eq('user_id', user.id).eq('status', 'active');
      if (error) throw error;
      if (!data.length) { el.innerHTML = UI.emptyState('No active loans. Once a loan is approved and disbursed it will appear here.'); return; }
      let html = '';
      for (const loan of data) {
        const repayRes = await SB.from('loan_repayments').select('*').eq('loan_application_id', loan.id).order('due_date');
        const repayments = repayRes.data || [];
        const paid = repayments.filter(function (r) { return r.status === 'paid'; });
        const outstanding = loan.amount - paid.reduce(function (s, r) { return s + Number(r.amount); }, 0);
        html +=
          '<div class="mb-3" style="border:1px solid var(--border);border-radius:10px;padding:18px">' +
            '<div class="flex-between"><div><div class="font-bold">' + UI.escapeHtml(loan.reference) + '</div>' +
            '<div class="text-sm text-muted">' + loan.term_months + ' months · ' + loan.interest_rate + '% APR</div></div>' +
            '<div style="text-align:right"><div class="text-sm text-muted">Outstanding</div><div class="font-bold" style="font-size:18px">' + UI.money(Math.max(0, outstanding), loan.currency) + '</div></div></div>' +
            '<div class="progress"><div style="width:' + Math.min(100, (paid.length / Math.max(1, repayments.length)) * 100) + '%"></div></div>' +
            '<div class="progress-label"><span>' + paid.length + '/' + repayments.length + ' installments paid</span><span>' + Math.round((paid.length / Math.max(1, repayments.length)) * 100) + '%</span></div>' +
            '<div class="table-wrap mt-2" style="margin-top:14px"><table class="table mobile-cards">' +
              '<thead><tr><th>Due date</th><th>Amount</th><th>Status</th><th>Paid at</th><th></th></tr></thead><tbody>' +
              repayments.map(function (r) {
                return '<tr><td data-label="Due date">' + UI.formatDate(r.due_date) + '</td>' +
                  '<td data-label="Amount">' + UI.money(r.amount, r.currency) + '</td>' +
                  '<td data-label="Status">' + UI.badge(r.status) + '</td>' +
                  '<td data-label="Paid at">' + (r.paid_at ? UI.formatDate(r.paid_at) : '—') + '</td>' +
                  '<td data-label="">' + (r.status === 'scheduled' && new Date(r.due_date) <= new Date(Date.now() + 40 * 86400000)
                    ? '<button class="btn btn-primary btn-sm" data-pay="' + r.id + '">Pay Now</button>' : '') + '</td></tr>';
              }).join('') +
            '</tbody></table></div>' +
          '</div>';
      }
      el.innerHTML = html;
      el.querySelectorAll('[data-pay]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const id = btn.getAttribute('data-pay');
          UI.confirmDialog('Pay this installment now?', async function () {
            try {
              const account = accounts.find(function (a) { return a.currency === 'USD'; });
              if (!account) { UI.toast('No USD account available for repayment.', 'error'); return; }
              const pin = await UI.promptPin({
                title: 'Confirm Loan Repayment',
                message: 'Enter your 4-digit security PIN to authorize this loan repayment.'
              });
              await UI.rpc('pay_loan_repayment', { p_user_id: user.id, p_repayment_id: id, p_account_id: account.id, p_pin: pin });
              UI.toast('Repayment successful.', 'success');
              loadActiveLoans();
            } catch (e) {
              if (e && e.message !== 'CANCELLED') UI.toast(UI.apiErrorMessage(e), 'error');
            }
          }, 'Pay Now');
        });
      });
    } catch (e) {
      el.innerHTML = UI.emptyState('Could not load active loans');
    }
  }

  await loadEligibility();
  await loadProducts();
  await loadApplications();
  await loadActiveLoans();
  PageLoader.hide();
})();
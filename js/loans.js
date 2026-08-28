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
    let step = 1;
    const totalSteps = 4;
    const profile = Auth.user || {};

    function stepHTML(n) {
      if (n === 1) {
        return '<h4 class="mb-2">Personal Information</h4>' +
          '<div class="field"><label>Full legal name *</label><input type="text" class="input" id="la-name" placeholder="As it appears on your ID" value="' + UI.escapeHtml(profile.full_name || '') + '"></div>' +
          '<div class="field"><label>Date of birth *</label><input type="date" class="input" id="la-dob"></div>' +
          '<div class="field"><label>Phone number *</label><input type="tel" class="input" id="la-phone" placeholder="+1 (555) 000-0000" value="' + UI.escapeHtml(profile.phone || '') + '"></div>' +
          '<div class="field"><label>Street address *</label><input type="text" class="input" id="la-address" placeholder="123 Main St"></div>' +
          '<div class="field"><label>City *</label><input type="text" class="input" id="la-city" placeholder="New York"></div>' +
          '<div class="field"><label>State *</label><input type="text" class="input" id="la-state" placeholder="NY"></div>' +
          '<div class="field"><label>ZIP code *</label><input type="text" class="input" id="la-zip" placeholder="10001"></div>';
      }
      if (n === 2) {
        return '<h4 class="mb-2">Employment & Income</h4>' +
          '<div class="field"><label>Employment status *</label><select class="select" id="la-employment">' +
            '<option value="">Select...</option><option value="employed">Employed</option><option value="self_employed">Self-Employed</option>' +
            '<option value="retired">Retired</option><option value="student">Student</option><option value="other">Other</option>' +
          '</select></div>' +
          '<div class="field"><label>Employer name</label><input type="text" class="input" id="la-employer" placeholder="Company name"></div>' +
          '<div class="field"><label>Annual income *</label><div class="amount-field"><input type="number" class="input" id="la-income" min="0" step="1000" placeholder="50000"><span class="currency-tag">$</span></div></div>' +
          '<div class="field"><label>Credit score (if known)</label><input type="number" class="input" id="la-credit" min="300" max="850" placeholder="e.g. 700"></div>';
      }
      if (n === 3) {
        return '<h4 class="mb-2">Loan Details</h4>' +
          '<div class="field"><label>Loan amount *</label><div class="amount-field"><input type="number" class="input" id="la-amount" min="' + product.min_amount + '" max="' + product.max_amount + '" value="' + product.min_amount + '"><span class="currency-tag">$</span></div></div>' +
          '<div class="field"><label>Term (months) *</label><select class="select" id="la-term">' +
            [6, 12, 24, 36, 48, 60, 72, 84].filter(function (m) { return m <= product.term_months; }).map(function (m) { return '<option value="' + m + '">' + m + ' months</option>'; }).join('') +
          '</select></div>' +
          '<div class="field"><label>Purpose of loan</label><input type="text" class="input" id="la-purpose" placeholder="e.g. Home renovation, business expansion"></div>' +
          '<div class="review-panel"><div class="detail-grid">' +
            '<div class="detail-item"><div class="k">Interest rate</div><div class="v">' + product.interest_rate + '% APR</div></div>' +
            '<div class="detail-item"><div class="k">Est. monthly payment</div><div class="v" id="la-monthly">—</div></div>' +
            '<div class="detail-item"><div class="k">Amount range</div><div class="v">' + UI.money(product.min_amount, 'USD') + ' – ' + UI.money(product.max_amount, 'USD') + '</div></div>' +
          '</div></div>';
      }
      if (n === 4) {
        return '<h4 class="mb-2">Review Your Application</h4>' +
          '<div class="review-panel"><div class="detail-grid" id="la-review"></div></div>' +
          '<div class="field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="la-agree"> I certify that the information provided is accurate and complete.</label></div>' +
          '<div class="form-error" id="la-error"></div>';
      }
      return '';
    }

    function renderStep() {
      const body = document.querySelector('.modal-body') || document.querySelector('.ui-modal-body');
      if (!body) return;
      body.innerHTML = stepHTML(step);
      const progress = document.getElementById('la-progress');
      if (progress) progress.textContent = 'Step ' + step + ' of ' + totalSteps;
      if (step === 3) {
        const recalc = function () {
          const amount = Number(document.getElementById('la-amount').value) || 0;
          const term = Number(document.getElementById('la-term').value) || product.term_months;
          const monthly = calcMonthly(amount, Number(product.interest_rate), term);
          document.getElementById('la-monthly').textContent = UI.money(monthly, 'USD');
        };
        document.getElementById('la-amount').addEventListener('input', recalc);
        document.getElementById('la-term').addEventListener('change', recalc);
        recalc();
      }
      if (step === 4) {
        const g = gatherData();
        const el = document.getElementById('la-review');
        el.innerHTML = [
          ['Name', g.name], ['Date of birth', g.dob], ['Phone', g.phone],
          ['Address', g.address + ', ' + g.city + ', ' + g.state + ' ' + g.zip],
          ['Employment', g.employment], ['Employer', g.employer || '—'],
          ['Annual income', g.income ? UI.money(g.income, 'USD') : '—'],
          ['Credit score', g.credit || '—'],
          ['Loan amount', UI.money(g.amount, 'USD')], ['Term', g.term + ' months'],
          ['Purpose', g.purpose || '—'],
          ['Monthly payment', g.monthly], ['Total interest', g.totalInterest]
        ].map(function (f) { return '<div class="detail-item"><div class="k">' + f[0] + '</div><div class="v">' + UI.escapeHtml(String(f[1])) + '</div></div>'; }).join('');
      }
      updateFooter();
    }

    function gatherData() {
      var amount = Number(document.getElementById('la-amount') ? document.getElementById('la-amount').value : 0) || 0;
      var term = Number(document.getElementById('la-term') ? document.getElementById('la-term').value : 12) || 12;
      var monthly = calcMonthly(amount, Number(product.interest_rate), term);
      var totalPaid = monthly * term;
      return {
        name: document.getElementById('la-name') ? document.getElementById('la-name').value.trim() : '',
        dob: document.getElementById('la-dob') ? document.getElementById('la-dob').value : '',
        phone: document.getElementById('la-phone') ? document.getElementById('la-phone').value.trim() : '',
        address: document.getElementById('la-address') ? document.getElementById('la-address').value.trim() : '',
        city: document.getElementById('la-city') ? document.getElementById('la-city').value.trim() : '',
        state: document.getElementById('la-state') ? document.getElementById('la-state').value.trim() : '',
        zip: document.getElementById('la-zip') ? document.getElementById('la-zip').value.trim() : '',
        employment: document.getElementById('la-employment') ? document.getElementById('la-employment').value : '',
        employer: document.getElementById('la-employer') ? document.getElementById('la-employer').value.trim() : '',
        income: Number(document.getElementById('la-income') ? document.getElementById('la-income').value : 0) || 0,
        credit: document.getElementById('la-credit') ? document.getElementById('la-credit').value : '',
        amount: amount, term: term, purpose: document.getElementById('la-purpose') ? document.getElementById('la-purpose').value.trim() : '',
        monthly: UI.money(monthly, 'USD'), totalInterest: UI.money(totalPaid - amount, 'USD')
      };
    }

    function validateStep() {
      if (step === 1) {
        var d = gatherData();
        if (!d.name) return 'Please enter your full legal name.';
        if (!d.dob) return 'Please enter your date of birth.';
        if (!d.phone) return 'Please enter your phone number.';
        if (!d.address) return 'Please enter your street address.';
        if (!d.city) return 'Please enter your city.';
        if (!d.state) return 'Please enter your state.';
        if (!d.zip) return 'Please enter your ZIP code.';
      }
      if (step === 2) {
        var d = gatherData();
        if (!d.employment) return 'Please select your employment status.';
        if (!d.income || d.income <= 0) return 'Please enter your annual income.';
      }
      if (step === 3) {
        var d = gatherData();
        if (!d.amount || d.amount < Number(product.min_amount) || d.amount > Number(product.max_amount))
          return 'Amount must be between ' + UI.money(product.min_amount, 'USD') + ' and ' + UI.money(product.max_amount, 'USD') + '.';
      }
      if (step === 4) {
        if (!document.getElementById('la-agree').checked) return 'Please certify that the information is accurate.';
      }
      return null;
    }

    function updateFooter() {
      var footer = modal.footer;
      footer.innerHTML = '';
      if (step > 1) {
        var back = document.createElement('button');
        back.className = 'btn btn-outline';
        back.textContent = 'Back';
        back.addEventListener('click', function () { step--; renderStep(); });
        footer.appendChild(back);
      }
      if (step < totalSteps) {
        var next = document.createElement('button');
        next.className = 'btn btn-primary';
        next.textContent = 'Next';
        next.addEventListener('click', function () {
          var err = validateStep();
          if (err) { UI.toast(err, 'error'); return; }
          step++;
          renderStep();
        });
        footer.appendChild(next);
      } else {
        var submit = document.createElement('button');
        submit.className = 'btn btn-primary';
        submit.textContent = 'Submit Application';
        submit.addEventListener('click', async function () {
          var errEl = document.getElementById('la-error');
          errEl.textContent = '';
          var err = validateStep();
          if (err) { errEl.textContent = err; return; }
          var g = gatherData();
          try {
            var pin = await UI.promptPin({
              title: 'Confirm Loan Application',
              message: 'Enter your 4-digit security PIN to submit this loan application for ' + UI.money(g.amount, 'USD') + '.'
            });
            submit.disabled = true;
            submit.textContent = 'Submitting...';
            var data = await UI.rpc('submit_loan_application', {
              p_user_id: user.id,
              p_product_id: product.id,
              p_amount: g.amount,
              p_term_months: g.term,
              p_purpose: g.purpose || null,
              p_pin: pin,
              p_form_data: {
                full_name: g.name, date_of_birth: g.dob, phone: g.phone,
                address: g.address, city: g.city, state: g.state, zip: g.zip,
                employment_status: g.employment, employer_name: g.employer,
                annual_income: g.income, credit_score: g.credit ? Number(g.credit) : null
              }
            });
            UI.toast('Application submitted. Reference: ' + data.reference, 'success');
            modal.close();
            loadApplications();
          } catch (e) {
            submit.disabled = false;
            submit.textContent = 'Submit Application';
            if (e && e.message !== 'CANCELLED') errEl.textContent = UI.apiErrorMessage(e);
          }
        });
        footer.appendChild(submit);
      }
    }

    var modal = UI.openModal(
      '<div class="text-center text-muted mb-2" id="la-progress">Step 1 of ' + totalSteps + '</div><div id="la-body"></div>',
      { title: 'Apply — ' + product.name, footer: '' }
    );
    renderStep();
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
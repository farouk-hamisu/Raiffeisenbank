// Raiffeisen Bank — Public website shell (shared header/footer)

const SITE_NAV = [
  { label: 'Home', href: 'index.html' },
  { label: 'About', href: 'about.html' },
  { label: 'Services', href: 'services.html' },
  { label: 'Cards', href: 'cards-info.html' },
  { label: 'Loans', href: 'loans-info.html' },
  { label: 'Transfers', href: 'transfers-info.html' },
  { label: 'Security', href: 'security.html' },
  { label: 'Contact', href: 'contact.html' }
];

function renderSiteShell() {
  const current = window.location.pathname.split('/').pop();

  const header = document.getElementById('site-header');
  if (header) {
    header.innerHTML =
      '<div class="container">' +
        '<a class="brand" href="index.html"><picture><source media="(max-width: 440px)" srcset="assets/logos/mark.svg"><img src="assets/logos/logo.svg" alt="Raiffeisen Bank"></picture></a>' +
        '<button class="nav-toggle" id="nav-toggle" aria-label="Menu">' + icon('menu') + '</button>' +
        '<nav class="site-nav" id="site-nav">' +
          SITE_NAV.map(function (n) {
            const active = current === n.href || (current === '' && n.href === 'index.html') ? 'active' : '';
            return '<a href="' + n.href + '" class="' + active + '">' + n.label + '</a>';
          }).join('') +
        '</nav>' +
        '<div class="site-actions">' +
          '<a class="btn btn-outline btn-sm" href="login.html">Log In</a>' +
          '<a class="btn btn-primary btn-sm" href="register.html">Open Account</a>' +
        '</div>' +
      '</div>';
    const toggle = document.getElementById('nav-toggle');
    const nav = document.getElementById('site-nav');
    toggle.addEventListener('click', function () { nav.classList.toggle('open'); });
  }

  const footer = document.getElementById('site-footer');
  if (footer) {
    footer.innerHTML =
      '<div class="container">' +
        '<div class="foot-grid">' +
          '<div><div class="footer-brand"><a class="brand" href="index.html"><img src="assets/logos/logo-light.svg" alt="Raiffeisen Bank"></a></div>' +
          '<p style="margin-top:14px;font-size:14px">A modern digital banking platform built for speed, security and trust. Banking made effortless.</p>' +
          '<p class="text-sm" style="margin-top:10px"><strong>24/7 Support</strong><br>+1 (800) 555-0142</p></div>' +
          '<div><h4>Company</h4><a href="about.html">About Us</a><a href="contact.html">Contact</a><a href="security.html">Security</a><a href="services.html">Services</a></div>' +
          '<div><h4>Products</h4><a href="accounts.html">Accounts</a><a href="cards-info.html">Cards</a><a href="loans-info.html">Loans</a><a href="transfers-info.html">Transfers</a><a href="currency-exchange.html">Currency Exchange</a><a href="mobile-app.html">Mobile App</a><a href="business.html">Business Banking</a></div>' +
          '<div><h4>Online Banking</h4><a href="login.html">Customer Login</a><a href="register.html">Open an Account</a><a href="forgot-password.html">Forgot Password</a><a href="admin/login.html">Admin Portal</a></div>' +
        '</div>' +
        '<div class="foot-bottom"><span>&copy; ' + new Date().getFullYear() + ' Raiffeisen Bank. All rights reserved.</span><span>FDIC Insured &middot; Member NCUA &middot; Equal Housing Lender</span></div>' +
      '</div>';
  }
}

document.addEventListener('DOMContentLoaded', renderSiteShell);
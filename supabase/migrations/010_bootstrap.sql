-- marvintlc - Migration 010
-- Bootstrap reference data (base infrastructure, NOT demo data).
-- Required for real user signup: handle_new_profile() creates a default
-- USD account, which needs at least one base currency to exist.
-- Safe to run more than once (idempotent: on conflict do nothing).

-- ---------------------------------------------------------------------------
-- Currencies
-- ---------------------------------------------------------------------------
insert into public.currencies (code, name, symbol, is_base, enabled) values
  ('USD', 'US Dollar',     '$',  true,  true),
  ('EUR', 'Euro',          '€',  false, true),
  ('GBP', 'British Pound', '£',  false, true),
  ('NGN', 'Nigerian Naira','₦',  false, true),
  ('CAD', 'Canadian Dollar','C$', false, true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Exchange rates (base -> quote)
-- ---------------------------------------------------------------------------
insert into public.exchange_rates (base_currency, quote_currency, rate, fee_percent) values
  ('USD', 'EUR', 0.9200, 0.50),
  ('USD', 'GBP', 0.7900, 0.50),
  ('USD', 'NGN', 1580.00, 1.00),
  ('USD', 'CAD', 1.3700, 0.50),
  ('EUR', 'USD', 1.0870, 0.50),
  ('GBP', 'USD', 1.2660, 0.50),
  ('NGN', 'USD', 0.00063, 1.00),
  ('CAD', 'USD', 0.7300, 0.50)
on conflict (base_currency, quote_currency) do nothing;

-- ---------------------------------------------------------------------------
-- Loan products
-- ---------------------------------------------------------------------------
insert into public.loan_products (name, description, min_amount, max_amount, interest_rate, term_months, enabled) values
  ('Personal Loan', 'Flexible personal loan for your everyday needs.', 500, 50000, 5.50, 12, true),
  ('Auto Loan', 'Finance your next vehicle with competitive rates.', 2000, 80000, 4.75, 60, true),
  ('Home Improvement', 'Upgrade and renovate your home.', 5000, 200000, 4.25, 84, true),
  ('Business Loan', 'Working capital to grow your business.', 10000, 500000, 6.25, 48, true);

-- ---------------------------------------------------------------------------
-- Admin roles
-- ---------------------------------------------------------------------------
insert into public.admin_roles (name, permissions) values
  ('super_admin', array[
    'dashboard','users.view','users.manage','accounts.view','accounts.manage',
    'transactions.view','transactions.manage','transfers.view','transfers.manage',
    'deposits.view','deposits.manage','cards.view','cards.manage',
    'currencies.view','currencies.manage','loans.view','loans.manage',
    'notifications.view','notifications.manage','audit.view','settings.view',
    'settings.manage','admins.manage'
  ]),
  ('admin', array[
    'dashboard','users.view','users.manage','accounts.view','accounts.manage',
    'transactions.view','transactions.manage','transfers.view','transfers.manage',
    'deposits.view','deposits.manage','cards.view','cards.manage',
    'currencies.view','currencies.manage','loans.view','loans.manage',
    'notifications.view','notifications.manage','audit.view','settings.view'
  ])
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- System settings
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value, description) values
  ('bank_name', '"marvintlc"', 'Institution display name'),
  ('currency', '"USD"', 'Default currency code'),
  ('local_transfer_fee', '0', 'Flat local transfer fee'),
  ('intl_transfer_fee', '15', 'Flat international transfer fee'),
  ('swap_fee_percent', '0.5', 'Default currency swap fee percentage'),
  ('maintenance_mode', 'false', 'Maintenance mode flag')
on conflict (key) do nothing;
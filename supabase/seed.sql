-- marvintlc - Seed data (development / demo only)
-- NOT for production. Credentials:
--   Customer: demo@marvintlc.com  /  Demo@1234
--   Admin:    admin@marvintlc.com /  Admin@123

-- Prevent the profile trigger from auto-creating random accounts during
-- seeding; accounts are created explicitly below. Re-enabled at the end.
alter table public.profiles disable trigger on_profile_created;

-- Only USD as fiat currency
DO $$ BEGIN
  insert into public.currencies (code, name, symbol, is_base, enabled) values
    ('USD', 'US Dollar', '$', true, true),
    ('BTC', 'Bitcoin', '\u20BF', false, true)
  on conflict (code) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'currencies: skipped'; END $$;

-- BTC/USD rate (seeded; live rate fetched from CoinGecko at runtime)
DO $$ BEGIN
  insert into public.exchange_rates (base_currency, quote_currency, rate, fee_percent) values
    ('USD', 'BTC', 0.00001200, 0.50),
    ('BTC', 'USD', 83333.33, 0.50)
  on conflict (base_currency, quote_currency) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'exchange_rates: skipped'; END $$;

DO $$ BEGIN
  insert into public.loan_products (name, description, min_amount, max_amount, interest_rate, term_months, enabled) values
    ('Personal Loan', 'Flexible personal loan for your everyday needs.', 500, 50000, 5.50, 12, true),
    ('Auto Loan', 'Finance your next vehicle with competitive rates.', 2000, 80000, 4.75, 60, true),
    ('Home Improvement', 'Upgrade and renovate your home.', 5000, 200000, 4.25, 84, true),
    ('Business Loan', 'Working capital to grow your business.', 10000, 500000, 6.25, 48, true)
  on conflict (name) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'loan_products: skipped'; END $$;

DO $$ BEGIN
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
    ]),
    ('support', array[
      'dashboard','users.view','accounts.view','transactions.view','transfers.view',
      'deposits.view','cards.view','notifications.view','notifications.manage','audit.view'
    ]),
    ('finance', array[
      'dashboard','transactions.view','transactions.manage','transfers.view','transfers.manage',
      'deposits.view','deposits.manage','currencies.view','currencies.manage','loans.view','loans.manage'
    ])
  on conflict (name) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'admin_roles: skipped'; END $$;

DO $$ BEGIN
  insert into public.admin_users (email, password_hash, full_name, role_id, status)
  select 'admin@marvintlc.com', public.admin_hash_password('Admin@123'), 'System Administrator', r.id, 'active'
  from public.admin_roles r where r.name = 'super_admin'
  on conflict (email) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'admin_users: skipped'; END $$;

DO $$ BEGIN
  insert into public.system_settings (key, value, description) values
    ('bank_name', '"marvintlc"', 'Institution display name'),
    ('currency', '"USD"', 'Default currency code'),
    ('local_transfer_fee', '0', 'Flat local transfer fee'),
    ('intl_transfer_fee', '15', 'Flat international transfer fee'),
    ('maintenance_mode', 'false', 'Maintenance mode flag')
  on conflict (key) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'system_settings: skipped'; END $$;

DO $$ BEGIN
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    'demo@marvintlc.com', public.admin_hash_password('Demo@1234'), now(),
    jsonb_build_object('provider', 'email', 'providers', '["email"]'),
    jsonb_build_object('full_name', 'Alex Morgan'),
    now(), now(), '', '', '', ''
  ) on conflict (id) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'auth.users: skipped'; END $$;

DO $$ BEGIN
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    jsonb_build_object('sub', '00000000-0000-0000-0000-000000000001', 'email', 'demo@marvintlc.com'),
    'email', now(), now(), now()
  ) on conflict (provider, provider_id) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'auth.identities: skipped'; END $$;

DO $$ BEGIN
  insert into public.profiles (id, email, full_name, phone, avatar_url, address, city, country, status, kyc_status, date_of_birth)
  values (
    '00000000-0000-0000-0000-000000000001', 'demo@marvintlc.com', 'Alex Morgan',
    '+1 (415) 555-0132', null, '2210 Market Street', 'San Francisco', 'United States', 'active', 'verified', '1991-04-12'
  )
  on conflict (id) do update set
    email = excluded.email, full_name = excluded.full_name, phone = excluded.phone,
    avatar_url = excluded.avatar_url, address = excluded.address, city = excluded.city,
    country = excluded.country, status = excluded.status, kyc_status = excluded.kyc_status,
    date_of_birth = excluded.date_of_birth;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'profiles: skipped'; END $$;

-- Demo accounts: Savings (USD), Current (USD)
DO $$ BEGIN
  insert into public.accounts (id, user_id, account_number, account_name, account_type, currency, status) values
    ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', '4800000000000011', 'Savings Account', 'savings', 'USD', 'active'),
    ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001', '4800000000000012', 'Current Account', 'checking', 'USD', 'active')
  on conflict (id) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'accounts: skipped'; END $$;

DO $$ BEGIN
  insert into public.account_balances (account_id, available_balance, ledger_balance, currency) values
    ('00000000-0000-0000-0000-000000000101', 24750.32, 25900.32, 'USD'),
    ('00000000-0000-0000-0000-000000000102', 18750.00, 18750.00, 'USD')
  on conflict (account_id) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'account_balances: skipped'; END $$;

DO $$ BEGIN
  insert into public.beneficiaries (user_id, name, bank_name, account_number, country, currency, is_international) values
    ('00000000-0000-0000-0000-000000000001', 'Jordan Blake', 'marvintlc', '4800000000000022', 'United States', 'USD', false),
    ('00000000-0000-0000-0000-000000000001', 'Sophia Carter', 'marvintlc', '4800000000000023', 'United States', 'USD', false)
  on conflict do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'beneficiaries: skipped'; END $$;

DO $$ BEGIN
  insert into public.transactions (reference, user_id, account_id, type, direction, amount, currency, fee, status, description, sender, recipient, created_at) values
    ('NTB-DEP0001', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'deposit', 'credit', 5000.00, 'USD', 0, 'completed', 'Salary deposit', 'Acme Corp', 'Alex Morgan', now() - interval '2 days'),
    ('NTB-LT0001',  '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'local_transfer', 'debit', 1200.00, 'USD', 0, 'completed', 'Rent payment', 'Alex Morgan', 'Jordan Blake', now() - interval '3 days'),
    ('NTB-BTC001',  '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'currency_swap', 'debit', 2000.00, 'USD', 10.00, 'completed', 'USD to BTC swap', 'Alex Morgan', 'USD -> BTC', now() - interval '5 days'),
    ('NTB-CTX0001', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'withdrawal', 'debit', 89.50, 'USD', 0, 'completed', 'ATM withdrawal', 'Alex Morgan', 'ATM', now() - interval '6 days'),
    ('NTB-DEP0002', '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000101', 'deposit', 'credit', 250.00, 'USD', 0, 'completed', 'Cash deposit', 'Cash Deposit', 'Alex Morgan', now() - interval '7 days'),
    ('NTB-CTX0002', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'withdrawal', 'debit', 154.20, 'USD', 0, 'completed', 'Online purchase', 'Whole Foods Market', 'Alex Morgan', now() - interval '8 days'),
    ('NTB-CTX0003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'withdrawal', 'debit', 320.00, 'USD', 0, 'completed', 'Online purchase', 'Apple Inc.', 'Alex Morgan', now() - interval '10 days'),
    ('NTB-LT0002',  '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'local_transfer', 'debit', 450.00, 'USD', 0, 'pending', 'Utilities payment', 'Alex Morgan', 'Pacific Gas & Electric', now() - interval '1 hour')
  on conflict (reference) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'transactions: skipped'; END $$;

DO $$ BEGIN
  insert into public.cards (user_id, account_id, card_number, masked_number, card_holder, card_type, card_brand, expiry_month, expiry_year, cvv, spending_limit, status) values
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', '4532015112830366', '4532 \u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 0366', 'Alex Morgan', 'debit', 'visa', 8, 2028, '112', 10000.00, 'active'),
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', '5391182039442218', '5391 \u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 2218', 'Alex Morgan', 'credit', 'mastercard', 3, 2029, '334', 15000.00, 'active'),
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000102', '4716880123456789', '4716 \u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 6789', 'Alex Morgan', 'virtual', 'visa', 12, 2027, '558', 5000.00, 'frozen')
  on conflict (card_number) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cards: skipped'; END $$;

DO $$ BEGIN
  insert into public.card_transactions (card_id, user_id, merchant, amount, currency, type, status, created_at) values
    ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000001', 'Whole Foods Market', 154.20, 'USD', 'purchase', 'completed', now() - interval '8 days'),
    ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000001', 'Starbucks', 12.50, 'USD', 'purchase', 'completed', now() - interval '4 days'),
    ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000001', 'Uber', 34.80, 'USD', 'online', 'completed', now() - interval '2 days'),
    ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000001', 'Amazon', 89.99, 'USD', 'online', 'completed', now() - interval '5 days');
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'card_transactions: skipped'; END $$;

DO $$ BEGIN
  insert into public.deposits (reference, user_id, account_id, amount, currency, method, note, status, created_at) values
    ('DEP-SEED-0001', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 5000.00, 'USD', 'bank_transfer', 'Monthly salary', 'completed', now() - interval '2 days'),
    ('DEP-SEED-0002', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 250.00, 'USD', 'cash', 'Branch deposit', 'completed', now() - interval '7 days'),
    ('DEP-SEED-0003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 1500.00, 'USD', 'bank_transfer', 'Refund', 'pending', now() - interval '30 minutes')
  on conflict (reference) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'deposits: skipped'; END $$;

DO $$ BEGIN
  insert into public.loan_applications (reference, user_id, product_id, amount, currency, term_months, interest_rate, monthly_payment, purpose, status, created_at) values
    ('LN-SEED-0001', '00000000-0000-0000-0000-000000000001',
     (select id from public.loan_products where name = 'Personal Loan'),
     8000.00, 'USD', 12, 5.50, 687.42, 'Home renovation', 'active', now() - interval '6 months'),
    ('LN-SEED-0002', '00000000-0000-0000-0000-000000000001',
     (select id from public.loan_products where name = 'Auto Loan'),
     25000.00, 'USD', 48, 4.75, 572.12, 'New car', 'under_review', now() - interval '3 days')
  on conflict (reference) do nothing;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'loan_applications: skipped'; END $$;

DO $$ BEGIN
  insert into public.loan_repayments (loan_application_id, user_id, amount, currency, due_date, paid_at, status, reference) values
    ((select id from public.loan_applications where reference = 'LN-SEED-0001'), '00000000-0000-0000-0000-000000000001', 687.42, 'USD', current_date - interval '5 months', now() - interval '5 months', 'paid', 'RP-SEED-0001'),
    ((select id from public.loan_applications where reference = 'LN-SEED-0001'), '00000000-0000-0000-0000-000000000001', 687.42, 'USD', current_date - interval '4 months', now() - interval '4 months', 'paid', 'RP-SEED-0002'),
    ((select id from public.loan_applications where reference = 'LN-SEED-0001'), '00000000-0000-0000-0000-000000000001', 687.42, 'USD', current_date - interval '3 months', now() - interval '3 months', 'paid', 'RP-SEED-0003'),
    ((select id from public.loan_applications where reference = 'LN-SEED-0001'), '00000000-0000-0000-0000-000000000001', 687.42, 'USD', current_date - interval '2 months', now() - interval '2 months', 'paid', 'RP-SEED-0004'),
    ((select id from public.loan_applications where reference = 'LN-SEED-0001'), '00000000-0000-0000-0000-000000000001', 687.42, 'USD', current_date - interval '1 month', now() - interval '1 month', 'paid', 'RP-SEED-0005'),
    ((select id from public.loan_applications where reference = 'LN-SEED-0001'), '00000000-0000-0000-0000-000000000001', 687.42, 'USD', current_date + interval '1 month', null, 'scheduled', null);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'loan_repayments: skipped'; END $$;

DO $$ BEGIN
  insert into public.notifications (user_id, title, message, type, is_read, created_at) values
    ('00000000-0000-0000-0000-000000000001', 'Transfer completed', 'Your transfer of 1,200.00 USD to Jordan Blake was completed. Ref: NTB-LT0001.', 'transfer', true, now() - interval '3 days'),
    ('00000000-0000-0000-0000-000000000001', 'Deposit received', 'Your deposit of 5,000.00 USD was completed. Ref: DEP-SEED-0001.', 'deposit', true, now() - interval '2 days'),
    ('00000000-0000-0000-0000-000000000001', 'Loan application received', 'Your Auto Loan application (LN-SEED-0002) is under review.', 'loan', false, now() - interval '3 days'),
    ('00000000-0000-0000-0000-000000000001', 'Bitcoin swap completed', 'Swapped 2,000.00 USD to 0.024 BTC.', 'swap', false, now() - interval '5 days'),
    ('00000000-0000-0000-0000-000000000001', 'Card security alert', 'A new device was used to access your account. If this was you, no action is needed.', 'security', false, now() - interval '1 day');

  insert into public.notifications (user_id, title, message, type, is_read, is_global) values
    (null, 'System maintenance', 'Scheduled maintenance on Sunday 02:00 - 04:00 UTC. Online banking may be briefly unavailable.', 'system', false, true);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'notifications: skipped'; END $$;

-- Re-enable the profile trigger for normal runtime behaviour.
alter table public.profiles enable trigger on_profile_created;

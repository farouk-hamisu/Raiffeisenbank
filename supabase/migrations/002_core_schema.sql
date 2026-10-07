-- Raiffeisen Bank - Migration 002
-- Core database schema

-- ---------------------------------------------------------------------------
-- PROFILES
-- ---------------------------------------------------------------------------
create table public.profiles (
    id            uuid primary key references auth.users (id) on delete cascade,
    email         text not null,
    full_name     text not null default '',
    phone         text,
    avatar_url    text,
    date_of_birth date,
    address       text,
    city          text,
    country       text,
    status        text not null default 'active'
                  check (status in ('pending', 'active', 'suspended', 'closed')),
    kyc_status    text not null default 'pending'
                  check (kyc_status in ('pending', 'verified', 'rejected')),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- CURRENCIES
-- ---------------------------------------------------------------------------
create table public.currencies (
    id          uuid primary key default gen_random_uuid(),
    code        text not null unique,
    name        text not null,
    symbol      text not null default '$',
    is_base     boolean not null default false,
    enabled     boolean not null default true,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- EXCHANGE RATES
-- ---------------------------------------------------------------------------
create table public.exchange_rates (
    id               uuid primary key default gen_random_uuid(),
    base_currency    text not null references public.currencies (code),
    quote_currency   text not null references public.currencies (code),
    rate             numeric(20, 8) not null check (rate > 0),
    fee_percent      numeric(10, 4) not null default 0,
    updated_by       uuid references public.profiles (id),
    updated_at       timestamptz not null default now(),
    unique (base_currency, quote_currency)
);

-- ---------------------------------------------------------------------------
-- ACCOUNTS
-- ---------------------------------------------------------------------------
create table public.accounts (
    id             uuid primary key default gen_random_uuid(),
    user_id        uuid not null references public.profiles (id) on delete cascade,
    account_number text not null unique,
    account_name   text not null,
    account_type   text not null default 'checking'
                   check (account_type in ('checking', 'savings')),
    currency       text not null default 'USD' references public.currencies (code),
    status         text not null default 'active'
                   check (status in ('active', 'inactive', 'suspended', 'closed')),
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- ACCOUNT BALANCES
-- ---------------------------------------------------------------------------
create table public.account_balances (
    id               uuid primary key default gen_random_uuid(),
    account_id       uuid not null references public.accounts (id) on delete cascade,
    available_balance numeric(20, 2) not null default 0 check (available_balance >= 0),
    ledger_balance   numeric(20, 2) not null default 0,
    currency         text not null references public.currencies (code),
    updated_at       timestamptz not null default now(),
    unique (account_id)
);

-- ---------------------------------------------------------------------------
-- TRANSACTIONS
-- ---------------------------------------------------------------------------
create table public.transactions (
    id          uuid primary key default gen_random_uuid(),
    reference   text not null unique,
    user_id     uuid not null references public.profiles (id) on delete cascade,
    account_id  uuid references public.accounts (id),
    type        text not null check (type in (
                  'deposit', 'withdrawal', 'local_transfer', 'international_transfer',
                  'currency_swap', 'loan_disbursement', 'loan_repayment',
                  'fee', 'interest', 'reversal', 'adjustment'
                )),
    direction   text not null check (direction in ('credit', 'debit')),
    amount      numeric(20, 2) not null check (amount > 0),
    currency    text not null references public.currencies (code),
    fee         numeric(20, 2) not null default 0,
    status      text not null default 'pending' check (status in (
                  'pending', 'processing', 'completed', 'failed', 'cancelled', 'reversed'
                )),
    description text,
    sender      text,
    recipient   text,
    related_id  uuid,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- BENEFICIARIES
-- ---------------------------------------------------------------------------
create table public.beneficiaries (
    id                     uuid primary key default gen_random_uuid(),
    user_id                uuid not null references public.profiles (id) on delete cascade,
    name                   text not null,
    bank_name              text,
    account_number         text not null,
    swift_code             text,
    country                text,
    currency               text default 'USD' references public.currencies (code),
    is_international       boolean not null default false,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- LOCAL TRANSFERS
-- ---------------------------------------------------------------------------
create table public.local_transfers (
    id                      uuid primary key default gen_random_uuid(),
    reference               text not null unique,
    user_id                 uuid not null references public.profiles (id) on delete cascade,
    from_account_id         uuid not null references public.accounts (id),
    beneficiary_id          uuid references public.beneficiaries (id),
    recipient_name          text not null,
    recipient_account_number text not null,
    recipient_bank          text,
    amount                  numeric(20, 2) not null check (amount > 0),
    currency                text not null references public.currencies (code),
    fee                     numeric(20, 2) not null default 0,
    description             text,
    status                  text not null default 'pending' check (status in (
                              'pending', 'processing', 'completed', 'failed', 'cancelled', 'reversed'
                            )),
    completed_at            timestamptz,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- INTERNATIONAL TRANSFERS
-- ---------------------------------------------------------------------------
create table public.international_transfers (
    id                       uuid primary key default gen_random_uuid(),
    reference                text not null unique,
    user_id                  uuid not null references public.profiles (id) on delete cascade,
    from_account_id          uuid not null references public.accounts (id),
    beneficiary_id           uuid references public.beneficiaries (id),
    recipient_name           text not null,
    recipient_bank           text not null,
    recipient_account_number text not null,
    swift_code               text,
    recipient_country        text not null,
    purpose                  text,
    amount                   numeric(20, 2) not null check (amount > 0),
    currency                 text not null references public.currencies (code),
    exchange_rate            numeric(20, 8) not null default 1,
    fee                      numeric(20, 2) not null default 0,
    estimated_delivery       timestamptz,
    status                   text not null default 'pending' check (status in (
                                'pending', 'processing', 'completed', 'failed', 'cancelled', 'reversed'
                              )),
    completed_at             timestamptz,
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- CARDS
-- ---------------------------------------------------------------------------
create table public.cards (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references public.profiles (id) on delete cascade,
    account_id      uuid references public.accounts (id),
    card_number     text not null unique,
    masked_number   text not null,
    card_holder     text not null,
    card_type       text not null default 'debit' check (card_type in ('debit', 'credit', 'virtual')),
    card_brand      text not null default 'visa' check (card_brand in ('visa', 'mastercard')),
    expiry_month    int not null check (expiry_month between 1 and 12),
    expiry_year     int not null,
    cvv             text not null,
    spending_limit  numeric(20, 2) not null default 10000,
    status          text not null default 'active' check (status in ('active', 'frozen', 'blocked', 'expired')),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- CARD TRANSACTIONS
-- ---------------------------------------------------------------------------
create table public.card_transactions (
    id            uuid primary key default gen_random_uuid(),
    card_id       uuid not null references public.cards (id) on delete cascade,
    user_id       uuid not null references public.profiles (id) on delete cascade,
    merchant      text not null,
    amount        numeric(20, 2) not null check (amount > 0),
    currency      text not null references public.currencies (code),
    type          text not null default 'purchase' check (type in ('purchase', 'atm', 'refund', 'online')),
    status        text not null default 'completed' check (status in ('pending', 'completed', 'failed', 'reversed')),
    created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- DEPOSITS
-- ---------------------------------------------------------------------------
create table public.deposits (
    id          uuid primary key default gen_random_uuid(),
    reference   text not null unique,
    user_id     uuid not null references public.profiles (id) on delete cascade,
    account_id  uuid not null references public.accounts (id),
    amount      numeric(20, 2) not null check (amount > 0),
    currency    text not null references public.currencies (code),
    method      text not null check (method in ('cash', 'bank_transfer', 'cheque', 'card', 'online')),
    note        text,
    status      text not null default 'pending' check (status in (
                  'pending', 'processing', 'completed', 'failed', 'rejected'
                )),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- CURRENCY SWAPS
-- ---------------------------------------------------------------------------
create table public.currency_swaps (
    id            uuid primary key default gen_random_uuid(),
    reference     text not null unique,
    user_id       uuid not null references public.profiles (id) on delete cascade,
    account_id    uuid references public.accounts (id),
    from_currency text not null references public.currencies (code),
    to_currency   text not null references public.currencies (code),
    from_amount   numeric(20, 2) not null check (from_amount > 0),
    to_amount     numeric(20, 2) not null check (to_amount > 0),
    rate          numeric(20, 8) not null,
    fee           numeric(20, 2) not null default 0,
    status        text not null default 'completed' check (status in (
                    'pending', 'processing', 'completed', 'failed', 'cancelled'
                  )),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- LOAN PRODUCTS
-- ---------------------------------------------------------------------------
create table public.loan_products (
    id            uuid primary key default gen_random_uuid(),
    name          text not null,
    description   text,
    min_amount    numeric(20, 2) not null default 500,
    max_amount    numeric(20, 2) not null default 100000,
    interest_rate numeric(10, 4) not null default 5,
    term_months   int not null default 12 check (term_months > 0),
    enabled       boolean not null default true,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- LOAN APPLICATIONS
-- ---------------------------------------------------------------------------
create table public.loan_applications (
    id              uuid primary key default gen_random_uuid(),
    reference       text not null unique,
    user_id         uuid not null references public.profiles (id) on delete cascade,
    product_id      uuid not null references public.loan_products (id),
    amount          numeric(20, 2) not null check (amount > 0),
    currency        text not null default 'USD' references public.currencies (code),
    term_months     int not null,
    interest_rate   numeric(10, 4) not null,
    monthly_payment numeric(20, 2) not null default 0,
    purpose         text,
    status          text not null default 'pending' check (status in (
                      'pending', 'under_review', 'approved', 'rejected', 'active', 'completed', 'cancelled'
                    )),
    admin_note      text,
    disbursed_at    timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- LOAN REPAYMENTS
-- ---------------------------------------------------------------------------
create table public.loan_repayments (
    id                  uuid primary key default gen_random_uuid(),
    loan_application_id uuid not null references public.loan_applications (id) on delete cascade,
    user_id             uuid not null references public.profiles (id) on delete cascade,
    account_id          uuid references public.accounts (id),
    amount              numeric(20, 2) not null check (amount > 0),
    currency            text not null references public.currencies (code),
    due_date            date not null,
    paid_at             timestamptz,
    status              text not null default 'scheduled' check (status in ('scheduled', 'paid', 'overdue', 'skipped')),
    reference           text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS
-- ---------------------------------------------------------------------------
create table public.notifications (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid references public.profiles (id) on delete cascade,
    title       text not null,
    message     text not null,
    type        text not null default 'system' check (type in (
                  'transfer', 'deposit', 'loan', 'card', 'swap', 'security', 'account', 'system'
                )),
    is_read     boolean not null default false,
    is_global   boolean not null default false,
    created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- ADMIN ROLES
-- ---------------------------------------------------------------------------
create table public.admin_roles (
    id          uuid primary key default gen_random_uuid(),
    name        text not null unique,
    permissions text[] not null default '{}',
    created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- ADMIN USERS
-- ---------------------------------------------------------------------------
create table public.admin_users (
    id            uuid primary key default gen_random_uuid(),
    email         text not null unique,
    password_hash text not null,
    full_name     text not null default '',
    role_id       uuid references public.admin_roles (id),
    status        text not null default 'active' check (status in ('active', 'suspended')),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- ADMIN SESSIONS
-- ---------------------------------------------------------------------------
create table public.admin_sessions (
    id         uuid primary key default gen_random_uuid(),
    admin_id   uuid not null references public.admin_users (id) on delete cascade,
    token      text not null unique,
    ip_address text,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- AUDIT LOGS
-- ---------------------------------------------------------------------------
create table public.audit_logs (
    id              uuid primary key default gen_random_uuid(),
    admin_id        uuid references public.admin_users (id) on delete set null,
    admin_email     text,
    action          text not null,
    resource        text not null,
    resource_id     text,
    previous_value  jsonb,
    new_value       jsonb,
    ip_address      text,
    created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- SYSTEM SETTINGS
-- ---------------------------------------------------------------------------
create table public.system_settings (
    id          uuid primary key default gen_random_uuid(),
    key         text not null unique,
    value       jsonb not null,
    description text,
    updated_at  timestamptz not null default now()
);
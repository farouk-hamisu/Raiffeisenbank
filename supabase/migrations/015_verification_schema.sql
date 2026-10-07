-- Raiffeisen Bank - Migration 015
-- Admin-controlled verification workflow for cryptocurrency withdrawals and
-- international transfers, plus per-customer outgoing-transfer restrictions.

-- ---------------------------------------------------------------------------
-- 1. Expand transfer status vocabularies
-- ---------------------------------------------------------------------------
alter table public.international_transfers drop constraint if exists international_transfers_status_check;
alter table public.international_transfers
  add constraint international_transfers_status_check check (status in (
    'pending', 'awaiting_admin_verification', 'processing', 'completed',
    'failed', 'cancelled', 'rejected', 'reversed'
  ));

alter table public.transactions drop constraint if exists transactions_status_check;
alter table public.transactions
  add constraint transactions_status_check check (status in (
    'pending', 'awaiting_admin_verification', 'processing', 'completed',
    'failed', 'cancelled', 'rejected', 'reversed'
  ));

-- ---------------------------------------------------------------------------
-- 2. Idempotency key for international transfers (prevents duplicate submits)
-- ---------------------------------------------------------------------------
alter table public.international_transfers add column if not exists request_id text;
create unique index if not exists uq_intl_transfer_request
  on public.international_transfers (user_id, request_id) where request_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Per-customer outgoing transfer restriction
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists outgoing_transfers_enabled boolean not null default true;
alter table public.profiles
  add column if not exists outgoing_transfers_disabled_reason text;

-- ---------------------------------------------------------------------------
-- 4. Supported crypto assets (asset + network pairs)
-- ---------------------------------------------------------------------------
create table public.crypto_assets (
    asset         text not null,
    network       text not null,
    asset_label   text not null,
    network_label text not null,
    is_enabled    boolean not null default true,
    min_amount    numeric(20, 8) not null default 0,
    max_amount    numeric(20, 8) not null default 1000,
    rate_usd      numeric(20, 8) not null default 1,
    updated_at    timestamptz not null default now(),
    primary key (asset, network)
);

alter table public.crypto_assets enable row level security;
create policy "crypto_assets_select_all" on public.crypto_assets
  for select using (true);

insert into public.crypto_assets (asset, network, asset_label, network_label, is_enabled, min_amount, max_amount, rate_usd) values
  ('BTC',  'bitcoin', 'Bitcoin',    'Bitcoin (BTC)',              true, 0.0001, 5.0,   60000.0),
  ('ETH',  'erc20',   'Ethereum',   'Ethereum (ETH) · ERC-20',    true, 0.001,  50.0,  3000.0),
  ('USDT', 'trc20',   'Tether',     'Tether (USDT) · TRC-20',     true, 1,      20000, 1.0),
  ('USDT', 'erc20',   'Tether',     'Tether (USDT) · ERC-20',     true, 1,      20000, 1.0)
on conflict (asset, network) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Cryptocurrency withdrawals
-- ---------------------------------------------------------------------------
create table public.crypto_withdrawals (
    id              uuid primary key default gen_random_uuid(),
    reference       text not null unique,
    request_id      text,
    user_id         uuid not null references public.profiles (id) on delete cascade,
    from_account_id uuid not null references public.accounts (id),
    asset           text not null,
    network         text not null,
    wallet_address  text not null,
    amount          numeric(20, 8) not null check (amount > 0),
    amount_fiat     numeric(20, 2) not null,
    currency        text not null references public.currencies (code),
    rate            numeric(20, 8) not null default 1,
    fee             numeric(20, 2) not null default 0,
    status          text not null default 'pending' check (status in (
                      'pending', 'awaiting_admin_verification', 'processing',
                      'completed', 'failed', 'cancelled', 'rejected', 'reversed'
                    )),
    completed_at    timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create unique index if not exists uq_crypto_withdrawal_request
  on public.crypto_withdrawals (user_id, request_id) where request_id is not null;
create index if not exists idx_crypto_wd_user  on public.crypto_withdrawals (user_id);
create index if not exists idx_crypto_wd_status on public.crypto_withdrawals (status);

alter table public.crypto_withdrawals enable row level security;
create policy "crypto_wd_select_own" on public.crypto_withdrawals
  for select using (auth.uid() = user_id);
create policy "crypto_wd_insert_own" on public.crypto_withdrawals
  for insert with check (auth.uid() = user_id);

create trigger touch_crypto_wd_updated before update on public.crypto_withdrawals
  for each row execute procedure public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Transfer verification codes (hashed, short-lived, single-use)
-- ---------------------------------------------------------------------------
create table public.transfer_verification_codes (
    id           uuid primary key default gen_random_uuid(),
    transfer_type text not null check (transfer_type in ('international_transfer', 'crypto_withdrawal')),
    transfer_id  uuid not null,
    user_id      uuid not null references public.profiles (id) on delete cascade,
    code_hash    text not null,
    code_prefix  text not null,
    expires_at   timestamptz not null,
    max_attempts int not null default 3,
    attempts     int not null default 0,
    status       text not null default 'active' check (status in ('active', 'used', 'revoked', 'expired')),
    used_at      timestamptz,
    created_by   uuid references public.admin_users (id),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create index if not exists idx_vcode_transfer on public.transfer_verification_codes (transfer_type, transfer_id);
create index if not exists idx_vcode_user on public.transfer_verification_codes (user_id);

-- Backend-only: no client policies.
alter table public.transfer_verification_codes enable row level security;
revoke all on table public.transfer_verification_codes from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Transfer verification attempt history (for admins + audit)
-- ---------------------------------------------------------------------------
create table public.transfer_verification_logs (
    id           uuid primary key default gen_random_uuid(),
    transfer_type text not null,
    transfer_id  uuid not null,
    code_id      uuid,
    user_id      uuid references public.profiles (id) on delete cascade,
    result       text not null,
    attempts     int not null default 1,
    created_at   timestamptz not null default now()
);

create index if not exists idx_vlog_transfer on public.transfer_verification_logs (transfer_type, transfer_id);

alter table public.transfer_verification_logs enable row level security;
revoke all on table public.transfer_verification_logs from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Permissions + roles
-- ---------------------------------------------------------------------------
update public.admin_roles
  set permissions = permissions || array['verifications.view', 'verifications.manage']
where name in ('super_admin', 'admin')
  and not (permissions @> array['verifications.manage']);

-- ---------------------------------------------------------------------------
-- 9. System settings
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value, description) values
  ('crypto_withdrawal_fee', '1.00', 'Flat cryptocurrency withdrawal fee'),
  ('verification_code_ttl_minutes', '30', 'Lifetime of a transfer verification code in minutes'),
  ('verification_code_max_attempts', '3', 'Maximum attempts before a verification code is invalidated')
on conflict (key) do nothing;
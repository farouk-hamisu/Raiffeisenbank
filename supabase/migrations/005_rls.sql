-- Raiffeisen Bank - Migration 005
-- Row Level Security policies (customer data)

alter table public.profiles             enable row level security;
alter table public.accounts             enable row level security;
alter table public.account_balances     enable row level security;
alter table public.transactions         enable row level security;
alter table public.beneficiaries        enable row level security;
alter table public.local_transfers      enable row level security;
alter table public.international_transfers enable row level security;
alter table public.cards                enable row level security;
alter table public.card_transactions    enable row level security;
alter table public.deposits             enable row level security;
alter table public.currencies           enable row level security;
alter table public.exchange_rates       enable row level security;
alter table public.currency_swaps       enable row level security;
alter table public.loan_products        enable row level security;
alter table public.loan_applications    enable row level security;
alter table public.loan_repayments      enable row level security;
alter table public.notifications        enable row level security;
alter table public.admin_users          enable row level security;
alter table public.admin_roles          enable row level security;
alter table public.admin_sessions       enable row level security;
alter table public.audit_logs           enable row level security;
alter table public.system_settings      enable row level security;

-- ---------------------------------------------------------------------------
-- PROFILES : users manage their own
-- ---------------------------------------------------------------------------
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- ACCOUNTS : users manage their own
-- ---------------------------------------------------------------------------
create policy "accounts_select_own" on public.accounts
  for select using (auth.uid() = user_id);
create policy "accounts_insert_own" on public.accounts
  for insert with check (auth.uid() = user_id);
create policy "accounts_update_own" on public.accounts
  for update using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ACCOUNT BALANCES : users manage their own (balances never written by client)
-- ---------------------------------------------------------------------------
create policy "balances_select_own" on public.account_balances
  for select using (
    exists (
      select 1 from public.accounts a
      where a.id = account_id and a.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- TRANSACTIONS
-- ---------------------------------------------------------------------------
create policy "transactions_select_own" on public.transactions
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- BENEFICIARIES
-- ---------------------------------------------------------------------------
create policy "benef_select_own" on public.beneficiaries
  for select using (auth.uid() = user_id);
create policy "benef_insert_own" on public.beneficiaries
  for insert with check (auth.uid() = user_id);
create policy "benef_update_own" on public.beneficiaries
  for update using (auth.uid() = user_id);
create policy "benef_delete_own" on public.beneficiaries
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- LOCAL / INTERNATIONAL TRANSFERS
-- ---------------------------------------------------------------------------
create policy "local_tx_select_own" on public.local_transfers
  for select using (auth.uid() = user_id);
create policy "local_tx_insert_own" on public.local_transfers
  for insert with check (auth.uid() = user_id);

create policy "intl_tx_select_own" on public.international_transfers
  for select using (auth.uid() = user_id);
create policy "intl_tx_insert_own" on public.international_transfers
  for insert with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- CARDS + CARD TRANSACTIONS
-- ---------------------------------------------------------------------------
create policy "cards_select_own" on public.cards
  for select using (auth.uid() = user_id);
create policy "cards_insert_own" on public.cards
  for insert with check (auth.uid() = user_id);
create policy "cards_update_own" on public.cards
  for update using (auth.uid() = user_id);

create policy "card_tx_select_own" on public.card_transactions
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- DEPOSITS
-- ---------------------------------------------------------------------------
create policy "deposits_select_own" on public.deposits
  for select using (auth.uid() = user_id);
create policy "deposits_insert_own" on public.deposits
  for insert with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- CURRENCIES + EXCHANGE RATES : public read-only
-- ---------------------------------------------------------------------------
create policy "currencies_select_public" on public.currencies
  for select using (true);
create policy "rates_select_public" on public.exchange_rates
  for select using (true);

-- ---------------------------------------------------------------------------
-- CURRENCY SWAPS
-- ---------------------------------------------------------------------------
create policy "swaps_select_own" on public.currency_swaps
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- LOAN PRODUCTS : public read-only
-- ---------------------------------------------------------------------------
create policy "loan_products_select" on public.loan_products
  for select using (enabled);

-- ---------------------------------------------------------------------------
-- LOAN APPLICATIONS / REPAYMENTS
-- ---------------------------------------------------------------------------
create policy "loan_apps_select_own" on public.loan_applications
  for select using (auth.uid() = user_id);
create policy "loan_apps_insert_own" on public.loan_applications
  for insert with check (auth.uid() = user_id);

create policy "repay_select_own" on public.loan_repayments
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS
-- ---------------------------------------------------------------------------
create policy "notif_select_own" on public.notifications
  for select using (auth.uid() = user_id or is_global);
create policy "notif_update_own" on public.notifications
  for update using (auth.uid() = user_id);
create policy "notif_delete_own" on public.notifications
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ADMIN TABLES : no direct client access (admin flows through security definer fns)
-- ---------------------------------------------------------------------------
create policy "admin_users_no_access" on public.admin_users for all using (false);
create policy "admin_roles_no_access" on public.admin_roles for all using (false);
create policy "admin_sessions_no_access" on public.admin_sessions for all using (false);
create policy "audit_logs_no_access" on public.audit_logs for all using (false);
create policy "system_settings_no_access" on public.system_settings for all using (false);
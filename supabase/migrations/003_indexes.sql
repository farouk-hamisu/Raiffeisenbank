-- Raiffeisen Bank - Migration 003
-- Indexes for frequently queried fields

create index if not exists idx_profiles_email      on public.profiles (email);
create index if not exists idx_profiles_status     on public.profiles (status);

create index if not exists idx_accounts_user_id    on public.accounts (user_id);
create index if not exists idx_accounts_status     on public.accounts (status);
create index if not exists idx_accounts_currency   on public.accounts (currency);

create index if not exists idx_balances_account    on public.account_balances (account_id);

create index if not exists idx_tx_user_id          on public.transactions (user_id);
create index if not exists idx_tx_account_id       on public.transactions (account_id);
create index if not exists idx_tx_status           on public.transactions (status);
create index if not exists idx_tx_created_at       on public.transactions (created_at desc);
create index if not exists idx_tx_type             on public.transactions (type);

create index if not exists idx_benef_user_id       on public.beneficiaries (user_id);

create index if not exists idx_local_tx_user       on public.local_transfers (user_id);
create index if not exists idx_local_tx_status     on public.local_transfers (status);

create index if not exists idx_intl_tx_user        on public.international_transfers (user_id);
create index if not exists idx_intl_tx_status      on public.international_transfers (status);

create index if not exists idx_cards_user_id       on public.cards (user_id);
create index if not exists idx_cards_status        on public.cards (status);
create index if not exists idx_cards_account       on public.cards (account_id);

create index if not exists idx_card_tx_card        on public.card_transactions (card_id);
create index if not exists idx_card_tx_user        on public.card_transactions (user_id);

create index if not exists idx_deposits_user       on public.deposits (user_id);
create index if not exists idx_deposits_status     on public.deposits (status);

create index if not exists idx_swaps_user          on public.currency_swaps (user_id);
create index if not exists idx_swaps_created       on public.currency_swaps (created_at desc);

create index if not exists idx_loans_user          on public.loan_applications (user_id);
create index if not exists idx_loans_status        on public.loan_applications (status);
create index if not exists idx_loans_product       on public.loan_applications (product_id);

create index if not exists idx_repay_loan          on public.loan_repayments (loan_application_id);
create index if not exists idx_repay_status        on public.loan_repayments (status);

create index if not exists idx_notif_user          on public.notifications (user_id);
create index if not exists idx_notif_read          on public.notifications (is_read);

create index if not exists idx_audit_admin         on public.audit_logs (admin_id);
create index if not exists idx_audit_created       on public.audit_logs (created_at desc);
create index if not exists idx_audit_resource      on public.audit_logs (resource);
-- Raiffeisen Bank - Migration 004
-- Helper + financial functions (atomic financial operations)

-- ---------------------------------------------------------------------------
-- Generate a unique bank reference
-- ---------------------------------------------------------------------------
create or replace function public.generate_reference(prefix text)
returns text
language sql
volatile
as $$
  select upper(prefix || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
$$;

-- ---------------------------------------------------------------------------
-- Updated-at trigger helper
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Create a notification
-- ---------------------------------------------------------------------------
create or replace function public.notify_user(
  p_user_id uuid,
  p_title text,
  p_message text,
  p_type text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_id, title, message, type)
  values (p_user_id, p_title, p_message, p_type);
end;
$$;

-- ---------------------------------------------------------------------------
-- On new auth user -> create profile
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Credit / debit an account balance (internal)
-- ---------------------------------------------------------------------------
create or replace function public.apply_balance_change(
  p_account_id uuid,
  p_delta numeric,
  p_currency text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.accounts%rowtype;
begin
  select * into v_account from public.accounts where id = p_account_id for update;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;
  if v_account.currency <> p_currency then
    raise exception 'CURRENCY_MISMATCH';
  end if;

  insert into public.account_balances (account_id, available_balance, ledger_balance, currency)
  values (p_account_id, p_delta, p_delta, p_currency)
  on conflict (account_id) do update
    set available_balance = account_balances.available_balance + p_delta,
        ledger_balance     = account_balances.ledger_balance + p_delta,
        updated_at         = now();

  if (select available_balance from public.account_balances where account_id = p_account_id) < 0 then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Create a transaction record (internal)
-- ---------------------------------------------------------------------------
create or replace function public.record_transaction(
  p_user_id uuid,
  p_account_id uuid,
  p_type text,
  p_direction text,
  p_amount numeric,
  p_currency text,
  p_status text,
  p_description text,
  p_sender text,
  p_recipient text,
  p_fee numeric default 0,
  p_related_id uuid default null
)
returns public.transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx public.transactions;
begin
  insert into public.transactions (
    reference, user_id, account_id, type, direction, amount, currency, status,
    description, sender, recipient, fee, related_id
  ) values (
    public.generate_reference('NTB'), p_user_id, p_account_id, p_type, p_direction,
    p_amount, p_currency, p_status, p_description, p_sender, p_recipient, p_fee, p_related_id
  )
  returning * into v_tx;
  return v_tx;
end;
$$;

-- ---------------------------------------------------------------------------
-- LOCAL TRANSFER (atomic)
--   Validate user/account/balance, debit, create transfer + transaction,
--   optionally credit the recipient's internal account, notify, and return reference.
-- ---------------------------------------------------------------------------
create or replace function public.create_local_transfer(
  p_user_id uuid,
  p_from_account_id uuid,
  p_recipient_name text,
  p_recipient_account_number text,
  p_recipient_bank text,
  p_amount numeric,
  p_currency text,
  p_description text,
  p_internal_recipient uuid default null
)
returns public.local_transfers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.accounts%rowtype;
  v_balance numeric;
  v_fee numeric;
  v_transfer public.local_transfers;
  v_sender_name text;
begin
  -- Validate user owns account
  select * into v_account from public.accounts
    where id = p_from_account_id and user_id = p_user_id and status = 'active' for update;
  if not found then
    raise exception 'INVALID_ACCOUNT';
  end if;

  select available_balance into v_balance from public.account_balances
    where account_id = p_from_account_id;
  if v_balance is null or v_balance < p_amount then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  select full_name into v_sender_name from public.profiles where id = p_user_id;

  v_fee := 0;

  -- Debit source account (amount)
  perform public.apply_balance_change(p_from_account_id, -p_amount, p_currency);

  -- Create transfer record (status completed for demo/internal transfers)
  insert into public.local_transfers (
    reference, user_id, from_account_id, recipient_name, recipient_account_number,
    recipient_bank, amount, currency, fee, description, status, completed_at
  ) values (
    public.generate_reference('LT'), p_user_id, p_from_account_id, p_recipient_name,
    p_recipient_account_number, p_recipient_bank, p_amount, p_currency, v_fee,
    p_description, 'completed', now()
  ) returning * into v_transfer;

  -- Record debit transaction
  perform public.record_transaction(
    p_user_id, p_from_account_id, 'local_transfer', 'debit', p_amount, p_currency,
    'completed', coalesce(p_description, 'Local transfer'),
    v_sender_name, p_recipient_name, v_fee, v_transfer.id
  );

  -- If internal recipient, credit them
  if p_internal_recipient is not null then
    declare
      v_dest public.accounts%rowtype;
    begin
      select * into v_dest from public.accounts
        where user_id = p_internal_recipient and currency = p_currency
        order by created_at limit 1;
      if found then
        perform public.apply_balance_change(v_dest.id, p_amount, p_currency);
        perform public.record_transaction(
          p_internal_recipient, v_dest.id, 'local_transfer', 'credit', p_amount, p_currency,
          'completed', 'Incoming local transfer', p_recipient_name, v_sender_name, 0, v_transfer.id
        );
        perform public.notify_user(p_internal_recipient,
          'Transfer received',
          'You received ' || to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency ||
          ' from ' || coalesce(v_sender_name, 'a customer') || '.',
          'transfer');
      end if;
    end;
  end if;

  perform public.notify_user(p_user_id,
    'Transfer completed',
    'Your transfer of ' || to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency ||
    ' to ' || p_recipient_name || ' was completed. Ref: ' || v_transfer.reference || '.',
    'transfer');

  return v_transfer;
end;
$$;

-- ---------------------------------------------------------------------------
-- CURRENCY SWAP (atomic)
--   Fetch live rate, compute fees, debit source, credit destination (in USD accounts
--   this is represented as a debit transaction of the source and a credit transaction
--   of the converted amount where possible).
-- ---------------------------------------------------------------------------
create or replace function public.create_currency_swap(
  p_user_id uuid,
  p_account_id uuid,
  p_from_currency text,
  p_to_currency text,
  p_from_amount numeric
)
returns public.currency_swaps
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rate numeric;
  v_fee_pct numeric;
  v_fee numeric;
  v_to_amount numeric;
  v_account public.accounts%rowtype;
  v_balance numeric;
  v_swap public.currency_swaps;
  v_name text;
begin
  select * into v_account from public.accounts
    where id = p_account_id and user_id = p_user_id and status = 'active' for update;
  if not found then
    raise exception 'INVALID_ACCOUNT';
  end if;

  if p_from_currency = p_to_currency then
    raise exception 'SAME_CURRENCY';
  end if;

  select rate, fee_percent into v_rate, v_fee_pct
    from public.exchange_rates
    where base_currency = p_from_currency and quote_currency = p_to_currency;
  if not found then
    raise exception 'RATE_NOT_AVAILABLE';
  end if;

  select available_balance into v_balance from public.account_balances where account_id = p_account_id;
  if v_balance is null or v_balance < p_from_amount then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  v_fee := round(p_from_amount * coalesce(v_fee_pct, 0) / 100, 2);
  v_to_amount := round((p_from_amount - v_fee) * v_rate, 2);

  select full_name into v_name from public.profiles where id = p_user_id;

  -- Debit the from amount + fee from source account
  perform public.apply_balance_change(p_account_id, -(p_from_amount + v_fee), p_from_currency);

  insert into public.currency_swaps (
    reference, user_id, account_id, from_currency, to_currency, from_amount, to_amount,
    rate, fee, status
  ) values (
    public.generate_reference('SW'), p_user_id, p_account_id, p_from_currency, p_to_currency,
    p_from_amount, v_to_amount, v_rate, v_fee, 'completed'
  ) returning * into v_swap;

  perform public.record_transaction(
    p_user_id, p_account_id, 'currency_swap', 'debit', p_from_amount, p_from_currency,
    'completed', 'Currency swap ' || p_from_currency || ' to ' || p_to_currency,
    v_name, p_from_currency || ' -> ' || p_to_currency, v_fee, v_swap.id
  );

  perform public.notify_user(p_user_id,
    'Currency swap completed',
    'Swapped ' || to_char(p_from_amount, 'FM9,999,999,990.00') || ' ' || p_from_currency ||
    ' to ' || to_char(v_to_amount, 'FM9,999,999,990.00') || ' ' || p_to_currency || '.',
    'swap');

  -- Credit a matching destination account if the customer holds one
  declare
    v_dest public.accounts%rowtype;
  begin
    select * into v_dest from public.accounts
      where user_id = p_user_id and currency = p_to_currency and status = 'active'
      order by created_at limit 1;
    if found then
      perform public.apply_balance_change(v_dest.id, v_to_amount, p_to_currency);
      perform public.record_transaction(
        p_user_id, v_dest.id, 'currency_swap', 'credit', v_to_amount, p_to_currency,
        'completed', 'Currency swap ' || p_from_currency || ' to ' || p_to_currency,
        p_from_currency || ' -> ' || p_to_currency, v_name, 0, v_swap.id
      );
    end if;
  end;

  return v_swap;
end;
$$;

-- ---------------------------------------------------------------------------
-- LOAN REPAYMENT (atomic)
-- ---------------------------------------------------------------------------
create or replace function public.pay_loan_repayment(
  p_user_id uuid,
  p_repayment_id uuid,
  p_account_id uuid
)
returns public.loan_repayments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_repayment public.loan_repayments%rowtype;
  v_account public.accounts%rowtype;
  v_balance numeric;
begin
  select * into v_repayment from public.loan_repayments
    where id = p_repayment_id and user_id = p_user_id and status = 'scheduled' for update;
  if not found then
    raise exception 'REPAYMENT_NOT_FOUND';
  end if;

  select * into v_account from public.accounts
    where id = p_account_id and user_id = p_user_id and status = 'active' for update;
  if not found then
    raise exception 'INVALID_ACCOUNT';
  end if;

  select available_balance into v_balance from public.account_balances where account_id = p_account_id;
  if v_balance is null or v_balance < v_repayment.amount then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  perform public.apply_balance_change(p_account_id, -v_repayment.amount, v_repayment.currency);

  update public.loan_repayments
    set status = 'paid', paid_at = now(), reference = public.generate_reference('RP'),
        account_id = p_account_id
    where id = v_repayment.id
    returning * into v_repayment;

  perform public.record_transaction(
    p_user_id, p_account_id, 'loan_repayment', 'debit', v_repayment.amount, v_repayment.currency,
    'completed', 'Loan repayment', 'Raiffeisen Bank',
    coalesce((select name from public.loan_products lp
      join public.loan_applications la on la.product_id = lp.id
      where la.id = v_repayment.loan_application_id), 'Loan repayment'),
    0, v_repayment.loan_application_id
  );

  -- If all repayments are paid, mark loan completed
  update public.loan_applications set status = 'completed'
    where id = v_repayment.loan_application_id
      and not exists (
        select 1 from public.loan_repayments lr
        where lr.loan_application_id = v_repayment.loan_application_id and lr.status <> 'paid'
      );

  return v_repayment;
end;
$$;
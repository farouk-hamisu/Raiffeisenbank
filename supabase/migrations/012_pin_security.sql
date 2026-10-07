-- Raiffeisen Bank - Migration 012
-- 4-digit customer security PIN
--  1. customer_pins table (bcrypt hash + failed-attempt lockout). No grants
--     and no RLS policies -> invisible and unmodifiable via the client API.
--  2. Internal hash/verify helpers (SECURITY DEFINER, revoked from clients).
--  3. Customer RPCs: set_customer_pin (setup/change), customer_verify_pin (login),
--     customer_has_pin (app-shell guard).
--  4. Signup: handle_new_user stores the hashed PIN from raw_user_meta_data.pin.
--  5. Every customer money-movement RPC now takes p_pin (backend-enforced) and
--     requires p_user_id to match auth.uid() (closes spoofed-user gap).
--  6. Deposit + loan-application creation converted to PIN-enforced RPCs.
--  7. Revokes/grants.

-- ---------------------------------------------------------------------------
-- 1. customer_pins (secret hash table)
-- ---------------------------------------------------------------------------
create table if not exists public.customer_pins (
  user_id         uuid primary key references public.profiles (id) on delete cascade,
  pin_hash        text not null,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  updated_at      timestamptz not null default now()
);

alter table public.customer_pins enable row level security;
-- No policies and no grants: only SECURITY DEFINER functions (owner) can touch it.
-- Supabase's default ACLs grant anon/authenticated table privileges automatically,
-- so revoke them explicitly (RLS also blocks every row/policy-less access).
revoke all on table public.customer_pins from anon, authenticated, service_role;
comment on table public.customer_pins is 'Hashed 4-digit customer PIN. Not directly accessible via the API.';

-- ---------------------------------------------------------------------------
-- 2. Internal hash + verify helpers (with committed lockout)
-- ---------------------------------------------------------------------------
create or replace function public.hash_customer_pin(p_pin text)
returns text
language sql
security definer
set search_path = public, extensions
as $$
  select crypt(p_pin, gen_salt('bf', 10));
$$;

-- Returns a status string; never raises for wrong/locked so the failed-attempt
-- counter and lock timestamp COMMIT with the calling statement (an exception
-- inside the same transaction would roll them back and defeat the lockout).
--   'ok'            -> correct PIN (attempts reset)
--   'invalid'       -> wrong PIN (attempt counter advanced / lock applied)
--   'invalid_format'-> PIN not exactly 4 digits
--   'not_set'       -> no PIN row
--   'locked'        -> locked_until is in the future
create or replace function public.verify_customer_pin(
  p_user_id uuid,
  p_pin     text
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_rec public.customer_pins%rowtype;
  v_ok   boolean;
  v_fail integer;
begin
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    return 'invalid_format';
  end if;

  select * into v_rec from public.customer_pins where user_id = p_user_id;
  if not found then
    return 'not_set';
  end if;

  -- An expired lock yields a fresh window of attempts.
  if v_rec.locked_until is not null and v_rec.locked_until <= now() then
    v_rec.failed_attempts := 0;
    v_rec.locked_until    := null;
  end if;
  if v_rec.locked_until is not null then
    return 'locked';
  end if;

  v_ok := crypt(p_pin, v_rec.pin_hash) = v_rec.pin_hash;
  if v_ok then
    update public.customer_pins
      set failed_attempts = 0, locked_until = null, updated_at = now()
      where user_id = p_user_id;
    return 'ok';
  end if;

  v_fail := v_rec.failed_attempts + 1;
  if v_fail >= 5 then
    update public.customer_pins
      set failed_attempts = 0, locked_until = now() + interval '15 minutes', updated_at = now()
      where user_id = p_user_id;
  else
    update public.customer_pins
      set failed_attempts = v_fail, updated_at = now()
      where user_id = p_user_id;
  end if;
  return 'invalid';
end;
$$;

-- Raise the correct exception for a PIN that must be satisfied (money RPCs).
create or replace function public.require_customer_pin(
  p_user_id uuid,
  p_pin     text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := public.verify_customer_pin(p_user_id, p_pin);
begin
  if v_status = 'locked' then
    raise exception 'PIN_LOCKED';
  elsif v_status = 'not_set' then
    raise exception 'PIN_NOT_SET';
  elsif v_status <> 'ok' then
    raise exception 'INVALID_PIN';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Customer-facing PIN RPCs
-- ---------------------------------------------------------------------------
create or replace function public.set_customer_pin(
  p_pin         text,
  p_current_pin text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'UNAUTHORIZED';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    raise exception 'INVALID_PIN_FORMAT';
  end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- Changing an existing PIN requires the current PIN (first-time setup does not).
  if exists (select 1 from public.customer_pins where user_id = v_uid) then
    if p_current_pin is null or public.verify_customer_pin(v_uid, p_current_pin) <> 'ok' then
      raise exception 'INVALID_PIN';
    end if;
  end if;

  insert into public.customer_pins (user_id, pin_hash, failed_attempts, locked_until, updated_at)
  values (v_uid, public.hash_customer_pin(p_pin), 0, null, now())
  on conflict (user_id) do update
    set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now();
end;
$$;

-- Login / sensitive-op gate. Returns a JSON status (never raises except for
-- unauthenticated callers) so the counter commits and the UI can act on it.
create or replace function public.customer_verify_pin(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid      uuid := auth.uid();
  v_status   text;
  v_attempts int;
  v_locked   timestamptz;
begin
  if v_uid is null then
    raise exception 'UNAUTHORIZED';
  end if;
  v_status := public.verify_customer_pin(v_uid, p_pin);
  select failed_attempts, locked_until into v_attempts, v_locked
    from public.customer_pins where user_id = v_uid;
  return jsonb_build_object(
    'status', v_status,
    'attempts_left', greatest(0, 5 - coalesce(v_attempts, 0)),
    'locked_until', to_char(v_locked, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

create or replace function public.customer_has_pin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from public.customer_pins where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- 4. Signup: store hashed PIN from raw_user_meta_data.pin
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pin text := new.raw_user_meta_data ->> 'pin';
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;

  if v_pin is not null and v_pin ~ '^[0-9]{4}$' then
    insert into public.customer_pins (user_id, pin_hash, updated_at)
    values (new.id, public.hash_customer_pin(v_pin), now())
    on conflict (user_id) do update
      set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now();
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Money-movement RPCs: add p_pin + enforce auth.uid() ownership
-- ---------------------------------------------------------------------------
drop function if exists public.create_local_transfer(uuid, uuid, text, text, text, numeric, text, text, uuid);
create or replace function public.create_local_transfer(
  p_user_id               uuid,
  p_from_account_id       uuid,
  p_recipient_name        text,
  p_recipient_account_number text,
  p_recipient_bank        text,
  p_amount                numeric,
  p_currency              text,
  p_description           text,
  p_internal_recipient    uuid default null,
  p_pin                   text default null
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
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  perform public.require_customer_pin(p_user_id, p_pin);

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

  perform public.apply_balance_change(p_from_account_id, -p_amount, p_currency);

  insert into public.local_transfers (
    reference, user_id, from_account_id, recipient_name, recipient_account_number,
    recipient_bank, amount, currency, fee, description, status, completed_at
  ) values (
    public.generate_reference('LT'), p_user_id, p_from_account_id, p_recipient_name,
    p_recipient_account_number, p_recipient_bank, p_amount, p_currency, v_fee,
    p_description, 'completed', now()
  ) returning * into v_transfer;

  perform public.record_transaction(
    p_user_id, p_from_account_id, 'local_transfer', 'debit', p_amount, p_currency,
    'completed', coalesce(p_description, 'Local transfer'),
    v_sender_name, p_recipient_name, v_fee, v_transfer.id
  );

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

drop function if exists public.create_currency_swap(uuid, uuid, text, text, numeric);
create or replace function public.create_currency_swap(
  p_user_id       uuid,
  p_account_id    uuid,
  p_from_currency text,
  p_to_currency   text,
  p_from_amount   numeric,
  p_pin           text default null,
  p_rate          numeric default null
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
  v_dest_id uuid;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  perform public.require_customer_pin(p_user_id, p_pin);

  select * into v_account from public.accounts
    where id = p_account_id and user_id = p_user_id and status = 'active' for update;
  if not found then
    raise exception 'INVALID_ACCOUNT';
  end if;

  if p_from_currency = p_to_currency then
    raise exception 'SAME_CURRENCY';
  end if;

  -- Try table lookup first; fall back to frontend-supplied rate if missing
  select rate, fee_percent into v_rate, v_fee_pct
    from public.exchange_rates
    where base_currency = p_from_currency and quote_currency = p_to_currency;

  if v_rate is null and p_rate is not null and p_rate > 0 then
    v_rate := p_rate;
    v_fee_pct := 0.5;
    -- Upsert the rate for next time
    insert into public.exchange_rates (base_currency, quote_currency, rate, fee_percent)
    values (p_from_currency, p_to_currency, p_rate, v_fee_pct)
    on conflict (base_currency, quote_currency) do update
      set rate = excluded.rate, fee_percent = excluded.fee_percent, updated_at = now();
  end if;

  if v_rate is null then
    raise exception 'RATE_NOT_AVAILABLE';
  end if;

  v_fee := round(p_from_amount * coalesce(v_fee_pct, 0) / 100, 2);

  select available_balance into v_balance from public.account_balances where account_id = p_account_id;
  if v_balance is null or v_balance < (p_from_amount + v_fee) then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  v_to_amount := round((p_from_amount - v_fee) * v_rate, 2);

  select full_name into v_name from public.profiles where id = p_user_id;

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

  select id into v_dest_id from public.accounts
    where user_id = p_user_id and currency = p_to_currency and status = 'active'
    order by created_at limit 1;
  if not found then
    insert into public.accounts (user_id, account_number, account_name, account_type, currency, status)
    values (p_user_id, public.generate_account_number(), coalesce(v_name, ''), 'checking', p_to_currency, 'active')
    returning id into v_dest_id;
    insert into public.account_balances (account_id, available_balance, ledger_balance, currency)
    values (v_dest_id, 0, 0, p_to_currency);
  end if;

  perform public.apply_balance_change(v_dest_id, v_to_amount, p_to_currency);
  perform public.record_transaction(
    p_user_id, v_dest_id, 'currency_swap', 'credit', v_to_amount, p_to_currency,
    'completed', 'Currency swap ' || p_from_currency || ' to ' || p_to_currency,
    p_from_currency || ' -> ' || p_to_currency, v_name, 0, v_swap.id
  );

  return v_swap;
end;
$$;

drop function if exists public.pay_loan_repayment(uuid, uuid, uuid);
create or replace function public.pay_loan_repayment(
  p_user_id       uuid,
  p_repayment_id  uuid,
  p_account_id    uuid,
  p_pin           text default null
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
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  perform public.require_customer_pin(p_user_id, p_pin);

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

  update public.loan_applications set status = 'completed'
    where id = v_repayment.loan_application_id
      and not exists (
        select 1 from public.loan_repayments lr
        where lr.loan_application_id = v_repayment.loan_application_id and lr.status <> 'paid'
      );

  return v_repayment;
end;
$$;

drop function if exists public.create_international_transfer(uuid, uuid, text, text, text, text, text, numeric, text, text);
create or replace function public.create_international_transfer(
  p_user_id               uuid,
  p_from_account_id       uuid,
  p_recipient_name        text,
  p_recipient_bank        text,
  p_recipient_account_number text,
  p_swift_code            text,
  p_recipient_country     text,
  p_amount                numeric,
  p_currency              text,
  p_purpose               text default null,
  p_pin                   text default null
)
returns public.international_transfers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.accounts%rowtype;
  v_balance numeric;
  v_fee numeric;
  v_rate numeric;
  v_xfer public.international_transfers;
  v_name text;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  perform public.require_customer_pin(p_user_id, p_pin);

  select * into v_account from public.accounts
    where id = p_from_account_id and user_id = p_user_id and status = 'active' for update;
  if not found then
    raise exception 'INVALID_ACCOUNT';
  end if;

  select available_balance into v_balance from public.account_balances where account_id = p_from_account_id;
  if v_balance is null then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  select coalesce((value::text)::numeric, 15) into v_fee
    from public.system_settings where key = 'intl_transfer_fee';
  if v_fee is null then v_fee := 15; end if;

  if v_balance < (p_amount + v_fee) then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  v_rate := 1;

  select full_name into v_name from public.profiles where id = p_user_id;

  perform public.apply_balance_change(p_from_account_id, -(p_amount + v_fee), p_currency);

  insert into public.international_transfers (
    reference, user_id, from_account_id, recipient_name, recipient_bank, recipient_account_number,
    swift_code, recipient_country, purpose, amount, currency, exchange_rate, fee,
    estimated_delivery, status, completed_at
  ) values (
    public.generate_reference('IT'), p_user_id, p_from_account_id, p_recipient_name, p_recipient_bank,
    p_recipient_account_number, p_swift_code, p_recipient_country, p_purpose, p_amount, p_currency,
    v_rate, v_fee, now() + interval '2 days', 'processing', null
  ) returning * into v_xfer;

  perform public.record_transaction(
    p_user_id, p_from_account_id, 'international_transfer', 'debit', p_amount, p_currency,
    'processing', coalesce(p_purpose, 'International transfer'),
    v_name, p_recipient_name || ' (' || p_recipient_country || ')', v_fee, v_xfer.id
  );

  perform public.notify_user(p_user_id,
    'International transfer submitted',
    'Your international transfer of ' || to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency ||
    ' to ' || p_recipient_name || ' has been submitted. Ref: ' || v_xfer.reference || '.',
    'transfer');

  return v_xfer;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Deposit + loan-application creation (PIN-enforced RPCs)
-- ---------------------------------------------------------------------------
create or replace function public.create_customer_deposit(
  p_user_id    uuid,
  p_account_id uuid,
  p_amount     numeric,
  p_currency   text,
  p_method     text,
  p_note       text default null,
  p_pin        text default null
)
returns public.deposits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.accounts%rowtype;
  v_deposit public.deposits;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  perform public.require_customer_pin(p_user_id, p_pin);

  select * into v_account from public.accounts
    where id = p_account_id and user_id = p_user_id and status = 'active';
  if not found then
    raise exception 'INVALID_ACCOUNT';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT';
  end if;
  if p_method is null or p_method not in ('cash', 'bank_transfer', 'cheque', 'card', 'online') then
    raise exception 'INVALID_METHOD';
  end if;

  insert into public.deposits (reference, user_id, account_id, amount, currency, method, note, status)
  values (
    public.generate_reference('DEP'), p_user_id, p_account_id, p_amount, p_currency, p_method,
    p_note, 'pending'
  ) returning * into v_deposit;

  perform public.notify_user(p_user_id,
    'Deposit submitted',
    'Your deposit request of ' || to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency ||
    ' was submitted for review. Ref: ' || v_deposit.reference || '.',
    'deposit');

  return v_deposit;
end;
$$;

create or replace function public.submit_loan_application(
  p_user_id      uuid,
  p_product_id   uuid,
  p_amount       numeric,
  p_term_months  int,
  p_purpose      text default null,
  p_pin          text default null
)
returns public.loan_applications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.loan_products%rowtype;
  v_rate numeric;
  v_monthly numeric;
  v_loan public.loan_applications;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  perform public.require_customer_pin(p_user_id, p_pin);

  select * into v_product from public.loan_products where id = p_product_id and enabled = true;
  if not found then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;

  if p_amount is null or p_amount < v_product.min_amount or p_amount > v_product.max_amount then
    raise exception 'INVALID_AMOUNT';
  end if;
  if p_term_months is null or p_term_months <= 0 then
    raise exception 'INVALID_TERM';
  end if;

  v_rate := v_product.interest_rate;
  if v_rate = 0 then
    v_monthly := p_amount / p_term_months;
  else
    v_monthly := p_amount * (v_rate / 100 / 12) /
      (1 - power(1 + (v_rate / 100 / 12), -p_term_months));
  end if;

  insert into public.loan_applications (
    reference, user_id, product_id, amount, currency, term_months, interest_rate,
    monthly_payment, purpose, status
  ) values (
    public.generate_reference('LN'), p_user_id, p_product_id, p_amount, 'USD',
    p_term_months, v_rate, round(v_monthly, 2), p_purpose, 'pending'
  ) returning * into v_loan;

  return v_loan;
end;
$$;

-- Card control RPCs (PIN-enforced, ownership-checked)
create or replace function public.customer_freeze_card(
  p_user_id uuid,
  p_card_id uuid,
  p_pin     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.cards%rowtype;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  perform public.require_customer_pin(p_user_id, p_pin);

  select * into v_card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if not found then
    raise exception 'CARD_NOT_FOUND';
  end if;

  update public.cards set status = 'frozen', updated_at = now() where id = p_card_id;
  perform public.notify_user(p_user_id, 'Card frozen',
    'Your card ending ' || right(v_card.masked_number, 4) || ' has been frozen.', 'card');
end;
$$;

create or replace function public.customer_unfreeze_card(
  p_user_id uuid,
  p_card_id uuid,
  p_pin     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.cards%rowtype;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  perform public.require_customer_pin(p_user_id, p_pin);

  select * into v_card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if not found then
    raise exception 'CARD_NOT_FOUND';
  end if;

  update public.cards set status = 'active', updated_at = now() where id = p_card_id;
  perform public.notify_user(p_user_id, 'Card unfrozen',
    'Your card ending ' || right(v_card.masked_number, 4) || ' is active again.', 'card');
end;
$$;

create or replace function public.customer_set_card_limit(
  p_user_id uuid,
  p_card_id uuid,
  p_limit   numeric,
  p_pin     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.cards%rowtype;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  perform public.require_customer_pin(p_user_id, p_pin);

  if p_limit is null or p_limit < 0 then
    raise exception 'INVALID_LIMIT';
  end if;

  select * into v_card from public.cards where id = p_card_id and user_id = p_user_id for update;
  if not found then
    raise exception 'CARD_NOT_FOUND';
  end if;

  update public.cards set spending_limit = p_limit, updated_at = now() where id = p_card_id;
  perform public.notify_user(p_user_id, 'Card limit updated',
    'Your card ending ' || right(v_card.masked_number, 4) || ' spending limit is now ' ||
    to_char(p_limit, 'FM9,999,999,990.00') || '.', 'card');
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Revokes + grants
-- ---------------------------------------------------------------------------
revoke execute on function public.hash_customer_pin(text) from public, anon, authenticated;
revoke execute on function public.verify_customer_pin(uuid, text) from public, anon, authenticated;
revoke execute on function public.require_customer_pin(uuid, text) from public, anon, authenticated;

grant execute on function public.set_customer_pin(text, text) to anon, authenticated;
grant execute on function public.customer_verify_pin(text) to anon, authenticated;
grant execute on function public.customer_has_pin() to anon, authenticated;

grant execute on function public.create_local_transfer(uuid, uuid, text, text, text, numeric, text, text, uuid, text) to anon, authenticated;
grant execute on function public.create_currency_swap(uuid, uuid, text, text, numeric, text, numeric) to anon, authenticated;
grant execute on function public.pay_loan_repayment(uuid, uuid, uuid, text) to anon, authenticated;
grant execute on function public.create_international_transfer(uuid, uuid, text, text, text, text, text, numeric, text, text, text) to anon, authenticated;
grant execute on function public.create_customer_deposit(uuid, uuid, numeric, text, text, text, text) to anon, authenticated;
grant execute on function public.submit_loan_application(uuid, uuid, numeric, integer, text, text) to anon, authenticated;
grant execute on function public.customer_freeze_card(uuid, uuid, text) to anon, authenticated;
grant execute on function public.customer_unfreeze_card(uuid, uuid, text) to anon, authenticated;
grant execute on function public.customer_set_card_limit(uuid, uuid, numeric, text) to anon, authenticated;
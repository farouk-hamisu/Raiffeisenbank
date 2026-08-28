-- Migration 021: Add local_transfer to verification workflow
-- Fixes:
--  1. local_transfers.status now includes 'awaiting_admin_verification'
--  2. create_local_transfer no longer debits funds immediately — sets awaiting_admin_verification
--  3. customer_verify_transfer / customer_transfer_verification_status / admin_approve / admin_reject
--     all handle 'local_transfer' type
--  4. transfer_verification_codes.transfer_type now includes 'local_transfer'

-- 1. Expand local_transfers status check
alter table public.local_transfers
  drop constraint if exists local_transfers_status_check;
alter table public.local_transfers
  add constraint local_transfers_status_check check (status in (
    'pending', 'awaiting_admin_verification', 'processing', 'completed',
    'failed', 'cancelled', 'rejected', 'reversed'
  ));

-- 2. Expand transfer_verification_codes transfer_type check
alter table public.transfer_verification_codes
  drop constraint if exists transfer_verification_codes_transfer_type_check;
alter table public.transfer_verification_codes
  add constraint transfer_verification_codes_transfer_type_check check (transfer_type in (
    'international_transfer', 'crypto_withdrawal', 'local_transfer'
  ));

-- 3. Fix create_local_transfer — no debit, status = awaiting_admin_verification
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
  perform public.require_outgoing_transfers(p_user_id);

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

  insert into public.local_transfers (
    reference, user_id, from_account_id, recipient_name, recipient_account_number,
    recipient_bank, amount, currency, fee, description, status, completed_at
  ) values (
    public.generate_reference('LT'), p_user_id, p_from_account_id, p_recipient_name,
    p_recipient_account_number, p_recipient_bank, p_amount, p_currency, v_fee,
    p_description, 'awaiting_admin_verification', null
  ) returning * into v_transfer;

  perform public.notify_user(p_user_id,
    'Transfer submitted',
    'Your transfer of ' || to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency ||
    ' to ' || p_recipient_name || ' is awaiting verification. Ref: ' || v_transfer.reference || '.',
    'transfer');

  return v_transfer;
end;
$$;

grant execute on function public.create_local_transfer(uuid, uuid, text, text, text, numeric, text, text, uuid, text) to anon, authenticated;

-- 4. Add local_transfer to customer_verify_transfer
create or replace function public.customer_verify_transfer(
  p_transfer_type text,
  p_transfer_id   uuid,
  p_code          text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_code public.transfer_verification_codes%rowtype;
  v_hash text;
  v_fail integer;
  v_ref text;
  v_xfer public.international_transfers%rowtype;
  v_wd public.crypto_withdrawals%rowtype;
  v_lt public.local_transfers%rowtype;
  v_account public.accounts%rowtype;
  v_balance numeric;
  v_name text;
begin
  if p_transfer_type not in ('international_transfer', 'crypto_withdrawal', 'local_transfer') then
    return jsonb_build_object('status', 'invalid_type');
  end if;
  if p_code is null or trim(p_code) = '' then
    return jsonb_build_object('status', 'invalid_format');
  end if;

  if p_transfer_type = 'international_transfer' then
    select user_id into v_uid from public.international_transfers where id = p_transfer_id;
  elsif p_transfer_type = 'local_transfer' then
    select user_id into v_uid from public.local_transfers where id = p_transfer_id;
  else
    select user_id into v_uid from public.crypto_withdrawals where id = p_transfer_id;
  end if;
  if v_uid is null or v_uid is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_code from public.transfer_verification_codes
    where transfer_type = p_transfer_type and transfer_id = p_transfer_id and user_id = v_uid
    order by created_at desc limit 1
    for update;

  if not found then
    perform public.log_verification_attempt(p_transfer_type, p_transfer_id, null, v_uid, 'no_code', 0);
    return jsonb_build_object('status', 'no_code');
  end if;

  if v_code.status = 'active' and v_code.attempts >= v_code.max_attempts then
    update public.transfer_verification_codes set status = 'expired', updated_at = now() where id = v_code.id;
    perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'attempts_exceeded', v_code.max_attempts);
    return jsonb_build_object('status', 'attempts_exceeded', 'attempts_left', 0);
  end if;

  if v_code.status = 'used' then return jsonb_build_object('status', 'used'); end if;
  if v_code.status = 'revoked' then return jsonb_build_object('status', 'revoked'); end if;
  if v_code.status = 'expired' then return jsonb_build_object('status', 'expired'); end if;
  if v_code.expires_at <= now() then
    update public.transfer_verification_codes set status = 'expired', updated_at = now() where id = v_code.id;
    perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'expired', v_code.attempts);
    return jsonb_build_object('status', 'expired');
  end if;

  v_hash := public.hash_verification_code(p_code);
  if v_hash <> v_code.code_hash then
    v_fail := v_code.attempts + 1;
    update public.transfer_verification_codes set attempts = v_fail, updated_at = now() where id = v_code.id;
    if v_fail >= v_code.max_attempts then
      update public.transfer_verification_codes set status = 'expired', updated_at = now() where id = v_code.id;
      perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'attempts_exceeded', v_fail);
      return jsonb_build_object('status', 'attempts_exceeded', 'attempts_left', 0);
    else
      perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'invalid_code', v_fail);
    end if;
    return jsonb_build_object('status', 'invalid_code', 'attempts_left', greatest(0, v_code.max_attempts - v_fail));
  end if;

  -- Correct code: mark used, debit funds, advance to processing.
  update public.transfer_verification_codes set status = 'used', used_at = now(), updated_at = now() where id = v_code.id;

  if p_transfer_type = 'international_transfer' then
    select * into v_xfer from public.international_transfers where id = p_transfer_id for update;
    select * into v_account from public.accounts where id = v_xfer.from_account_id for update;
    select available_balance into v_balance from public.account_balances where account_id = v_account.id;
    if v_balance is null or v_balance < (v_xfer.amount + v_xfer.fee) then
      update public.international_transfers set status = 'failed', updated_at = now() where id = v_xfer.id;
      perform public.notify_user(v_uid, 'International transfer failed',
        'Transfer ' || v_xfer.reference || ' could not be processed due to insufficient funds.', 'transfer');
      perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'failed_insufficient_funds', v_code.attempts + 1);
      return jsonb_build_object('status', 'failed_insufficient_funds', 'reference', v_xfer.reference);
    end if;
    perform public.apply_balance_change(v_account.id, -(v_xfer.amount + v_xfer.fee), v_account.currency);
    update public.international_transfers set status = 'completed', completed_at = now(), updated_at = now() where id = v_xfer.id;
    select full_name into v_name from public.profiles where id = v_uid;
    perform public.record_transaction(
      v_uid, v_account.id, 'international_transfer', 'debit', v_xfer.amount, v_account.currency,
      'completed', coalesce(v_xfer.purpose, 'International transfer'), v_name,
      v_xfer.recipient_name || ' (' || v_xfer.recipient_country || ')', v_xfer.fee, v_xfer.id);
    perform public.notify_user(v_uid, 'Transfer completed',
      'Your transfer ' || v_xfer.reference || ' has been verified and completed.', 'transfer');
    v_ref := v_xfer.reference;

  elsif p_transfer_type = 'local_transfer' then
    select * into v_lt from public.local_transfers where id = p_transfer_id for update;
    select * into v_account from public.accounts where id = v_lt.from_account_id for update;
    select available_balance into v_balance from public.account_balances where account_id = v_account.id;
    if v_balance is null or v_balance < (v_lt.amount + v_lt.fee) then
      update public.local_transfers set status = 'failed', updated_at = now() where id = v_lt.id;
      perform public.notify_user(v_uid, 'Transfer failed',
        'Transfer ' || v_lt.reference || ' could not be processed due to insufficient funds.', 'transfer');
      perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'failed_insufficient_funds', v_code.attempts + 1);
      return jsonb_build_object('status', 'failed_insufficient_funds', 'reference', v_lt.reference);
    end if;
    perform public.apply_balance_change(v_account.id, -(v_lt.amount + v_lt.fee), v_account.currency);
    update public.local_transfers set status = 'completed', completed_at = now(), updated_at = now() where id = v_lt.id;
    select full_name into v_name from public.profiles where id = v_uid;
    perform public.record_transaction(
      v_uid, v_account.id, 'local_transfer', 'debit', v_lt.amount, v_account.currency,
      'completed', coalesce(v_lt.description, 'Local transfer'), v_name,
      v_lt.recipient_name, v_lt.fee, v_lt.id);
    perform public.notify_user(v_uid, 'Transfer completed',
      'Transfer ' || v_lt.reference || ' has been verified and completed.', 'transfer');

    -- Credit internal recipient if applicable
    if v_lt.internal_recipient_id is not null then
      declare
        v_dest public.accounts%rowtype;
      begin
        select * into v_dest from public.accounts
          where user_id = v_lt.internal_recipient_id and currency = v_lt.currency
          order by created_at limit 1;
        if found then
          perform public.apply_balance_change(v_dest.id, v_lt.amount, v_lt.currency);
          perform public.record_transaction(
            v_lt.internal_recipient_id, v_dest.id, 'local_transfer', 'credit', v_lt.amount, v_lt.currency,
            'completed', 'Incoming local transfer', v_lt.recipient_name, v_name, 0, v_lt.id);
          perform public.notify_user(v_lt.internal_recipient_id,
            'Transfer received',
            'You received ' || to_char(v_lt.amount, 'FM9,999,999,990.00') || ' ' || v_lt.currency ||
            ' from ' || coalesce(v_name, 'a customer') || '.',
            'transfer');
        end if;
      end;
    end if;

    v_ref := v_lt.reference;

  else
    select * into v_wd from public.crypto_withdrawals where id = p_transfer_id for update;
    select * into v_account from public.accounts where id = v_wd.from_account_id for update;
    select available_balance into v_balance from public.account_balances where account_id = v_account.id;
    if v_balance is null or v_balance < (v_wd.amount_fiat + v_wd.fee) then
      update public.crypto_withdrawals set status = 'failed', updated_at = now() where id = v_wd.id;
      perform public.notify_user(v_uid, 'Crypto withdrawal failed',
        'Withdrawal ' || v_wd.reference || ' could not be processed due to insufficient funds.', 'transfer');
      perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'failed_insufficient_funds', v_code.attempts + 1);
      return jsonb_build_object('status', 'failed_insufficient_funds', 'reference', v_wd.reference);
    end if;
    perform public.apply_balance_change(v_account.id, -(v_wd.amount_fiat + v_wd.fee), v_account.currency);
    update public.crypto_withdrawals set status = 'processing', updated_at = now() where id = v_wd.id;
    select full_name into v_name from public.profiles where id = v_uid;
    perform public.record_transaction(
      v_uid, v_account.id, 'withdrawal', 'debit', v_wd.amount_fiat, v_account.currency,
      'processing', 'Crypto withdrawal ' || v_wd.amount || ' ' || v_wd.asset, v_name,
      v_wd.wallet_address, v_wd.fee, v_wd.id);
    perform public.notify_user(v_uid, 'Crypto withdrawal verified',
      'Withdrawal ' || v_wd.reference || ' has been verified and is now processing.', 'transfer');
    v_ref := v_wd.reference;
  end if;

  perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'success', v_code.attempts + 1);
  return jsonb_build_object('status', 'ok', 'reference', v_ref, 'transfer_id', p_transfer_id::text);
end;
$$;

grant execute on function public.customer_verify_transfer(text, uuid, text) to anon, authenticated;

-- 5. Add local_transfer to customer_transfer_verification_status
create or replace function public.customer_transfer_verification_status(
  p_transfer_type text,
  p_transfer_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_code public.transfer_verification_codes%rowtype;
begin
  if p_transfer_type = 'international_transfer' then
    select user_id into v_uid from public.international_transfers where id = p_transfer_id;
  elsif p_transfer_type = 'crypto_withdrawal' then
    select user_id into v_uid from public.crypto_withdrawals where id = p_transfer_id;
  elsif p_transfer_type = 'local_transfer' then
    select user_id into v_uid from public.local_transfers where id = p_transfer_id;
  else
    return jsonb_build_object('status', 'invalid_type');
  end if;
  if v_uid is null or v_uid is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_code from public.transfer_verification_codes
    where transfer_type = p_transfer_type and transfer_id = p_transfer_id and user_id = v_uid
    order by created_at desc limit 1;

  if not found then
    return jsonb_build_object('status', 'none');
  end if;

  return jsonb_build_object(
    'status', v_code.status,
    'code_issued', v_code.code_prefix is not null,
    'code_prefix', v_code.code_prefix,
    'expires_at', v_code.expires_at,
    'attempts_left', greatest(0, v_code.max_attempts - v_code.attempts)
  );
end;
$$;

grant execute on function public.customer_transfer_verification_status(text, uuid) to anon, authenticated;

-- 6. Add local_transfer to admin_approve_transfer
create or replace function public.admin_approve_transfer(
  p_token text,
  p_transfer_type text,
  p_transfer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_admin public.admin_users;
  v_status text;
  v_code text;
  v_hash text;
  v_prefix text;
  v_ttl_min int;
  v_max_attempts int;
  v_expires timestamptz;
  v_code_id uuid;
  v_old jsonb;
  v_user_id uuid;
begin
  if not public.admin_can(p_token, 'verifications.manage') then
    raise exception 'FORBIDDEN';
  end if;
  if p_transfer_type not in ('international_transfer', 'crypto_withdrawal', 'local_transfer') then
    raise exception 'INVALID_TYPE';
  end if;

  if p_transfer_type = 'international_transfer' then
    select status, to_jsonb(t), t.user_id into v_status, v_old, v_user_id from public.international_transfers t where id = p_transfer_id;
  elsif p_transfer_type = 'local_transfer' then
    select status, to_jsonb(t), t.user_id into v_status, v_old, v_user_id from public.local_transfers t where id = p_transfer_id;
  else
    select status, to_jsonb(t), t.user_id into v_status, v_old, v_user_id from public.crypto_withdrawals t where id = p_transfer_id;
  end if;
  if v_old is null then
    raise exception 'TRANSFER_NOT_FOUND';
  end if;
  if v_status <> 'awaiting_admin_verification' then
    raise exception 'TRANSFER_NOT_VERIFIABLE';
  end if;

  v_admin := public.admin_from_token(p_token);

  update public.transfer_verification_codes
    set status = 'revoked', updated_at = now()
  where transfer_type = p_transfer_type and transfer_id = p_transfer_id and status = 'active';

  select coalesce((value::text)::int, 30) into v_ttl_min
    from public.system_settings where key = 'verification_code_ttl_minutes';
  if v_ttl_min is null then v_ttl_min := 30; end if;
  select coalesce((value::text)::int, 3) into v_max_attempts
    from public.system_settings where key = 'verification_code_max_attempts';
  if v_max_attempts is null then v_max_attempts := 3; end if;

  v_code := public.generate_verification_code();
  v_hash := public.hash_verification_code(v_code);
  v_prefix := chr(8226)||chr(8226)||chr(8226)||chr(8226)||'-' || right(v_code, 4);
  v_expires := now() + (v_ttl_min * interval '1 minute');

  insert into public.transfer_verification_codes (
    transfer_type, transfer_id, user_id, code_hash, code_prefix, expires_at, max_attempts, attempts, status, created_by
  ) values (
    p_transfer_type, p_transfer_id, v_user_id,
    v_hash, v_prefix, v_expires, v_max_attempts, 0, 'active', v_admin.id
  ) returning id into v_code_id;

  perform public.log_audit(p_token, 'APPROVE_TRANSFER', p_transfer_type, p_transfer_id::text, v_old,
    jsonb_build_object('status', 'approved', 'code_id', v_code_id::text));
  perform public.log_audit(p_token, 'GENERATE_CODE', 'transfer_verification_code', v_code_id::text, null,
    jsonb_build_object('transfer_type', p_transfer_type, 'transfer_id', p_transfer_id::text, 'code_prefix', v_prefix, 'expires_at', v_expires));

  return jsonb_build_object('code', v_code, 'code_prefix', v_prefix, 'code_id', v_code_id::text, 'expires_at', v_expires);
end;
$$;

grant execute on function public.admin_approve_transfer(text, text, uuid) to anon, authenticated;

-- 7. Add local_transfer to admin_reject_transfer
create or replace function public.admin_reject_transfer(
  p_token text,
  p_transfer_type text,
  p_transfer_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_old jsonb;
  v_status text;
  v_user_id uuid;
begin
  if not public.admin_can(p_token, 'verifications.manage') then
    raise exception 'FORBIDDEN';
  end if;
  if p_transfer_type not in ('international_transfer', 'crypto_withdrawal', 'local_transfer') then
    raise exception 'INVALID_TYPE';
  end if;

  if p_transfer_type = 'international_transfer' then
    select status, to_jsonb(t), t.user_id into v_status, v_old, v_user_id
      from public.international_transfers t where id = p_transfer_id for update;
  elsif p_transfer_type = 'local_transfer' then
    select status, to_jsonb(t), t.user_id into v_status, v_old, v_user_id
      from public.local_transfers t where id = p_transfer_id for update;
  else
    select status, to_jsonb(t), t.user_id into v_status, v_old, v_user_id
      from public.crypto_withdrawals t where id = p_transfer_id for update;
  end if;
  if v_old is null then
    raise exception 'TRANSFER_NOT_FOUND';
  end if;
  if v_status <> 'awaiting_admin_verification' then
    raise exception 'TRANSFER_NOT_VERIFIABLE';
  end if;

  update public.transfer_verification_codes
    set status = 'revoked', updated_at = now()
  where transfer_type = p_transfer_type and transfer_id = p_transfer_id and status = 'active';

  if p_transfer_type = 'international_transfer' then
    update public.international_transfers set status = 'rejected', updated_at = now() where id = p_transfer_id;
  elsif p_transfer_type = 'local_transfer' then
    update public.local_transfers set status = 'rejected', updated_at = now() where id = p_transfer_id;
  else
    update public.crypto_withdrawals set status = 'rejected', updated_at = now() where id = p_transfer_id;
  end if;

  perform public.notify_user(v_user_id, 'Transfer rejected',
    'Your transfer was rejected.' ||
    case when p_reason is not null and p_reason <> '' then ' Reason: ' || p_reason else '' end,
    'transfer');
end;
$$;

grant execute on function public.admin_reject_transfer(text, text, uuid, text) to anon, authenticated;

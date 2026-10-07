-- Raiffeisen Bank - Migration 016
-- RPCs for the admin-controlled verification workflow: transfer creation,
-- code generation/verification, admin review, and outgoing-transfer controls.

-- ---------------------------------------------------------------------------
-- Internal helpers (revoked from clients at the bottom)
-- ---------------------------------------------------------------------------

-- Secure, unambiguous verification code (no 0/O/1/I).
create or replace function public.generate_verification_code()
returns text
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  v_chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text := '';
begin
  for v_i in 1..8 loop
    v_code := v_code || substr(v_chars, (get_byte(gen_random_bytes(1), 0) % 32) + 1, 1);
  end loop;
  return v_code;
end;
$$;

-- Hash a code for storage (codes are high-entropy + short-lived, SHA-256 is fine).
create or replace function public.hash_verification_code(p_code text)
returns text
language sql
stable
set search_path = public, extensions
as $$
  select encode(digest(trim(p_code)::bytea, 'sha256'), 'hex');
$$;

-- Raise if outgoing transfers are disabled for the customer.
create or replace function public.require_outgoing_transfers(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
begin
  select outgoing_transfers_enabled into v_enabled from public.profiles where id = p_user_id;
  if v_enabled is not true then
    raise exception 'OUTGOING_TRANSFERS_DISABLED';
  end if;
end;
$$;

-- Record a verification attempt (success or failure) for audit/history.
create or replace function public.log_verification_attempt(
  p_transfer_type text,
  p_transfer_id uuid,
  p_code_id uuid,
  p_user_id uuid,
  p_result text,
  p_attempts int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.transfer_verification_logs (transfer_type, transfer_id, code_id, user_id, result, attempts)
  values (p_transfer_type, p_transfer_id, p_code_id, p_user_id, p_result, p_attempts);
end;
$$;

-- ---------------------------------------------------------------------------
-- Customer: create cryptocurrency withdrawal (awaiting admin verification)
-- ---------------------------------------------------------------------------
create or replace function public.create_crypto_withdrawal(
  p_user_id         uuid,
  p_from_account_id uuid,
  p_asset           text,
  p_network         text,
  p_wallet_address  text,
  p_amount          numeric,
  p_pin             text default null,
  p_request_id      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text;
  v_asset public.crypto_assets%rowtype;
  v_account public.accounts%rowtype;
  v_balance numeric;
  v_fee numeric;
  v_amount_fiat numeric;
  v_wd public.crypto_withdrawals;
  v_created boolean := true;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;
  perform public.require_customer_pin(p_user_id, p_pin);
  perform public.require_outgoing_transfers(p_user_id);

  select code into v_base from public.currencies where is_base = true limit 1;
  if not found then v_base := 'USD'; end if;

  select * into v_asset from public.crypto_assets
    where asset = p_asset and network = p_network and is_enabled;
  if not found then
    raise exception 'ASSET_NOT_SUPPORTED';
  end if;
  if p_amount is null or p_amount < v_asset.min_amount or p_amount > v_asset.max_amount then
    raise exception 'ASSET_LIMIT';
  end if;

  select * into v_account from public.accounts
    where id = p_from_account_id and user_id = p_user_id and status = 'active' for update;
  if not found then
    raise exception 'INVALID_ACCOUNT';
  end if;
  if v_account.currency <> v_base and v_account.currency <> p_asset then
    raise exception 'CRYPTO_REQUIRES_BASE_CURRENCY';
  end if;

  select available_balance into v_balance from public.account_balances where account_id = p_from_account_id;
  if v_balance is null then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  select coalesce((value::text)::numeric, 1) into v_fee
    from public.system_settings where key = 'crypto_withdrawal_fee';
  if v_fee is null then v_fee := 1; end if;

  -- If withdrawing from a BTC account, the amount is in BTC directly
  if v_account.currency = p_asset then
    if v_balance < (p_amount + v_fee) then
      raise exception 'INSUFFICIENT_FUNDS';
    end if;
    v_amount_fiat := round(p_amount * v_asset.rate_usd, 2);
    -- Debit BTC account directly
    perform public.apply_balance_change(p_from_account_id, -(p_amount + v_fee), p_asset);
  else
    -- Fiat account: convert to fiat equivalent
    v_amount_fiat := round(p_amount * v_asset.rate_usd, 2);
    if v_balance < (v_amount_fiat + v_fee) then
      raise exception 'INSUFFICIENT_FUNDS';
    end if;
    perform public.apply_balance_change(p_from_account_id, -(v_amount_fiat + v_fee), v_base);
  end if;

  insert into public.crypto_withdrawals (
    reference, request_id, user_id, from_account_id, asset, network, wallet_address,
    amount, amount_fiat, currency, rate, fee, status, completed_at
  ) values (
    public.generate_reference('CW'), p_request_id, p_user_id, p_from_account_id, p_asset, p_network,
    p_wallet_address, p_amount, v_amount_fiat, v_base, v_asset.rate_usd, v_fee,
    'awaiting_admin_verification', null
  )
  on conflict (user_id, request_id) where request_id is not null do nothing
  returning * into v_wd;

  if not found then
    select * into v_wd from public.crypto_withdrawals
      where user_id = p_user_id and request_id = p_request_id;
    v_created := false;
  end if;

  if v_created then
    perform public.notify_user(p_user_id,
      'Crypto withdrawal submitted',
      'Your withdrawal of ' || p_amount || ' ' || p_asset || ' to ' || p_wallet_address ||
      ' was received and is awaiting administrative verification. Ref: ' || v_wd.reference || '.', 'transfer');
  end if;

  return jsonb_build_object(
    'id', v_wd.id, 'reference', v_wd.reference, 'status', v_wd.status,
    'created', v_created, 'amount', p_amount, 'asset', p_asset,
    'amount_fiat', v_amount_fiat, 'currency', v_base, 'fee', v_fee
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Customer: create international transfer (awaiting admin verification)
-- ---------------------------------------------------------------------------
drop function if exists public.create_international_transfer(uuid, uuid, text, text, text, text, text, numeric, text, text, text);
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
  p_pin                   text default null,
  p_request_id            text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.accounts%rowtype;
  v_balance numeric;
  v_fee numeric;
  v_xfer public.international_transfers;
  v_created boolean := true;
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

  insert into public.international_transfers (
    reference, request_id, user_id, from_account_id, recipient_name, recipient_bank,
    recipient_account_number, swift_code, recipient_country, purpose, amount, currency,
    exchange_rate, fee, estimated_delivery, status, completed_at
  ) values (
    public.generate_reference('IT'), p_request_id, p_user_id, p_from_account_id, p_recipient_name,
    p_recipient_bank, p_recipient_account_number, p_swift_code, p_recipient_country, p_purpose,
    p_amount, p_currency, 1, v_fee, now() + interval '2 days', 'awaiting_admin_verification', null
  )
  on conflict (user_id, request_id) where request_id is not null do nothing
  returning * into v_xfer;

  if not found then
    select * into v_xfer from public.international_transfers
      where user_id = p_user_id and request_id = p_request_id;
    v_created := false;
  end if;

  if v_created then
    perform public.notify_user(p_user_id,
      'International transfer submitted',
      'Your international transfer of ' || to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency ||
      ' to ' || p_recipient_name || ' was received and is awaiting administrative verification. Ref: ' ||
      v_xfer.reference || '.', 'transfer');
  end if;

  return jsonb_build_object(
    'id', v_xfer.id, 'reference', v_xfer.reference, 'status', v_xfer.status,
    'created', v_created, 'amount', p_amount, 'currency', p_currency, 'fee', v_fee
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Customer: verify a transfer with the admin-issued one-time code
-- Returns a status jsonb instead of raising, so failed attempts persist and
-- the attempts counter commits even though the client sees an error.
-- ---------------------------------------------------------------------------
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
  v_account public.accounts%rowtype;
  v_balance numeric;
  v_name text;
begin
  if p_transfer_type not in ('international_transfer', 'crypto_withdrawal') then
    return jsonb_build_object('status', 'invalid_type');
  end if;
  if p_code is null or trim(p_code) = '' then
    return jsonb_build_object('status', 'invalid_format');
  end if;

  if p_transfer_type = 'international_transfer' then
    select user_id into v_uid from public.international_transfers where id = p_transfer_id;
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

  -- Exhausted attempts invalidates the code (before expiry is even checked).
  if v_code.status = 'active' and v_code.attempts >= v_code.max_attempts then
    update public.transfer_verification_codes set status = 'expired', updated_at = now() where id = v_code.id;
    perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'attempts_exceeded', v_code.max_attempts);
    return jsonb_build_object('status', 'attempts_exceeded', 'attempts_left', 0);
  end if;

  if v_code.status = 'used' then
    return jsonb_build_object('status', 'used');
  end if;
  if v_code.status = 'revoked' then
    return jsonb_build_object('status', 'revoked');
  end if;
  if v_code.status = 'expired' then
    return jsonb_build_object('status', 'expired');
  end if;
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

  -- Correct code: mark the code used and advance the transfer to processing.
  -- Funds are deducted NOW - never before verification completes.
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
    update public.international_transfers set status = 'processing', updated_at = now() where id = v_xfer.id;
    select full_name into v_name from public.profiles where id = v_uid;
    perform public.record_transaction(
      v_uid, v_account.id, 'international_transfer', 'debit', v_xfer.amount, v_account.currency,
      'processing', coalesce(v_xfer.purpose, 'International transfer'), v_name,
      v_xfer.recipient_name || ' (' || v_xfer.recipient_country || ')', v_xfer.fee, v_xfer.id);
    perform public.notify_user(v_uid, 'International transfer verified',
      'Transfer ' || v_xfer.reference || ' has been verified and is now processing.', 'transfer');
    v_ref := v_xfer.reference;
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

-- ---------------------------------------------------------------------------
-- Customer: read-only verification status (never exposes the code itself)
-- ---------------------------------------------------------------------------
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
    'code_issued', v_code.status in ('active', 'used', 'revoked', 'expired'),
    'attempts_left', greatest(0, v_code.max_attempts - v_code.attempts),
    'expires_at', v_code.expires_at,
    'code_prefix', v_code.code_prefix
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: pending verifications
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_transfer_verifications(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_intl jsonb;
  v_crypto jsonb;
begin
  if not public.admin_can(p_token, 'verifications.view') then
    raise exception 'FORBIDDEN';
  end if;

  select coalesce(jsonb_agg(to_jsonb(u)), '[]') into v_intl
  from (
    select t.*, 'international_transfer' as transfer_type, p.full_name as user_name, p.email as user_email,
      vc.status as code_status, vc.code_prefix as code_prefix, vc.expires_at as code_expires_at,
      vc.attempts as code_attempts, vc.max_attempts as code_max_attempts, vc.id as code_id
    from public.international_transfers t
    join public.profiles p on p.id = t.user_id
    left join lateral (
      select v.* from public.transfer_verification_codes v
      where v.transfer_type = 'international_transfer' and v.transfer_id = t.id
      order by v.created_at desc limit 1
    ) vc on true
    where t.status = 'awaiting_admin_verification'
    order by t.created_at desc
  ) u;

  select coalesce(jsonb_agg(to_jsonb(u)), '[]') into v_crypto
  from (
    select t.*, 'crypto_withdrawal' as transfer_type, p.full_name as user_name, p.email as user_email,
      vc.status as code_status, vc.code_prefix as code_prefix, vc.expires_at as code_expires_at,
      vc.attempts as code_attempts, vc.max_attempts as code_max_attempts, vc.id as code_id
    from public.crypto_withdrawals t
    join public.profiles p on p.id = t.user_id
    left join lateral (
      select v.* from public.transfer_verification_codes v
      where v.transfer_type = 'crypto_withdrawal' and v.transfer_id = t.id
      order by v.created_at desc limit 1
    ) vc on true
    where t.status = 'awaiting_admin_verification'
    order by t.created_at desc
  ) u;

  return jsonb_build_object(
    'international', v_intl,
    'crypto', v_crypto,
    'total', jsonb_array_length(v_intl) + jsonb_array_length(v_crypto)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: verification history for one transfer
-- ---------------------------------------------------------------------------
create or replace function public.admin_transfer_verification_history(
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
  v_transfer jsonb;
  v_codes jsonb;
  v_logs jsonb;
begin
  if not public.admin_can(p_token, 'verifications.view') then
    raise exception 'FORBIDDEN';
  end if;

  if p_transfer_type = 'international_transfer' then
    select to_jsonb(t) into v_transfer from public.international_transfers t where id = p_transfer_id;
  elsif p_transfer_type = 'crypto_withdrawal' then
    select to_jsonb(t) into v_transfer from public.crypto_withdrawals t where id = p_transfer_id;
  else
    raise exception 'INVALID_TYPE';
  end if;
  if v_transfer is null then
    raise exception 'TRANSFER_NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', v.id, 'status', v.status, 'code_prefix', v.code_prefix, 'created_at', v.created_at,
    'used_at', v.used_at, 'expires_at', v.expires_at, 'attempts', v.attempts, 'max_attempts', v.max_attempts,
    'created_by', (select au.email from public.admin_users au where au.id = v.created_by)
  ) order by v.created_at), '[]') into v_codes
  from public.transfer_verification_codes v
  where v.transfer_type = p_transfer_type and v.transfer_id = p_transfer_id;

  select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at), '[]') into v_logs
  from public.transfer_verification_logs l
  where l.transfer_type = p_transfer_type and l.transfer_id = p_transfer_id;

  return jsonb_build_object('transfer', v_transfer, 'codes', v_codes, 'logs', v_logs);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: approve (issues a single-use code) / reject a transfer
-- ---------------------------------------------------------------------------
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
begin
  if not public.admin_can(p_token, 'verifications.manage') then
    raise exception 'FORBIDDEN';
  end if;
  if p_transfer_type not in ('international_transfer', 'crypto_withdrawal') then
    raise exception 'INVALID_TYPE';
  end if;

  if p_transfer_type = 'international_transfer' then
    select status, to_jsonb(t) into v_status, v_old from public.international_transfers t where id = p_transfer_id;
  else
    select status, to_jsonb(t) into v_status, v_old from public.crypto_withdrawals t where id = p_transfer_id;
  end if;
  if v_old is null then
    raise exception 'TRANSFER_NOT_FOUND';
  end if;
  if v_status <> 'awaiting_admin_verification' then
    raise exception 'TRANSFER_NOT_VERIFIABLE';
  end if;

  v_admin := public.admin_from_token(p_token);

  -- Invalidate any previously active code for this transfer (revoke before re-issue).
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
  v_prefix := '••••-' || right(v_code, 4);
  v_expires := now() + (v_ttl_min * interval '1 minute');

  insert into public.transfer_verification_codes (
    transfer_type, transfer_id, user_id, code_hash, code_prefix, expires_at, max_attempts, attempts, status, created_by
  )
  select p_transfer_type, p_transfer_id,
    case when p_transfer_type = 'international_transfer' then (select user_id from public.international_transfers where id = p_transfer_id)
         else (select user_id from public.crypto_withdrawals where id = p_transfer_id) end,
    v_hash, v_prefix, v_expires, v_max_attempts, 0, 'active', v_admin.id
  returning id into v_code_id;

  perform public.log_audit(p_token, 'APPROVE_TRANSFER', p_transfer_type, p_transfer_id::text, v_old,
    jsonb_build_object('status', 'approved', 'code_id', v_code_id::text));
  perform public.log_audit(p_token, 'GENERATE_CODE', 'transfer_verification_code', v_code_id::text, null,
    jsonb_build_object('transfer_type', p_transfer_type, 'transfer_id', p_transfer_id::text, 'code_prefix', v_prefix, 'expires_at', v_expires));

  -- The plaintext code is returned ONLY to the authorized admin, never stored.
  return jsonb_build_object('code', v_code, 'code_prefix', v_prefix, 'code_id', v_code_id::text, 'expires_at', v_expires);
end;
$$;

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
  if p_transfer_type not in ('international_transfer', 'crypto_withdrawal') then
    raise exception 'INVALID_TYPE';
  end if;

  if p_transfer_type = 'international_transfer' then
    select status, to_jsonb(t), t.user_id into v_status, v_old, v_user_id
      from public.international_transfers t where id = p_transfer_id for update;
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
  else
    update public.crypto_withdrawals set status = 'rejected', updated_at = now() where id = p_transfer_id;
  end if;

  perform public.notify_user(v_user_id, 'Transfer rejected',
    'Your transfer was rejected by our verification team.' ||
    case when p_reason is not null and p_reason <> '' then ' Reason: ' || p_reason else '' end ||
    '. Contact support for details.', 'transfer');

  perform public.log_audit(p_token, 'REJECT_TRANSFER', p_transfer_type, p_transfer_id::text, v_old,
    jsonb_build_object('status', 'rejected', 'reason', coalesce(p_reason, '')));
end;
$$;

create or replace function public.admin_revoke_transfer_code(p_token text, p_code_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_old jsonb;
begin
  if not public.admin_can(p_token, 'verifications.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(v) into v_old from public.transfer_verification_codes v where id = p_code_id;
  if not found then
    raise exception 'CODE_NOT_FOUND';
  end if;
  update public.transfer_verification_codes set status = 'revoked', updated_at = now() where id = p_code_id;
  perform public.log_audit(p_token, 'REVOKE_CODE', 'transfer_verification_code', p_code_id::text, v_old,
    jsonb_build_object('status', 'revoked'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: complete / manage crypto withdrawal + sync intl transaction status
-- ---------------------------------------------------------------------------
create or replace function public.admin_update_crypto_withdrawal(
  p_token text,
  p_withdrawal_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_old jsonb;
  v_wd public.crypto_withdrawals%rowtype;
begin
  if not public.admin_can(p_token, 'transfers.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select * into v_wd from public.crypto_withdrawals where id = p_withdrawal_id for update;
  if not found then
    raise exception 'WITHDRAWAL_NOT_FOUND';
  end if;
  select to_jsonb(v_wd) into v_old;
  update public.crypto_withdrawals set status = p_status,
    completed_at = case when p_status = 'completed' then now() else completed_at end,
    updated_at = now()
  where id = p_withdrawal_id;
  update public.transactions set status = p_status, updated_at = now() where related_id = p_withdrawal_id;
  perform public.log_audit(p_token, 'UPDATE_STATUS', 'crypto_withdrawal', p_withdrawal_id::text, v_old,
    jsonb_build_object('status', p_status));
end;
$$;

create or replace function public.admin_update_intl_transfer(
  p_token text, p_transfer_id uuid, p_status text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb;
begin
  if not public.admin_can(p_token, 'transfers.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(t) into v_old from public.international_transfers t where id = p_transfer_id;
  if not found then
    raise exception 'TRANSFER_NOT_FOUND';
  end if;
  update public.international_transfers set status = p_status,
    completed_at = case when p_status = 'completed' then now() else completed_at end,
    updated_at = now()
  where id = p_transfer_id;
  update public.transactions set status = p_status, updated_at = now() where related_id = p_transfer_id;
  perform public.log_audit(p_token, 'UPDATE_STATUS', 'international_transfer', p_transfer_id::text, v_old, jsonb_build_object('status', p_status));
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: outgoing-transfer restriction (account-level setting)
-- ---------------------------------------------------------------------------
create or replace function public.admin_toggle_outgoing_transfers(
  p_token text,
  p_user_id uuid,
  p_enabled boolean,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_old jsonb;
begin
  if not public.admin_can(p_token, 'users.manage') then
    raise exception 'FORBIDDEN';
  end if;
  if not p_enabled and (p_reason is null or trim(p_reason) = '') then
    raise exception 'REASON_REQUIRED';
  end if;
  select to_jsonb(p) into v_old from public.profiles p where id = p_user_id;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;
  update public.profiles set
    outgoing_transfers_enabled = p_enabled,
    outgoing_transfers_disabled_reason = case when p_enabled then null else p_reason end,
    updated_at = now()
  where id = p_user_id;
  perform public.log_audit(p_token, 'TOGGLE_OUTGOING_TRANSFERS', 'profile', p_user_id::text, v_old,
    jsonb_build_object('outgoing_transfers_enabled', p_enabled, 'reason', case when p_enabled then null else p_reason end));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants + revokes
-- ---------------------------------------------------------------------------
revoke execute on function public.generate_verification_code() from public, anon, authenticated;
revoke execute on function public.hash_verification_code(text) from public, anon, authenticated;
revoke execute on function public.require_outgoing_transfers(uuid) from public, anon, authenticated;
revoke execute on function public.log_verification_attempt(text, uuid, uuid, uuid, text, int) from public, anon, authenticated;

grant execute on function public.create_crypto_withdrawal(uuid, uuid, text, text, text, numeric, text, text) to anon, authenticated;
grant execute on function public.create_international_transfer(uuid, uuid, text, text, text, text, text, numeric, text, text, text, text) to anon, authenticated;
grant execute on function public.customer_verify_transfer(text, uuid, text) to anon, authenticated;
grant execute on function public.customer_transfer_verification_status(text, uuid) to anon, authenticated;

grant execute on function public.admin_list_transfer_verifications(text) to anon, authenticated;
grant execute on function public.admin_transfer_verification_history(text, text, uuid) to anon, authenticated;
grant execute on function public.admin_approve_transfer(text, text, uuid) to anon, authenticated;
grant execute on function public.admin_reject_transfer(text, text, uuid, text) to anon, authenticated;
grant execute on function public.admin_revoke_transfer_code(text, uuid) to anon, authenticated;
grant execute on function public.admin_update_crypto_withdrawal(text, uuid, text) to anon, authenticated;
grant execute on function public.admin_toggle_outgoing_transfers(text, uuid, boolean, text) to anon, authenticated;
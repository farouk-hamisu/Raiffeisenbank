-- Migration 032: Admin-configurable transfer code requirement
--
-- Adds a persistent, server-side setting `transfer_code_required` (system_settings)
-- that administrators control from the existing Admin -> Settings screen
-- (admin_update_setting, permission `settings.manage`, audited via log_audit).
--
--   ON  (default): create_*_transfer submits land in `awaiting_admin_verification`
--                  exactly as before; an admin issues an 8-character code
--                  (TTL + attempt limits, SHA-256 hashed, single-use) and the
--                  transfer only completes through customer_verify_transfer.
--   OFF:           eligible transfers are completed by the backend immediately
--                  during creation — debit, transaction record, internal
--                  recipient credit and notification happen in the SAME atomic
--                  statement. No code is requested.
--
-- In-progress rule: the setting is read ONLY when a transfer is created.
-- Transfers already awaiting verification keep requiring their issued code even
-- if the admin flips the switch to OFF — a configuration change can never
-- bypass verification for an in-progress transaction. customer_verify_transfer
-- does not consult the flag at all; the transfer's own status gates it.
--
-- Backend is the source of truth: every create_*/verify function reads the
-- setting inside SECURITY DEFINER functions. The frontend only renders based on
-- the status the backend returns, so a stale or tampered client cannot skip the
-- code. All other controls (auth.uid() match, PIN, outgoing-transfers toggle,
-- account ownership, balance, fees, attempt limits, expiry, replay protection)
-- remain enforced unchanged.
--
-- Also fixed here because the OFF path and the acceptance tests depend on them:
--  1. local_transfers.internal_recipient_id was referenced by
--     customer_verify_transfer (021) but never created by any migration — the
--     local verification path could not run. The column now exists and
--     create_local_transfer stores the resolved internal recipient on it.
--  2. local transfers had no request_id idempotency key (intl/crypto already
--     had one) — added, with the same partial-unique-index pattern.
--  3. create_crypto_withdrawal debited BEFORE its on-conflict idempotency check
--     (a replayed request_id debited twice), and customer_verify_transfer
--     debited AGAIN at verification although creation already debited (double
--     debit or spurious INSUFFICIENT failure). The debit now happens exactly
--     once — at creation, only when the row was newly created — and verification
--     never debits crypto.
--
-- Apply order: after 031. Idempotent (IF NOT EXISTS / ON CONFLICT / CREATE OR
-- REPLACE throughout).

-- ---------------------------------------------------------------------------
-- 1. The setting (seeded ON = fail-safe, preserves current behaviour)
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value, description)
values (
  'transfer_code_required',
  'true'::jsonb,
  'ON: users must enter an admin-issued transfer code before a transfer completes. '
  || 'OFF: eligible transfers complete immediately after PIN confirmation, with no code requested. '
  || 'PIN, balance, limits, fraud and authorization checks stay enforced either way.'
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Server-side reader (single source of truth for every RPC).
--    Tolerant of boolean or string jsonb; anything unrecognised fails SAFE to
--    "code required".
-- ---------------------------------------------------------------------------
create or replace function public.transfer_code_required()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_raw text;
begin
  select lower(coalesce(s.value #>> '{}', '')) into v_raw
    from public.system_settings s
   where s.key = 'transfer_code_required';
  if v_raw in ('true', 't', '1', 'on', 'yes') then return true; end if;
  if v_raw in ('false', 'f', '0', 'off', 'no') then return false; end if;
  return true; -- missing or garbage -> require the code
end;
$$;

revoke execute on function public.transfer_code_required() from public, anon;
grant execute on function public.transfer_code_required() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. local_transfers: internal recipient + idempotency key
-- ---------------------------------------------------------------------------
alter table public.local_transfers
  add column if not exists internal_recipient_id uuid references public.profiles (id),
  add column if not exists request_id text;

create unique index if not exists uq_local_transfer_request
  on public.local_transfers (user_id, request_id)
  where request_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Shared completion helper — ONE implementation of "money moves now",
--    used by customer_verify_transfer (code path) and by the create_* functions
--    (immediate path). Internal only: no client may execute it directly.
-- ---------------------------------------------------------------------------
create or replace function public.complete_transfer_internal(
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

  if p_transfer_type = 'international_transfer' then
    select * into v_xfer from public.international_transfers where id = p_transfer_id for update;
    if not found then return jsonb_build_object('status', 'not_found'); end if;
    if v_xfer.status = 'completed' then
      return jsonb_build_object('status', 'ok', 'reference', v_xfer.reference,
        'transfer_id', p_transfer_id::text, 'already_completed', true);
    end if;
    if v_xfer.status <> 'awaiting_admin_verification' then
      return jsonb_build_object('status', 'not_completable', 'transfer_status', v_xfer.status,
        'reference', v_xfer.reference);
    end if;
    v_uid := v_xfer.user_id;
    select * into v_account from public.accounts where id = v_xfer.from_account_id for update;
    select available_balance into v_balance from public.account_balances where account_id = v_account.id;
    if v_balance is null or v_balance < (v_xfer.amount + v_xfer.fee) then
      update public.international_transfers set status = 'failed', updated_at = now() where id = v_xfer.id;
      perform public.notify_user(v_uid, 'International transfer failed',
        'Transfer ' || v_xfer.reference || ' could not be processed due to insufficient funds.', 'transfer');
      return jsonb_build_object('status', 'failed_insufficient_funds', 'reference', v_xfer.reference);
    end if;
    perform public.apply_balance_change(v_account.id, -(v_xfer.amount + v_xfer.fee), v_account.currency);
    update public.international_transfers
       set status = 'completed', completed_at = now(), updated_at = now()
     where id = v_xfer.id;
    select full_name into v_name from public.profiles where id = v_uid;
    perform public.record_transaction(
      v_uid, v_account.id, 'international_transfer', 'debit', v_xfer.amount, v_account.currency,
      'completed', coalesce(v_xfer.purpose, 'International transfer'), v_name,
      v_xfer.recipient_name || ' (' || v_xfer.recipient_country || ')', v_xfer.fee, v_xfer.id);
    perform public.notify_user(v_uid, 'Transfer completed',
      'Your transfer ' || v_xfer.reference || ' has been completed.', 'transfer');
    return jsonb_build_object('status', 'ok', 'reference', v_xfer.reference,
      'transfer_id', p_transfer_id::text);

  elsif p_transfer_type = 'local_transfer' then
    select * into v_lt from public.local_transfers where id = p_transfer_id for update;
    if not found then return jsonb_build_object('status', 'not_found'); end if;
    if v_lt.status = 'completed' then
      return jsonb_build_object('status', 'ok', 'reference', v_lt.reference,
        'transfer_id', p_transfer_id::text, 'already_completed', true);
    end if;
    if v_lt.status <> 'awaiting_admin_verification' then
      return jsonb_build_object('status', 'not_completable', 'transfer_status', v_lt.status,
        'reference', v_lt.reference);
    end if;
    v_uid := v_lt.user_id;
    select * into v_account from public.accounts where id = v_lt.from_account_id for update;
    select available_balance into v_balance from public.account_balances where account_id = v_account.id;
    if v_balance is null or v_balance < (v_lt.amount + v_lt.fee) then
      update public.local_transfers set status = 'failed', updated_at = now() where id = v_lt.id;
      perform public.notify_user(v_uid, 'Transfer failed',
        'Transfer ' || v_lt.reference || ' could not be processed due to insufficient funds.', 'transfer');
      return jsonb_build_object('status', 'failed_insufficient_funds', 'reference', v_lt.reference);
    end if;
    perform public.apply_balance_change(v_account.id, -(v_lt.amount + v_lt.fee), v_account.currency);
    update public.local_transfers
       set status = 'completed', completed_at = now(), updated_at = now()
     where id = v_lt.id;
    select full_name into v_name from public.profiles where id = v_uid;
    perform public.record_transaction(
      v_uid, v_account.id, 'local_transfer', 'debit', v_lt.amount, v_lt.currency,
      'completed', coalesce(v_lt.description, 'Local transfer'), v_name,
      v_lt.recipient_name, v_lt.fee, v_lt.id);
    perform public.notify_user(v_uid, 'Transfer completed',
      'Your transfer ' || v_lt.reference || ' has been completed.', 'transfer');

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
    return jsonb_build_object('status', 'ok', 'reference', v_lt.reference,
      'transfer_id', p_transfer_id::text);

  else
    -- crypto_withdrawal: funds were debited exactly once at creation time;
    -- verification must NOT debit again.
    select * into v_wd from public.crypto_withdrawals where id = p_transfer_id for update;
    if not found then return jsonb_build_object('status', 'not_found'); end if;
    if v_wd.status in ('processing', 'completed') then
      return jsonb_build_object('status', 'ok', 'reference', v_wd.reference,
        'transfer_id', p_transfer_id::text, 'already_completed', true);
    end if;
    if v_wd.status <> 'awaiting_admin_verification' then
      return jsonb_build_object('status', 'not_completable', 'transfer_status', v_wd.status,
        'reference', v_wd.reference);
    end if;
    v_uid := v_wd.user_id;
    update public.crypto_withdrawals set status = 'processing', updated_at = now() where id = v_wd.id;
    select full_name into v_name from public.profiles where id = v_uid;
    select * into v_account from public.accounts where id = v_wd.from_account_id for update;
    perform public.record_transaction(
      v_uid, v_account.id, 'withdrawal', 'debit', v_wd.amount_fiat, v_account.currency,
      'processing', 'Crypto withdrawal ' || v_wd.amount || ' ' || v_wd.asset, v_name,
      v_wd.wallet_address, v_wd.fee, v_wd.id);
    perform public.notify_user(v_uid, 'Crypto withdrawal submitted',
      'Withdrawal ' || v_wd.reference || ' is now processing.', 'transfer');
    return jsonb_build_object('status', 'ok', 'reference', v_wd.reference,
      'transfer_id', p_transfer_id::text);
  end if;
end;
$$;

-- Internal helper: callable only from within other SECURITY DEFINER functions.
revoke all on function public.complete_transfer_internal(text, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. customer_verify_transfer — same verification contract as 021 (code row
--    lock, expiry, attempt limits, used/revoked/replay guards), but the
--    completion work delegates to the shared helper. A issued code row still
--    gates every call, so this path is independent of the flag: in-progress
--    transfers keep requiring their code even after the admin turns the
--    requirement OFF.
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
  v_res jsonb;
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

  -- Correct code: burn it (single-use, replay-proof), then complete via helper.
  update public.transfer_verification_codes set status = 'used', used_at = now(), updated_at = now() where id = v_code.id;

  v_res := public.complete_transfer_internal(p_transfer_type, p_transfer_id);

  if (v_res->>'status') = 'ok' then
    perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'success', v_code.attempts + 1);
  elsif (v_res->>'status') = 'failed_insufficient_funds' then
    perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, 'failed_insufficient_funds', v_code.attempts + 1);
  else
    perform public.log_verification_attempt(p_transfer_type, p_transfer_id, v_code.id, v_uid, coalesce(v_res->>'status', 'error'), v_code.attempts + 1);
  end if;
  return v_res;
end;
$$;

grant execute on function public.customer_verify_transfer(text, uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. create_local_transfer — the flag decides: awaiting (ON) or immediate
--    completion (OFF). New optional p_request_id for idempotency. The old
--    10-argument signature is dropped so PostgREST sees exactly one overload.
-- ---------------------------------------------------------------------------
drop function if exists public.create_local_transfer(uuid, uuid, text, text, text, numeric, text, text, uuid, text);

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
  p_pin                   text default null,
  p_request_id            text default null
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
  v_required boolean;
  v_res jsonb;
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
  v_required := public.transfer_code_required();

  insert into public.local_transfers (
    reference, user_id, from_account_id, recipient_name, recipient_account_number,
    recipient_bank, amount, currency, fee, description, status, completed_at,
    internal_recipient_id, request_id
  ) values (
    public.generate_reference('LT'), p_user_id, p_from_account_id, p_recipient_name,
    p_recipient_account_number, p_recipient_bank, p_amount, p_currency, v_fee,
    p_description, 'awaiting_admin_verification', null,
    p_internal_recipient, p_request_id
  )
  on conflict (user_id, request_id) where request_id is not null do nothing
  returning * into v_transfer;

  if not found then
    -- Idempotent replay of a previously submitted request: return the stored
    -- row untouched (its debit/completion already happened atomically).
    select * into v_transfer from public.local_transfers
     where user_id = p_user_id and request_id = p_request_id;
    return v_transfer;
  end if;

  if v_required then
    perform public.notify_user(p_user_id,
      'Transfer submitted',
      'Your transfer of ' || to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency ||
      ' to ' || p_recipient_name || ' is awaiting verification. Ref: ' || v_transfer.reference || '.',
      'transfer');
    return v_transfer;
  end if;

  -- Requirement OFF: complete now, in this same transaction. The sender
  -- account row lock was taken above, so no concurrent spend can interleave;
  -- any failure rolls the whole transfer back with no deduction.
  v_res := public.complete_transfer_internal('local_transfer', v_transfer.id);
  if (v_res->>'status') <> 'ok' then
    raise exception 'TRANSFER_FAILED_RELEASE';
  end if;
  select * into v_transfer from public.local_transfers where id = v_transfer.id;
  return v_transfer;
end;
$$;

grant execute on function public.create_local_transfer(uuid, uuid, text, text, text, numeric, text, text, uuid, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. create_international_transfer — flag decides awaiting (ON) or immediate
--    completion (OFF). Signature unchanged (p_request_id already present).
-- ---------------------------------------------------------------------------
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
  v_required boolean;
  v_res jsonb;
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

  v_required := public.transfer_code_required();

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
    if v_required then
      perform public.notify_user(p_user_id,
        'International transfer submitted',
        'Your international transfer of ' || to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency ||
        ' to ' || p_recipient_name || ' was received and is awaiting administrative verification. Ref: ' ||
        v_xfer.reference || '.', 'transfer');
    else
      -- Requirement OFF: debit, ledger entry and completion in one statement.
      -- The sender account row lock was taken above; any failure (e.g. funds
      -- spent in a race) rolls back the whole transfer with no deduction.
      v_res := public.complete_transfer_internal('international_transfer', v_xfer.id);
      if (v_res->>'status') <> 'ok' then
        raise exception 'TRANSFER_FAILED_RELEASE';
      end if;
      select * into v_xfer from public.international_transfers where id = v_xfer.id;
    end if;
  end if;

  return jsonb_build_object(
    'id', v_xfer.id, 'reference', v_xfer.reference, 'status', v_xfer.status,
    'created', v_created, 'amount', p_amount, 'currency', p_currency, 'fee', v_fee
  );
end;
$$;

grant execute on function public.create_international_transfer(uuid, uuid, text, text, text, text, text, numeric, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. create_crypto_withdrawal — the debit is moved AFTER the idempotency
--    insert and happens ONLY for a newly created row, so a replayed
--    p_request_id can never deduct funds twice. The flag decides awaiting
--    (ON) or immediate move to processing (OFF). Signature unchanged.
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
  v_debit_amt numeric;
  v_debit_cur text;
  v_wd public.crypto_withdrawals;
  v_created boolean := true;
  v_required boolean;
  v_res jsonb;
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

  -- Withdrawal from a BTC account debits the asset directly; from a fiat
  -- account the debit is the fiat equivalent. Validate up front (fast fail),
  -- the authoritative check runs inside apply_balance_change at debit time.
  v_amount_fiat := round(p_amount * v_asset.rate_usd, 2);
  if v_account.currency = p_asset then
    v_debit_amt := p_amount + v_fee;
    v_debit_cur := p_asset;
  else
    v_debit_amt := v_amount_fiat + v_fee;
    v_debit_cur := v_base;
  end if;
  if v_balance < v_debit_amt then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  v_required := public.transfer_code_required();

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
    -- The one and only deduction for this withdrawal. If it raises, the
    -- insert above rolls back with it — no orphan row, no partial debit.
    perform public.apply_balance_change(p_from_account_id, -v_debit_amt, v_debit_cur);

    if v_required then
      perform public.notify_user(p_user_id,
        'Crypto withdrawal submitted',
        'Your withdrawal of ' || p_amount || ' ' || p_asset || ' to ' || p_wallet_address ||
        ' was received and is awaiting administrative verification. Ref: ' || v_wd.reference || '.', 'transfer');
    else
      v_res := public.complete_transfer_internal('crypto_withdrawal', v_wd.id);
      if (v_res->>'status') <> 'ok' then
        raise exception 'TRANSFER_FAILED_RELEASE';
      end if;
      select * into v_wd from public.crypto_withdrawals where id = v_wd.id;
    end if;
  end if;

  return jsonb_build_object(
    'id', v_wd.id, 'reference', v_wd.reference, 'status', v_wd.status,
    'created', v_created, 'amount', p_amount, 'asset', p_asset,
    'amount_fiat', v_amount_fiat, 'currency', v_base, 'fee', v_fee
  );
end;
$$;

grant execute on function public.create_crypto_withdrawal(uuid, uuid, text, text, text, numeric, text, text) to anon, authenticated;

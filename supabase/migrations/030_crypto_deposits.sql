-- Migration 030: cryptocurrency-only deposits (Bitcoin)
--
-- Turns the deposit system into a Bitcoin-only, verifiable workflow while
-- staying inside the existing `public.deposits` table, admin list and admin
-- approve/reject UI.
--
-- HOW A DEPOSIT IS ATTRIBUTED (important)
-- ---------------------------------------
-- The platform has ONE shared Bitcoin address, so an incoming payment cannot
-- be tied to a user by address alone. Attribution therefore uses amount
-- tagging: create_btc_deposit() reserves a UNIQUE number of satoshis for the
-- request (base amount + a small offset that never collides with another
-- active request). The client must send EXACTLY that amount; the QR code and
-- the BIP-21 URI both carry it so wallets prefill it. Matching is then plain
-- integer equality on satoshis, which cannot be ambiguous.
--
-- VERIFICATION RULE
-- -----------------
-- Crediting is ONLY reachable from `credit_btc_deposit()`, which is granted
-- to `service_role` alone (i.e. the `monitor-btc-deposits` edge function).
-- It reads the chain itself, requires the observed output value to equal the
-- reserved `expected_sats`, and requires the required confirmation count.
-- The frontend never submits a tx hash and has no crediting path at all, so
-- a screenshot, a typed-in hash or a fake success animation credits nothing.
--
-- SINGLE-CREDIT GUARANTEE
-- -----------------------
-- `credit_btc_deposit()` takes `select ... for update` on the deposit row and
-- re-checks `credited_at is null` while holding that lock, so two concurrent
-- monitor runs (or monitor + admin) cannot both credit. A partial unique index
-- on `tx_hash` additionally stops two deposit rows claiming one chain tx, and
-- `admin_update_deposit()` is tightened to refuse completing a crypto deposit
-- that has not satisfied the confirmation requirement.
--
-- STATUS MODEL (per the spec)
--   awaiting   -> Awaiting Deposit: no qualifying payment detected
--   processing -> Processing: detected, awaiting confirmations
--   completed  -> Completed: confirmations met, credited (credited_at set)
--   expired    -> Expired: expired before any qualifying payment
--   failed     -> Failed: observed payment did not satisfy the rules
--   pending / rejected kept for legacy fiat rows so history stays intact.
--
-- DEPOSIT ADDRESS: seeded into system_settings (single source of truth read
-- by both this schema and the frontend via btc_deposit_config()).
--
-- ROLLBACK:
--   drop function public.btc_deposit_config();
--   drop function public.create_btc_deposit(uuid, uuid, numeric, text);
--   drop function public.credit_btc_deposit(uuid, text, int, bigint);
--   drop function public.record_btc_tx(text, text, bigint, int, boolean, uuid);
--   drop function public.expire_btc_deposits();
--   drop table if exists public.crypto_deposit_txs;
--   delete from public.system_settings where key in
--     ('btc_deposit_address','btc_deposit_confirmations','btc_deposit_expiry_minutes',
--      'btc_deposit_min_btc','btc_deposit_max_btc','btc_usd_rate','btc_esplora_api');
--   alter table public.deposits drop column if exists network, drop column if exists wallet_address,
--     drop column if exists expected_amount, drop column if exists expected_sats,
--     drop column if exists btc_rate, drop column if exists tx_hash, drop column if exists confirmations,
--     drop column if exists required_confirmations, drop column if exists detected_at,
--     drop column if exists completed_at, drop column if exists expires_at,
--     drop column if exists credited_at, drop column if exists monitor_note;
--   (constraints can be restored from 002_core_schema.sql)

-- ---------------------------------------------------------------------------
-- 1. Constraints: allow the crypto method and the new status values
-- ---------------------------------------------------------------------------
alter table public.deposits drop constraint if exists deposits_method_check;
alter table public.deposits add constraint deposits_method_check
  check (method in ('cash', 'bank_transfer', 'cheque', 'card', 'online', 'crypto'));

alter table public.deposits drop constraint if exists deposits_status_check;
alter table public.deposits add constraint deposits_status_check
  check (status in ('pending', 'processing', 'completed', 'failed', 'rejected',
                    'awaiting', 'expired'));

-- ---------------------------------------------------------------------------
-- 2. Bitcoin columns on the deposit record
-- ---------------------------------------------------------------------------
alter table public.deposits
  add column if not exists network               text,
  add column if not exists wallet_address        text,
  add column if not exists expected_amount       numeric(20, 8),
  add column if not exists expected_sats         bigint,
  add column if not exists btc_rate              numeric(20, 8),
  add column if not exists tx_hash               text,
  add column if not exists confirmations         int not null default 0,
  add column if not exists required_confirmations int not null default 1,
  add column if not exists detected_at           timestamptz,
  add column if not exists completed_at          timestamptz,
  add column if not exists expires_at            timestamptz,
  add column if not exists credited_at           timestamptz,
  add column if not exists monitor_note          text;

create unique index if not exists uq_deposits_tx_hash on public.deposits (tx_hash)
  where tx_hash is not null;
-- two active requests must never reserve the same satoshi amount, otherwise
-- one on-chain payment could be attributed to two users
create unique index if not exists uq_deposits_active_sats on public.deposits (expected_sats)
  where method = 'crypto' and status in ('awaiting', 'processing');
create index if not exists idx_deposits_active on public.deposits (status, expires_at)
  where method = 'crypto';

-- ---------------------------------------------------------------------------
-- 3. Observed on-chain transactions (monitor bookkeeping, admin visibility)
-- ---------------------------------------------------------------------------
create table if not exists public.crypto_deposit_txs (
  tx_hash           text primary key,
  address           text not null,
  value_sats        bigint not null,
  confirmations     int not null default 0,
  in_block          boolean not null default false,
  first_seen_at     timestamptz not null default now(),
  last_checked_at   timestamptz not null default now(),
  matched_deposit_id uuid references public.deposits (id) on delete set null
);
alter table public.crypto_deposit_txs enable row level security;
drop policy if exists "crypto_deposit_txs_no_access" on public.crypto_deposit_txs;
create policy "crypto_deposit_txs_no_access" on public.crypto_deposit_txs
  for all using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 4. Configuration (single source of truth for frontend AND backend)
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value, description) values
  ('btc_deposit_address',       '"bc1qgjgkldh3phdx20l3l4awjh8z82qr5pnhafxh4z"', 'Bitcoin address customers send deposits to'),
  ('btc_deposit_confirmations', '1',  'Block confirmations required before a Bitcoin deposit is credited'),
  ('btc_deposit_expiry_minutes','60', 'Minutes before an unused Bitcoin deposit request expires'),
  ('btc_deposit_min_btc',       '0.0001', 'Minimum Bitcoin deposit (BTC)'),
  ('btc_deposit_max_btc',       '5',  'Maximum Bitcoin deposit (BTC)'),
  ('btc_usd_rate',              '83000', 'USD per BTC used to quote and lock a deposit amount'),
  ('btc_esplora_api',           '"https://mempool.space/api"', 'Block explorer Esplora API base used to verify deposits')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 5. BTC/USD rate used to quote (and then LOCK) the fiat credit
-- ---------------------------------------------------------------------------
create or replace function public.btc_usd_rate()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    -- jsonb numbers arrive as '83000', string settings as '"83000"'
    (select nullif(case when jsonb_typeof(value) = 'number'
                        then value #>> '{}' else replace(value #>> '{}', '"', '') end, '')::numeric
       from public.system_settings where key = 'btc_usd_rate'),
    (select rate_usd from public.crypto_assets where asset = 'BTC' and network = 'bitcoin'),
    (select rate from public.exchange_rates where base_currency = 'BTC' and quote_currency = 'USD')
  );
$$;

-- ---------------------------------------------------------------------------
-- 6. Public deposit configuration for the frontend
-- ---------------------------------------------------------------------------
create or replace function public.btc_deposit_config()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'address',            (select value #>> '{}' from public.system_settings where key = 'btc_deposit_address'),
    'network',            'bitcoin',
    'network_label',      'Bitcoin (BTC) · native segwit',
    'confirmations',      coalesce((select (value #>> '{}')::int from public.system_settings where key = 'btc_deposit_confirmations'), 1),
    'expiry_minutes',     coalesce((select (value #>> '{}')::int from public.system_settings where key = 'btc_deposit_expiry_minutes'), 60),
    'min_btc',            coalesce((select (value #>> '{}')::numeric from public.system_settings where key = 'btc_deposit_min_btc'), 0.0001),
    'max_btc',            coalesce((select (value #>> '{}')::numeric from public.system_settings where key = 'btc_deposit_max_btc'), 5),
    'btc_usd_rate',       public.btc_usd_rate()
  );
$$;

-- ---------------------------------------------------------------------------
-- 7. Create a Bitcoin deposit request (reserves a unique satoshi amount)
-- ---------------------------------------------------------------------------
create or replace function public.create_btc_deposit(
  p_user_id     uuid,
  p_account_id  uuid,
  p_amount_btc  numeric,
  p_note        text default null
)
returns public.deposits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account    public.accounts%rowtype;
  v_address    text;
  v_rate       numeric;
  v_fx         numeric := 1;
  v_min        numeric;
  v_max        numeric;
  v_expiry     int;
  v_conf       int;
  v_btc        numeric;
  v_base_sats  bigint;
  v_sats       bigint;
  v_offset     int := null;
  v_amount     numeric;
  v_deposit    public.deposits;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_account from public.accounts
   where id = p_account_id and user_id = p_user_id and status = 'active';
  if not found then
    raise exception 'INVALID_ACCOUNT';
  end if;

  select (value #>> '{}') into v_address
    from public.system_settings where key = 'btc_deposit_address';
  if v_address is null or v_address = '' then
    raise exception 'BTC_ADDRESS_NOT_CONFIGURED';
  end if;

  -- four separate scalar subqueries: one row per setting, not one row total
  select
    (select (value #>> '{}')::int    from public.system_settings where key = 'btc_deposit_confirmations'),
    (select (value #>> '{}')::int    from public.system_settings where key = 'btc_deposit_expiry_minutes'),
    (select (value #>> '{}')::numeric from public.system_settings where key = 'btc_deposit_min_btc'),
    (select (value #>> '{}')::numeric from public.system_settings where key = 'btc_deposit_max_btc')
    into v_conf, v_expiry, v_min, v_max;
  v_conf  := coalesce(v_conf, 1);
  v_expiry := coalesce(v_expiry, 60);
  v_min   := coalesce(v_min, 0.0001);
  v_max   := coalesce(v_max, 5);

  if p_amount_btc is null or p_amount_btc::numeric <= 0 then
    raise exception 'INVALID_AMOUNT';
  end if;
  v_btc := round(p_amount_btc::numeric, 8);
  if v_btc < v_min then
    raise exception 'BELOW_MINIMUM';
  end if;
  if v_btc > v_max then
    raise exception 'ABOVE_MAXIMUM';
  end if;

  if (select count(*) from public.deposits
       where user_id = p_user_id and method = 'crypto'
         and status in ('awaiting', 'processing')) >= 3 then
    raise exception 'TOO_MANY_ACTIVE_DEPOSITS';
  end if;

  v_rate := public.btc_usd_rate();
  if v_rate is null or v_rate <= 0 then
    raise exception 'RATE_UNAVAILABLE';
  end if;

  if v_account.currency <> 'USD' then
    select rate into v_fx from public.exchange_rates
     where base_currency = 'USD' and quote_currency = v_account.currency;
    if v_fx is null or v_fx <= 0 then
      raise exception 'RATE_UNAVAILABLE';
    end if;
  end if;

  -- reserve a unique satoshi amount so this payment is unambiguous
  v_base_sats := round(v_btc * 100000000)::bigint;
  for i in 0..999 loop
    if not exists (
      select 1 from public.deposits
       where method = 'crypto'
         and status in ('awaiting', 'processing')
         and expected_sats = v_base_sats + i
    ) then
      v_offset := i;
      exit;
    end if;
  end loop;
  if v_offset is null then
    raise exception 'AMOUNT_TAG_EXHAUSTED';
  end if;
  v_sats := v_base_sats + v_offset;

  -- quote the fiat credit from the reserved amount and lock it on the row
  v_amount := round((v_sats::numeric / 100000000.0) * v_rate * v_fx, 2);
  if v_amount is null or v_amount < 0.01 then
    raise exception 'AMOUNT_TOO_SMALL';
  end if;

  -- uq_deposits_active_sats can reject a concurrent reservation of the same
  -- amount; bump the offset and retry so we still return a unique amount.
  for attempt in 1..5 loop
    begin
      insert into public.deposits (
        reference, user_id, account_id, amount, currency, method, note, status,
        network, wallet_address, expected_amount, expected_sats, btc_rate,
        required_confirmations, expires_at
      ) values (
        public.generate_reference('BTC'), p_user_id, p_account_id, v_amount, v_account.currency,
        'crypto', p_note, 'awaiting', 'bitcoin', v_address,
        round(v_sats::numeric / 100000000.0, 8), v_sats, v_rate,
        v_conf, now() + make_interval(mins => v_expiry)
      ) returning * into v_deposit;
      exit;
    exception when unique_violation then
      v_sats := v_sats + 1;
      v_amount := round((v_sats::numeric / 100000000.0) * v_rate * v_fx, 2);
      if attempt = 5 then
        raise;
      end if;
    end;
  end loop;

  perform public.notify_user(p_user_id,
    'Bitcoin deposit started',
    'Send exactly ' || to_char(v_sats / 100000000.0, 'FM999999990.00000000') ||
    ' BTC on the Bitcoin network to complete deposit ' || v_deposit.reference ||
    '. It expires in ' || v_expiry || ' minutes.',
    'deposit');

  return v_deposit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Record an observed on-chain transaction (monitor only)
-- ---------------------------------------------------------------------------
create or replace function public.record_btc_tx(
  p_tx_hash      text,
  p_address      text,
  p_value_sats   bigint,
  p_confirmations int,
  p_in_block     boolean,
  p_matched_deposit_id uuid default null
)
returns public.crypto_deposit_txs
language plpgsql
security definer
set search_path = public
as $$
declare v_tx public.crypto_deposit_txs;
begin
  insert into public.crypto_deposit_txs
    (tx_hash, address, value_sats, confirmations, in_block, matched_deposit_id, last_checked_at)
  values
    (p_tx_hash, p_address, p_value_sats, p_confirmations, p_in_block, p_matched_deposit_id, now())
  on conflict (tx_hash) do update
    set confirmations     = excluded.confirmations,
        in_block          = excluded.in_block,
        last_checked_at   = now(),
        matched_deposit_id = coalesce(crypto_deposit_txs.matched_deposit_id, excluded.matched_deposit_id)
  returning * into v_tx;
  return v_tx;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Credit a verified Bitcoin deposit — service_role ONLY
-- ---------------------------------------------------------------------------
create or replace function public.credit_btc_deposit(
  p_deposit_id   uuid,
  p_tx_hash      text,
  p_confirmations int,
  p_value_sats   bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deposit public.deposits%rowtype;
begin
  -- row lock serialises concurrent monitor/admin runs
  select * into v_deposit from public.deposits
   where id = p_deposit_id for update;
  if not found then
    raise exception 'DEPOSIT_NOT_FOUND';
  end if;
  if v_deposit.method <> 'crypto' then
    raise exception 'NOT_CRYPTO_DEPOSIT';
  end if;

  -- idempotency: already paid out
  if v_deposit.credited_at is not null or v_deposit.status = 'completed' then
    return jsonb_build_object('credited', false, 'already_credited', true,
                              'status', v_deposit.status, 'deposit_id', p_deposit_id);
  end if;

  -- server-side value check against what we reserved. A payment with the
  -- wrong value is simply NOT this request's payment: leave the request
  -- awaiting (its own payment may still arrive) and do not burn its tx_hash.
  if p_value_sats is distinct from v_deposit.expected_sats then
    update public.deposits
       set monitor_note = 'Saw an unrelated ' || p_value_sats || ' sat payment on the shared address; ' ||
                          'this request expects ' || v_deposit.expected_sats || ' sats',
           updated_at = now()
     where id = p_deposit_id;
    return jsonb_build_object('credited', false, 'failed', 'AMOUNT_MISMATCH',
                              'deposit_id', p_deposit_id);
  end if;

  update public.deposits
     set tx_hash = p_tx_hash,
         confirmations = p_confirmations,
         detected_at = coalesce(detected_at, now()),
         updated_at = now()
   where id = p_deposit_id;

  if p_confirmations < coalesce(v_deposit.required_confirmations, 1) then
    update public.deposits set status = 'processing', updated_at = now()
     where id = p_deposit_id and status in ('awaiting', 'pending');
    return jsonb_build_object('credited', false, 'status', 'processing',
                              'confirmations', p_confirmations,
                              'required', coalesce(v_deposit.required_confirmations, 1));
  end if;

  -- single-credit: only flip credited_at while holding the lock
  update public.deposits
     set status = 'completed',
         credited_at = now(),
         completed_at = now(),
         updated_at = now()
   where id = p_deposit_id and credited_at is null;

  if not found then
    return jsonb_build_object('credited', false, 'already_credited', true);
  end if;

  perform public.apply_balance_change(v_deposit.account_id, v_deposit.amount, v_deposit.currency);
  perform public.record_transaction(
    v_deposit.user_id, v_deposit.account_id, 'deposit', 'credit', v_deposit.amount,
    v_deposit.currency, 'completed',
    'Bitcoin deposit ' || v_deposit.reference,
    'Bitcoin ' || left(coalesce(p_tx_hash, ''), 12) || '…',
    v_deposit.user_id::text, 0, v_deposit.id
  );
  perform public.notify_user(v_deposit.user_id, 'Deposit completed',
    coalesce(
      'Your Bitcoin deposit of ' || to_char(v_deposit.amount, 'FM9,999,999,990.00') || ' ' ||
      v_deposit.currency || ' (' ||
      to_char(coalesce(v_deposit.expected_amount,
                       (v_deposit.expected_sats / 100000000.0)::numeric),
              'FM999999990.00000000') ||
      ' BTC) is confirmed and credited. Ref: ' || v_deposit.reference || '.',
      'Your Bitcoin deposit is confirmed and credited. Ref: ' || v_deposit.reference || '.'
    ), 'deposit');

  return jsonb_build_object('credited', true, 'status', 'completed',
                            'confirmations', p_confirmations, 'deposit_id', p_deposit_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Expire stale requests (monitor only)
-- ---------------------------------------------------------------------------
create or replace function public.expire_btc_deposits()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  update public.deposits
     set status = 'expired', updated_at = now(),
         monitor_note = coalesce(monitor_note, 'No qualifying payment received before expiry')
   where method = 'crypto'
     and status = 'awaiting'
     and expires_at is not null
     and expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Admin approval may not bypass verification for crypto deposits
-- ---------------------------------------------------------------------------
create or replace function public.admin_update_deposit(
  p_token text, p_deposit_id uuid, p_status text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb; v_deposit public.deposits%rowtype;
begin
  if not public.admin_can(p_token, 'deposits.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select * into v_deposit from public.deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'DEPOSIT_NOT_FOUND';
  end if;
  select to_jsonb(v_deposit) into v_old;

  -- A crypto deposit may only be completed once the chain has actually been
  -- verified (credit_btc_deposit does this); an admin cannot mark it paid by
  -- hand. Rejecting/expiring it is still allowed.
  if p_status = 'completed'
     and v_deposit.method = 'crypto'
     and (v_deposit.credited_at is null
          or coalesce(v_deposit.confirmations, 0) < coalesce(v_deposit.required_confirmations, 1)) then
    raise exception 'DEPOSIT_NOT_VERIFIED';
  end if;

  update public.deposits set status = p_status, updated_at = now()
   where id = p_deposit_id;

  if p_status = 'completed'
     and v_deposit.method <> 'crypto'
     and v_deposit.status in ('pending', 'processing')
     and v_deposit.credited_at is null then
    update public.deposits set credited_at = now() where id = p_deposit_id and credited_at is null;
    if found then
      perform public.apply_balance_change(v_deposit.account_id, v_deposit.amount, v_deposit.currency);
      perform public.record_transaction(
        v_deposit.user_id, v_deposit.account_id, 'deposit', 'credit', v_deposit.amount,
        v_deposit.currency, 'completed', 'Deposit ' || v_deposit.reference,
        v_deposit.user_id::text, v_deposit.user_id::text, 0, v_deposit.id);
    end if;
    perform public.notify_user(v_deposit.user_id, 'Deposit completed',
      'Your deposit of ' || to_char(v_deposit.amount, 'FM9,999,999,990.00') || ' ' || v_deposit.currency ||
      ' was completed. Ref: ' || v_deposit.reference || '.', 'deposit');
  elsif p_status = 'rejected' then
    perform public.notify_user(v_deposit.user_id, 'Deposit rejected',
      'Your deposit of ' || to_char(v_deposit.amount, 'FM9,999,999,990.00') || ' ' || v_deposit.currency ||
      ' was rejected. Contact support for details.', 'deposit');
  end if;

  perform public.log_audit(p_token, 'UPDATE_STATUS', 'deposit', p_deposit_id::text, v_old,
                           jsonb_build_object('status', p_status));
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Grants: clients may create/read, only service_role may credit
-- ---------------------------------------------------------------------------
-- The monitor edge function runs as service_role and resolves deposit rows
-- before calling the SECURITY DEFINER credit function.
grant  select on public.deposits to service_role;

revoke execute on function public.btc_deposit_config() from public, anon;
grant  execute on function public.btc_deposit_config() to authenticated;

revoke execute on function public.create_btc_deposit(uuid, uuid, numeric, text) from public, anon;
grant  execute on function public.create_btc_deposit(uuid, uuid, numeric, text) to authenticated;

revoke execute on function public.credit_btc_deposit(uuid, text, int, bigint)
  from public, anon, authenticated;
grant  execute on function public.credit_btc_deposit(uuid, text, int, bigint) to service_role;

revoke execute on function public.record_btc_tx(text, text, bigint, int, boolean, uuid)
  from public, anon, authenticated;
grant  execute on function public.record_btc_tx(text, text, bigint, int, boolean, uuid) to service_role;

revoke execute on function public.expire_btc_deposits() from public, anon, authenticated;
grant  execute on function public.expire_btc_deposits() to service_role;

revoke execute on function public.btc_usd_rate() from public, anon;
grant  execute on function public.btc_usd_rate() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 13. Verification
-- ---------------------------------------------------------------------------
do $$
declare hits int;
begin
  select count(*) into hits
    from information_schema.columns
   where table_schema = 'public' and table_name = 'deposits'
     and column_name in ('network', 'wallet_address', 'expected_amount', 'expected_sats',
                         'btc_rate', 'tx_hash', 'confirmations', 'required_confirmations',
                         'detected_at', 'completed_at', 'expires_at', 'credited_at', 'monitor_note');
  if hits <> 13 then
    raise exception 'DEPOSIT_COLUMNS_MISSING: found % of 13', hits;
  end if;

  if coalesce((select value #>> '{}' from public.system_settings where key = 'btc_deposit_address'), '') <> 'bc1qgjgkldh3phdx20l3l4awjh8z82qr5pnhafxh4z' then
    raise exception 'BTC_ADDRESS_NOT_SEEDED';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'credit_btc_deposit'
  ) then
    raise exception 'CREDIT_FUNCTION_MISSING';
  end if;

  raise notice 'Migration 030 verification passed';
end $$;

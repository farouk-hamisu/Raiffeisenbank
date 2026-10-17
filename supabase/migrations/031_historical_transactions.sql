-- Marvin Bank - Migration 031
-- Record eight dated historical transactions for a single target user,
-- totalling USD 2,406,061.10, ADDED to (never replacing) the account's
-- existing balance.
--
-- IMPORTANT — ADMINISTRATIVE ADJUSTMENT RECORDS (NOT VERIFIED PAYMENTS):
--   The authenticity of these eight items cannot be verified: they were
--   supplied as a list of dates and amounts with no supporting statements,
--   counterparties or reference numbers. Every row this migration writes is
--   therefore labelled as an ADMINISTRATIVE BALANCE ADJUSTMENT:
--     * type        = 'adjustment'      (never 'deposit' / 'transfer')
--     * sender      = 'Marvin Bank — Data Migration'
--     * description = '... historical record import (migration 031),
--                      not a verified payment'
--     * reference   = 'HIST031-<8 hex of md5(user_id)>-<YYYYMMDD>'
--       (unique, user-scoped so the global reference namespace can never
--       collide across targets — same md5(user_id) idiom as migration 026)
--   They must not be represented as authentic deposits or payments.
--
-- Target / scope / safety:
--   * Targets EXACTLY ONE user, found by email below. If no such profile
--     exists the migration ABORTS without writing anything.
--   * Destination account: the user's OLDEST ACTIVE USD account. If the user
--     has no active USD account, one 'checking' USD account is created first
--     (same pattern as migration 026) so that USD amounts never land on a
--     non-USD account (apply_balance_change would raise CURRENCY_MISMATCH).
--   * Existing balance is READ, REPORTED, then INCREMENTED — never replaced.
--   * Atomic: the whole file is a single DO block = one statement; any
--     RAISE EXCEPTION rolls back every write in the block.
--   * Idempotent: rows carry fixed deterministic references, inserted with
--     ON CONFLICT (reference) DO NOTHING; the balance is incremented ONLY by
--     the rows actually inserted on THIS run, so re-running is a verified
--     no-op (see verification below).
--
-- Balance model (inspected before writing this migration):
--   * Balances are STORED on public.account_balances
--     (available_balance and ledger_balance, numeric(20,2)).
--   * There is NO trigger that derives balances from transactions — the only
--     triggers touching public.transactions are the touch_updated_at family
--     (updated_at on UPDATE only).
--   * Balance movement is EXPLICIT via public.apply_balance_change()
--     (same helper used by credit_btc_deposit and the admin deposit flows),
--     which updates available_balance and ledger_balance together, holds row
--     locks, and guards CURRENCY_MISMATCH / INSUFFICIENT_FUNDS.
--   * public.record_transaction() does NOT touch balances (confirmed
--     empirically) and does not accept created_at, so historical dates are
--     written with a direct INSERT (same approach as migration 026).
--   * This migration therefore writes the 8 ledger rows and applies exactly
--     ONE apply_balance_change(+sum of rows inserted this run). Nothing can
--     be double-counted.
--
-- PRE-CHECK — run manually in the SQL Editor BEFORE applying to inspect the
-- current state (read-only):
--
--   select p.id as user_id, p.email, a.id as account_id, a.account_number,
--          a.currency, a.status, b.available_balance, b.ledger_balance,
--          b.updated_at as balance_updated_at
--     from public.profiles p
--     left join public.accounts a
--            on a.user_id = p.id and a.currency = 'USD' and a.status = 'active'
--     left join public.account_balances b on b.account_id = a.id
--    where lower(p.email) = lower('mangratelawrence@gmail.com')
--    order by a.created_at;
--
-- ROLLBACK (manual, if this seed must be undone — run BOTH statements in one
-- transaction after confirming the count is 8):
--
--   begin;
--   delete from public.transactions
--    where reference like 'HIST031-%'
--      and user_id = (select id from public.profiles
--                      where lower(email) = lower('mangratelawrence@gmail.com'))
--      and account_id = (select id from public.accounts
--                         where user_id = (select id from public.profiles
--                                            where lower(email) = lower('mangratelawrence@gmail.com'))
--                           and currency = 'USD' and status = 'active'
--                         order by created_at limit 1);
--   -- then subtract the same total from that account's balances:
--   -- select public.apply_balance_change(<account_id>, -2406061.10, 'USD');
--   commit;

do $$
declare
  -- ---- target -------------------------------------------------------------
  v_email        constant text := 'mangratelawrence@gmail.com';
  v_currency     constant text := 'USD';
  v_total        constant numeric(20,2) := 2406061.10;   -- stated sum of the 8
  v_ref_prefix   constant text := 'HIST031-';
  v_ref_base     text;                    -- prefix + md5(user_id) + '-'
  v_description  constant text
                 := 'Administrative balance adjustment — historical record '
                    || 'import (migration 031), not a verified payment';
  v_sender       constant text := 'Marvin Bank — Data Migration';

  -- ---- handles ------------------------------------------------------------
  v_user_id      uuid;
  v_holder       text;
  v_account_id   uuid;
  v_account_no   text;
  v_created_acct boolean := false;

  -- ---- balance snapshot ---------------------------------------------------
  v_before_avail numeric := 0;
  v_before_ledg  numeric := 0;
  v_ins_n        int := 0;          -- rows actually inserted THIS run
  v_ins_sum      numeric(20,2) := 0;
  v_after_avail  numeric;
  v_after_ledg   numeric;

  -- ---- loop / verification ------------------------------------------------
  r              record;
  v_amt          numeric;           -- RETURNING target for one insert
  v_ok           int;
  v_ts           timestamptz;
  v_all_sum      numeric(20,2);     -- sum of ALL 8 HIST031 rows (verification)
begin
  -- ------------------------------------------------------------------ 1. user
  select id, coalesce(nullif(full_name, ''),
                      split_part(email, '@', 1), 'Customer')
    into v_user_id, v_holder
    from public.profiles
   where lower(email) = lower(v_email)
   order by created_at
   limit 1;

  if v_user_id is null then
    raise exception 'ABORT: target user % not found — no rows written.', v_email;
  end if;
  v_ref_base := v_ref_prefix || upper(substr(md5(v_user_id::text), 1, 8)) || '-';

  -- -------------------------------------------------- 2. destination account
  select id, account_number
    into v_account_id, v_account_no
    from public.accounts
   where user_id = v_user_id and currency = v_currency and status = 'active'
   order by created_at
   limit 1;

  if v_account_id is null then
    -- No active USD account: create one (migration-026 pattern) so USD rows
    -- never land on a foreign-currency account.
    v_account_id := gen_random_uuid();
    v_account_no  := public.generate_account_number();
    insert into public.accounts
      (id, user_id, account_number, account_name, account_type, currency, status)
    values
      (v_account_id, v_user_id, v_account_no,
       v_holder || ' — USD Checking', 'checking', v_currency, 'active');
    insert into public.account_balances
      (account_id, available_balance, ledger_balance, currency)
    values (v_account_id, 0, 0, v_currency);
    v_created_acct := true;
    raise notice '031: no active USD account for % — created account % (balance 0).',
      v_email, v_account_no;
  end if;

  -- -------------------------------------------------- 3. balance BEFORE (read)
  select coalesce(available_balance, 0), coalesce(ledger_balance, 0)
    into v_before_avail, v_before_ledg
    from public.account_balances
   where account_id = v_account_id;
  if v_before_avail is null then
    v_before_avail := 0;
    v_before_ledg  := 0;
  end if;

  -- ------------------------------------------------------- 4. insert the rows
  -- The eight items exactly as supplied (dates DD/MM/YYYY). Any typo here
  -- fails the sum verification below and rolls the whole block back.
  for r in
    select * from (values
      ('2023-01-30'::date, 326010.00::numeric),
      ('2023-03-24'::date, 182954.00::numeric),
      ('2023-07-01'::date, 54600.00::numeric),
      ('2023-12-29'::date, 82965.00::numeric),
      ('2024-01-01'::date, 158876.50::numeric),
      ('2024-08-30'::date, 1115954.00::numeric),
      ('2025-04-15'::date, 451600.00::numeric),
      ('2026-02-28'::date, 33101.60::numeric)
    ) as v (on_date, amt)
  loop
    v_ts := (r.on_date + time '12:00:00') at time zone 'UTC';

    insert into public.transactions
      (reference, user_id, account_id, type, direction, amount, currency, fee,
       status, description, sender, recipient, created_at, updated_at)
    values
      (v_ref_base || to_char(r.on_date, 'YYYYMMDD'),
       v_user_id, v_account_id, 'adjustment', 'credit', r.amt, v_currency, 0,
       'completed', v_description, v_sender, v_holder, v_ts, v_ts)
    on conflict (reference) do nothing
    returning amount into v_amt;    -- NULL when the row already existed

    if v_amt is not null then
      v_ins_n   := v_ins_n + 1;
      v_ins_sum := v_ins_sum + v_amt;
    end if;
  end loop;

  -- --------------------------------- 5. balance: add ONLY what we just wrote
  if v_ins_n > 0 then
    perform public.apply_balance_change(v_account_id, v_ins_sum, v_currency);
    raise notice '031: inserted % of 8 row(s) this run (USD %); balance +%%.',
      v_ins_n, v_ins_sum;
  else
    raise notice '031: all 8 rows already present (idempotent re-run) — balance untouched.';
  end if;

  -- ------------------------------------------------------------ 6. verify all
  -- 6a. every expected row exists, exactly once, with the exact date, amount,
  --     type, direction, status and currency.
  for r in
    select * from (values
      ('2023-01-30'::date, 326010.00::numeric),
      ('2023-03-24'::date, 182954.00::numeric),
      ('2023-07-01'::date, 54600.00::numeric),
      ('2023-12-29'::date, 82965.00::numeric),
      ('2024-01-01'::date, 158876.50::numeric),
      ('2024-08-30'::date, 1115954.00::numeric),
      ('2025-04-15'::date, 451600.00::numeric),
      ('2026-02-28'::date, 33101.60::numeric)
    ) as v (on_date, amt)
  loop
    v_ts := (r.on_date + time '12:00:00') at time zone 'UTC';
    select count(*) into v_ok
      from public.transactions
     where reference = v_ref_base || to_char(r.on_date, 'YYYYMMDD')
       and user_id = v_user_id
       and account_id = v_account_id
       and type = 'adjustment'
       and direction = 'credit'
       and amount = r.amt
       and currency = v_currency
       and fee = 0
       and status = 'completed'
       and created_at = v_ts;
    if v_ok <> 1 then
      raise exception
        'VERIFICATION FAILED: expected exactly 1 row for % / USD %, found %.',
        r.on_date, r.amt, v_ok;
    end if;
  end loop;

  -- 6b. count = 8 and sum = the stated total, scoped to this user+account.
  select count(*), coalesce(sum(amount), 0)
    into v_ok, v_all_sum
    from public.transactions
   where user_id = v_user_id
     and account_id = v_account_id
     and reference like (v_ref_prefix || '%');
  if v_ok <> 8 then
    raise exception 'VERIFICATION FAILED: expected 8 HIST031 rows, found %.', v_ok;
  end if;
  if v_all_sum <> v_total then
    raise exception
      'VERIFICATION FAILED: HIST031 rows sum to %, expected %.', v_all_sum, v_total;
  end if;

  -- 6c. stored balance = balance read at start + rows inserted THIS run,
  --     and available_balance = ledger_balance.
  select available_balance, ledger_balance
    into v_after_avail, v_after_ledg
    from public.account_balances
   where account_id = v_account_id;
  if v_after_avail is distinct from (v_before_avail + v_ins_sum) then
    raise exception
      'VERIFICATION FAILED: balance % <> before % + inserted %.',
      v_after_avail, v_before_avail, v_ins_sum;
  end if;
  if v_after_ledg is distinct from v_after_avail then
    raise exception
      'VERIFICATION FAILED: ledger_balance % <> available_balance %.',
      v_after_ledg, v_after_avail;
  end if;

  -- ------------------------------------------------------------- 7. report
  raise notice '=== Migration 031 — administrative historical adjustments ===';
  raise notice 'Target user   : % (%)', v_email, v_user_id;
  raise notice 'Account       : % (USD, id %)%', v_account_no, v_account_id,
    case when v_created_acct then ' [created this run]' else '' end;
  raise notice 'Rows          : 8 HIST031- records, dates preserved, sum USD %', v_total;
  raise notice 'Balance calc  : USD % (before) + USD % (inserted this run) = USD % (after)',
    v_before_avail, v_ins_sum, v_after_avail;
  raise notice 'Verification  : 8 rows ✓  sum = % ✓  balance delta ✓  ledger = available ✓',
    v_total;
  raise notice 'Label         : type=adjustment, "not a verified payment" (migration 031)';
end;
$$;

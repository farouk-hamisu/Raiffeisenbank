-- Marvin Bank - Migration 026
-- Seed a comprehensive historical transaction ledger for a single target user.
--
-- IMPORTANT — TEST / DEMO DATA:
--   Every row written by this migration is SYNTHETIC demo data, not genuine
--   real-world banking activity. All references are prefixed 'HIST-' so they
--   are trivially identifiable and removable (see ROLLBACK below). Descriptions
--   use clearly fictional counterparties. This is intended for a test/staging
--   environment so the customer's Transactions page is not empty.
--
-- Scope / safety:
--   * Targets EXACTLY ONE user (identified by email below). If that user does
--     not exist the migration ABORTS without touching anything.
--   * All writes are confined to that user's GBP account (created if missing).
--   * Idempotent: re-running deletes this user's prior 'HIST-%' rows first.
--   * Atomic: runs as a single DO block / transaction — any failure rolls back.
--
-- Balance reconciliation:
--   The account's opening balance is its legitimate pre-existing ledger figure
--   (0 for a freshly-created GBP account, in which case a realistic £3,000
--   opening deposit is seeded as the starting point). The ledger is then built
--   so that:
--       opening balance
--     + sum(completed credits)
--     - sum(completed debits + their fees)
--     + a final reconciling 'adjustment'
--     = £1,245.23 GBP  (the requested accrued balance)
--   The account_balances row is then set to that SAME reconciled sum, so the
--   stored balance and the transaction ledger agree exactly. We never write an
--   arbitrary balance that the transactions do not support.
--
-- ROLLBACK (to undo this seed, run manually):
--   begin;
--   delete from public.transactions
--     where reference like 'HIST-%'
--       and user_id = (select id from public.profiles
--                       where lower(email) = lower('mangratelawrence@gmail.com'));
--   -- then restore account_balances for that user's GBP account as needed;
--   commit;

do $$
declare
  -- ---- target -------------------------------------------------------------
  v_email        constant text := 'mangratelawrence@gmail.com';
  v_currency     constant text := 'GBP';
  v_target       constant numeric := 1245.23;   -- requested final accrued balance

  -- ---- handles ------------------------------------------------------------
  v_user_id      uuid;
  v_account_id   uuid;
  v_holder       text;

  -- ---- reconciliation -----------------------------------------------------
  v_opening_dep  constant numeric := 3000.00;   -- opening-balance credit (2023-01-01)
  v_pre          numeric := 0;                  -- legitimate pre-existing ledger balance
  v_opening_amt  numeric;                       -- actual opening credit used
  v_net          numeric := 0;                  -- net balance impact of completed activity
  v_needed       numeric;                       -- reconciling adjustment
  v_final        numeric;

  -- ---- generation ---------------------------------------------------------
  v_n            constant int := 1030;          -- activity rows (>> 1000 required)
  v_start        constant date := date '2023-01-01';
  v_end          date := current_date;
  v_days         int;
  v_i            int;
  r              numeric;
  v_ts           timestamptz;
  v_type         text;
  v_dir          text;
  v_amount       numeric;
  v_fee          numeric := 0;
  v_status       text;
  v_desc         text;
  v_sender       text;
  v_recipient    text;
  v_ref          text;

  -- ---- counters for summary ----------------------------------------------
  v_min_ts       timestamptz := 'infinity'::timestamptz;
  v_max_ts       timestamptz := '-infinity'::timestamptz;
  v_completed    int := 0;
  v_opening_id   uuid;
  v_adjust_id    uuid;

  -- counterparty pools (fictional)
  v_payers       constant text[] := array[
    'Thameside Consulting Ltd','Northgate Payroll','Self-employed receipts',
    'Oakfield Rentals','Dividend payout — Bluechip Trust','HMRC tax rebate'];
  v_payees       constant text[] := array[
    'Sainsbury''s','Tesco','Amazon UK','Shell Energy','Thames Water','BT plc',
    'Network Rail','British Gas','Spotify','Netflix','ASOS','Argos',
    'Rent — Oakfield Lets','Council tax — Westminster','Vodafone','EE Ltd'];
  v_intl         constant text[] := array[
    'Acme GmbH (Berlin)','Lumen SARL (Paris)','Kite Logistics (Dubai)',
    'Harbour Freight (Singapore)','Meridian Studios (Lagos)'];
begin
  -- ------------------------------------------------------------------ 1. user
  select id, coalesce(nullif(full_name,''), 'Customer')
    into v_user_id, v_holder
    from public.profiles
   where lower(email) = lower(v_email);

  if v_user_id is null then
    raise exception 'ABORT: target user % not found — no rows written.', v_email;
  end if;

  -- ensure the GBP currency row exists (harmless if present)
  insert into public.currencies (code, name, symbol, is_base, enabled)
  values ('GBP', 'British Pound', '£', false, true)
  on conflict (code) do nothing;

  -- ------------------------------------------------------- 2. GBP account
  select id into v_account_id
    from public.accounts
   where user_id = v_user_id and currency = v_currency and status = 'active'
   order by created_at
   limit 1;

  if v_account_id is null then
    v_account_id := gen_random_uuid();
    insert into public.accounts
      (id, user_id, account_number, account_name, account_type, currency, status)
    values
      (v_account_id, v_user_id,
       '48' || lpad(floor(random() * 1e15)::bigint::text, 15, '0'),
       coalesce(v_holder,'Customer') || ' — GBP Current', 'checking', v_currency, 'active');
    insert into public.account_balances (account_id, available_balance, ledger_balance, currency)
    values (v_account_id, 0, 0, v_currency);
  end if;

  -- --------------------------------------- 3. idempotent: clear prior seed
  delete from public.transactions
   where user_id = v_user_id and account_id = v_account_id and reference like 'HIST-%';

  -- Opening balance: honour any legitimate pre-existing ledger balance on this
  -- account (the account's true starting point). For a freshly-created GBP
  -- account this is 0, so we seed a realistic opening deposit (v_opening_dep)
  -- to establish initial funds — a real transaction record, not an overwrite.
  select coalesce(ledger_balance, 0) into v_pre
    from public.account_balances where account_id = v_account_id;
  if v_pre is null or v_pre <= 0 then
    v_pre := 0;
  end if;

  v_opening_amt := case when v_pre > 0 then v_pre else v_opening_dep end;

  -- Reconciliation model:
  --   opening credit (v_opening_amt) + completed activity net + final adjustment
  --   = v_target (1245.23). The stored balance is then set to that same sum, so
  --   the account_balances row and the transaction ledger agree exactly.
  v_days := greatest((v_end - v_start), 1);

  -- deterministic, reproducible generation
  perform setseed(0.20261016);

  -- ------------------------------------------------- 4. opening-balance credit
  v_ts    := v_start::timestamptz + interval '9 hours';
  v_ref   := 'HIST-OPEN-' || upper(substr(md5(v_user_id::text || 'open'), 1, 8));
  insert into public.transactions
    (reference, user_id, account_id, type, direction, amount, currency, fee,
     status, description, sender, recipient, created_at, updated_at)
  values
    (v_ref, v_user_id, v_account_id, 'deposit', 'credit', v_opening_amt, v_currency, 0,
     'completed', 'Opening balance brought forward (2023)',
     'Previous institution', v_holder, v_ts, v_ts)
  returning id into v_opening_id;

  v_net := v_net + v_opening_amt;               -- credit adds
  if v_ts < v_min_ts then v_min_ts := v_ts; end if;
  if v_ts > v_max_ts then v_max_ts := v_ts; end if;

  -- ------------------------------------------------- 5. the activity itself
  for v_i in 1 .. v_n loop
    -- chronological, evenly-spread timestamp with time-of-day jitter
    v_ts := v_start::timestamptz
            + ((v_i - 1)::numeric * (v_days::numeric / v_n)) * interval '1 day'
            + (random() * interval '23:59:59');

    -- pick a transaction type (weighted mix)
    r := random();
    if r < 0.18 then
      -- income / deposits (credit)
      v_type := 'deposit'; v_dir := 'credit';
      v_amount := round((2500 + random() * 2000)::numeric, 2);      -- salary-ish
      v_sender  := v_payers[1 + floor(random() * array_length(v_payers,1))::int];
      v_recipient := v_holder;
      v_desc    := 'Salary / income credit';
      v_fee     := 0;
    elsif r < 0.30 then
      -- card / cash spending (debit)
      v_type := 'withdrawal'; v_dir := 'debit';
      v_amount := round((15 + random() * 385)::numeric, 2);
      v_sender  := v_holder;
      v_recipient := v_payees[1 + floor(random() * array_length(v_payees,1))::int];
      v_desc    := 'Card purchase / cash withdrawal';
      v_fee     := 0;
    elsif r < 0.46 then
      -- domestic transfers (debit, small fee)
      v_type := 'local_transfer'; v_dir := 'debit';
      v_amount := round((50 + random() * 1150)::numeric, 2);
      v_fee     := round((random() * 5)::numeric, 2);
      v_sender  := v_holder;
      v_recipient := v_payees[1 + floor(random() * array_length(v_payees,1))::int];
      v_desc    := 'Domestic transfer';
    elsif r < 0.56 then
      -- international transfers (debit, fee)
      v_type := 'international_transfer'; v_dir := 'debit';
      v_amount := round((150 + random() * 1650)::numeric, 2);
      v_fee     := 15.00;                                           -- settings intl fee
      v_sender  := v_holder;
      v_recipient := v_intl[1 + floor(random() * array_length(v_intl,1))::int];
      v_desc    := 'International transfer';
    elsif r < 0.63 then
      -- currency swaps (debit + fee)
      v_type := 'currency_swap'; v_dir := 'debit';
      v_amount := round((100 + random() * 900)::numeric, 2);
      v_fee     := round(v_amount * 0.005, 2);
      v_sender  := v_holder;
      v_recipient := 'FX desk — GBP→EUR';
      v_desc    := 'Currency swap';
    elsif r < 0.72 then
      -- monthly account fees (debit)
      v_type := 'fee'; v_dir := 'debit';
      v_amount := round((5 + random() * 30)::numeric, 2);
      v_sender  := v_holder;
      v_recipient := 'Marvin Bank';
      v_desc    := 'Account maintenance fee';
      v_fee     := 0;
    elsif r < 0.80 then
      -- interest earned (credit)
      v_type := 'interest'; v_dir := 'credit';
      v_amount := round((1 + random() * 39)::numeric, 2);
      v_sender  := 'Marvin Bank';
      v_recipient := v_holder;
      v_desc    := 'Interest credited';
      v_fee     := 0;
    elsif r < 0.86 then
      -- loan repayment (debit)
      v_type := 'loan_repayment'; v_dir := 'debit';
      v_amount := round((100 + random() * 700)::numeric, 2);
      v_sender  := v_holder;
      v_recipient := 'Marvin Bank — Loan';
      v_desc    := 'Loan repayment';
      v_fee     := 0;
    elsif r < 0.90 then
      -- occasional loan disbursement (credit)
      v_type := 'loan_disbursement'; v_dir := 'credit';
      v_amount := round((1000 + random() * 4000)::numeric, 2);
      v_sender  := 'Marvin Bank — Loans';
      v_recipient := v_holder;
      v_desc    := 'Loan disbursement';
      v_fee     := 0;
    elsif r < 0.94 then
      -- card refunds (credit)
      v_type := 'reversal'; v_dir := 'credit';
      v_amount := round((10 + random() * 190)::numeric, 2);
      v_sender  := v_payees[1 + floor(random() * array_length(v_payees,1))::int];
      v_recipient := v_holder;
      v_desc    := 'Card refund / reversal';
      v_fee     := 0;
    else
      -- small balance adjustment (credit or debit)
      v_type := 'adjustment';
      if random() < 0.5 then
        v_dir := 'credit'; v_sender := 'Marvin Bank'; v_recipient := v_holder;
      else
        v_dir := 'debit';  v_sender := v_holder; v_recipient := 'Marvin Bank';
      end if;
      v_amount := round((1 + random() * 49)::numeric, 2);
      v_desc   := 'Balance adjustment';
      v_fee    := 0;
    end if;

    -- ~92% completed; the rest are pending/failed/cancelled (display-only,
    -- they do NOT move the balance and are excluded from reconciliation).
    r := random();
    if   r < 0.92 then v_status := 'completed';
    elsif r < 0.95 then v_status := 'pending';
    elsif r < 0.98 then v_status := 'failed';
    else                 v_status := 'cancelled';
    end if;

    v_ref := 'HIST-' || lpad(v_i::text, 6, '0') || '-'
             || upper(substr(md5(v_user_id::text || v_i::text), 1, 8));

    insert into public.transactions
      (reference, user_id, account_id, type, direction, amount, currency, fee,
       status, description, sender, recipient, created_at, updated_at)
    values
      (v_ref, v_user_id, v_account_id, v_type, v_dir, v_amount, v_currency, v_fee,
       v_status, v_desc, v_sender, v_recipient, v_ts, v_ts);

    if v_status = 'completed' then
      v_completed := v_completed + 1;
      -- balance impact: credit adds amount; debit removes amount + fee
      if v_dir = 'credit' then
        v_net := v_net + v_amount;
      else
        v_net := v_net - (v_amount + v_fee);
      end if;
    end if;

    if v_ts < v_min_ts then v_min_ts := v_ts; end if;
    if v_ts > v_max_ts then v_max_ts := v_ts; end if;
  end loop;

  -- --------------------------------- 6. reconciling adjustment -> £1,245.23
  -- v_net currently = pre-seed ledger + opening_amt + completed activity net.
  -- Bridge any gap to the target with a single, clearly-labelled adjustment.
  v_needed := v_target - v_net;
  if abs(v_needed) >= 0.01 then
    v_ts  := v_end::timestamptz + interval '20:00:00';
    v_ref := 'HIST-ADJ-' || upper(substr(md5(v_user_id::text || 'adj'), 1, 8));
    insert into public.transactions
      (reference, user_id, account_id, type, direction, amount, currency, fee,
       status, description, sender, recipient, created_at, updated_at)
    values
      (v_ref, v_user_id, v_account_id, 'adjustment',
       case when v_needed >= 0 then 'credit' else 'debit' end,
       abs(v_needed), v_currency, 0, 'completed',
       'Balance reconciliation adjustment to accrued figure',
       case when v_needed >= 0 then 'Marvin Bank' else v_holder end,
       case when v_needed >= 0 then v_holder else 'Marvin Bank' end,
       v_ts, v_ts)
    returning id into v_adjust_id;
    v_net := v_net + v_needed;                 -- now exactly the target
    if v_ts > v_max_ts then v_max_ts := v_ts; end if;
    if v_ts < v_min_ts then v_min_ts := v_ts; end if;
  end if;

  v_final := v_net;

  -- ------------------ 7. store the balance = the reconciled ledger sum
  insert into public.account_balances (account_id, available_balance, ledger_balance, currency)
  values (v_account_id, v_final, v_final, v_currency)
  on conflict (account_id) do update
    set available_balance = excluded.available_balance,
        ledger_balance     = excluded.ledger_balance,
        currency           = excluded.currency,
        updated_at         = now();

  -- ---------------------------------------------------------- 8. verification
  if (select round(coalesce(sum(
        case when direction = 'credit' then amount else -(amount + fee) end), 0), 2)
        from public.transactions
       where user_id = v_user_id and account_id = v_account_id
         and reference like 'HIST-%' and status = 'completed')
     <> v_target then
    raise exception 'RECONCILIATION FAILED: ledger does not equal %', v_target;
  end if;

  raise notice '=== Migration 026 — demo ledger seed summary ===';
  raise notice 'Target user          : % (%)', v_email, v_user_id;
  raise notice 'Account              : % (GBP, id %)',
    (select account_number from public.accounts where id = v_account_id), v_account_id;
  raise notice 'Rows created (HIST-) : %',
    (select count(*) from public.transactions
      where user_id = v_user_id and account_id = v_account_id and reference like 'HIST-%');
  raise notice '  of which completed : %', v_completed + 1 + case when abs(v_needed)>=0.01 then 1 else 0 end;
  raise notice 'Date range           : %  ->  %', v_min_ts, v_max_ts;
  raise notice 'Reconciled balance   : £% GBP', v_final;
  raise notice 'Verification         : ledger sum == target == stored balance ✓';
end;
$$;

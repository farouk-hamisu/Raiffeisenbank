-- marvintlc - Migration 011
-- Platform correctness fixes + feature completion
--  1. row_to_jsonb() does not exist -> replaced with to_jsonb() in 11 admin functions.
--  2. admin_create_transaction called record_transaction() missing sender/recipient.
--  3. admin_list_loan_repayments referenced invalid r.due_date alias.
--  4. admin_get_user missing local/international transfers (used by customer detail tab).
--  5. New admin_get_chart_data() for the admin dashboard charts (RLS-safe).
--  6. create_currency_swap: fee-inclusive balance check + guaranteed destination credit.
--  7. Luhn-valid card number generation for admin_create_card.
--  8. Security: internal SECURITY DEFINER helpers + admin_hash_password revoked from anon/auth.
--  9. system_settings readable by authenticated users (intl fee preview).
-- 10. Loan repayments auto-marked overdue.
-- Safe on a fresh database: all statements are idempotent create/replace/grant/revoke.

-- ---------------------------------------------------------------------------
-- 1. record_transaction: give sender/recipient defaults so 8-arg callers work
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
  p_sender text default null,
  p_recipient text default null,
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
-- 2. row_to_jsonb -> to_jsonb fixes (admin list functions)
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_users(
  p_token text,
  p_search text default '',
  p_status text default null,
  p_limit int default 100,
  p_offset int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_rows jsonb;
begin
  if not public.admin_can(p_token, 'users.view') then
    raise exception 'FORBIDDEN';
  end if;
  select coalesce(jsonb_agg(to_jsonb(u)), '[]')
  from (
    select p.*,
      (select count(*) from public.accounts a where a.user_id = p.id) as account_count,
      (select coalesce(sum(b.ledger_balance), 0) from public.account_balances b
        join public.accounts a on a.id = b.account_id where a.user_id = p.id) as total_balance
    from public.profiles p
    where (p_search = '' or p.full_name ilike '%' || p_search || '%' or p.email ilike '%' || p_search || '%')
      and (p_status is null or p.status = p_status)
    order by p.created_at desc
    limit p_limit offset p_offset
  ) u into v_rows;
  return jsonb_build_object(
    'rows', v_rows,
    'total', (select count(*) from public.profiles p
      where (p_search = '' or p.full_name ilike '%' || p_search || '%' or p.email ilike '%' || p_search || '%')
        and (p_status is null or p.status = p_status))
  );
end;
$$;

create or replace function public.admin_list_accounts(
  p_token text,
  p_search text default '',
  p_status text default null,
  p_currency text default null,
  p_limit int default 100,
  p_offset int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_rows jsonb;
begin
  if not public.admin_can(p_token, 'accounts.view') then
    raise exception 'FORBIDDEN';
  end if;
  select coalesce(jsonb_agg(to_jsonb(u)), '[]')
  from (
    select a.*, p.full_name as owner_name, p.email as owner_email,
      (select b.available_balance from public.account_balances b where b.account_id = a.id) as available_balance,
      (select b.ledger_balance from public.account_balances b where b.account_id = a.id) as ledger_balance
    from public.accounts a
    join public.profiles p on p.id = a.user_id
    where (p_search = '' or a.account_number ilike '%' || p_search || '%' or p.full_name ilike '%' || p_search || '%' or p.email ilike '%' || p_search || '%')
      and (p_status is null or a.status = p_status)
      and (p_currency is null or a.currency = p_currency)
    order by a.created_at desc
    limit p_limit offset p_offset
  ) u into v_rows;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end;
$$;

create or replace function public.admin_list_transactions(
  p_token text,
  p_search text default '',
  p_status text default null,
  p_type text default null,
  p_currency text default null,
  p_limit int default 100,
  p_offset int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_rows jsonb;
begin
  if not public.admin_can(p_token, 'transactions.view') then
    raise exception 'FORBIDDEN';
  end if;
  select coalesce(jsonb_agg(to_jsonb(u)), '[]')
  from (
    select t.*, p.full_name as user_name, p.email as user_email
    from public.transactions t
    left join public.profiles p on p.id = t.user_id
    where (p_search = '' or t.reference ilike '%' || p_search || '%'
           or t.recipient ilike '%' || p_search || '%' or p.email ilike '%' || p_search || '%')
      and (p_status is null or t.status = p_status)
      and (p_type is null or t.type = p_type)
      and (p_currency is null or t.currency = p_currency)
    order by t.created_at desc
    limit p_limit offset p_offset
  ) u into v_rows;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end;
$$;

create or replace function public.admin_list_local_transfers(
  p_token text, p_search text default '', p_status text default null, p_limit int default 100, p_offset int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_rows jsonb;
begin
  if not public.admin_can(p_token, 'transfers.view') then
    raise exception 'FORBIDDEN';
  end if;
  select coalesce(jsonb_agg(to_jsonb(u)), '[]')
  from (
    select t.*, p.full_name as user_name, p.email as user_email
    from public.local_transfers t join public.profiles p on p.id = t.user_id
    where (p_search = '' or t.reference ilike '%' || p_search || '%' or t.recipient_name ilike '%' || p_search || '%' or p.email ilike '%' || p_search || '%')
      and (p_status is null or t.status = p_status)
    order by t.created_at desc limit p_limit offset p_offset
  ) u into v_rows;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end;
$$;

create or replace function public.admin_list_intl_transfers(
  p_token text, p_search text default '', p_status text default null, p_limit int default 100, p_offset int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_rows jsonb;
begin
  if not public.admin_can(p_token, 'transfers.view') then
    raise exception 'FORBIDDEN';
  end if;
  select coalesce(jsonb_agg(to_jsonb(u)), '[]')
  from (
    select t.*, p.full_name as user_name, p.email as user_email
    from public.international_transfers t join public.profiles p on p.id = t.user_id
    where (p_search = '' or t.reference ilike '%' || p_search || '%' or t.recipient_name ilike '%' || p_search || '%' or p.email ilike '%' || p_search || '%')
      and (p_status is null or t.status = p_status)
    order by t.created_at desc limit p_limit offset p_offset
  ) u into v_rows;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end;
$$;

create or replace function public.admin_list_deposits(
  p_token text, p_search text default '', p_status text default null, p_limit int default 100, p_offset int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_rows jsonb;
begin
  if not public.admin_can(p_token, 'deposits.view') then
    raise exception 'FORBIDDEN';
  end if;
  select coalesce(jsonb_agg(to_jsonb(u)), '[]')
  from (
    select d.*, p.full_name as user_name, p.email as user_email
    from public.deposits d join public.profiles p on p.id = d.user_id
    where (p_search = '' or d.reference ilike '%' || p_search || '%' or p.email ilike '%' || p_search || '%')
      and (p_status is null or d.status = p_status)
    order by d.created_at desc limit p_limit offset p_offset
  ) u into v_rows;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end;
$$;

create or replace function public.admin_list_cards(
  p_token text, p_search text default '', p_status text default null, p_limit int default 100, p_offset int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_rows jsonb;
begin
  if not public.admin_can(p_token, 'cards.view') then
    raise exception 'FORBIDDEN';
  end if;
  select coalesce(jsonb_agg(to_jsonb(u)), '[]')
  from (
    select c.*, p.full_name as user_name, p.email as user_email
    from public.cards c join public.profiles p on p.id = c.user_id
    where (p_search = '' or c.masked_number ilike '%' || p_search || '%' or c.card_holder ilike '%' || p_search || '%' or p.email ilike '%' || p_search || '%')
      and (p_status is null or c.status = p_status)
    order by c.created_at desc limit p_limit offset p_offset
  ) u into v_rows;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end;
$$;

create or replace function public.admin_list_loan_applications(
  p_token text, p_search text default '', p_status text default null, p_limit int default 100, p_offset int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_rows jsonb;
begin
  if not public.admin_can(p_token, 'loans.view') then
    raise exception 'FORBIDDEN';
  end if;
  select coalesce(jsonb_agg(to_jsonb(u)), '[]')
  from (
    select la.*, p.full_name as user_name, p.email as user_email, lp.name as product_name
    from public.loan_applications la
    join public.profiles p on p.id = la.user_id
    join public.loan_products lp on lp.id = la.product_id
    where (p_search = '' or la.reference ilike '%' || p_search || '%' or p.email ilike '%' || p_search || '%')
      and (p_status is null or la.status = p_status)
    order by la.created_at desc limit p_limit offset p_offset
  ) u into v_rows;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end;
$$;

create or replace function public.admin_list_loan_repayments(
  p_token text, p_loan_id uuid default null, p_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.admin_can(p_token, 'loans.view') then
    raise exception 'FORBIDDEN';
  end if;
  return (
    select coalesce(jsonb_agg(to_jsonb(u) order by u.due_date), '[]')
    from (
      select r.*, la.reference as loan_reference, p.full_name as user_name, p.email as user_email
      from public.loan_repayments r
      join public.loan_applications la on la.id = r.loan_application_id
      join public.profiles p on p.id = r.user_id
      where (p_loan_id is null or r.loan_application_id = p_loan_id)
        and (p_status is null or r.status = p_status)
    ) u
  );
end;
$$;

create or replace function public.admin_list_notifications(
  p_token text, p_limit int default 100, p_offset int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_rows jsonb;
begin
  if not public.admin_can(p_token, 'notifications.view') then
    raise exception 'FORBIDDEN';
  end if;
  select coalesce(jsonb_agg(to_jsonb(n)), '[]')
  from (
    select n.*, p.full_name as user_name, p.email as user_email
    from public.notifications n left join public.profiles p on p.id = n.user_id
    order by n.created_at desc limit p_limit offset p_offset
  ) n into v_rows;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end;
$$;

create or replace function public.admin_list_audit_logs(
  p_token text, p_search text default '', p_limit int default 100, p_offset int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_rows jsonb;
begin
  if not public.admin_can(p_token, 'audit.view') then
    raise exception 'FORBIDDEN';
  end if;
  select coalesce(jsonb_agg(to_jsonb(a)), '[]')
  from (
    select a.*, au.full_name as admin_name
    from public.audit_logs a left join public.admin_users au on au.id = a.admin_id
    where (p_search = '' or a.action ilike '%' || p_search || '%' or a.resource ilike '%' || p_search || '%'
           or a.admin_email ilike '%' || p_search || '%' or a.resource_id ilike '%' || p_search || '%')
    order by a.created_at desc limit p_limit offset p_offset
  ) a into v_rows;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. admin_create_transaction: pass meaningful sender/recipient
-- ---------------------------------------------------------------------------
create or replace function public.admin_create_transaction(
  p_token text,
  p_user_id uuid,
  p_account_id uuid,
  p_type text,
  p_direction text,
  p_amount numeric,
  p_currency text,
  p_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_tx public.transactions; v_name text;
begin
  if not public.admin_can(p_token, 'transactions.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select full_name into v_name from public.profiles where id = p_user_id;
  v_tx := public.record_transaction(
    p_user_id, p_account_id, p_type, p_direction, p_amount, p_currency, 'completed', p_description,
    case when p_direction = 'credit' then 'marvintlc' else coalesce(v_name, 'Customer') end,
    case when p_direction = 'credit' then coalesce(v_name, 'Customer') else 'marvintlc' end
  );
  if p_direction = 'credit' then
    perform public.apply_balance_change(p_account_id, p_amount, p_currency);
    perform public.notify_user(p_user_id, 'Credit received',
      to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency || ' credited to your account.', 'account');
  elsif p_direction = 'debit' then
    perform public.apply_balance_change(p_account_id, -p_amount, p_currency);
    perform public.notify_user(p_user_id, 'Debit applied',
      to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency || ' debited from your account.', 'account');
  end if;
  perform public.log_audit(p_token, 'CREATE', 'transaction', v_tx.id::text, null, to_jsonb(v_tx));
  return to_jsonb(v_tx);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. admin_get_user: include local + international transfers for the customer tab
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_user(p_token text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user jsonb;
begin
  if not public.admin_can(p_token, 'users.view') then
    raise exception 'FORBIDDEN';
  end if;
  select jsonb_build_object(
    'profile', to_jsonb(p),
    'accounts', (select coalesce(jsonb_agg(to_jsonb(a)), '[]') from public.accounts a where a.user_id = p_user_id),
    'transactions', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]') from public.transactions t where t.user_id = p_user_id limit 50),
    'cards', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from public.cards c where c.user_id = p_user_id),
    'deposits', (select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at desc), '[]') from public.deposits d where d.user_id = p_user_id limit 50),
    'swaps', (select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]') from public.currency_swaps s where s.user_id = p_user_id limit 50),
    'loans', (select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc), '[]') from public.loan_applications l where l.user_id = p_user_id limit 50),
    'local_transfers', (select coalesce(jsonb_agg(to_jsonb(lt) order by lt.created_at desc), '[]') from public.local_transfers lt where lt.user_id = p_user_id limit 50),
    'international_transfers', (select coalesce(jsonb_agg(to_jsonb(ix) order by ix.created_at desc), '[]') from public.international_transfers ix where ix.user_id = p_user_id limit 50),
    'notifications', (select coalesce(jsonb_agg(to_jsonb(n) order by n.created_at desc), '[]') from public.notifications n where n.user_id = p_user_id limit 20)
  ) into v_user
  from public.profiles p where p.id = p_user_id;
  return v_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. admin_get_chart_data: last-6-months volume + status breakdown (RLS-safe)
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_chart_data(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_result jsonb;
begin
  if not public.admin_can(p_token, 'dashboard') then
    raise exception 'FORBIDDEN';
  end if;
  select jsonb_build_object(
    'months', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'month', to_char(m, 'Mon'),
        'credits', coalesce((select sum(t.amount) from public.transactions t
          where t.status = 'completed' and t.direction = 'credit'
            and date_trunc('month', t.created_at) = m), 0),
        'debits', coalesce((select sum(t.amount) from public.transactions t
          where t.status = 'completed' and t.direction = 'debit'
            and date_trunc('month', t.created_at) = m), 0)
      )), '[]')
      from generate_series(
        date_trunc('month', now()) - interval '5 months',
        date_trunc('month', now()),
        interval '1 month'
      ) as m
    ),
    'status_breakdown', (
      select coalesce(jsonb_object_agg(t.status, t.cnt), '{}')
      from (select status, count(*) as cnt from public.transactions group by status) t
    )
  ) into v_result;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Card number generation (Luhn-valid, brand-prefixed, collision-safe)
-- ---------------------------------------------------------------------------
create or replace function public.generate_card_number(p_brand text default 'mastercard')
returns text
language plpgsql
set search_path = public
as $$
declare
  v_prefix text := case when p_brand = 'mastercard' then '5' else '4' end;
  v_rest text;
  v_num text;
  v_sum int;
  v_i int;
  v_d int;
  v_check int;
begin
  loop
    v_rest := '';
    for v_i in 1..14 loop
      v_rest := v_rest || floor(random() * 10)::int::text;
    end loop;
    v_num := v_prefix || v_rest;
    v_sum := 0;
    for v_i in 1..15 loop
      v_d := substr(v_num, v_i, 1)::int;
      if (v_i % 2) = 1 then
        v_d := v_d * 2;
        if v_d > 9 then v_d := v_d - 9; end if;
      end if;
      v_sum := v_sum + v_d;
    end loop;
    v_check := (10 - (v_sum % 10)) % 10;
    v_num := v_num || v_check::text;
    exit when not exists (select 1 from public.cards where card_number = v_num);
  end loop;
  return v_num;
end;
$$;

create or replace function public.admin_create_card(
  p_token text,
  p_user_id uuid,
  p_account_id uuid,
  p_card_type text,
  p_card_brand text,
  p_expiry_month int,
  p_expiry_year int,
  p_spending_limit numeric,
  p_status text default 'active'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_number text;
  v_masked text;
  v_card public.cards%rowtype;
  v_name text;
begin
  if not public.admin_can(p_token, 'cards.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select full_name into v_name from public.profiles where id = p_user_id;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  v_number := public.generate_card_number(p_card_brand);
  v_masked := substr(v_number, 1, 4) || ' •••• •••• ' || substr(v_number, 13, 4);

  insert into public.cards (user_id, account_id, card_number, masked_number, card_holder, card_type, card_brand,
    expiry_month, expiry_year, cvv, spending_limit, status)
  values (p_user_id, p_account_id, v_number, v_masked, v_name, p_card_type, p_card_brand,
    p_expiry_month, p_expiry_year, lpad(floor(random()*900+100)::int::text,3,'0'), p_spending_limit, p_status)
  returning * into v_card;

  perform public.notify_user(p_user_id, 'Card issued',
    'A new ' || p_card_type || ' ' || p_card_brand || ' card ending in ' || substr(v_number, 13, 4) || ' was issued.', 'card');
  perform public.log_audit(p_token, 'CREATE', 'card', v_card.id::text, null, jsonb_build_object('masked_number', v_masked, 'card_type', p_card_type, 'card_brand', p_card_brand));
  return jsonb_build_object('id', v_card.id, 'masked_number', v_masked, 'status', v_card.status);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Account number generation (collision-safe) + currency swap money safety
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
  v_balance numeric;
begin
  select * into v_account from public.accounts where id = p_account_id for update;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;
  if v_account.currency <> p_currency then
    raise exception 'CURRENCY_MISMATCH';
  end if;

  -- Read the current balance first so we can raise a friendly error instead of
  -- tripping the CHECK constraint. NOTE: an "insert ... on conflict do update"
  -- would evaluate available_balance >= 0 against the raw VALUES tuple (the delta
  -- alone), so negative deltas always failed even with sufficient funds.
  select available_balance into v_balance from public.account_balances
    where account_id = p_account_id for update;
  if v_balance is null then
    v_balance := 0;
  end if;
  if (v_balance + p_delta) < 0 then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  update public.account_balances
    set available_balance = available_balance + p_delta,
        ledger_balance     = ledger_balance + p_delta,
        updated_at         = now()
    where account_id = p_account_id;
  if not found then
    insert into public.account_balances (account_id, available_balance, ledger_balance, currency)
    values (p_account_id, p_delta, p_delta, p_currency)
    on conflict (account_id) do update
      set available_balance = account_balances.available_balance + excluded.available_balance,
          ledger_balance     = account_balances.ledger_balance + excluded.ledger_balance,
          updated_at         = now();
  end if;
end;
$$;

create or replace function public.generate_account_number()
returns text
language plpgsql
set search_path = public
as $$
declare v_num text;
begin
  loop
    v_num := '48' || lpad(floor(random() * 100000000000000)::bigint::text, 14, '0');
    exit when not exists (select 1 from public.accounts where account_number = v_num);
  end loop;
  return v_num;
end;
$$;

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
  v_dest_id uuid;
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

  -- Guarantee the converted funds are never lost: use an existing destination
  -- account or create one for the customer.
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

-- ---------------------------------------------------------------------------
-- 8. Security hardening: revoke internal SECURITY DEFINER helpers + hash fn
--    (must also revoke from PUBLIC, which holds default EXECUTE on functions)
-- ---------------------------------------------------------------------------
revoke execute on function public.apply_balance_change(uuid, numeric, text) from public, anon, authenticated;
revoke execute on function public.record_transaction(uuid, uuid, text, text, numeric, text, text, text, text, text, numeric, uuid) from public, anon, authenticated;
revoke execute on function public.notify_user(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.generate_reference(text) from public, anon, authenticated;
revoke execute on function public.admin_hash_password(text) from public, anon, authenticated;
revoke execute on function public.generate_card_number(text) from public, anon, authenticated;
revoke execute on function public.generate_account_number() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. system_settings: allow authenticated clients to read config (intl fee preview)
-- ---------------------------------------------------------------------------
drop policy if exists "system_settings_no_access" on public.system_settings;
drop policy if exists "system_settings_select_auth" on public.system_settings;
create policy "system_settings_select_auth" on public.system_settings
  for select using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- 10. Loan repayments auto-marked overdue (row-level, recursion-safe)
-- ---------------------------------------------------------------------------
create or replace function public.refresh_repayment_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'scheduled' and new.due_date < current_date then
    new.status := 'overdue';
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists refresh_repayment_status_tg on public.loan_repayments;
create trigger refresh_repayment_status_tg
  before insert or update on public.loan_repayments
  for each row execute procedure public.refresh_repayment_status();

-- ---------------------------------------------------------------------------
-- Grants for new/changed customer + admin functions
-- ---------------------------------------------------------------------------
grant execute on function public.create_currency_swap(uuid, uuid, text, text, numeric) to anon, authenticated;
grant execute on function public.admin_get_chart_data(text) to anon, authenticated;
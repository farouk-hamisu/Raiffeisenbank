-- Raiffeisen Bank - Migration 006
-- Admin authentication + CRUD via SECURITY DEFINER functions.
-- All functions validate the admin session token server-side; client-side checks are not trusted.

-- Ensure pgcrypto (crypt / gen_salt) is available even if run standalone.
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Verify a bearer token -> returns admin row or null
create or replace function public.admin_from_token(p_token text)
returns public.admin_users
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_session public.admin_sessions%rowtype;
  v_admin public.admin_users;
begin
  if p_token is null or p_token = '' then
    return null;
  end if;
  select * into v_session from public.admin_sessions
    where token = p_token and expires_at > now();
  if not found then
    return null;
  end if;
  select * into v_admin from public.admin_users
    where id = v_session.admin_id and status = 'active';
  return v_admin;
end;
$$;

-- Permission check
create or replace function public.admin_can(p_token text, p_perm text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_admin public.admin_users;
  v_role public.admin_roles;
begin
  v_admin := public.admin_from_token(p_token);
  if v_admin is null then
    return false;
  end if;
  select * into v_role from public.admin_roles where id = v_admin.role_id;
  if not found then
    return false;
  end if;
  if v_role.name = 'super_admin' then
    return true;
  end if;
  return coalesce(p_perm = any (v_role.permissions), false);
end;
$$;

-- Internal audit logger
create or replace function public.log_audit(
  p_token text,
  p_action text,
  p_resource text,
  p_resource_id text default null,
  p_previous jsonb default null,
  p_new jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_admin public.admin_users;
begin
  v_admin := public.admin_from_token(p_token);
  insert into public.audit_logs (admin_id, admin_email, action, resource, resource_id, previous_value, new_value)
  values (
    coalesce(v_admin.id, null),
    coalesce(v_admin.email, 'unknown'),
    p_action, p_resource, p_resource_id, p_previous, p_new
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Auth
-- ---------------------------------------------------------------------------

create or replace function public.admin_login(p_email text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_admin public.admin_users;
  v_token text;
  v_role text;
begin
  select * into v_admin from public.admin_users where lower(email) = lower(p_email) and status = 'active';
  if not found then
    raise exception 'INVALID_CREDENTIALS';
  end if;
  if v_admin.password_hash <> crypt(p_password, v_admin.password_hash) then
    raise exception 'INVALID_CREDENTIALS';
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.admin_sessions (admin_id, token, expires_at)
  values (v_admin.id, v_token, now() + interval '12 hours');

  select r.name into v_role from public.admin_roles r where r.id = v_admin.role_id;
  return jsonb_build_object(
    'token', v_token,
    'admin', jsonb_build_object(
      'id', v_admin.id,
      'email', v_admin.email,
      'full_name', v_admin.full_name,
      'role', coalesce(v_role, 'admin')
    )
  );
end;
$$;

create or replace function public.admin_logout(p_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from public.admin_sessions where token = p_token;
end;
$$;

create or replace function public.admin_validate(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_admin public.admin_users;
  v_role public.admin_roles;
begin
  v_admin := public.admin_from_token(p_token);
  if v_admin is null then
    raise exception 'UNAUTHORIZED';
  end if;
  select * into v_role from public.admin_roles where id = v_admin.role_id;
  return jsonb_build_object(
    'id', v_admin.id,
    'email', v_admin.email,
    'full_name', v_admin.full_name,
    'role', coalesce(v_role.name, 'admin'),
    'permissions', coalesce(v_role.permissions, '{}')
  );
end;
$$;

create or replace function public.admin_hash_password(p_password text)
returns text
language sql
security definer
set search_path = public, extensions
as $$
  select crypt(p_password, gen_salt('bf', 10));
$$;

-- ---------------------------------------------------------------------------
-- DASHBOARD STATS
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_stats(p_token text)
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
    'total_customers', (select count(*) from public.profiles),
    'active_customers', (select count(*) from public.profiles where status = 'active'),
    'suspended_customers', (select count(*) from public.profiles where status = 'suspended'),
    'pending_customers', (select count(*) from public.profiles where status = 'pending'),
    'total_accounts', (select count(*) from public.accounts),
    'total_balances', coalesce((select sum(ledger_balance) from public.account_balances), 0),
    'total_transactions', (select count(*) from public.transactions),
    'pending_transactions', (select count(*) from public.transactions where status = 'pending'),
    'completed_transactions', (select count(*) from public.transactions where status = 'completed'),
    'failed_transactions', (select count(*) from public.transactions where status in ('failed', 'cancelled', 'reversed')),
    'total_deposits', (select count(*) from public.deposits),
    'pending_deposits', (select count(*) from public.deposits where status = 'pending'),
    'local_transfers', (select count(*) from public.local_transfers),
    'international_transfers', (select count(*) from public.international_transfers),
    'active_cards', (select count(*) from public.cards where status = 'active'),
    'frozen_cards', (select count(*) from public.cards where status = 'frozen'),
    'loan_applications', (select count(*) from public.loan_applications),
    'pending_loans', (select count(*) from public.loan_applications where status in ('pending', 'under_review')),
    'active_loans', (select count(*) from public.loan_applications where status = 'active'),
    'total_swaps', (select count(*) from public.currency_swaps),
    'unread_notifications', (select count(*) from public.notifications where is_read = false)
  ) into v_result;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- USERS
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
  select coalesce(jsonb_agg(row_to_jsonb(u)), '[]')
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
    'notifications', (select coalesce(jsonb_agg(to_jsonb(n) order by n.created_at desc), '[]') from public.notifications n where n.user_id = p_user_id limit 20)
  ) into v_user
  from public.profiles p where p.id = p_user_id;
  return v_user;
end;
$$;

create or replace function public.admin_create_user(
  p_token text,
  p_email text,
  p_password text,
  p_full_name text,
  p_phone text default null,
  p_address text default null,
  p_city text default null,
  p_country text default null,
  p_status text default 'active'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid;
  v_profile public.profiles%rowtype;
begin
  if not public.admin_can(p_token, 'users.manage') then
    raise exception 'FORBIDDEN';
  end if;

  select id into v_uid from auth.users where email = lower(p_email);
  if found then
    raise exception 'EMAIL_EXISTS';
  end if;

  v_uid := gen_random_uuid();
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token)
  values (
    v_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    lower(p_email), crypt(p_password, gen_salt('bf', 10)), now(),
    jsonb_build_object('provider', 'email', 'providers', '["email"]'),
    jsonb_build_object('full_name', p_full_name),
    now(), now(), '', '', '', ''
  );
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (
    gen_random_uuid(), v_uid, v_uid::text,
    jsonb_build_object('sub', v_uid::text, 'email', lower(p_email)),
    'email', now(), now(), now()
  );

  insert into public.profiles (id, email, full_name, phone, address, city, country, status)
  values (v_uid, lower(p_email), p_full_name, p_phone, p_address, p_city, p_country, p_status)
  on conflict (id) do update set full_name = excluded.full_name, status = excluded.status
  returning * into v_profile;

  perform public.log_audit(p_token, 'CREATE', 'user', v_uid::text, null,
    jsonb_build_object('email', lower(p_email), 'full_name', p_full_name, 'status', p_status));

  return jsonb_build_object('id', v_profile.id, 'email', v_profile.email, 'full_name', v_profile.full_name);
end;
$$;

create or replace function public.admin_update_user(
  p_token text,
  p_user_id uuid,
  p_full_name text default null,
  p_phone text default null,
  p_address text default null,
  p_city text default null,
  p_country text default null,
  p_status text default null,
  p_kyc_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_profile public.profiles%rowtype;
begin
  if not public.admin_can(p_token, 'users.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(p) into v_old from public.profiles p where id = p_user_id;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  update public.profiles set
    full_name = coalesce(p_full_name, full_name),
    phone = coalesce(p_phone, phone),
    address = coalesce(p_address, address),
    city = coalesce(p_city, city),
    country = coalesce(p_country, country),
    status = coalesce(p_status, status),
    kyc_status = coalesce(p_kyc_status, kyc_status),
    updated_at = now()
  where id = p_user_id
  returning * into v_profile;

  select to_jsonb(v_profile) into v_new;
  perform public.log_audit(p_token, 'UPDATE', 'user', p_user_id::text, v_old, v_new);
  return v_new;
end;
$$;

create or replace function public.admin_suspend_user(p_token text, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb;
begin
  if not public.admin_can(p_token, 'users.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(p) into v_old from public.profiles p where id = p_user_id;
  update public.profiles set status = 'suspended', updated_at = now() where id = p_user_id;
  update public.accounts set status = 'suspended', updated_at = now() where user_id = p_user_id;
  update public.cards set status = 'blocked', updated_at = now() where user_id = p_user_id;
  perform public.notify_user(p_user_id, 'Account suspended', 'Your account has been suspended. Contact support for assistance.', 'security');
  perform public.log_audit(p_token, 'SUSPEND', 'user', p_user_id::text, v_old, jsonb_build_object('status', 'suspended'));
end;
$$;

create or replace function public.admin_activate_user(p_token text, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.admin_can(p_token, 'users.manage') then
    raise exception 'FORBIDDEN';
  end if;
  update public.profiles set status = 'active', updated_at = now() where id = p_user_id;
  perform public.notify_user(p_user_id, 'Account activated', 'Your account has been re-activated.', 'account');
  perform public.log_audit(p_token, 'ACTIVATE', 'user', p_user_id::text);
end;
$$;

create or replace function public.admin_delete_user(p_token text, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb;
begin
  if not public.admin_can(p_token, 'users.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(p) into v_old from public.profiles p where id = p_user_id;
  delete from public.profiles where id = p_user_id;
  perform public.log_audit(p_token, 'DELETE', 'user', p_user_id::text, v_old, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- ACCOUNTS
-- ---------------------------------------------------------------------------
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
  select coalesce(jsonb_agg(row_to_jsonb(u)), '[]')
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

create or replace function public.admin_create_account(
  p_token text,
  p_user_id uuid,
  p_account_type text,
  p_currency text,
  p_account_number text,
  p_status text default 'active'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_account public.accounts%rowtype;
  v_name text;
begin
  if not public.admin_can(p_token, 'accounts.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select full_name into v_name from public.profiles where id = p_user_id;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  insert into public.accounts (user_id, account_number, account_name, account_type, currency, status)
  values (p_user_id, p_account_number, coalesce(v_name, ''), p_account_type, p_currency, p_status)
  returning * into v_account;

  insert into public.account_balances (account_id, available_balance, ledger_balance, currency)
  values (v_account.id, 0, 0, p_currency);

  perform public.notify_user(p_user_id, 'Account opened',
    'A new ' || p_account_type || ' account (' || p_account_number || ') was opened for you.', 'account');
  perform public.log_audit(p_token, 'CREATE', 'account', v_account.id::text, null, to_jsonb(v_account));
  return to_jsonb(v_account);
end;
$$;

create or replace function public.admin_update_account(
  p_token text,
  p_account_id uuid,
  p_account_type text default null,
  p_status text default null,
  p_currency text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb; v_account public.accounts%rowtype;
begin
  if not public.admin_can(p_token, 'accounts.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(a) into v_old from public.accounts a where id = p_account_id;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;
  update public.accounts set
    account_type = coalesce(p_account_type, account_type),
    status = coalesce(p_status, status),
    currency = coalesce(p_currency, currency),
    updated_at = now()
  where id = p_account_id returning * into v_account;
  perform public.log_audit(p_token, 'UPDATE', 'account', p_account_id::text, v_old, to_jsonb(v_account));
  return to_jsonb(v_account);
end;
$$;

create or replace function public.admin_change_account_status(p_token text, p_account_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb;
begin
  if not public.admin_can(p_token, 'accounts.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(a) into v_old from public.accounts a where id = p_account_id;
  update public.accounts set status = p_status, updated_at = now() where id = p_account_id;
  perform public.log_audit(p_token, 'UPDATE_STATUS', 'account', p_account_id::text, v_old, jsonb_build_object('status', p_status));
end;
$$;

-- ---------------------------------------------------------------------------
-- TRANSACTIONS
-- ---------------------------------------------------------------------------
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
  select coalesce(jsonb_agg(row_to_jsonb(u)), '[]')
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
declare v_tx public.transactions;
begin
  if not public.admin_can(p_token, 'transactions.manage') then
    raise exception 'FORBIDDEN';
  end if;
  v_tx := public.record_transaction(p_user_id, p_account_id, p_type, p_direction, p_amount, p_currency, 'completed', p_description);
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

create or replace function public.admin_update_transaction_status(
  p_token text,
  p_tx_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb; v_tx public.transactions%rowtype;
begin
  if not public.admin_can(p_token, 'transactions.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(t) into v_old from public.transactions t where id = p_tx_id;
  if not found then
    raise exception 'TRANSACTION_NOT_FOUND';
  end if;
  update public.transactions set status = p_status, updated_at = now() where id = p_tx_id returning * into v_tx;
  perform public.log_audit(p_token, 'UPDATE_STATUS', 'transaction', p_tx_id::text, v_old, jsonb_build_object('status', p_status));
  return to_jsonb(v_tx);
end;
$$;

create or replace function public.admin_reverse_transaction(p_token text, p_tx_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tx public.transactions%rowtype;
  v_ref text;
begin
  if not public.admin_can(p_token, 'transactions.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select * into v_tx from public.transactions where id = p_tx_id and status = 'completed' for update;
  if not found then
    raise exception 'TRANSACTION_NOT_COMPLETED';
  end if;

  update public.transactions set status = 'reversed', updated_at = now() where id = p_tx_id;

  -- reverse the money movement
  if v_tx.direction = 'debit' then
    perform public.apply_balance_change(v_tx.account_id, v_tx.amount + v_tx.fee, v_tx.currency);
  else
    perform public.apply_balance_change(v_tx.account_id, -(v_tx.amount - v_tx.fee), v_tx.currency);
  end if;

  perform public.record_transaction(
    v_tx.user_id, v_tx.account_id, 'reversal', v_tx.direction, v_tx.amount, v_tx.currency,
    'completed', 'Reversal of ' || v_tx.reference, v_tx.sender, v_tx.recipient, 0, v_tx.id
  );

  perform public.notify_user(v_tx.user_id, 'Transaction reversed',
    'Transaction ' || v_tx.reference || ' was reversed. Amount ' || to_char(v_tx.amount, 'FM9,999,999,990.00') || ' ' || v_tx.currency || ' returned to your account.', 'security');

  perform public.log_audit(p_token, 'REVERSE', 'transaction', p_tx_id::text, to_jsonb(v_tx), jsonb_build_object('status', 'reversed'));
  return to_jsonb(v_tx);
end;
$$;

-- ---------------------------------------------------------------------------
-- TRANSFERS
-- ---------------------------------------------------------------------------
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
  select coalesce(jsonb_agg(row_to_jsonb(u)), '[]')
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
  select coalesce(jsonb_agg(row_to_jsonb(u)), '[]')
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

create or replace function public.admin_update_local_transfer(
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
  select to_jsonb(t) into v_old from public.local_transfers t where id = p_transfer_id;
  if not found then
    raise exception 'TRANSFER_NOT_FOUND';
  end if;
  update public.local_transfers set status = p_status,
    completed_at = case when p_status = 'completed' then now() else completed_at end,
    updated_at = now()
  where id = p_transfer_id;
  perform public.log_audit(p_token, 'UPDATE_STATUS', 'local_transfer', p_transfer_id::text, v_old, jsonb_build_object('status', p_status));
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
  perform public.log_audit(p_token, 'UPDATE_STATUS', 'international_transfer', p_transfer_id::text, v_old, jsonb_build_object('status', p_status));
end;
$$;

-- ---------------------------------------------------------------------------
-- DEPOSITS
-- ---------------------------------------------------------------------------
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
  select coalesce(jsonb_agg(row_to_jsonb(u)), '[]')
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

  update public.deposits set status = p_status, updated_at = now() where id = p_deposit_id;

  if p_status = 'completed' and v_deposit.status in ('pending', 'processing') then
    perform public.apply_balance_change(v_deposit.account_id, v_deposit.amount, v_deposit.currency);
    perform public.record_transaction(
      v_deposit.user_id, v_deposit.account_id, 'deposit', 'credit', v_deposit.amount,
      v_deposit.currency, 'completed', 'Deposit ' || v_deposit.reference, v_deposit.user_id::text, v_deposit.user_id::text, 0, v_deposit.id
    );
    perform public.notify_user(v_deposit.user_id, 'Deposit completed',
      'Your deposit of ' || to_char(v_deposit.amount, 'FM9,999,999,990.00') || ' ' || v_deposit.currency || ' was completed. Ref: ' || v_deposit.reference || '.', 'deposit');
  elsif p_status = 'rejected' then
    perform public.notify_user(v_deposit.user_id, 'Deposit rejected',
      'Your deposit of ' || to_char(v_deposit.amount, 'FM9,999,999,990.00') || ' ' || v_deposit.currency || ' was rejected. Contact support for details.', 'deposit');
  end if;

  perform public.log_audit(p_token, 'UPDATE_STATUS', 'deposit', p_deposit_id::text, v_old, jsonb_build_object('status', p_status));
end;
$$;

-- ---------------------------------------------------------------------------
-- CARDS
-- ---------------------------------------------------------------------------
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
  select coalesce(jsonb_agg(row_to_jsonb(u)), '[]')
  from (
    select c.*, p.full_name as user_name, p.email as user_email
    from public.cards c join public.profiles p on p.id = c.user_id
    where (p_search = '' or c.masked_number ilike '%' || p_search || '%' or p.card_holder ilike '%' || p_search || '%' or p.email ilike '%' || p_search || '%')
      and (p_status is null or c.status = p_status)
    order by c.created_at desc limit p_limit offset p_offset
  ) u into v_rows;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
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

  v_number := lpad(floor(random() * 9000000000000000)::bigint::text, 16, '4');
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

create or replace function public.admin_update_card(
  p_token text, p_card_id uuid, p_status text default null, p_spending_limit numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb; v_card public.cards%rowtype;
begin
  if not public.admin_can(p_token, 'cards.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(c) into v_old from public.cards c where id = p_card_id;
  if not found then
    raise exception 'CARD_NOT_FOUND';
  end if;
  update public.cards set
    status = coalesce(p_status, status),
    spending_limit = coalesce(p_spending_limit, spending_limit),
    updated_at = now()
  where id = p_card_id returning * into v_card;

  if p_status is not null and p_status <> (v_old->>'status') then
    perform public.notify_user(v_card.user_id, 'Card status changed',
      'Your card ending ' || substr(v_card.card_number, -4) || ' is now ' || p_status || '.', 'card');
  end if;

  perform public.log_audit(p_token, 'UPDATE', 'card', p_card_id::text, v_old, to_jsonb(v_card));
  return to_jsonb(v_card);
end;
$$;

-- ---------------------------------------------------------------------------
-- CURRENCIES + EXCHANGE RATES
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_currencies(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.admin_can(p_token, 'currencies.view') then
    raise exception 'FORBIDDEN';
  end if;
  return (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'currency', to_jsonb(c),
        'rates', (select coalesce(jsonb_agg(to_jsonb(r) order by r.quote_currency), '[]')
                  from public.exchange_rates r where r.base_currency = c.code)
      ) order by c.code), '[]')
    from public.currencies c
  );
end;
$$;

create or replace function public.admin_create_currency(
  p_token text, p_code text, p_name text, p_symbol text, p_is_base boolean default false, p_enabled boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_cur public.currencies%rowtype;
begin
  if not public.admin_can(p_token, 'currencies.manage') then
    raise exception 'FORBIDDEN';
  end if;
  insert into public.currencies (code, name, symbol, is_base, enabled)
  values (upper(p_code), p_name, p_symbol, p_is_base, p_enabled) returning * into v_cur;
  perform public.log_audit(p_token, 'CREATE', 'currency', v_cur.id::text, null, to_jsonb(v_cur));
  return to_jsonb(v_cur);
end;
$$;

create or replace function public.admin_update_currency(
  p_token text, p_code text, p_name text default null, p_symbol text default null,
  p_enabled boolean default null, p_is_base boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb; v_cur public.currencies%rowtype;
begin
  if not public.admin_can(p_token, 'currencies.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(c) into v_old from public.currencies c where code = p_code;
  if not found then
    raise exception 'CURRENCY_NOT_FOUND';
  end if;
  update public.currencies set
    name = coalesce(p_name, name),
    symbol = coalesce(p_symbol, symbol),
    enabled = coalesce(p_enabled, enabled),
    is_base = coalesce(p_is_base, is_base),
    updated_at = now()
  where code = p_code returning * into v_cur;
  perform public.log_audit(p_token, 'UPDATE', 'currency', p_code, v_old, to_jsonb(v_cur));
  return to_jsonb(v_cur);
end;
$$;

create or replace function public.admin_delete_currency(p_token text, p_code text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb;
begin
  if not public.admin_can(p_token, 'currencies.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(c) into v_old from public.currencies c where code = p_code;
  if (select count(*) from public.accounts where currency = p_code) > 0 then
    raise exception 'CURRENCY_IN_USE';
  end if;
  delete from public.exchange_rates where base_currency = p_code or quote_currency = p_code;
  delete from public.currencies where code = p_code;
  perform public.log_audit(p_token, 'DELETE', 'currency', p_code, v_old, null);
end;
$$;

create or replace function public.admin_set_exchange_rate(
  p_token text, p_base text, p_quote text, p_rate numeric, p_fee_percent numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_rate public.exchange_rates%rowtype;
begin
  if not public.admin_can(p_token, 'currencies.manage') then
    raise exception 'FORBIDDEN';
  end if;
  insert into public.exchange_rates (base_currency, quote_currency, rate, fee_percent)
  values (p_base, p_quote, p_rate, p_fee_percent)
  on conflict (base_currency, quote_currency) do update
    set rate = p_rate, fee_percent = p_fee_percent, updated_at = now()
  returning * into v_rate;
  perform public.log_audit(p_token, 'UPDATE_RATE', 'exchange_rate', p_base || '/' || p_quote, null,
    jsonb_build_object('base_currency', p_base, 'quote_currency', p_quote, 'rate', p_rate, 'fee_percent', p_fee_percent));
  return to_jsonb(v_rate);
end;
$$;

-- ---------------------------------------------------------------------------
-- LOANS
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_loan_products(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.admin_can(p_token, 'loans.view') then
    raise exception 'FORBIDDEN';
  end if;
  return (select coalesce(jsonb_agg(to_jsonb(lp) order by lp.created_at), '[]') from public.loan_products lp);
end;
$$;

create or replace function public.admin_create_loan_product(
  p_token text, p_name text, p_description text, p_min_amount numeric, p_max_amount numeric,
  p_interest_rate numeric, p_term_months int, p_enabled boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_lp public.loan_products%rowtype;
begin
  if not public.admin_can(p_token, 'loans.manage') then
    raise exception 'FORBIDDEN';
  end if;
  insert into public.loan_products (name, description, min_amount, max_amount, interest_rate, term_months, enabled)
  values (p_name, p_description, p_min_amount, p_max_amount, p_interest_rate, p_term_months, p_enabled)
  returning * into v_lp;
  perform public.log_audit(p_token, 'CREATE', 'loan_product', v_lp.id::text, null, to_jsonb(v_lp));
  return to_jsonb(v_lp);
end;
$$;

create or replace function public.admin_update_loan_product(
  p_token text, p_product_id uuid, p_name text default null, p_description text default null,
  p_min_amount numeric default null, p_max_amount numeric default null, p_interest_rate numeric default null,
  p_term_months int default null, p_enabled boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb; v_lp public.loan_products%rowtype;
begin
  if not public.admin_can(p_token, 'loans.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(lp) into v_old from public.loan_products lp where id = p_product_id;
  if not found then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;
  update public.loan_products set
    name = coalesce(p_name, name), description = coalesce(p_description, description),
    min_amount = coalesce(p_min_amount, min_amount), max_amount = coalesce(p_max_amount, max_amount),
    interest_rate = coalesce(p_interest_rate, interest_rate), term_months = coalesce(p_term_months, term_months),
    enabled = coalesce(p_enabled, enabled), updated_at = now()
  where id = p_product_id returning * into v_lp;
  perform public.log_audit(p_token, 'UPDATE', 'loan_product', p_product_id::text, v_old, to_jsonb(v_lp));
  return to_jsonb(v_lp);
end;
$$;

create or replace function public.admin_delete_loan_product(p_token text, p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb;
begin
  if not public.admin_can(p_token, 'loans.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(lp) into v_old from public.loan_products lp where id = p_product_id;
  if (select count(*) from public.loan_applications where product_id = p_product_id) > 0 then
    raise exception 'PRODUCT_IN_USE';
  end if;
  delete from public.loan_products where id = p_product_id;
  perform public.log_audit(p_token, 'DELETE', 'loan_product', p_product_id::text, v_old, null);
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
  select coalesce(jsonb_agg(row_to_jsonb(u)), '[]')
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

create or replace function public.admin_update_loan_application(
  p_token text, p_loan_id uuid, p_status text, p_admin_note text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb; v_loan public.loan_applications%rowtype;
begin
  if not public.admin_can(p_token, 'loans.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select * into v_loan from public.loan_applications where id = p_loan_id for update;
  if not found then
    raise exception 'LOAN_NOT_FOUND';
  end if;
  select to_jsonb(v_loan) into v_old;

  update public.loan_applications set status = p_status,
    admin_note = coalesce(p_admin_note, admin_note),
    disbursed_at = case when p_status = 'active' then now() else disbursed_at end,
    updated_at = now()
  where id = p_loan_id;

  if p_status = 'approved' then
    perform public.notify_user(v_loan.user_id, 'Loan approved',
      'Congratulations! Your loan application ' || v_loan.reference || ' has been approved.', 'loan');
  elsif p_status = 'rejected' then
    perform public.notify_user(v_loan.user_id, 'Loan rejected',
      'Your loan application ' || v_loan.reference || ' was not approved.' || coalesce(' Reason: ' || p_admin_note, ''), 'loan');
  elsif p_status = 'active' then
    -- disburse into the customer's account of matching currency
    declare v_acc uuid;
    begin
      select id into v_acc from public.accounts
        where user_id = v_loan.user_id and currency = v_loan.currency and status = 'active'
        order by created_at limit 1;
      if found then
        perform public.apply_balance_change(v_acc, v_loan.amount, v_loan.currency);
        perform public.record_transaction(
          v_loan.user_id, v_acc, 'loan_disbursement', 'credit', v_loan.amount, v_loan.currency,
          'completed', 'Loan disbursement ' || v_loan.reference, 'Raiffeisen Bank', v_loan.user_id::text, 0, v_loan.id
        );
        perform public.notify_user(v_loan.user_id, 'Loan disbursed',
          'Your approved loan of ' || to_char(v_loan.amount, 'FM9,999,999,990.00') || ' ' || v_loan.currency || ' has been disbursed.', 'loan');
      end if;
    end;
  end if;

  perform public.log_audit(p_token, 'UPDATE_STATUS', 'loan_application', p_loan_id::text, v_old, jsonb_build_object('status', p_status));
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
    select coalesce(jsonb_agg(row_to_jsonb(u) order by r.due_date), '[]')
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

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS (admin)
-- ---------------------------------------------------------------------------
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
  select coalesce(jsonb_agg(row_to_jsonb(n)), '[]')
  from (
    select n.*, p.full_name as user_name, p.email as user_email
    from public.notifications n left join public.profiles p on p.id = n.user_id
    order by n.created_at desc limit p_limit offset p_offset
  ) n into v_rows;
  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end;
$$;

create or replace function public.admin_send_notification(
  p_token text, p_user_id uuid, p_title text, p_message text, p_type text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_notif public.notifications%rowtype;
begin
  if not public.admin_can(p_token, 'notifications.manage') then
    raise exception 'FORBIDDEN';
  end if;
  insert into public.notifications (user_id, title, message, type)
  values (p_user_id, p_title, p_message, p_type) returning * into v_notif;
  perform public.log_audit(p_token, 'SEND', 'notification', v_notif.id::text, null, to_jsonb(v_notif));
  return to_jsonb(v_notif);
end;
$$;

create or replace function public.admin_send_global_notification(
  p_token text, p_title text, p_message text, p_type text default 'system'
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.admin_can(p_token, 'notifications.manage') then
    raise exception 'FORBIDDEN';
  end if;
  insert into public.notifications (user_id, title, message, type, is_global)
  values (null, p_title, p_message, p_type, true);
  perform public.log_audit(p_token, 'SEND_GLOBAL', 'notification', null, null,
    jsonb_build_object('title', p_title, 'message', p_message, 'type', p_type));
end;
$$;

create or replace function public.admin_delete_notification(p_token text, p_notif_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb;
begin
  if not public.admin_can(p_token, 'notifications.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(n) into v_old from public.notifications n where id = p_notif_id;
  delete from public.notifications where id = p_notif_id;
  perform public.log_audit(p_token, 'DELETE', 'notification', p_notif_id::text, v_old, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- AUDIT LOGS
-- ---------------------------------------------------------------------------
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
  select coalesce(jsonb_agg(row_to_jsonb(a)), '[]')
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
-- ADMIN USER MANAGEMENT
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_admins(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.admin_can(p_token, 'admins.manage') then
    raise exception 'FORBIDDEN';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', au.id, 'email', au.email, 'full_name', au.full_name,
      'status', au.status, 'role', coalesce(ar.name, 'admin'),
      'created_at', au.created_at
    ) order by au.created_at), '[]')
    from public.admin_users au left join public.admin_roles ar on ar.id = au.role_id
  );
end;
$$;

create or replace function public.admin_create_admin(
  p_token text, p_email text, p_password text, p_full_name text, p_role_name text default 'support', p_status text default 'active'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_role uuid; v_admin public.admin_users%rowtype;
begin
  if not public.admin_can(p_token, 'admins.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select id into v_role from public.admin_roles where name = p_role_name;
  if not found then
    raise exception 'ROLE_NOT_FOUND';
  end if;
  insert into public.admin_users (email, password_hash, full_name, role_id, status)
  values (lower(p_email), public.admin_hash_password(p_password), p_full_name, v_role, p_status)
  returning * into v_admin;
  perform public.log_audit(p_token, 'CREATE', 'admin_user', v_admin.id::text, null, to_jsonb(v_admin));
  return to_jsonb(v_admin);
end;
$$;

create or replace function public.admin_update_admin(
  p_token text, p_admin_id uuid, p_full_name text default null, p_role_name text default null,
  p_status text default null, p_password text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb; v_role uuid; v_admin public.admin_users%rowtype;
begin
  if not public.admin_can(p_token, 'admins.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select to_jsonb(au) into v_old from public.admin_users au where id = p_admin_id;
  if not found then
    raise exception 'ADMIN_NOT_FOUND';
  end if;
  if p_role_name is not null then
    select id into v_role from public.admin_roles where name = p_role_name;
    if not found then
      raise exception 'ROLE_NOT_FOUND';
    end if;
  end if;
  update public.admin_users set
    full_name = coalesce(p_full_name, full_name),
    role_id = coalesce(v_role, role_id),
    status = coalesce(p_status, status),
    password_hash = case when p_password is not null and p_password <> '' then public.admin_hash_password(p_password) else password_hash end,
    updated_at = now()
  where id = p_admin_id returning * into v_admin;
  perform public.log_audit(p_token, 'UPDATE', 'admin_user', p_admin_id::text, v_old, to_jsonb(v_admin));
  return to_jsonb(v_admin);
end;
$$;

-- ---------------------------------------------------------------------------
-- SYSTEM SETTINGS
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_settings(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.admin_can(p_token, 'settings.view') then
    raise exception 'FORBIDDEN';
  end if;
  return (
    select coalesce(jsonb_object_agg(key, value), '{}') from public.system_settings
  );
end;
$$;

create or replace function public.admin_update_setting(p_token text, p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_old jsonb;
begin
  if not public.admin_can(p_token, 'settings.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select value into v_old from public.system_settings where key = p_key;
  insert into public.system_settings (key, value, updated_at)
  values (p_key, p_value, now())
  on conflict (key) do update set value = p_value, updated_at = now();
  perform public.log_audit(p_token, 'UPDATE_SETTING', 'setting', p_key, v_old, p_value);
end;
$$;

-- Grant execute to anon/authenticated so the frontend can call RPCs.
grant execute on function public.admin_login, public.admin_logout, public.admin_validate,
  public.admin_from_token, public.admin_can, public.admin_hash_password, public.log_audit,
  public.admin_get_stats, public.admin_list_users, public.admin_get_user, public.admin_create_user,
  public.admin_update_user, public.admin_suspend_user, public.admin_activate_user, public.admin_delete_user,
  public.admin_list_accounts, public.admin_create_account, public.admin_update_account, public.admin_change_account_status,
  public.admin_list_transactions, public.admin_create_transaction, public.admin_update_transaction_status, public.admin_reverse_transaction,
  public.admin_list_local_transfers, public.admin_list_intl_transfers, public.admin_update_local_transfer, public.admin_update_intl_transfer,
  public.admin_list_deposits, public.admin_update_deposit,
  public.admin_list_cards, public.admin_create_card, public.admin_update_card,
  public.admin_list_currencies, public.admin_create_currency, public.admin_update_currency, public.admin_delete_currency, public.admin_set_exchange_rate,
  public.admin_list_loan_products, public.admin_create_loan_product, public.admin_update_loan_product, public.admin_delete_loan_product,
  public.admin_list_loan_applications, public.admin_update_loan_application, public.admin_list_loan_repayments,
  public.admin_list_notifications, public.admin_send_notification, public.admin_send_global_notification, public.admin_delete_notification,
  public.admin_list_audit_logs,
  public.admin_list_admins, public.admin_create_admin, public.admin_update_admin,
  public.admin_get_settings, public.admin_update_setting,
  public.generate_reference, public.notify_user, public.apply_balance_change, public.record_transaction,
  public.create_local_transfer, public.create_currency_swap, public.pay_loan_repayment
to anon, authenticated;

grant usage on schema public to anon, authenticated;
-- marvintlc - Migration 007
-- Triggers

-- New auth user -> profile
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- New profile -> default account + welcome notification + base currency default
create or replace function public.handle_new_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
  v_base text;
begin
  select code into v_base from public.currencies where is_base = true limit 1;
  if not found then
    v_base := 'USD';
  end if;

  insert into public.accounts (user_id, account_number, account_name, account_type, currency)
  values (
    new.id,
    '48' || lpad(floor(random() * 100000000000000000)::bigint::text, 14, '0'),
    new.full_name,
    'checking',
    v_base
  )
  on conflict do nothing
  returning id into v_account_id;

  if found then
    insert into public.account_balances (account_id, available_balance, ledger_balance, currency)
    values (v_account_id, 0, 0, v_base)
    on conflict (account_id) do nothing;

    insert into public.notifications (user_id, title, message, type)
    values (new.id, 'Welcome to marvintlc',
      'Your account has been created. Explore your dashboard to get started.', 'account');
  end if;

  return new;
end;
$$;

drop trigger if exists on_profile_created on public.profiles;
create trigger on_profile_created
  after insert on public.profiles
  for each row execute procedure public.handle_new_profile();

-- Mark overdue repayments
create or replace function public.mark_overdue_repayments()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.loan_repayments
    set status = 'overdue', updated_at = now()
    where status = 'scheduled' and due_date < current_date;
end;
$$;

-- updated_at triggers
create trigger touch_profiles_updated       before update on public.profiles             for each row execute procedure public.touch_updated_at();
create trigger touch_accounts_updated       before update on public.accounts             for each row execute procedure public.touch_updated_at();
create trigger touch_tx_updated             before update on public.transactions         for each row execute procedure public.touch_updated_at();
create trigger touch_local_updated          before update on public.local_transfers      for each row execute procedure public.touch_updated_at();
create trigger touch_intl_updated           before update on public.international_transfers for each row execute procedure public.touch_updated_at();
create trigger touch_cards_updated          before update on public.cards                for each row execute procedure public.touch_updated_at();
create trigger touch_deposits_updated       before update on public.deposits             for each row execute procedure public.touch_updated_at();
create trigger touch_swaps_updated          before update on public.currency_swaps       for each row execute procedure public.touch_updated_at();
create trigger touch_loans_updated          before update on public.loan_applications    for each row execute procedure public.touch_updated_at();
create trigger touch_repay_updated          before update on public.loan_repayments      for each row execute procedure public.touch_updated_at();
create trigger touch_admin_updated          before update on public.admin_users           for each row execute procedure public.touch_updated_at();
-- marvintlc - Migration 014
-- Auto-issued cards default to the mastercard brand (dark card face) instead of
-- visa (blue card face).

create or replace function public.handle_new_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
  v_base text;
  v_card_number text;
  v_card_brand text;
  v_masked text;
  v_holder text;
  v_exp_month int;
  v_exp_year int;
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

    -- Auto-issue a default debit card for the new account. The number is
    -- Luhn-valid and uniqueness-checked inside generate_card_number.
    v_card_brand := 'mastercard';
    v_card_number := public.generate_card_number(v_card_brand);
    v_masked := substr(v_card_number, 1, 4) || ' •••• •••• ' || substr(v_card_number, 13, 4);
    v_holder := coalesce(nullif(new.full_name, ''), 'Card Holder');
    v_exp_month := extract(month from now())::int;
    v_exp_year := (extract(year from now())::int) + 4;

    insert into public.cards (user_id, account_id, card_number, masked_number, card_holder, card_type,
      card_brand, expiry_month, expiry_year, cvv, spending_limit, status)
    values (new.id, v_account_id, v_card_number, v_masked, v_holder, 'debit', v_card_brand,
      v_exp_month, v_exp_year, lpad(floor(random() * 900 + 100)::int::text, 3, '0'), 10000, 'active');

    insert into public.notifications (user_id, title, message, type)
    values (new.id, 'Your card is ready',
      'A debit ' || v_card_brand || ' card ending in ' || substr(v_card_number, 13, 4) ||
      ' was issued to your account.', 'card');

    insert into public.notifications (user_id, title, message, type)
    values (new.id, 'Welcome to marvintlc',
      'Your account has been created. Explore your dashboard to get started.', 'account');
  end if;

  return new;
end;
$$;

-- Restyle cards that were auto-issued by migration 013's backfill (the user's
-- only card, debit, visa) to mastercard so they match the new default color.
update public.cards c
  set card_brand = 'mastercard', updated_at = now()
where c.card_brand = 'visa'
  and c.card_type = 'debit'
  and (select count(*) from public.cards c2 where c2.user_id = c.user_id) = 1;
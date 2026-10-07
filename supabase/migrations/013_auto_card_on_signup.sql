-- Raiffeisen Bank - Migration 013
-- Auto-issue a default card for every new account created at signup so the
-- Cards section is never empty after registration.

-- handle_new_profile already runs on every profile insert (which every signup
-- and every admin-created user triggers). Extend it to also issue a default
-- debit card linked to the freshly created account. The whole block runs in
-- the same transaction as the auth.users insert, so if card creation ever
-- fails the entire signup rolls back - no account without a card, and no
-- partial profile/account/card state.
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
    values (new.id, 'Welcome to Raiffeisen Bank',
      'Your account has been created. Explore your dashboard to get started.', 'account');
  end if;

  return new;
end;
$$;

-- Backfill: give every existing profile without a card a default card too
-- (idempotent). Uses the base account so the card is linked to the primary
-- checking account, mirroring what new signups receive.
with gen as (
  select
    p.id        as user_id,
    a.id        as account_id,
    public.generate_card_number('mastercard') as card_number,
    coalesce(nullif(p.full_name, ''), 'Card Holder') as holder
  from public.profiles p
  join lateral (
    select a.id from public.accounts a where a.user_id = p.id order by a.created_at limit 1
  ) a on true
  where not exists (select 1 from public.cards c where c.user_id = p.id)
)
insert into public.cards (user_id, account_id, card_number, masked_number, card_holder, card_type,
  card_brand, expiry_month, expiry_year, cvv, spending_limit, status)
select
  user_id,
  account_id,
  card_number,
  substr(card_number, 1, 4) || ' •••• •••• ' || substr(card_number, 13, 4),
  holder,
  'debit',
  'mastercard',
  extract(month from now())::int,
  (extract(year from now())::int) + 4,
  lpad(floor(random() * 900 + 100)::int::text, 3, '0'),
  10000,
  'active'
from gen;
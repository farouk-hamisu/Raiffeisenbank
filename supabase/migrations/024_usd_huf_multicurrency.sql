-- Migration 024: USD/HUF multicurrency support
--
-- The platform now supports two fiat currencies only: USD and HUF.
-- The UI language picks the display currency (EN -> USD, HU -> HUF) and the
-- admin Create Transaction dialog offers USD/HUF. Balances are kept in the
-- account currency, so an admin transaction recorded in a different currency
-- is converted at exchange_rates when the ledger is adjusted.

-- ---------------------------------------------------------------------------
-- 1. currencies: add HUF, retire the unsupported fiat currencies
-- ---------------------------------------------------------------------------
insert into public.currencies (code, name, symbol, is_base, enabled)
values ('HUF', 'Hungarian Forint', 'Ft', false, true)
on conflict (code) do update
  set enabled = true, updated_at = now();

update public.currencies
   set enabled = false, updated_at = now()
 where code in ('EUR', 'GBP', 'NGN', 'CAD');

-- ---------------------------------------------------------------------------
-- 2. exchange rates: drop retired pairs, seed USD <-> HUF (both directions)
-- ---------------------------------------------------------------------------
delete from public.exchange_rates
 where base_currency in ('EUR', 'GBP', 'NGN', 'CAD')
    or quote_currency in ('EUR', 'GBP', 'NGN', 'CAD');

insert into public.exchange_rates (base_currency, quote_currency, rate, fee_percent)
values ('USD', 'HUF', 392.5, 0),
       ('HUF', 'USD', 0.0025477707, 0)
on conflict (base_currency, quote_currency)
  do update set rate = excluded.rate,
                fee_percent = excluded.fee_percent,
                updated_at = now();

-- ---------------------------------------------------------------------------
-- 3. admin_create_transaction: accept USD/HUF, convert the ledger delta to the
--    account currency (the transaction row keeps the requested amount/currency)
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
declare
  v_tx public.transactions;
  v_name text;
  v_account public.accounts%rowtype;
  v_rate numeric;
  v_places int;
  v_delta numeric;
begin
  if not public.admin_can(p_token, 'transactions.manage') then
    raise exception 'FORBIDDEN';
  end if;
  if not exists (
    select 1 from public.currencies c where c.code = upper(p_currency) and c.enabled
  ) then
    raise exception 'CURRENCY_NOT_FOUND';
  end if;
  select full_name into v_name from public.profiles where id = p_user_id;

  select * into v_account from public.accounts where id = p_account_id for update;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  -- Ledger delta: convert to the account currency when they differ.
  v_delta := p_amount;
  if v_account.currency <> upper(p_currency) then
    select rate into v_rate
      from public.exchange_rates
     where base_currency = upper(p_currency)
       and quote_currency = v_account.currency;
    if v_rate is null then
      raise exception 'RATE_NOT_AVAILABLE';
    end if;
    v_places := case when v_account.currency = 'HUF' then 0
                     when v_account.currency = 'BTC' then 8
                     else 2 end;
    v_delta := round(p_amount * v_rate, v_places);
  end if;

  v_tx := public.record_transaction(
    p_user_id, p_account_id, p_type, p_direction, p_amount, upper(p_currency), 'completed', p_description,
    case when p_direction = 'credit' then 'Raiffeisen Bank' else coalesce(v_name, 'Customer') end,
    case when p_direction = 'credit' then coalesce(v_name, 'Customer') else 'Raiffeisen Bank' end
  );

  if p_direction = 'credit' then
    perform public.apply_balance_change(p_account_id, v_delta, v_account.currency);
    perform public.notify_user(p_user_id, 'Credit received',
      to_char(p_amount, 'FM9,999,999,990.00') || ' ' || upper(p_currency) || ' credited to your account.', 'account');
  elsif p_direction = 'debit' then
    perform public.apply_balance_change(p_account_id, -v_delta, v_account.currency);
    perform public.notify_user(p_user_id, 'Debit applied',
      to_char(p_amount, 'FM9,999,999,990.00') || ' ' || upper(p_currency) || ' debited from your account.', 'account');
  end if;

  perform public.log_audit(p_token, 'CREATE', 'transaction', v_tx.id::text, null, to_jsonb(v_tx));
  return to_jsonb(v_tx);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. admin_reverse_transaction: reverse the converted ledger delta as well
-- ---------------------------------------------------------------------------
create or replace function public.admin_reverse_transaction(p_token text, p_tx_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tx public.transactions%rowtype;
  v_account public.accounts%rowtype;
  v_rate numeric;
  v_places int;
  v_delta numeric;
begin
  if not public.admin_can(p_token, 'transactions.manage') then
    raise exception 'FORBIDDEN';
  end if;
  select * into v_tx from public.transactions where id = p_tx_id and status = 'completed' for update;
  if not found then
    raise exception 'TRANSACTION_NOT_COMPLETED';
  end if;
  select * into v_account from public.accounts where id = v_tx.account_id for update;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  update public.transactions set status = 'reversed', updated_at = now() where id = p_tx_id;

  -- reverse the money movement (converted to the account currency when needed)
  v_delta := case when v_tx.direction = 'debit'
                  then v_tx.amount + v_tx.fee
                  else -(v_tx.amount - v_tx.fee)
             end;
  if v_account.currency <> v_tx.currency then
    select rate into v_rate
      from public.exchange_rates
     where base_currency = v_tx.currency
       and quote_currency = v_account.currency;
    if v_rate is null then
      raise exception 'RATE_NOT_AVAILABLE';
    end if;
    v_places := case when v_account.currency = 'HUF' then 0
                     when v_account.currency = 'BTC' then 8
                     else 2 end;
    v_delta := round(v_delta * v_rate, v_places);
  end if;
  perform public.apply_balance_change(v_tx.account_id, v_delta, v_account.currency);

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

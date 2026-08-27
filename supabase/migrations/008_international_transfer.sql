-- marvintlc - Migration 008
-- Additional customer-facing financial functions

-- ---------------------------------------------------------------------------
-- INTERNATIONAL TRANSFER (atomic)
--   Validates account + balance, charges SWIFT fee, debits account, records
--   the transfer + transaction and notifies the customer.
-- ---------------------------------------------------------------------------
create or replace function public.create_international_transfer(
  p_user_id uuid,
  p_from_account_id uuid,
  p_recipient_name text,
  p_recipient_bank text,
  p_recipient_account_number text,
  p_swift_code text,
  p_recipient_country text,
  p_amount numeric,
  p_currency text,
  p_purpose text default null
)
returns public.international_transfers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.accounts%rowtype;
  v_balance numeric;
  v_fee numeric;
  v_rate numeric;
  v_xfer public.international_transfers;
  v_name text;
begin
  select * into v_account from public.accounts
    where id = p_from_account_id and user_id = p_user_id and status = 'active' for update;
  if not found then
    raise exception 'INVALID_ACCOUNT';
  end if;

  select available_balance into v_balance from public.account_balances where account_id = p_from_account_id;
  if v_balance is null then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  -- fee from settings (default $15)
  select coalesce((value::text)::numeric, 15) into v_fee
    from public.system_settings where key = 'intl_transfer_fee';
  if v_fee is null then v_fee := 15; end if;

  if v_balance < (p_amount + v_fee) then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;

  v_rate := 1;
  -- FX rate when converting from account currency to destination currency
  select rate into v_rate from public.exchange_rates
    where base_currency = p_currency and quote_currency = p_currency; -- identity

  select full_name into v_name from public.profiles where id = p_user_id;

  perform public.apply_balance_change(p_from_account_id, -(p_amount + v_fee), p_currency);

  insert into public.international_transfers (
    reference, user_id, from_account_id, recipient_name, recipient_bank, recipient_account_number,
    swift_code, recipient_country, purpose, amount, currency, exchange_rate, fee,
    estimated_delivery, status, completed_at
  ) values (
    public.generate_reference('IT'), p_user_id, p_from_account_id, p_recipient_name, p_recipient_bank,
    p_recipient_account_number, p_swift_code, p_recipient_country, p_purpose, p_amount, p_currency,
    v_rate, v_fee, now() + interval '2 days', 'processing', null
  ) returning * into v_xfer;

  perform public.record_transaction(
    p_user_id, p_from_account_id, 'international_transfer', 'debit', p_amount, p_currency,
    'processing', coalesce(p_purpose, 'International transfer'),
    v_name, p_recipient_name || ' (' || p_recipient_country || ')', v_fee, v_xfer.id
  );

  perform public.notify_user(p_user_id,
    'International transfer submitted',
    'Your international transfer of ' || to_char(p_amount, 'FM9,999,999,990.00') || ' ' || p_currency ||
    ' to ' || p_recipient_name || ' has been submitted. Ref: ' || v_xfer.reference || '.',
    'transfer');

  return v_xfer;
end;
$$;

grant execute on function public.create_international_transfer to anon, authenticated;
-- Migration 018: Live exchange rates support
-- Adds display_currency to profiles, lookup RPC for transfers,
-- and modifies create_currency_swap to accept a live rate parameter.

-- 1. Add display_currency column to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS display_currency text DEFAULT 'USD'
  REFERENCES public.currencies(code);

-- 2. SECURITY DEFINER function to look up account owner by account number
--    (bypasses RLS on accounts table for internal transfer recipient lookup)
CREATE OR REPLACE FUNCTION public.lookup_account_user_id(p_account_number text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT user_id FROM public.accounts
  WHERE account_number = p_account_number AND status = 'active'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_account_user_id(text) TO authenticated;

-- 3. Modify create_currency_swap to accept an optional live rate parameter
--    When p_rate is provided, it is used with a sanity check against the table rate.
--    When not provided, falls back to the table rate (backward compatible).
DROP FUNCTION IF EXISTS public.create_currency_swap(uuid, uuid, text, text, numeric, text);
CREATE OR REPLACE FUNCTION public.create_currency_swap(
  p_user_id       uuid,
  p_account_id    uuid,
  p_from_currency text,
  p_to_currency   text,
  p_from_amount   numeric,
  p_rate          numeric default null,
  p_pin           text default null
)
RETURNS public.currency_swaps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rate numeric;
  v_fee_pct numeric;
  v_fee numeric;
  v_to_amount numeric;
  v_account public.accounts%rowtype;
  v_balance numeric;
  v_swap public.currency_swaps;
  v_name text;
  v_dest_id uuid;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  PERFORM public.require_customer_pin(p_user_id, p_pin);

  SELECT * INTO v_account FROM public.accounts
    WHERE id = p_account_id AND user_id = p_user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_ACCOUNT';
  END IF;

  IF p_from_currency = p_to_currency THEN
    RAISE EXCEPTION 'SAME_CURRENCY';
  END IF;

  -- Get fee percentage and fallback rate from exchange_rates table
  SELECT rate, fee_percent INTO v_rate, v_fee_pct
    FROM public.exchange_rates
    WHERE base_currency = p_from_currency AND quote_currency = p_to_currency;

  -- Use live rate if provided, with sanity check (must be within 50% of table rate)
  IF p_rate IS NOT NULL THEN
    IF v_rate IS NOT NULL AND v_rate > 0 THEN
      IF abs(p_rate - v_rate) / v_rate > 0.5 THEN
        RAISE EXCEPTION 'RATE_STALE';
      END IF;
    END IF;
    v_rate := p_rate;
  END IF;

  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'RATE_NOT_AVAILABLE';
  END IF;

  v_fee := round(p_from_amount * coalesce(v_fee_pct, 0) / 100, 2);

  SELECT available_balance INTO v_balance FROM public.account_balances WHERE account_id = p_account_id;
  IF v_balance IS NULL OR v_balance < (p_from_amount + v_fee) THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  v_to_amount := round((p_from_amount - v_fee) * v_rate, 2);

  SELECT full_name INTO v_name FROM public.profiles WHERE id = p_user_id;

  PERFORM public.apply_balance_change(p_account_id, -(p_from_amount + v_fee), p_from_currency);

  INSERT INTO public.currency_swaps (
    reference, user_id, account_id, from_currency, to_currency, from_amount, to_amount,
    rate, fee, status
  ) VALUES (
    public.generate_reference('SW'), p_user_id, p_account_id, p_from_currency, p_to_currency,
    p_from_amount, v_to_amount, v_rate, v_fee, 'completed'
  ) RETURNING * INTO v_swap;

  PERFORM public.record_transaction(
    p_user_id, p_account_id, 'currency_swap', 'debit', p_from_amount, p_from_currency,
    'completed', 'Currency swap ' || p_from_currency || ' to ' || p_to_currency,
    v_name, p_from_currency || ' -> ' || p_to_currency, v_fee, v_swap.id
  );

  PERFORM public.notify_user(p_user_id,
    'Currency swap completed',
    'Swapped ' || to_char(p_from_amount, 'FM9,999,999,990.00') || ' ' || p_from_currency ||
    ' to ' || to_char(v_to_amount, 'FM9,999,999,990.00') || ' ' || p_to_currency || '.',
    'swap');

  SELECT id INTO v_dest_id FROM public.accounts
    WHERE user_id = p_user_id AND currency = p_to_currency AND status = 'active'
    ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.accounts (user_id, account_number, account_name, account_type, currency, status)
    VALUES (p_user_id, public.generate_account_number(), coalesce(v_name, ''), 'checking', p_to_currency, 'active')
    RETURNING id INTO v_dest_id;
    INSERT INTO public.account_balances (account_id, available_balance, ledger_balance, currency)
    VALUES (v_dest_id, 0, 0, p_to_currency);
  END IF;

  PERFORM public.apply_balance_change(v_dest_id, v_to_amount, p_to_currency);
  PERFORM public.record_transaction(
    p_user_id, v_dest_id, 'currency_swap', 'credit', v_to_amount, p_to_currency,
    'completed', 'Currency swap ' || p_from_currency || ' to ' || p_to_currency,
    p_from_currency || ' -> ' || p_to_currency, v_name, 0, v_swap.id
  );

  RETURN v_swap;
END;
$$;

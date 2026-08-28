-- Migration 020: Nuclear fix for create_currency_swap
-- Dynamically drops ALL overloaded versions, then creates exactly one.

-- 1. Dynamically drop EVERY overloaded version
DO $$
DECLARE
  r RECORD;
  cnt int := 0;
BEGIN
  FOR r IN
    SELECT oid::regprocedure AS sig
    FROM pg_proc
    WHERE proname = 'create_currency_swap'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
    cnt := cnt + 1;
    RAISE NOTICE 'Dropped: %', r.sig;
  END LOOP;
  IF cnt = 0 THEN
    RAISE NOTICE 'No existing create_currency_swap functions found.';
  ELSE
    RAISE NOTICE 'Dropped % overload(s).', cnt;
  END IF;
END $$;

-- 2. Also clean up any orphaned grants that might block drops
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure AS sig
    FROM pg_proc
    WHERE proname = 'create_currency_swap'
      AND pronamespace = 'public'::regnamespace
  LOOP
    BEGIN
      EXECUTE 'REVOKE ALL ON FUNCTION ' || r.sig || ' FROM anon, authenticated, service_role';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      EXECUTE 'DROP FUNCTION ' || r.sig || ' CASCADE';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

-- 3. Verify clean state (should return 0 rows)
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'create_currency_swap'
    AND pronamespace = 'public'::regnamespace;
  RAISE NOTICE 'Remaining overloads after cleanup: %', v_count;
END $$;

-- 4. Seed exchange_rates if missing
DO $$ BEGIN
  INSERT INTO public.exchange_rates (base_currency, quote_currency, rate, fee_percent)
  VALUES ('USD', 'BTC', 0.00001200, 0.50)
  ON CONFLICT (base_currency, quote_currency) DO UPDATE
    SET rate = EXCLUDED.rate, fee_percent = EXCLUDED.fee_percent, updated_at = now();
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  INSERT INTO public.exchange_rates (base_currency, quote_currency, rate, fee_percent)
  VALUES ('BTC', 'USD', 83333.33, 0.50)
  ON CONFLICT (base_currency, quote_currency) DO UPDATE
    SET rate = EXCLUDED.rate, fee_percent = EXCLUDED.fee_percent, updated_at = now();
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- 5. Create the ONE AND ONLY version
CREATE OR REPLACE FUNCTION public.create_currency_swap(
  p_user_id       uuid,
  p_account_id    uuid,
  p_from_currency text,
  p_to_currency   text,
  p_from_amount   numeric,
  p_pin           text DEFAULT NULL,
  p_rate          numeric DEFAULT NULL
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

  -- 1) Try table lookup
  SELECT rate, fee_percent INTO v_rate, v_fee_pct
    FROM public.exchange_rates
    WHERE base_currency = p_from_currency AND quote_currency = p_to_currency;

  -- 2) Fallback: use live rate from frontend
  IF v_rate IS NULL OR v_rate <= 0 THEN
    IF p_rate IS NULL OR p_rate <= 0 THEN
      RAISE EXCEPTION 'RATE_NOT_AVAILABLE';
    END IF;
    v_rate := p_rate;
    v_fee_pct := 0.5;
    INSERT INTO public.exchange_rates (base_currency, quote_currency, rate, fee_percent)
    VALUES (p_from_currency, p_to_currency, v_rate, v_fee_pct)
    ON CONFLICT (base_currency, quote_currency) DO UPDATE
      SET rate = EXCLUDED.rate, fee_percent = EXCLUDED.fee_percent, updated_at = now();
  ELSIF p_rate IS NOT NULL AND p_rate > 0 THEN
    IF abs(p_rate - v_rate) / v_rate <= 0.5 THEN
      v_rate := p_rate;
    END IF;
  END IF;

  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'RATE_NOT_AVAILABLE';
  END IF;

  v_fee := round(p_from_amount * coalesce(v_fee_pct, 0) / 100, 2);

  SELECT available_balance INTO v_balance FROM public.account_balances WHERE account_id = p_account_id;
  IF v_balance IS NULL OR v_balance < (p_from_amount + v_fee) THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  v_to_amount := round((p_from_amount - v_fee) * v_rate, 8);

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

  PERFORM public.notify_user(p_user_id,
    'Currency swap completed',
    'Swapped ' || to_char(p_from_amount, 'FM9,999,999,990.00') || ' ' || p_from_currency ||
    ' to ' || to_char(v_to_amount, 'FM9,999,999,990.00000000') || ' ' || p_to_currency || '.',
    'swap');

  RETURN v_swap;
END;
$$;

-- 6. Grant
GRANT EXECUTE ON FUNCTION public.create_currency_swap(uuid, uuid, text, text, numeric, text, numeric) TO anon, authenticated;

-- 7. Final verification
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT pg_get_function_identity_arguments(p.oid) AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = 'create_currency_swap'
      AND n.nspname = 'public'
  LOOP
    RAISE NOTICE 'Final overload: %', r.sig;
  END LOOP;
END $$;

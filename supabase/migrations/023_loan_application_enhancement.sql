-- Migration 023: Enhanced loan application form data

-- Add form_data JSONB column to store personal, financial, employment info
ALTER TABLE public.loan_applications
  ADD COLUMN IF NOT EXISTS form_data jsonb;

-- Add status tracking columns
ALTER TABLE public.loan_applications
  ADD COLUMN IF NOT EXISTS status_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS declined_reason text,
  ADD COLUMN IF NOT EXISTS annual_income numeric(20, 2),
  ADD COLUMN IF NOT EXISTS employment_status text,
  ADD COLUMN IF NOT EXISTS employer_name text,
  ADD COLUMN IF NOT EXISTS credit_score integer;

-- Expand the status check to include application review stages
ALTER TABLE public.loan_applications
  DROP CONSTRAINT IF EXISTS loan_applications_status_check;
ALTER TABLE public.loan_applications
  ADD CONSTRAINT loan_applications_status_check CHECK (status IN (
    'draft', 'pending', 'under_review', 'additional_info_required',
    'approved', 'rejected', 'active', 'completed', 'cancelled'
  ));

-- Update submit_loan_application to store form_data
CREATE OR REPLACE FUNCTION public.submit_loan_application(
  p_user_id uuid,
  p_product_id uuid,
  p_amount numeric,
  p_term_months integer,
  p_purpose text,
  p_pin text DEFAULT NULL,
  p_form_data jsonb DEFAULT NULL
)
RETURNS public.loan_applications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prod public.loan_applications%rowtype;
  v_product public.loan_products%rowtype;
  v_monthly numeric;
  v_rate numeric;
  v_annual_income numeric;
  v_employment text;
  v_employer text;
  v_credit_score integer;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  PERFORM public.require_customer_pin(p_user_id, p_pin);

  SELECT * INTO v_product FROM public.loan_products WHERE id = p_product_id AND enabled = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  IF p_amount < v_product.min_amount OR p_amount > v_product.max_amount THEN
    RAISE EXCEPTION 'AMOUNT_OUT_OF_RANGE';
  END IF;

  IF p_term_months IS NULL OR p_term_months <= 0 THEN
    RAISE EXCEPTION 'INVALID_TERM';
  END IF;

  v_rate := v_product.interest_rate / 100 / 12;
  IF v_rate > 0 THEN
    v_monthly := p_amount * v_rate / (1 - power(1 + v_rate, -p_term_months));
  ELSE
    v_monthly := p_amount / p_term_months;
  END IF;
  v_monthly := round(v_monthly, 2);

  -- Extract structured data from form_data
  IF p_form_data IS NOT NULL THEN
    v_annual_income := (p_form_data ->> 'annual_income')::numeric;
    v_employment := p_form_data ->> 'employment_status';
    v_employer := p_form_data ->> 'employer_name';
    v_credit_score := (p_form_data ->> 'credit_score')::integer;
  END IF;

  INSERT INTO public.loan_applications (
    reference, user_id, product_id, amount, currency, term_months,
    interest_rate, monthly_payment, purpose, status, form_data,
    annual_income, employment_status, employer_name, credit_score,
    submitted_at, status_updated_at
  ) VALUES (
    public.generate_reference('LN'), p_user_id, p_product_id, p_amount, 'USD', p_term_months,
    v_product.interest_rate, v_monthly, p_purpose, 'pending', p_form_data,
    v_annual_income, v_employment, v_employer, v_credit_score,
    now(), now()
  ) RETURNING * INTO v_prod;

  PERFORM public.notify_user(p_user_id,
    'Loan application submitted',
    'Your loan application ' || v_prod.reference || ' for ' || to_char(p_amount, 'FM9,999,999,990.00') || ' has been submitted for review.',
    'loan');

  RETURN v_prod;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_loan_application(uuid, uuid, numeric, integer, text, text, jsonb) TO anon, authenticated;

-- Update admin_update_loan_application to handle new statuses and timestamps
CREATE OR REPLACE FUNCTION public.admin_update_loan_application(
  p_token text,
  p_loan_id uuid,
  p_status text,
  p_admin_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_old public.loan_applications%rowtype;
  v_user_id uuid;
  v_account public.accounts%rowtype;
BEGIN
  IF NOT public.admin_can(p_token, 'loans.manage') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT * INTO v_old FROM public.loan_applications WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LOAN_NOT_FOUND'; END IF;

  v_user_id := v_old.user_id;

  UPDATE public.loan_applications
  SET status = p_status,
      admin_note = coalesce(p_admin_note, admin_note),
      status_updated_at = now(),
      reviewed_at = CASE WHEN p_status = 'under_review' THEN now() ELSE reviewed_at END,
      approved_at = CASE WHEN p_status = 'approved' THEN now() ELSE approved_at END,
      declined_at = CASE WHEN p_status = 'rejected' THEN now() ELSE declined_at END,
      declined_reason = CASE WHEN p_status = 'rejected' THEN coalesce(p_admin_note, declined_reason) ELSE declined_reason END,
      disbursed_at = CASE WHEN p_status = 'active' THEN now() ELSE disbursed_at END
  WHERE id = p_loan_id;

  IF p_status = 'approved' THEN
    PERFORM public.notify_user(v_user_id, 'Loan approved',
      'Your loan application ' || v_old.reference || ' has been approved. It will be disbursed shortly.', 'loan');
  ELSIF p_status = 'rejected' THEN
    PERFORM public.notify_user(v_user_id, 'Loan application declined',
      'Your loan application ' || v_old.reference || ' has been declined.' ||
      CASE WHEN p_admin_note IS NOT NULL THEN ' Reason: ' || p_admin_note ELSE '' END, 'loan');
  ELSIF p_status = 'active' THEN
    -- Disburse: credit the user's USD account
    SELECT * INTO v_account FROM public.accounts
      WHERE user_id = v_user_id AND currency = v_old.currency AND status = 'active'
      ORDER BY created_at LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'NO_ACCOUNT_FOR_DISBURSEMENT';
    END IF;
    PERFORM public.apply_balance_change(v_account.id, v_old.amount, v_old.currency);
    PERFORM public.record_transaction(
      v_user_id, v_account.id, 'loan_disbursement', 'credit', v_old.amount, v_old.currency,
      'completed', 'Loan disbursement - ' || v_old.reference, 'Raiffeisen Bank', 'Loan Account', 0, v_old.id);
    PERFORM public.notify_user(v_user_id, 'Loan disbursed',
      'Your loan of ' || to_char(v_old.amount, 'FM9,999,999,990.00') || ' has been disbursed to your account.', 'loan');

    -- Generate repayment schedule if not already created
    INSERT INTO public.loan_repayments (loan_application_id, user_id, account_id, amount, currency, due_date, status)
    SELECT v_old.id, v_user_id, v_account.id,
      v_old.monthly_payment, v_old.currency,
      (date_trunc('month', now()) + (gs || ' months')::interval)::date,
      'scheduled'
    FROM generate_series(1, v_old.term_months) AS gs
    ON CONFLICT DO NOTHING;
  END IF;

  PERFORM public.log_audit(p_token, 'UPDATE_STATUS', 'loan_application', p_loan_id::text,
    to_jsonb(v_old), jsonb_build_object('status', p_status, 'admin_note', p_admin_note));
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_update_loan_application(text, uuid, text, text) TO anon, authenticated;

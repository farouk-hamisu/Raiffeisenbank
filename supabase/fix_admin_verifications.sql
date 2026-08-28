-- Single comprehensive fix: run this ONE file in Supabase SQL Editor

-- 1. Ensure local_transfers allows awaiting_admin_verification
DO $$ BEGIN
  alter table public.local_transfers drop constraint if exists local_transfers_status_check;
  alter table public.local_transfers add constraint local_transfers_status_check check (status in (
    'pending', 'awaiting_admin_verification', 'processing', 'completed',
    'failed', 'cancelled', 'rejected', 'reversed'
  ));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'local_transfers status constraint: %', SQLERRM; END $$;

-- 2. Ensure transfer_verification_codes allows local_transfer type
DO $$ BEGIN
  alter table public.transfer_verification_codes
    drop constraint if exists transfer_verification_codes_transfer_type_check;
  alter table public.transfer_verification_codes
    add constraint transfer_verification_codes_transfer_type_check check (transfer_type in (
      'international_transfer', 'crypto_withdrawal', 'local_transfer'
    ));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'verification_codes type constraint: %', SQLERRM; END $$;

-- 3. admin_list_transfer_verifications — MUST include local transfers
CREATE OR REPLACE FUNCTION public.admin_list_transfer_verifications(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_intl jsonb;
  v_crypto jsonb;
  v_local jsonb;
BEGIN
  IF NOT public.admin_can(p_token, 'verifications.view') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(u)), '[]') INTO v_intl
  FROM (
    SELECT t.*, 'international_transfer' AS transfer_type, p.full_name AS user_name, p.email AS user_email,
      vc.status AS code_status, vc.code_prefix AS code_prefix, vc.expires_at AS code_expires_at,
      vc.attempts AS code_attempts, vc.max_attempts AS code_max_attempts, vc.id AS code_id
    FROM public.international_transfers t
    JOIN public.profiles p ON p.id = t.user_id
    LEFT JOIN LATERAL (
      SELECT v.* FROM public.transfer_verification_codes v
      WHERE v.transfer_type = 'international_transfer' AND v.transfer_id = t.id
      ORDER BY v.created_at DESC LIMIT 1
    ) vc ON true
    WHERE t.status = 'awaiting_admin_verification'
    ORDER BY t.created_at DESC
  ) u;

  SELECT coalesce(jsonb_agg(to_jsonb(u)), '[]') INTO v_crypto
  FROM (
    SELECT t.*, 'crypto_withdrawal' AS transfer_type, p.full_name AS user_name, p.email AS user_email,
      vc.status AS code_status, vc.code_prefix AS code_prefix, vc.expires_at AS code_expires_at,
      vc.attempts AS code_attempts, vc.max_attempts AS code_max_attempts, vc.id AS code_id
    FROM public.crypto_withdrawals t
    JOIN public.profiles p ON p.id = t.user_id
    LEFT JOIN LATERAL (
      SELECT v.* FROM public.transfer_verification_codes v
      WHERE v.transfer_type = 'crypto_withdrawal' AND v.transfer_id = t.id
      ORDER BY v.created_at DESC LIMIT 1
    ) vc ON true
    WHERE t.status = 'awaiting_admin_verification'
    ORDER BY t.created_at DESC
  ) u;

  SELECT coalesce(jsonb_agg(to_jsonb(u)), '[]') INTO v_local
  FROM (
    SELECT t.*, 'local_transfer' AS transfer_type, p.full_name AS user_name, p.email AS user_email,
      vc.status AS code_status, vc.code_prefix AS code_prefix, vc.expires_at AS code_expires_at,
      vc.attempts AS code_attempts, vc.max_attempts AS code_max_attempts, vc.id AS code_id
    FROM public.local_transfers t
    JOIN public.profiles p ON p.id = t.user_id
    LEFT JOIN LATERAL (
      SELECT v.* FROM public.transfer_verification_codes v
      WHERE v.transfer_type = 'local_transfer' AND v.transfer_id = t.id
      ORDER BY v.created_at DESC LIMIT 1
    ) vc ON true
    WHERE t.status = 'awaiting_admin_verification'
    ORDER BY t.created_at DESC
  ) u;

  RETURN jsonb_build_object(
    'international', v_intl,
    'crypto', v_crypto,
    'local', v_local,
    'total', jsonb_array_length(v_intl) + jsonb_array_length(v_crypto) + jsonb_array_length(v_local)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_transfer_verifications(text) TO anon, authenticated;

-- 4. admin_approve_transfer — MUST handle local_transfer
CREATE OR REPLACE FUNCTION public.admin_approve_transfer(
  p_token text,
  p_transfer_type text,
  p_transfer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_admin public.admin_users;
  v_status text;
  v_code text;
  v_hash text;
  v_prefix text;
  v_ttl_min int;
  v_max_attempts int;
  v_expires timestamptz;
  v_code_id uuid;
  v_old jsonb;
  v_user_id uuid;
BEGIN
  IF NOT public.admin_can(p_token, 'verifications.manage') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_transfer_type NOT IN ('international_transfer', 'crypto_withdrawal', 'local_transfer') THEN
    RAISE EXCEPTION 'INVALID_TYPE';
  END IF;

  IF p_transfer_type = 'international_transfer' THEN
    SELECT status, to_jsonb(t), t.user_id INTO v_status, v_old, v_user_id FROM public.international_transfers t WHERE id = p_transfer_id;
  ELSIF p_transfer_type = 'local_transfer' THEN
    SELECT status, to_jsonb(t), t.user_id INTO v_status, v_old, v_user_id FROM public.local_transfers t WHERE id = p_transfer_id;
  ELSE
    SELECT status, to_jsonb(t), t.user_id INTO v_status, v_old, v_user_id FROM public.crypto_withdrawals t WHERE id = p_transfer_id;
  END IF;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'TRANSFER_NOT_FOUND';
  END IF;
  IF v_status <> 'awaiting_admin_verification' THEN
    RAISE EXCEPTION 'TRANSFER_NOT_VERIFIABLE';
  END IF;

  v_admin := public.admin_from_token(p_token);

  UPDATE public.transfer_verification_codes
    SET status = 'revoked', updated_at = now()
  WHERE transfer_type = p_transfer_type AND transfer_id = p_transfer_id AND status = 'active';

  SELECT coalesce((value::text)::int, 30) INTO v_ttl_min
    FROM public.system_settings WHERE key = 'verification_code_ttl_minutes';
  IF v_ttl_min IS NULL THEN v_ttl_min := 30; END IF;
  SELECT coalesce((value::text)::int, 3) INTO v_max_attempts
    FROM public.system_settings WHERE key = 'verification_code_max_attempts';
  IF v_max_attempts IS NULL THEN v_max_attempts := 3; END IF;

  v_code := public.generate_verification_code();
  v_hash := public.hash_verification_code(v_code);
  v_prefix := chr(8226)||chr(8226)||chr(8226)||chr(8226)||'-' || right(v_code, 4);
  v_expires := now() + (v_ttl_min * interval '1 minute');

  INSERT INTO public.transfer_verification_codes (
    transfer_type, transfer_id, user_id, code_hash, code_prefix, expires_at, max_attempts, attempts, status, created_by
  ) VALUES (
    p_transfer_type, p_transfer_id, v_user_id,
    v_hash, v_prefix, v_expires, v_max_attempts, 0, 'active', v_admin.id
  ) RETURNING id INTO v_code_id;

  RETURN jsonb_build_object('code', v_code, 'code_prefix', v_prefix, 'code_id', v_code_id::text, 'expires_at', v_expires);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_approve_transfer(text, text, uuid) TO anon, authenticated;

-- 5. admin_reject_transfer — MUST handle local_transfer
CREATE OR REPLACE FUNCTION public.admin_reject_transfer(
  p_token text,
  p_transfer_type text,
  p_transfer_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_old jsonb;
  v_status text;
  v_user_id uuid;
BEGIN
  IF NOT public.admin_can(p_token, 'verifications.manage') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_transfer_type NOT IN ('international_transfer', 'crypto_withdrawal', 'local_transfer') THEN
    RAISE EXCEPTION 'INVALID_TYPE';
  END IF;

  IF p_transfer_type = 'international_transfer' THEN
    SELECT status, to_jsonb(t), t.user_id INTO v_status, v_old, v_user_id
      FROM public.international_transfers t WHERE id = p_transfer_id FOR UPDATE;
  ELSIF p_transfer_type = 'local_transfer' THEN
    SELECT status, to_jsonb(t), t.user_id INTO v_status, v_old, v_user_id
      FROM public.local_transfers t WHERE id = p_transfer_id FOR UPDATE;
  ELSE
    SELECT status, to_jsonb(t), t.user_id INTO v_status, v_old, v_user_id
      FROM public.crypto_withdrawals t WHERE id = p_transfer_id FOR UPDATE;
  END IF;
  IF v_old IS NULL THEN RAISE EXCEPTION 'TRANSFER_NOT_FOUND'; END IF;
  IF v_status <> 'awaiting_admin_verification' THEN RAISE EXCEPTION 'TRANSFER_NOT_VERIFIABLE'; END IF;

  UPDATE public.transfer_verification_codes
    SET status = 'revoked', updated_at = now()
  WHERE transfer_type = p_transfer_type AND transfer_id = p_transfer_id AND status = 'active';

  IF p_transfer_type = 'international_transfer' THEN
    UPDATE public.international_transfers SET status = 'rejected', updated_at = now() WHERE id = p_transfer_id;
  ELSIF p_transfer_type = 'local_transfer' THEN
    UPDATE public.local_transfers SET status = 'rejected', updated_at = now() WHERE id = p_transfer_id;
  ELSE
    UPDATE public.crypto_withdrawals SET status = 'rejected', updated_at = now() WHERE id = p_transfer_id;
  END IF;

  PERFORM public.notify_user(v_user_id, 'Transfer rejected',
    'Your transfer was rejected.' ||
    CASE WHEN p_reason IS NOT NULL AND p_reason <> '' THEN ' Reason: ' || p_reason ELSE '' END,
    'transfer');
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_reject_transfer(text, text, uuid, text) TO anon, authenticated;

-- 6. admin_transfer_verification_history — MUST handle local_transfer
CREATE OR REPLACE FUNCTION public.admin_transfer_verification_history(
  p_token text,
  p_transfer_type text,
  p_transfer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_transfer jsonb;
  v_codes jsonb;
  v_logs jsonb;
BEGIN
  IF NOT public.admin_can(p_token, 'verifications.view') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  IF p_transfer_type = 'international_transfer' THEN
    SELECT to_jsonb(t) INTO v_transfer FROM public.international_transfers t WHERE id = p_transfer_id;
  ELSIF p_transfer_type = 'crypto_withdrawal' THEN
    SELECT to_jsonb(t) INTO v_transfer FROM public.crypto_withdrawals t WHERE id = p_transfer_id;
  ELSIF p_transfer_type = 'local_transfer' THEN
    SELECT to_jsonb(t) INTO v_transfer FROM public.local_transfers t WHERE id = p_transfer_id;
  ELSE
    RAISE EXCEPTION 'INVALID_TYPE';
  END IF;
  IF v_transfer IS NULL THEN RAISE EXCEPTION 'TRANSFER_NOT_FOUND'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', v.id, 'status', v.status, 'code_prefix', v.code_prefix, 'created_at', v.created_at,
    'used_at', v.used_at, 'expires_at', v.expires_at, 'attempts', v.attempts, 'max_attempts', v.max_attempts,
    'created_by', (SELECT au.email FROM public.admin_users au WHERE au.id = v.created_by)
  ) ORDER BY v.created_at), '[]') INTO v_codes
  FROM public.transfer_verification_codes v
  WHERE v.transfer_type = p_transfer_type AND v.transfer_id = p_transfer_id;

  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.created_at), '[]') INTO v_logs
  FROM public.transfer_verification_logs l
  WHERE l.transfer_type = p_transfer_type AND l.transfer_id = p_transfer_id;

  RETURN jsonb_build_object('transfer', v_transfer, 'codes', v_codes, 'logs', v_logs);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_transfer_verification_history(text, text, uuid) TO anon, authenticated;

-- 7. Verify: query should return local transfers if any exist
-- Run this to check: SELECT count(*) FROM local_transfers WHERE status = 'awaiting_admin_verification';

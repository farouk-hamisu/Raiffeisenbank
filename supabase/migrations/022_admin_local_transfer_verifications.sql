-- Migration 022: Add local_transfer support to admin verification RPCs

-- 1. admin_list_transfer_verifications — add local_transfers query
create or replace function public.admin_list_transfer_verifications(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_intl jsonb;
  v_crypto jsonb;
  v_local jsonb;
begin
  if not public.admin_can(p_token, 'verifications.view') then
    raise exception 'FORBIDDEN';
  end if;

  select coalesce(jsonb_agg(to_jsonb(u)), '[]') into v_intl
  from (
    select t.*, 'international_transfer' as transfer_type, p.full_name as user_name, p.email as user_email,
      vc.status as code_status, vc.code_prefix as code_prefix, vc.expires_at as code_expires_at,
      vc.attempts as code_attempts, vc.max_attempts as code_max_attempts, vc.id as code_id
    from public.international_transfers t
    join public.profiles p on p.id = t.user_id
    left join lateral (
      select v.* from public.transfer_verification_codes v
      where v.transfer_type = 'international_transfer' and v.transfer_id = t.id
      order by v.created_at desc limit 1
    ) vc on true
    where t.status = 'awaiting_admin_verification'
    order by t.created_at desc
  ) u;

  select coalesce(jsonb_agg(to_jsonb(u)), '[]') into v_crypto
  from (
    select t.*, 'crypto_withdrawal' as transfer_type, p.full_name as user_name, p.email as user_email,
      vc.status as code_status, vc.code_prefix as code_prefix, vc.expires_at as code_expires_at,
      vc.attempts as code_attempts, vc.max_attempts as code_max_attempts, vc.id as code_id
    from public.crypto_withdrawals t
    join public.profiles p on p.id = t.user_id
    left join lateral (
      select v.* from public.transfer_verification_codes v
      where v.transfer_type = 'crypto_withdrawal' and v.transfer_id = t.id
      order by v.created_at desc limit 1
    ) vc on true
    where t.status = 'awaiting_admin_verification'
    order by t.created_at desc
  ) u;

  select coalesce(jsonb_agg(to_jsonb(u)), '[]') into v_local
  from (
    select t.*, 'local_transfer' as transfer_type, p.full_name as user_name, p.email as user_email,
      vc.status as code_status, vc.code_prefix as code_prefix, vc.expires_at as code_expires_at,
      vc.attempts as code_attempts, vc.max_attempts as code_max_attempts, vc.id as code_id
    from public.local_transfers t
    join public.profiles p on p.id = t.user_id
    left join lateral (
      select v.* from public.transfer_verification_codes v
      where v.transfer_type = 'local_transfer' and v.transfer_id = t.id
      order by v.created_at desc limit 1
    ) vc on true
    where t.status = 'awaiting_admin_verification'
    order by t.created_at desc
  ) u;

  return jsonb_build_object(
    'international', v_intl,
    'crypto', v_crypto,
    'local', v_local,
    'total', jsonb_array_length(v_intl) + jsonb_array_length(v_crypto) + jsonb_array_length(v_local)
  );
end;
$$;

grant execute on function public.admin_list_transfer_verifications(text) to anon, authenticated;

-- 2. admin_transfer_verification_history — add local_transfer support
create or replace function public.admin_transfer_verification_history(
  p_token text,
  p_transfer_type text,
  p_transfer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_transfer jsonb;
  v_codes jsonb;
  v_logs jsonb;
begin
  if not public.admin_can(p_token, 'verifications.view') then
    raise exception 'FORBIDDEN';
  end if;

  if p_transfer_type = 'international_transfer' then
    select to_jsonb(t) into v_transfer from public.international_transfers t where id = p_transfer_id;
  elsif p_transfer_type = 'crypto_withdrawal' then
    select to_jsonb(t) into v_transfer from public.crypto_withdrawals t where id = p_transfer_id;
  elsif p_transfer_type = 'local_transfer' then
    select to_jsonb(t) into v_transfer from public.local_transfers t where id = p_transfer_id;
  else
    raise exception 'INVALID_TYPE';
  end if;
  if v_transfer is null then
    raise exception 'TRANSFER_NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', v.id, 'status', v.status, 'code_prefix', v.code_prefix, 'created_at', v.created_at,
    'used_at', v.used_at, 'expires_at', v.expires_at, 'attempts', v.attempts, 'max_attempts', v.max_attempts,
    'created_by', (select au.email from public.admin_users au where au.id = v.created_by)
  ) order by v.created_at), '[]') into v_codes
  from public.transfer_verification_codes v
  where v.transfer_type = p_transfer_type and v.transfer_id = p_transfer_id;

  select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at), '[]') into v_logs
  from public.transfer_verification_logs l
  where l.transfer_type = p_transfer_type and l.transfer_id = p_transfer_id;

  return jsonb_build_object('transfer', v_transfer, 'codes', v_codes, 'logs', v_logs);
end;
$$;

grant execute on function public.admin_transfer_verification_history(text, text, uuid) to anon, authenticated;

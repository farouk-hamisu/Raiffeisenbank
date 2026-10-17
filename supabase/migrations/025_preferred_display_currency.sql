-- Migration 025: per-user preferred display currency (admin-managed)
--
-- Adds profiles.preferred_currency and an admin RPC to set or clear it.
-- When set, the customer UI renders ALL monetary values for that user in
-- this currency, converted at live exchange_rates prices. Underlying
-- transaction/ledger amounts are never modified — conversion is display-only.
--
-- Supported display currencies (validated here, matches js/fx.js):
--   USD, HUF, EUR, GBP, NGN, CAD

alter table public.profiles
  add column if not exists preferred_currency text;

comment on column public.profiles.preferred_currency is
  'ISO display currency override for this user (null = follow UI language: EN->USD, HU->HUF)';

create or replace function public.admin_set_user_currency(
  p_token text,
  p_user_id uuid,
  p_currency text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_old     jsonb;
  v_profile public.profiles%rowtype;
  v_code    text;
begin
  if not public.admin_can(p_token, 'users.manage') then
    raise exception 'FORBIDDEN';
  end if;

  select to_jsonb(p) into v_old from public.profiles p where id = p_user_id;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  v_code := nullif(trim(coalesce(p_currency, '')), '');
  if v_code is not null then
    v_code := upper(v_code);
    if v_code not in ('USD', 'HUF', 'EUR', 'GBP', 'NGN', 'CAD') then
      raise exception 'CURRENCY_NOT_SUPPORTED';
    end if;
  end if;

  update public.profiles
     set preferred_currency = v_code,
         updated_at = now()
   where id = p_user_id
   returning * into v_profile;

  perform public.log_audit(
    p_token, 'SET_CURRENCY', 'profile', p_user_id::text,
    jsonb_build_object('preferred_currency', v_old -> 'preferred_currency'),
    jsonb_build_object('preferred_currency', v_profile.preferred_currency)
  );

  return jsonb_build_object('profile', to_jsonb(v_profile));
end;
$$;

grant execute on function public.admin_set_user_currency(text, uuid, text) to anon, authenticated;

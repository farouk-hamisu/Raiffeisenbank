-- Migration 028: rebrand account e-mail addresses
--
-- Follow-on to 027 (which deliberately left e-mails alone). The institution's
-- e-mail domain is part of the brand, so every address moves from
-- @raiffeisenbank.com to @marvinbank.com — including the live demo/admin
-- accounts, otherwise sign-in would keep pointing at the old domain.
--
-- Touched, in dependency order:
--   auth.users.email        — Supabase Auth identities (password sign-in)
--   auth.identities.*       — e-mail provider identity (provider_id = address)
--   public.profiles.email   — customer profile shown in the app / admin users
--   public.admin_users.email— admin_login() matches lower(email)
--   any other text column in public that stores the old domain (audit trails,
--   notifications …) via the same generic sweep used by 027.
--
-- Passwords, hashes and session tokens are NOT touched — only the address
-- string — so existing credentials keep working unchanged.
--
-- ROLLBACK: re-run with 'marvinbank.com' -> 'raiffeisenbank.com'.
--
-- NOTE: run 027 first; this migration assumes the institution name is already
-- Marvin Bank. Both are idempotent.

-- ---------------------------------------------------------------------------
-- 1. auth schema (Supabase owns these tables; address + provider identity)
-- ---------------------------------------------------------------------------
do $$
declare
  n bigint;
begin
  update auth.users
     set email = replace(lower(email), '@raiffeisenbank.com', '@marvinbank.com')
   where lower(email) like '%@raiffeisenbank.com';
  get diagnostics n = row_count;
  raise notice 'rebrand: auth.users.email (+% rows)', n;

  -- Email/password provider stores the address as provider_id (and in "email").
  if exists (select 1 from information_schema.tables
              where table_schema = 'auth' and table_name = 'identities') then
    update auth.identities
       set provider_id = replace(lower(provider_id), '@raiffeisenbank.com', '@marvinbank.com')
     where provider = 'email'
       and lower(provider_id) like '%@raiffeisenbank.com';
    get diagnostics n = row_count;
    raise notice 'rebrand: auth.identities.provider_id (+% rows)', n;
  end if;

  if exists (select 1 from information_schema.columns
              where table_schema = 'auth' and table_name = 'identities' and column_name = 'email') then
    update auth.identities
       set email = replace(lower(email), '@raiffeisenbank.com', '@marvinbank.com')
     where lower(email) like '%@raiffeisenbank.com';
    get diagnostics n = row_count;
    raise notice 'rebrand: auth.identities.email (+% rows)', n;
  end if;

  -- auth schema uses identity e-mail data in a jsonb blob on some versions
  if exists (select 1 from information_schema.columns
              where table_schema = 'auth' and table_name = 'users' and column_name = 'raw_user_meta_data') then
    update auth.users
       set raw_user_meta_data = replace(raw_user_meta_data::text,
             '@raiffeisenbank.com', '@marvinbank.com')::jsonb
     where raw_user_meta_data::text like '%@raiffeisenbank.com%';
    get diagnostics n = row_count;
    raise notice 'rebrand: auth.users.raw_user_meta_data (+% rows)', n;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. public schema — every text/jsonb column holding the old domain
-- ---------------------------------------------------------------------------
do $$
declare
  c    record;
  n    bigint;
  sql  text;
begin
  for c in
    select table_name, column_name, data_type
      from information_schema.columns
     where table_schema = 'public'
       and data_type in ('text', 'jsonb')
     order by table_name, column_name
  loop
    if c.data_type = 'jsonb' then
      sql := format(
        'update public.%I set %I = replace(%I::text, $a$raiffeisenbank.com$a$, $a$marvinbank.com$a$)::jsonb
          where %I::text like $a$%s$a$',
        c.table_name, c.column_name, c.column_name, c.column_name, '%raiffeisenbank.com%');
    else
      sql := format(
        'update public.%I set %I = replace(%I, $a$raiffeisenbank.com$a$, $a$marvinbank.com$a$)
          where %I like $a$%s$a$',
        c.table_name, c.column_name, c.column_name, c.column_name, '%raiffeisenbank.com%');
    end if;
    execute sql;
    get diagnostics n = row_count;
    if n > 0 then
      raise notice 'rebrand: %.% (+% rows)', c.table_name, c.column_name, n;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Verify: no address on the old domain is left anywhere
-- ---------------------------------------------------------------------------
do $$
declare
  c    record;
  hits bigint;
begin
  if exists (
       select 1 from auth.users where lower(email) like '%@raiffeisenbank.com%'
     ) then
    raise exception 'REBRAND_INCOMPLETE: auth.users still has old-domain addresses';
  end if;

  for c in
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'public' and data_type in ('text', 'jsonb')
     order by table_name, column_name
  loop
    execute format(
      'select count(*) from public.%I where %I::text like $a$%s$a$',
      c.table_name, c.column_name, '%raiffeisenbank.com%') into hits;
    if hits > 0 then
      raise exception 'REBRAND_INCOMPLETE: public.%.% still has % row(s) on the old domain',
                      c.table_name, c.column_name, hits;
    end if;
  end loop;

  raise notice 'rebrand: e-mail verification passed';
end;
$$;

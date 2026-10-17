-- Migration 027: platform rebrand Raiffeisen Bank -> Marvin Bank
--
-- The application source was renamed in place; the live database still holds
-- the previous institution name in three places:
--
--   1. system_settings ('bank_name') — read by the admin settings screen and
--      by transfer/beneficiary flows.
--   2. Compiled function bodies (plpgsql) that hard-code the bank as a
--      counterparty: welcome notifications, loan disbursements/repayments,
--      admin credit/debit recording. Editing migration files does NOT change
--      already-applied definitions, so they are re-derived from pg_get_functiondef.
--   3. Stored columns customers still see: transactions.sender/recipient,
--      notifications, beneficiary/bank names, audit payloads.
--
-- DISPLAY-ONLY + IDENTITY ONLY: no amount, rate, fee, status, reference,
-- account number, date or balance is touched. Replacement is case sensitive,
-- so lowercase account e-mails such as demo@marvinbank.com are left alone —
-- those are live authentication identities, not branding.
--
-- ROLLBACK: re-run the same statements with 'Marvin Bank' -> 'Raiffeisen Bank'
-- and 'Marvin' -> 'Raiffeisen'.

-- ---------------------------------------------------------------------------
-- 1. Re-derive every public function that still embeds the old institution name
-- ---------------------------------------------------------------------------
do $$
declare
  r  record;
  d  text;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosrc like '%Raiffeisen%'
     order by 1
  loop
    d := pg_get_functiondef(r.sig);
    d := replace(d, 'Raiffeisen Bank', 'Marvin Bank');
    d := replace(d, 'Raiffeisen', 'Marvin');
    execute d;
    raise notice 'rebrand: redefined %', r.sig;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Stored display text: every text/jsonb column in the public schema,
--    only rows that actually mention the old name.
--    jsonb goes through ::text so keys/strings inside payloads are rewritten
--    too; scalar jsonb (numbers/booleans) never matches the LIKE predicate.
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
        'update public.%I set %I = replace(%I::text, $a$Raiffeisen Bank$a$, $a$Marvin Bank$a$)::jsonb
          where %I::text like $a$%s$a$',
        c.table_name, c.column_name, c.column_name, c.column_name, '%Raiffeisen Bank%');
      execute sql;
      get diagnostics n = row_count;
      if n > 0 then raise notice 'rebrand: %.% (+% rows)', c.table_name, c.column_name, n; end if;

      sql := format(
        'update public.%I set %I = replace(%I::text, $a$Raiffeisen$a$, $a$Marvin$a$)::jsonb
          where %I::text like $a$%s$a$',
        c.table_name, c.column_name, c.column_name, c.column_name, '%Raiffeisen%');
      execute sql;
      get diagnostics n = row_count;
      if n > 0 then raise notice 'rebrand: %.% (+% rows)', c.table_name, c.column_name, n; end if;
    else
      sql := format(
        'update public.%I set %I = replace(%I, $a$Raiffeisen Bank$a$, $a$Marvin Bank$a$)
          where %I like $a$%s$a$',
        c.table_name, c.column_name, c.column_name, c.column_name, '%Raiffeisen Bank%');
      execute sql;
      get diagnostics n = row_count;
      if n > 0 then raise notice 'rebrand: %.% (+% rows)', c.table_name, c.column_name, n; end if;

      sql := format(
        'update public.%I set %I = replace(%I, $a$Raiffeisen$a$, $a$Marvin$a$)
          where %I like $a$%s$a$',
        c.table_name, c.column_name, c.column_name, c.column_name, '%Raiffeisen%');
      execute sql;
      get diagnostics n = row_count;
      if n > 0 then raise notice 'rebrand: %.% (+% rows)', c.table_name, c.column_name, n; end if;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Verify: nothing in the public schema should mention the old name any more
-- ---------------------------------------------------------------------------
do $$
declare
  c    record;
  hits bigint;
begin
  if exists (
       select 1 from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosrc like '%Raiffeisen%'
     ) then
    raise exception 'REBRAND_INCOMPLETE: function bodies still reference the old name';
  end if;

  for c in
    select table_name, column_name, data_type
      from information_schema.columns
     where table_schema = 'public'
       and data_type in ('text', 'jsonb')
     order by table_name, column_name
  loop
    execute format(
      'select count(*) from public.%I where %I::text like $a$%s$a$',
      c.table_name, c.column_name, '%Raiffeisen%') into hits;
    if hits > 0 then
      raise exception 'REBRAND_INCOMPLETE: public.%.% still has % row(s) with the old name',
                      c.table_name, c.column_name, hits;
    end if;
  end loop;

  raise notice 'rebrand: verification passed';
end;
$$;

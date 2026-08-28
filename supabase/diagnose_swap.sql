-- Diagnostic: Find all overloaded versions of create_currency_swap
-- Run this FIRST in Supabase SQL Editor to see what's actually in the DB
SELECT
  p.oid,
  pg_get_function_identity_arguments(p.oid) AS signature,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE p.proname = 'create_currency_swap'
  AND n.nspname = 'public';

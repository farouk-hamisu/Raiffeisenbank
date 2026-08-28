-- DIAGNOSTIC: Run this FIRST to see what's actually in your database

-- 1. Check what overloads of admin_list_transfer_verifications exist
SELECT pg_get_function_identity_arguments(p.oid) AS signature
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE p.proname = 'admin_list_transfer_verifications'
  AND n.nspname = 'public';

-- 2. Check if any local transfers are awaiting verification
SELECT id, reference, status, recipient_name, amount, currency, created_at
FROM public.local_transfers
WHERE status = 'awaiting_admin_verification'
ORDER BY created_at DESC
LIMIT 20;

-- 3. Check all local_transfer statuses
SELECT status, count(*) AS cnt
FROM public.local_transfers
GROUP BY status;

-- 4. Check if the verification code table supports local_transfer
SELECT DISTINCT transfer_type
FROM public.transfer_verification_codes;

-- 5. Check local_transfers check constraint
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.local_transfers'::regclass
  AND conname LIKE '%status%';

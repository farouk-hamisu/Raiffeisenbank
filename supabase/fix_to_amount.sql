-- Fix: widen all monetary columns to hold BTC precision (8 decimals)
-- Run this in Supabase SQL Editor

-- currency_swaps
ALTER TABLE public.currency_swaps ALTER COLUMN to_amount TYPE numeric(20, 8);

-- account_balances
ALTER TABLE public.account_balances ALTER COLUMN available_balance TYPE numeric(20, 8);
ALTER TABLE public.account_balances ALTER COLUMN ledger_balance TYPE numeric(20, 8);

-- transactions
ALTER TABLE public.transactions ALTER COLUMN amount TYPE numeric(20, 8);
ALTER TABLE public.transactions ALTER COLUMN fee TYPE numeric(20, 8);

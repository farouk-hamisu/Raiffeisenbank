-- Migration 029: customer transaction history with balance-after
--
-- Adds an RPC that serves the customer's transaction ledger in the layout a
-- bank statement uses: date, description, credit/debit, reference, amount,
-- status and — crucially — the account balance immediately AFTER each entry.
--
-- Balance-after is not stored. It is derived from the ledger itself:
--
--   opening_balance(account) = current ledger_balance - sum(all settled deltas)
--   balance_after(tx)       = opening_balance + running_sum(deltas up to tx)
--
-- so the newest row always equals the live ledger balance, and every older
-- row is the balance that was in force right after that entry was booked.
--
-- DELTA RULE — mirrors the apply_balance_change() calls in 004/006/011/023:
--   credit              ->  +amount
--   debit               ->  -(amount + fee)
--   reversal            ->  the negated delta of the original it points at
--                           (a reversal is booked with the SAME direction and
--                            amount as the original, so the naive rule would
--                            double-count; related_id gives us the truth)
--   pending/processing/
--   failed/cancelled    ->  0  (never touched the balance)
--   completed/reversed  ->  counted (a reversed pair nets to zero, correctly)
--
-- SECURITY: security invoker + the existing transactions_select_own RLS
-- policy, so a caller can only ever read their own ledger. The explicit
-- user_id = auth.uid() predicate is defence in depth.
--
-- Known limitation (pre-existing, not introduced here):
-- admin_update_transaction_status() changes a status WITHOUT moving money, so
-- an admin manually flipping a pending row to 'completed' leaves the ledger
-- and the row's implied delta out of step. Balance-after stays internally
-- consistent (it always reconciles to the live ledger) but that one row will
-- not reflect a manual status flip.

create or replace function public.customer_transaction_history(
  p_search  text        default '',
  p_type    text        default null,
  p_status  text        default null,
  p_from    timestamptz default null,
  p_to      timestamptz default null,
  p_sort    text        default 'created_at',
  p_dir     text        default 'desc',
  p_limit   int         default 10,
  p_offset  int         default 0
)
returns jsonb
language sql
stable
set search_path = public
as $$
with base as (
  select t.id, t.reference, t.type, t.direction, t.amount, t.currency, t.fee,
         t.status, t.description, t.sender, t.recipient, t.related_id,
         t.user_id, t.account_id, t.created_at,
         a.currency as account_currency
    from public.transactions t
    left join public.accounts a on a.id = t.account_id
   where t.user_id = auth.uid()
),
deltas as (
  select b.*,
         case
           when b.status not in ('completed', 'reversed') then 0
           when b.type = 'reversal' and o.id is not null then
             - case when o.direction = 'credit' then o.amount
                    else -(o.amount + coalesce(o.fee, 0)) end
           when b.direction = 'credit' then b.amount
           else -(b.amount + coalesce(b.fee, 0))
         end as delta
    from base b
    left join public.transactions o
           on o.id = b.related_id and b.type = 'reversal' and o.user_id = b.user_id
),
running as (
  select d.*,
         sum(d.delta) over (
           partition by d.account_id
           order by d.created_at, d.id
           rows between unbounded preceding and current row
         ) as run
    from deltas d
),
totals as (
  select account_id, coalesce(sum(delta), 0) as total
    from running
   where account_id is not null
   group by account_id
),
withbal as (
  select r.*,
         case
           when r.account_id is null or t.total is null then null
           else coalesce(ab.ledger_balance, 0) - t.total + r.run
         end as balance_after
    from running r
    left join totals t      on t.account_id = r.account_id
    left join public.account_balances ab on ab.account_id = r.account_id
),
filtered as (
  select * from withbal w
   where (p_search = ''
          or w.reference   ilike '%' || p_search || '%'
          or w.description ilike '%' || p_search || '%'
          or w.sender      ilike '%' || p_search || '%'
          or w.recipient   ilike '%' || p_search || '%')
     and (p_type   is null or w.type   = p_type)
     and (p_status is null or w.status = p_status)
     and (p_from   is null or w.created_at >= p_from)
     and (p_to     is null or w.created_at <= p_to)
),
sorted as (
  select f.*,
         case p_sort
           when 'reference'   then f.reference
           when 'description' then f.description
           when 'type'        then f.type
           when 'status'      then f.status
           when 'currency'    then f.currency
           else null
         end as text_key,
         case p_sort
           when 'amount'        then f.amount
           when 'balance_after' then f.balance_after
           else null
         end as num_key
    from filtered f
)
select jsonb_build_object(
  'rows', coalesce((
    select jsonb_agg(to_jsonb(s))
      from (
        select id, reference, type, direction, amount, currency, fee, status,
               description, sender, recipient, related_id, account_id,
               account_currency, balance_after, created_at
          from sorted
         order by
           case when p_dir = 'asc'  then text_key end asc  nulls last,
           case when p_dir = 'desc' then text_key end desc nulls last,
           case when p_dir = 'asc'  then num_key   end asc  nulls last,
           case when p_dir = 'desc' then num_key   end desc nulls last,
           case when p_dir = 'asc'  and p_sort = 'created_at' then created_at end asc  nulls last,
           case when p_dir = 'desc' and p_sort = 'created_at' then created_at end desc nulls last,
           created_at desc, id desc
         limit greatest(coalesce(p_limit, 10), 0)
        offset greatest(coalesce(p_offset, 0), 0)
      ) s
  ), '[]'::jsonb),
  'total', (select count(*) from filtered)
);
$$;

revoke execute on function public.customer_transaction_history(text, text, text, timestamptz, timestamptz, text, text, int, int)
  from public, anon;
grant  execute on function public.customer_transaction_history(text, text, text, timestamptz, timestamptz, text, text, int, int)
  to authenticated;

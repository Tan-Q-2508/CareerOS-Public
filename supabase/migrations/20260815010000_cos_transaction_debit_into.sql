-- Single COS transaction per scan, updated live (out-of-band UX batch,
-- 2026-08-15). Root cause of "46 jobs scored, only 4 transaction rows, and
-- the balance didn't seem to move": aiFeeCosDelta's once-per-scan BYOK floor
-- (apps/server/src/lib/aiRouter.js) means most jobs legitimately produce a
-- $0 marginal debit, and jobScorer.js correctly skips writing a row for a
-- $0 delta — that part was working as designed. But every non-zero debit
-- was still its OWN row (jobScorer.js) even when the scan already had a flat-
-- fee row from runScan.js, so a scan with several billable increments showed
-- as several separate ledger lines instead of one.
--
-- debit_cos_into lets a caller who already holds a cos_transactions row id
-- (the flat-fee row runScan.js creates at scan start) accumulate further
-- ai_cost/sourcing_cost into THAT SAME row, atomically with the matching
-- users.cos_balance decrement — same atomicity guarantee as debit_cos, just
-- an UPDATE into an existing row instead of an INSERT of a new one. This
-- preserves the deliberate crash-safe progressive billing debit_cos already
-- provided (a scan killed mid-run still bills for the jobs it actually
-- scored) while collapsing the ledger display to one row per scan.
--
-- total_cost is a GENERATED column (flat_fee + sourcing_cost + ai_cost) and
-- recomputes on its own — never set directly.

create or replace function public.debit_cos_into(
  p_transaction_id uuid,
  p_user_id uuid,
  p_ai_cost numeric default null,
  p_sourcing_cost numeric default null,
  p_note text default null
)
returns public.cos_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cos_transactions;
  v_delta numeric;
begin
  v_delta := coalesce(p_ai_cost, 0) + coalesce(p_sourcing_cost, 0);

  update public.users
    set cos_balance = cos_balance - v_delta
    where id = p_user_id;

  if not found then
    raise exception 'user % not found', p_user_id;
  end if;

  update public.cos_transactions
    set ai_cost = coalesce(ai_cost, 0) + coalesce(p_ai_cost, 0),
        sourcing_cost = coalesce(sourcing_cost, 0) + coalesce(p_sourcing_cost, 0),
        note = coalesce(p_note, note)
    where id = p_transaction_id and user_id = p_user_id
    returning * into v_row;

  if not found then
    raise exception 'cos_transactions row % not found for user %', p_transaction_id, p_user_id;
  end if;

  return v_row;
end;
$$;

notify pgrst, 'reload schema';

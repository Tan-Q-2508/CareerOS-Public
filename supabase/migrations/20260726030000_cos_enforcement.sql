-- COS enforcement, Stripe-free (spec 0.1/13/15#13, Phase 2 session 13).
-- Mirrors grant_cos: debit_cos atomically decrements users.cos_balance and
-- writes the real, billed:true cos_transactions row in one transaction, so a
-- billable action's ledger entry and its balance effect can never drift apart
-- (a crash between "decrement balance" and "write the row" is impossible —
-- it's one function). Allowed to leave cos_balance negative: the flat fee is
-- checked BEFORE an action starts (application-level pre-check against
-- tunables.enforceCosBalance), but the AI-cost component is only known after
-- the real call completes, so a cheap-flat-fee action with an expensive
-- measured AI cost can still push the balance below zero — the NEXT action is
-- what gets blocked, matching 13.6's "once exhausted, further actions require
-- a positive balance" framing (postpaid-per-action, not a hard mid-action cap).

create or replace function public.debit_cos(
  p_user_id uuid,
  p_action_type text,
  p_flat_fee numeric,
  p_sourcing_cost numeric default null,
  p_ai_cost numeric default null,
  p_note text default null,
  p_related_scan_id uuid default null,
  p_related_job_id uuid default null
)
returns public.cos_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cos_transactions;
  v_total numeric;
begin
  v_total := coalesce(p_flat_fee, 0) + coalesce(p_sourcing_cost, 0) + coalesce(p_ai_cost, 0);

  update public.users
    set cos_balance = cos_balance - v_total
    where id = p_user_id;

  if not found then
    raise exception 'user % not found', p_user_id;
  end if;

  insert into public.cos_transactions
    (user_id, action_type, flat_fee, sourcing_cost, ai_cost, note, billed, related_scan_id, related_job_id)
  values
    (p_user_id, p_action_type, coalesce(p_flat_fee, 0), p_sourcing_cost, p_ai_cost, p_note, true, p_related_scan_id, p_related_job_id)
  returning * into v_row;

  return v_row;
end;
$$;

notify pgrst, 'reload schema';

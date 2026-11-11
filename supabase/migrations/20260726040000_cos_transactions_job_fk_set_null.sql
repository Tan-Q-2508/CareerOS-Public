-- Fix: cos_transactions.related_job_id had no ON DELETE behavior (plain FK to
-- jobs), unlike ai_usage_log.related_job_id which already has ON DELETE SET
-- NULL for the exact same reason — a below-threshold job's row is deleted
-- right after it's scored (A2), and runScan now attributes each job's AI-fee
-- debit to that job via related_job_id (2026-07-26, incremental per-job COS
-- billing). Without this, deleting a below-threshold job whose scoring debit
-- referenced it would fail with a foreign-key violation and silently break
-- runScan.js's per-job loop for every scored-but-discarded job.

begin;

do $$
declare
  v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.cos_transactions'::regclass
    and confrelid = 'public.jobs'::regclass
    and contype = 'f';

  if v_conname is not null then
    execute format('alter table public.cos_transactions drop constraint %I', v_conname);
  end if;

  alter table public.cos_transactions
    add constraint cos_transactions_related_job_id_fkey
    foreign key (related_job_id) references public.jobs(id) on delete set null;
end $$;

commit;

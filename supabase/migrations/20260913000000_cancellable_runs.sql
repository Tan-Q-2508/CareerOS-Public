-- Cancellable long-running work (spec §7.12/§12.4).
--
-- `scan_history.status` has allowed 'cancelled' since the initial schema;
-- `generated_documents.status` never did, so a résumé or cover letter had only
-- 'failed' to fall back on. That conflates two genuinely different outcomes:
-- something went wrong, versus the user changed their mind (or a deploy killed
-- the process). Users read "failed" as "the product is broken", and a reaper
-- that marks an orphaned run 'failed' makes the distinction unrecoverable
-- afterwards.
--
-- Drop-then-add rather than ALTER, following 20260811020000_application_qa.sql's
-- pattern for widening a CHECK on a live table. Purely additive: every existing
-- row already holds one of the four original values.

alter table public.generated_documents
  drop constraint if exists generated_documents_status_check;

alter table public.generated_documents
  add constraint generated_documents_status_check
  check (status in ('queued', 'running', 'completed', 'failed', 'cancelled'));

-- The reaper (staleScanTimer's reapStaleGenerations) finds orphaned runs by
-- age, so it reads `updated_at` on rows that are still 'queued'/'running'.
-- Without this it is a sequential scan of the whole table on every 10-minute
-- tick; the partial predicate keeps the index to just the in-flight rows,
-- which is almost always zero of them.
create index if not exists generated_documents_inflight_idx
  on public.generated_documents (updated_at)
  where status in ('queued', 'running');

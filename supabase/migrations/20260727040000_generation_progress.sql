-- CareerOS — progress steps for long-running async pipelines (résumé/cover
-- letter generation, scans, manual-entry scoring). Frontend UI request:
-- replace the bare spinner + one static word with a real, code-style progress
-- console. Purely additive — an append-only jsonb log column each pipeline
-- writes a few `{step, label, at}` entries to between EXISTING stages. Does
-- not change what any pipeline does, in what order, or with what AI calls;
-- see apps/server/src/lib/progress.js for the shared writer.
--
-- Also widens jobs.status to include 'failed' — scoreManualJob.js today only
-- records a failure via a `note` prefix ("Scoring failed: ...") because the
-- status CHECK had no failure value, leaving the row stuck at 'prefiltered'
-- forever; the frontend poll has been working around this by string-sniffing
-- `note`. A real 'failed' status lets the new progress console end cleanly
-- without that sniffing, and mirrors generated_documents/scan_history, which
-- already have a 'failed' status.

begin;

alter table public.generated_documents add column progress jsonb not null default '[]'::jsonb;
alter table public.scan_history add column progress jsonb not null default '[]'::jsonb;
alter table public.jobs add column progress jsonb not null default '[]'::jsonb;

alter table public.jobs drop constraint jobs_status_check;
alter table public.jobs add constraint jobs_status_check
  check (status in ('prefiltered', 'scored', 'archived', 'failed'));

commit;

notify pgrst, 'reload schema';

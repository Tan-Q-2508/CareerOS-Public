-- On-demand scoring (spec 4.7, §15 #64).
--
-- A scan can now source and pre-filter WITHOUT AI-scoring its survivors
-- (scan_history.config.score_mode = 'on_demand'); the user then picks which
-- jobs to score. Two new jobs.status values carry that:
--   'sourced'  a pre-filter survivor left unscored on purpose. Deliberately NOT
--              'prefiltered' — sweepOrphanedPrefilteredJobs turns a scan's
--              leftover 'prefiltered' rows into 'failed' once it completes,
--              which is right for a scoring failure and wrong for a choice.
--   'scoring'  claimed by POST /api/jobs/score, in flight. A crash leaves it
--              here; reapStaleOnDemandScoring puts it back to 'sourced'.
-- jobs.triage holds the deterministic Quick read computed at insert (no AI).
-- scan_schedules.score_mode lets a schedule run in either mode.

begin;

alter table public.jobs drop constraint jobs_status_check;
alter table public.jobs add constraint jobs_status_check
  check (status in ('prefiltered', 'scored', 'archived', 'failed', 'sourced', 'scoring'));

alter table public.jobs add column if not exists triage jsonb;

alter table public.scan_schedules add column if not exists score_mode text not null default 'auto';
alter table public.scan_schedules drop constraint if exists scan_schedules_score_mode_check;
alter table public.scan_schedules add constraint scan_schedules_score_mode_check
  check (score_mode in ('auto', 'on_demand'));

-- The stuck-claim reaper selects on (status, updated_at).
create index if not exists jobs_scoring_updated_at_idx on public.jobs (updated_at) where status = 'scoring';

commit;

notify pgrst, 'reload schema';

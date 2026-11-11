-- Multi-title scans (4.6.15), ATS Direct only. `scan_history.config` is a
-- jsonb blob with no title column, so no migration is needed there —
-- `config.job_titles: string[]` is introduced purely in application code,
-- with `config.job_title` still written as the first title so every
-- pre-existing reader keeps working on old AND new rows unchanged (see
-- packages/shared/src/scanTitles.js).
--
-- `scan_schedules.job_title` is a real column, so it needs an actual
-- migration: add `job_titles text[]`, backfill every existing row from its
-- current `job_title`, and keep `job_title` populated with the first title
-- going forward (same "canonical array, scalar kept in sync" shape as the
-- jsonb side) rather than dropping the column — every existing reader
-- (scheduler.js's select lists, the orphan-reap notification) keeps working
-- untouched.

alter table public.scan_schedules add column job_titles text[];

update public.scan_schedules
set job_titles = array[job_title]
where job_title is not null and job_titles is null;

comment on column public.scan_schedules.job_titles is
  'Canonical multi-title list (4.6.15, ATS Direct only). job_title is kept in sync as job_titles[1] by the application for legacy readers.';

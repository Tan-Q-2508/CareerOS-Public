-- Live scan telemetry counters (fixes the §26 progress regression — see
-- CareerOS_Changelog.md §4.6.12). ATS Direct's concurrent sourcing/scoring
-- pipeline stopped surfacing any live progress mid-run; these columns let
-- scanCounters.js (apps/server/src/scan/scanCounters.js) write incrementally
-- from both the ATS Direct pipeline and the CS/BYO path, instead of the
-- existing jobs_found_count / jobs_survived_prefilter_count only landing once
-- at the very end.
--
-- Nullable, no backfill: null on a pre-existing scan row reads as "this scan
-- predates the counters," and the dashboard renders that as "—", same
-- convention already used by jobs_found_count et al.
alter table public.scan_history
  add column if not exists jobs_above_threshold_count int,
  add column if not exists companies_queried_count int,
  add column if not exists companies_total_count int;

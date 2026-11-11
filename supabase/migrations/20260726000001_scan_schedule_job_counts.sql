-- Fix: scheduled scans ignored the job-count/posted-within-days settings the
-- user picked in New Scan's Advanced section — scan_schedules had nowhere to
-- store them, so runDueScans.js's configFromSchedule always fell back to the
-- global tunables defaults (cs 50 / ld 100 / 3 days) instead of what was
-- actually configured at "Repeat this scan" time (2026-07-26).

begin;

alter table public.scan_schedules
  add column if not exists cs_job_count int,
  add column if not exists ld_job_count int,
  add column if not exists posted_within_days int;

commit;

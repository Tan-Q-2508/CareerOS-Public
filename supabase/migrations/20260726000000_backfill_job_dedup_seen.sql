-- Backfill job_dedup_seen from existing jobs (2026-07-26).
--
-- The 2026-07-25 bugs-batch migration added job_dedup_seen and switched
-- runScan's "already seen" pre-filter check to read from it instead of
-- jobs.dedup_key — but never backfilled it from jobs that already existed.
-- Effect: every job scored/kept before this migration was invisible to the
-- new dedup check, so the pre-filter let them "survive" as if brand new; the
-- actual insert into `jobs` then silently no-op'd on the (user_id, dedup_key)
-- conflict (ignoreDuplicates:true), so most "survivors" of a scan never
-- actually got a row to score under the new scan_history_id. Confirmed live:
-- 151 real jobs existed, only 61 dedup keys were in job_dedup_seen.

begin;

insert into public.job_dedup_seen (user_id, dedup_key)
select user_id, dedup_key from public.jobs
on conflict (user_id, dedup_key) do nothing;

commit;

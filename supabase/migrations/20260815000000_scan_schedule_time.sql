-- Time-of-day for scheduled scans (out-of-band UX batch, 2026-08-15).
-- scan_schedules previously had no way to pick WHEN a recurring scan runs —
-- computeNextRunAt (apps/server/src/scan/scheduler.js) only advanced by
-- frequency (daily/weekdays/weekly) from whatever instant the schedule was
-- created or last claimed at, so "9am" vs "11pm" was accidental, not chosen.
--
-- run_at_time + timezone let the user pick a wall-clock time in their own
-- zone; computeNextRunAt pins the frequency-advanced date to that wall clock
-- and converts back to a UTC instant. The every-30-minute scheduler cron
-- (.github/workflows/scheduler.yml) is unchanged — a chosen time lands
-- within its own claim window, since claimDueSchedules only fires already-
-- due rows.
--
-- Backfill sets both columns from each row's current next_run_at (which was
-- always stored in UTC) so existing schedules keep running at the same
-- effective time as before this migration, rather than silently jumping to
-- the 09:00 UTC default.

alter table public.scan_schedules
  add column run_at_time time not null default '09:00',
  add column timezone text not null default 'UTC';

update public.scan_schedules
  set run_at_time = (next_run_at at time zone 'UTC')::time,
      timezone = 'UTC'
  where next_run_at is not null;

notify pgrst, 'reload schema';

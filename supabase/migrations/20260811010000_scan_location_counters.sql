-- Location-filter telemetry (new §4.6.16). Lets scanCounters.js surface how
-- many postings a scan's location filter actually excluded/left unsure, so a
-- scan that finds nothing gives a real reason instead of the generic "found
-- no postings" empty-state (DashboardView.jsx). Same nullable/no-backfill
-- convention as 20260810030000_scan_counters.sql — null on a pre-existing
-- scan row reads as "this scan predates the counters."
alter table public.scan_history
  add column if not exists jobs_location_filtered_count int,
  add column if not exists jobs_location_unsure_count int;

-- CareerOS — scan_history heartbeat column (spec §4.6.12/§16.9; Phase 4, §15 #26).
--
-- reapStaleScans (apps/server/src/scan/scheduler.js) used to reap any
-- status='running' row whose started_at was more than STALE_RUNNING_MINUTES
-- (30) in the past. That was a reasonable proxy for "the process crashed"
-- back when a scan's total wall-clock was well under 30 minutes — but ATS
-- Direct's own sourcing budget (tunables.atsDirect.maxRunWallClockMs) is
-- ALSO 30 minutes, and scoring runs after that, so a real, healthy
-- ~43-minute run was being falsely marked failed (with a user-facing
-- "scan_orphaned" notification) while it was still actively scoring, then
-- flipped back to 'completed' moments later by runScan.js's own final
-- mark(). heartbeat_at decouples "still alive" from "started a while ago":
-- the running process touches it periodically (scanHeartbeat.js) for the
-- FULL duration of a scan (both sourcing and scoring), so the reaper can
-- tell a genuinely wedged/crashed scan (heartbeat stopped) from a long but
-- healthy one (heartbeat still ticking) regardless of total run length.
--
-- Backfilled to started_at for existing rows (a NULL heartbeat_at on an old
-- completed/failed row is irrelevant — the reaper only ever looks at
-- status='running' rows) and defaulted to now() so every future insert has
-- a value from the moment the scan starts, before the first heartbeat tick.

begin;

alter table public.scan_history
  add column heartbeat_at timestamptz not null default now();

update public.scan_history
  set heartbeat_at = started_at
  where started_at is not null;

commit;

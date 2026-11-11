-- A board a scan found gone (spec 4.6.3 / 4.6.12).
--
-- When a scan's full-board fetch gets a 404/410 AND a follow-up probe of the
-- same board confirms it, the row is set to status 'board_gone'. Scan
-- selection only ever reads status = 'active' (companies/registry.js
-- resolveScanSelection), so the board stops failing — and stops generating a
-- "couldn't reach" notification — on every scan after, without deleting the
-- row mid-scan (tracklist memberships and scan cursors still point at it).
-- scripts/park-dead-boards.js moves 'board_gone' rows to
-- company_ats_unresolved outside a scan, the same way it handles its own 404s.
--
-- Widening a CHECK on a live table: drop-then-add, following
-- 20260913000000_cancellable_runs.sql. Purely additive.

alter table public.company_ats_registry
  drop constraint if exists company_ats_registry_status_check;

alter table public.company_ats_registry
  add constraint company_ats_registry_status_check
  check (status in ('active', 'pending_adapter', 'board_gone'));

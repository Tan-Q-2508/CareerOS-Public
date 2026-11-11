-- ATS Direct scan-form changes (spec 4.6.6, 12.3; Phase 4, §15 #25c-2 — second
-- half of the 25c split, following 25c-1's auto-track opt-in).
--
-- Closes the two data-model gaps 4.6.6/12.3 flagged pre-Session-25 (2026-08-06):
--
--   1. scan_schedules.tracklist_ids — 12.3's decided option (b): a schedule
--      stores the tracklist/subscription SELECTION itself (personal tracklist
--      ids and/or subscribed system tracklist ids, both live in `tracklists`),
--      re-resolved to a live company set at every run — not a frozen id
--      snapshot. The pre-existing `tracked_company_ids` column (§24) stays as
--      the legacy/narrow-to-specific-companies input, now read ALONGSIDE this
--      one rather than being replaced by it (25c-1's decision 3: tracklists
--      primary, with tracked_company_ids as the optional narrow sub-picker /
--      legacy fallback for pre-25c schedules that only ever set that column).
--
--   2. scan_schedules.ats_job_count — previously hardcoded to the tunable
--      default in runDueScans.js's configFromSchedule (no column existed to
--      carry a per-schedule value). Now meaningful: 4.6.6's target-with-
--      backfill reinterprets this count as a target, not a raw-pull cap, so a
--      schedule's saved target needs to actually persist.
--
-- posted_within_days needs NO column change — it already exists on
-- scan_schedules (20260726000000) and is nullable; ATS Direct's new "any
-- time" default (this session, maintainer decision — existing ATS schedules
-- must not silently start filtering where they previously didn't) is just
-- NULL, same column every other source already writes a real value into.
--
-- ats_scan_cursors — 4.6.6's rotating cursor, resolved per its own "cursor
-- stability bug" note: the cursor is the id of the LAST COMPANY ACTUALLY
-- QUERIED (an immutable, monotonically-assigned company_ats_registry id), not
-- an integer position — a tracklist's membership isn't static (companies are
-- added/removed, sector tracklists reclassify), so a bare integer offset would
-- silently point at a different company after any such change. Scoped to
-- (user_id, selection_key) — the selection, not the user or a single
-- tracklist — so combining tracklists differently starts a fresh rotation
-- rather than reusing an unrelated cursor's position.

begin;

alter table public.scan_schedules add column tracklist_ids uuid[];
alter table public.scan_schedules add column ats_job_count int;

create table public.ats_scan_cursors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  -- sha256 hex of the sorted, deduped (tracklist_ids + registry_ids) that make
  -- up one distinct selection (apps/server/src/companies/scanCursor.js).
  selection_key text not null,
  -- ON DELETE SET NULL, not cascade: a deleted company shouldn't take the
  -- whole cursor row down with it — orderFromCursor() treats a null
  -- last_company_id exactly like "no cursor yet" (fresh random start), which
  -- is the correct fallback, not an error.
  last_company_id uuid references public.company_ats_registry(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (user_id, selection_key)
);

create index ats_scan_cursors_user on public.ats_scan_cursors (user_id);

create trigger set_updated_at before update on public.ats_scan_cursors
  for each row execute function public.set_updated_at();

alter table public.ats_scan_cursors enable row level security;
create policy owns_row on public.ats_scan_cursors
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on public.ats_scan_cursors to anon, authenticated, service_role;

commit;

notify pgrst, 'reload schema';

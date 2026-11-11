-- ATS Direct scan integration + pricing (spec 4.6.6/4.6.7, 12.3; Phase 4, §15 #24).
--
-- §23 (2026-08-05) built the registry/dedup tables and all four detection entry
-- points but deliberately left four prerequisites for this session, flagged in
-- its own handoff: jobs.sources has no 'ats_direct', cos_transactions.action_type
-- has no 'ats_direct_scan', scan_schedules has no tracked_company_ids, and
-- NOTIFICATION_TYPES (enforced in JS only, no DB change needed) has no
-- 'ats_direct_company_failed'. This migration closes the first three.
--
-- Follows the exact drop-then-add CHECK pattern of
-- 20260719000000_byo_scraper_rename.sql (no data migration needed here — this
-- is a widen, not a rename).

begin;

-- jobs.sources: allow the new source value.
alter table public.jobs drop constraint jobs_sources_check;
alter table public.jobs
  add constraint jobs_sources_check check (sources <@ array['cs', 'byo', 'manual', 'ats_direct']::text[]);

-- cos_transactions.action_type: allow the new billed action type (4.6.7 — 1 COS
-- flat, matching cs_scan, no sourcing-cost component ever).
alter table public.cos_transactions drop constraint cos_transactions_action_type_check;
alter table public.cos_transactions
  add constraint cos_transactions_action_type_check check (
    action_type = any (array[
      'cs_scan', 'byo_scan', 'ats_direct_scan', 'resume_generation', 'cover_letter_generation',
      'email_check', 'manual_entry', 'admin_grant', 'copilot_session'
    ]::text[])
  );

-- scan_schedules.tracked_company_ids (12.3): which companies an ATS Direct
-- schedule re-runs against. Holds company_ats_registry ids, NOT
-- user_tracked_companies (join-row) ids — registry ids survive an
-- untrack/retrack cycle, which would otherwise mint a new join-row id and
-- silently empty a saved schedule. NULL/empty means "all currently tracked"
-- (4.6.6's stated default), re-intersected against the user's live tracked set
-- at run time so untracking a company removes it from future runs without
-- breaking the schedule. No FK: a soft reference is deliberate here (see
-- runScan/companies/registry.js for the intersect logic) so a deleted registry
-- row just drops out rather than needing ON DELETE handling on an array column.
-- NULL/ignored for any non-ATS-Direct schedule, mirroring how `location` is
-- simply unused for one today.
alter table public.scan_schedules add column tracked_company_ids uuid[];

commit;

notify pgrst, 'reload schema';

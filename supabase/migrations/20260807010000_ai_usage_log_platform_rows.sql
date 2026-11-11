-- CareerOS — ai_usage_log.user_id made nullable (spec 4.6.9/16.10; Phase 4,
-- §15 #25b).
--
-- §4.6.9's sector-classification pipeline (the one-time bulk pass over the
-- existing registry, and the going-forward detection-time hook) is explicit
-- platform overhead: "not billed to any user ... logged to ai_usage_log ...
-- absorbed as platform overhead like the rest of 4.6's detection pipeline."
-- A platform-overhead call has no user to attribute the row to, but
-- ai_usage_log.user_id (20260717010000) was `not null` — every prior AI call
-- in this codebase has been made on behalf of a specific user.
--
-- Same NULL-falls-out reasoning 20260806000000 (tracklists) already documents
-- for system rows: the table's verbatim owns_row policy (auth.uid() = user_id)
-- evaluates to NULL -> false for a user_id-null row, so a platform usage row
-- is invisible to every authenticated user via RLS and only ever readable by
-- the service-role backend — no second policy needed, nothing to "fix."
--
-- Chosen over seeding a synthetic system `users` row: a fake user would leak
-- into every users-scoped query in the app (join, count, admin listing, ...).
-- Verified safe to widen: every reference to ai_usage_log in the codebase is a
-- WRITE (runScan.js, scoreManualJob.js, runGenerate*.js, runCopilotSeed.js,
-- routes/resume.js, routes/copilot.js, runEmailCheck.js) — there is no read
-- path that assumes user_id is present and would start seeing orphan rows.

begin;

alter table public.ai_usage_log alter column user_id drop not null;

commit;

notify pgrst, 'reload schema';

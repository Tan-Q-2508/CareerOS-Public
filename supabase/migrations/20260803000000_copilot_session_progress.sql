-- CareerOS — progress steps for Copilot Mode's seed pipeline ("Open in
-- Copilot"), mirroring 20260727040000_generation_progress.sql for
-- generated_documents/scan_history/jobs. Copilot was the one long-running
-- pipeline left without a progress column, so its seeding UI had nothing to
-- poll beyond status — a hardcoded "~20-40s" line was the only feedback for
-- what's often several minutes. Purely additive; see
-- apps/server/src/lib/progress.js for the shared writer and
-- apps/server/src/generation/runCopilotSeed.js for the new call sites.

begin;

alter table public.resume_edit_sessions add column progress jsonb not null default '[]'::jsonb;

commit;

notify pgrst, 'reload schema';

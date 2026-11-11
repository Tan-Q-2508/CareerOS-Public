-- Phase 3, Session 20 Stage 3 (spec 15 #20(f) / 7.14.2 / 7.14.8). One-click
-- résumé generation now persists its content_tree so "Continue in Copilot"
-- (Session 21) can re-open the exact already-generated content without
-- re-running (and re-billing) the Content Director + Shotgun Draft.
--
-- Adds a sixth resume_edit_sessions.status value: 'completed_generation' —
-- written automatically the moment a one-click generation finishes, holding
-- that generation's content_tree even though no Copilot session was ever
-- explicitly opened. It moves to 'editing' (Session 21) the moment the user
-- actually starts editing. Never swept by the reaper (copilotSessions.js only
-- touches 'editing'/'seeding') — inert storage, not a billable session.
--
-- Also adds a partial unique index enforcing one completed_generation row per
-- (user_id, job_id) — re-generating the same job updates the existing row in
-- place (app-code select-then-insert-or-update, not .upsert({onConflict}),
-- since Supabase's upsert API can't target a partial unique index).

begin;

alter table public.resume_edit_sessions drop constraint resume_edit_sessions_status_check;
alter table public.resume_edit_sessions
  add constraint resume_edit_sessions_status_check check (
    status = any (array[
      'seeding', 'editing', 'exported', 'abandoned', 'failed', 'completed_generation'
    ]::text[])
  );

create unique index resume_edit_sessions_one_completed_gen
  on public.resume_edit_sessions (user_id, job_id)
  where status = 'completed_generation';

commit;

notify pgrst, 'reload schema';

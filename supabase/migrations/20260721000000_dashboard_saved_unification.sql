-- Dashboard/Tracker unification + email-check broadening (2026-07-21).
-- The dashboard becomes the "Saved" triage queue: every scored job is a Saved
-- application, acting on it (Not for me / forward move / email-detected apply)
-- removes it from the dashboard. Adds a terminal "Deemed Not Suitable" bucket
-- and an optional interview_round note.

begin;

-- 1. Widen the stage vocabulary with the new terminal bucket. The init CHECK is
--    inline + unnamed → Postgres named it applications_stage_check.
alter table public.applications drop constraint applications_stage_check;
alter table public.applications
  add constraint applications_stage_check check (
    stage in ('Saved', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Accepted', 'Deemed Not Suitable')
  );

-- 2. Optional interview-round note (e.g. "Round 2", "Final", "Technical").
--    Purely informational; the bucket stays Interviewing regardless of round.
alter table public.applications add column if not exists interview_round text;

-- 3. Backfill: every already-scored job becomes a Saved application (the
--    dashboard-as-Saved view), without disturbing jobs already moved forward.
insert into public.applications (user_id, job_id, stage)
select j.user_id, j.id, 'Saved'
from public.jobs j
where j.status = 'scored'
  and not exists (
    select 1 from public.applications a
    where a.job_id = j.id and a.user_id = j.user_id
  );

commit;

notify pgrst, 'reload schema';

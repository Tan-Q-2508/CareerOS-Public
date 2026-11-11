-- CareerOS — auto-track flip to opt-in (spec 4.6.10; Phase 4, §15 #25c-1).
--
-- 4.6.5 (as built, §23) auto-tracked every company surfacing from a user's
-- own scan/manual entry, on every sighting. At 11k+ registry companies this
-- pollutes the curated personal/sector tracklists 25a/25b built. 4.6.10
-- flips tracking (not detection/sector-tagging, which stay unconditional)
-- to opt-in: a per-job "Track this company" action, plus a Settings toggle
-- that auto-tracks into a dedicated "Scraped Companies" list so automatic
-- and curated tracking stay visibly separate.
--
-- Two columns:
--   1. jobs.company_ats_registry_id — 4.6.10's "previously unflagged gap":
--      nothing writes detection's resolution back onto the job row, so the
--      job detail page has no cheap way to know which registry row (if any)
--      corresponds to the job's company, for the "Track this company"
--      action. ON DELETE SET NULL — a registry row disappearing must not
--      take a user's job history with it. jobs is user-scoped/RLS'd
--      already (owns_row) — no policy change needed.
--   2. users.auto_track_scraped_companies — the Settings toggle, same
--      provenance-flag-boolean shape as years_of_experience_manual
--      (20260725000000), default false per 4.6.10 ("off by default").

begin;

alter table public.jobs
  add column if not exists company_ats_registry_id uuid
    references public.company_ats_registry(id) on delete set null;

create index if not exists jobs_company_ats_registry_id_idx
  on public.jobs (company_ats_registry_id);

alter table public.users
  add column if not exists auto_track_scraped_companies boolean not null default false;

commit;

notify pgrst, 'reload schema';

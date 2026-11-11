-- Bugs-to-fix batch: per-scan threshold, dedup-without-storage, profile
-- provenance flags (2026-07-25).

begin;

-- 1. Per-scan user-chosen threshold replaces the fixed storageCutoff.
alter table public.scan_schedules
  add column if not exists threshold numeric not null default 6.0;

-- 2. Dedup memory independent of whether a job's row survives (below-threshold
--    jobs get deleted from `jobs`, but we still don't want to re-pay to
--    re-score them on a later scan).
create table if not exists public.job_dedup_seen (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  dedup_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, dedup_key)
);

alter table public.job_dedup_seen enable row level security;

create policy owns_row on public.job_dedup_seen
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 3. Provenance flags: distinguish "auto-derived from a résumé" from
--    "the user explicitly set this in Settings" so a fresh upload can safely
--    refresh auto-derived fields without clobbering a manual override.
alter table public.users
  add column if not exists years_of_experience_manual boolean not null default false;
alter table public.users
  add column if not exists domain_keywords_manual boolean not null default false;

commit;

notify pgrst, 'reload schema';

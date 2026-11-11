-- CareerOS — email_check_runs (bug batch 2026-07-28)
-- Frontend UI request: "Check Email for Updates" gave no real sense of
-- progress during its multi-second Gmail-search + AI-classify run — just a
-- button spinner, unlike scans/generation which already got a real
-- ProgressConsole (20260727040000_generation_progress.sql). This table gives
-- that button the same run-row-to-poll pattern scan_history/generated_documents
-- already use; runEmailCheck.js writes `progress` milestones via the existing
-- shared `makeProgressLogger` (apps/server/src/lib/progress.js) and the
-- terminal row (`completed`/`failed` + `result`) at the end.

create table public.email_check_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed')),
  progress jsonb not null default '[]'::jsonb,   -- append-only [{step, label, at}], same shape as the other pipelines
  result jsonb,                                   -- the { suggestions, checked_count, candidate_count, cos } payload once completed
  checked_count int,
  candidate_count int,
  error_message text,
  error_code text,                                -- e.g. 'gmail_not_connected' — lets the client still trigger reconnect
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index email_check_runs_user_created on public.email_check_runs (user_id, created_at desc);

alter table public.email_check_runs enable row level security;
create policy owns_row on public.email_check_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on public.email_check_runs to anon, authenticated, service_role;

notify pgrst, 'reload schema';

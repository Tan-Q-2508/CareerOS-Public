-- "Build my watchlist" as a tracked run with live progress (spec 20).
--
-- Curating takes 30-90 s (a cheap spec call, a registry candidate screen of
-- several hundred companies, a strong ranking call). It used to be one
-- synchronous request with a spinner and no status — and when it failed
-- partway the error had nowhere durable to live. Same shape as
-- email_check_runs: POST returns 202 + the run id, the pipeline appends
-- {step, label, at} milestones to `progress`, the client polls.

create table public.watchlist_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed')),
  input text,                                     -- the user's free-text steer, if any
  progress jsonb not null default '[]'::jsonb,    -- append-only [{step, label, at}]
  spec jsonb,                                     -- the target spec the cheap tier inferred
  candidates_considered int,
  result_count int,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index watchlist_runs_user_created on public.watchlist_runs (user_id, created_at desc);

alter table public.watchlist_runs enable row level security;
create policy owns_row on public.watchlist_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on public.watchlist_runs to anon, authenticated, service_role;

notify pgrst, 'reload schema';

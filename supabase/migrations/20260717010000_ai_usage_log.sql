-- CareerOS — ai_usage_log (Phase 1, Session 2)
-- Raw AI usage per call (spec 16.10), separate from the cos_transactions ledger.
-- Every AI call logs here, even free ones (resume parsing, 13.1) that have no
-- ledger row — this is what makes free work still contribute to cost calibration.

create table public.ai_usage_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  action_type text not null,                 -- 'resume_parse' now; scoring/generation later
  provider text not null default 'gemini',
  connection_mode text not null check (connection_mode in ('vertex', 'developer')),
  model text not null,
  input_tokens int,
  output_tokens int,
  cached_tokens int,
  total_tokens int,
  raw_usage jsonb,                           -- provider usageMetadata verbatim
  cost_usd numeric,                          -- computed $ cost at log time (16.10)
  related_resume_version_id uuid references public.resume_versions(id) on delete set null,
  related_scan_id uuid references public.scan_history(id) on delete set null,
  related_job_id uuid references public.jobs(id) on delete set null,
  created_at timestamptz not null default now()
);

create index ai_usage_log_user on public.ai_usage_log (user_id);
create index ai_usage_log_action on public.ai_usage_log (action_type);

-- RLS + explicit grants, matching the Session-1 pattern (service-role backend
-- bypasses RLS; policies protect any future direct-client path).
alter table public.ai_usage_log enable row level security;

create policy owns_row on public.ai_usage_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on public.ai_usage_log to anon, authenticated, service_role;

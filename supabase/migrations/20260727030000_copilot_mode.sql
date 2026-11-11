-- Copilot Mode Stage 1 (spec 7.14, Phase 2 build-order item 16). New table
-- for an in-progress interactive résumé edit session (7.14.8) + widening the
-- COS action_type CHECK for the new 'copilot_session' flat fee (7.14.7).
--
-- Deviations from 7.14.8's literal column list, both deliberate (see
-- handoffs/phase_2_session_16a_handoff.md):
--   - status has two extra values beyond editing/exported/abandoned: 'seeding'
--     (the Content Director + shotgun draft take 20-40s, so session start must
--     be async-with-polling like generate-resume, not synchronous) and
--     'failed' (mirrors generated_documents' own failure state, needed for the
--     orphan-reap cleanup pass).
--   - origin_tree jsonb: an immutable-to-the-client server-held baseline. The
--     server updates it in place after a seed or an AI edit; a plain client
--     PATCH never does. Without it, PATCH /api/resume/copilot/sessions/:id
--     would have no way to stop a client from writing arbitrary un-grounded
--     text straight into content_tree and bypassing every 5.6/7.7/7.11
--     grounding rule without ever calling an AI edit endpoint.

begin;

create table public.resume_edit_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  resume_version_id uuid not null references public.resume_versions(id) on delete cascade,
  content_tree jsonb,
  origin_tree jsonb,
  status text not null default 'seeding'
    check (status in ('seeding', 'editing', 'exported', 'abandoned', 'failed')),
  generated_document_id uuid references public.generated_documents(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index resume_edit_sessions_user_status on public.resume_edit_sessions (user_id, status);
create index resume_edit_sessions_job on public.resume_edit_sessions (job_id);
create index resume_edit_sessions_stale on public.resume_edit_sessions (status, updated_at);

create trigger set_updated_at before update on public.resume_edit_sessions
  for each row execute function public.set_updated_at();

-- RLS + explicit grants, matching generated_documents' pattern exactly
-- (service-role backend bypasses RLS; policies protect any future direct-client path).
alter table public.resume_edit_sessions enable row level security;

create policy owns_row on public.resume_edit_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on public.resume_edit_sessions to anon, authenticated, service_role;

-- cos_transactions.action_type: widen for the new copilot_session flat fee (7.14.7).
alter table public.cos_transactions drop constraint cos_transactions_action_type_check;
alter table public.cos_transactions
  add constraint cos_transactions_action_type_check check (
    action_type = any (array[
      'cs_scan', 'byo_scan', 'resume_generation', 'cover_letter_generation',
      'email_check', 'manual_entry', 'admin_grant', 'copilot_session'
    ]::text[])
  );

commit;

notify pgrst, 'reload schema';

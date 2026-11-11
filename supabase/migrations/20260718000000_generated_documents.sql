-- CareerOS — generated_documents (Phase 1, Session 5)
-- Metadata + async-status record for every generated deliverable (resume now,
-- cover_letter in Session 6). Spec 11.1 stores the .docx in object storage the
-- moment it's created; this table is the record-of-generation (which job, which
-- resume version, ATS score, which Section-7 checks passed, pending skill
-- confirmations) and doubles as the generation job's status row (like
-- scan_history for scans).
--
-- Deviation note: the canonical table list (spec 2) never named a
-- generated-file metadata table; added here since generation needs a
-- storage-of-record row and Section 6 (cover letters) reuses it.

create table public.generated_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  doc_type text not null check (doc_type in ('resume', 'cover_letter')),
  storage_path text,                          -- {user_id}/generated/{job_id}.docx (private bucket)
  resume_version_id uuid references public.resume_versions(id),
  prompt_version text,
  ats_score numeric(4,1),                     -- 7.11 weighted keyword match (0-100)
  checks_passed jsonb,                        -- {onePage, fillRatio, ats, unresolved:[...]}
  pending_confirmations jsonb,                -- skills needed to close the ATS gap (7.11/7.13)
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index generated_documents_user on public.generated_documents (user_id);
create index generated_documents_job on public.generated_documents (job_id);

create trigger set_updated_at before update on public.generated_documents
  for each row execute function public.set_updated_at();

-- RLS + explicit grants, matching the Session-1/2 pattern (service-role backend
-- bypasses RLS; policies protect any future direct-client path).
alter table public.generated_documents enable row level security;

create policy owns_row on public.generated_documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on public.generated_documents to anon, authenticated, service_role;

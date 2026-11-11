-- Custom application Q&A (spec 8.6; pre-Phase-5 cleanup batch, reported #10).
--
-- Lets a user paste an arbitrary application question ("Why do you want to
-- join this company?") and get an AI answer grounded only in their real
-- master résumé / confirmed skills (same no-fabrication rule as cover
-- letters, 8.4). Unlike résumé/cover-letter generation there's no document to
-- render/store — the answer is synchronous request/response and persists in
-- job_question_answers so it survives navigating away and back.
--
-- Follows the exact drop-then-add CHECK pattern of
-- 20260805020000_ats_direct_scan.sql for the cos_transactions widen.

begin;

-- cos_transactions.action_type: allow the new billed action type
-- (application_qa — flat fee in tunables.flatFees.application_qa, 13.4).
alter table public.cos_transactions drop constraint cos_transactions_action_type_check;
alter table public.cos_transactions
  add constraint cos_transactions_action_type_check check (
    action_type = any (array[
      'cs_scan', 'byo_scan', 'ats_direct_scan', 'resume_generation', 'cover_letter_generation',
      'email_check', 'manual_entry', 'admin_grant', 'copilot_session', 'application_qa'
    ]::text[])
  );

-- ---------------------------------------------------------------------------
-- job_question_answers — one row per answered question, so a user can build
-- up a bank of several answers per application across a session.
-- ---------------------------------------------------------------------------
create table public.job_question_answers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  question text not null,
  answer text not null,
  created_at timestamptz not null default now()
);

create index job_question_answers_job on public.job_question_answers (user_id, job_id, created_at desc);

alter table public.job_question_answers enable row level security;
create policy owns_row on public.job_question_answers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on public.job_question_answers to anon, authenticated, service_role;

commit;

notify pgrst, 'reload schema';

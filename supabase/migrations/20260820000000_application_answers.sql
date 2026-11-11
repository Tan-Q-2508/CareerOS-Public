-- Application Autofill answer bank (spec 0.1 Phase 5 / §15 session 28).
--
-- The autofill extension fills standard fields (name/email/phone/links/résumé
-- file) deterministically from the user's contact fields and Structured Resume
-- Profile — nothing to store for those. What DOES need storing is the answers
-- to a platform's custom screening questions ("Are you authorized to work in
-- the US?", "How did you hear about us?"), so the same question never has to
-- be answered twice, on any platform.
--
-- Same reuse discipline as confirmed_skills (7.13): the row is written only
-- from the user's own explicit input, never AI-guessed, and is keyed by
-- NORMALIZED question text so a question phrased slightly differently on a
-- later application still hits the same answer. The normalizer is
-- packages/shared/src/autofill/normalizeQuestion.js — server and extension
-- must both key on that exact function's output or reuse silently breaks.
--
-- Deliberately NOT stored here: anything EEO/self-identification (race,
-- gender, veteran, disability). Spec §14 forbids autofilling those at all, so
-- there is no reason to ever persist an answer to one — the extension blocks
-- them before they reach this table.

begin;

create table public.application_answers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  -- The reuse key: normalizeQuestion(question_original).
  question_normalized text not null,
  -- The question exactly as it appeared on the form that first produced this
  -- answer — kept so the review UI can show the user real wording, not the
  -- stripped-down key.
  question_original text not null,
  answer_text text not null,
  answer_type text not null default 'text'
    check (answer_type = any (array['text', 'textarea', 'select', 'boolean', 'number']::text[])),
  -- Which platform the answer was first captured on, for debugging a bad
  -- adapter later. Never used for matching — an answer is deliberately
  -- portable across platforms (that's session 29's deliverable).
  first_seen_platform text,
  times_used integer not null default 1,
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint application_answers_user_question_unique unique (user_id, question_normalized)
);

create index application_answers_user on public.application_answers (user_id, last_used_at desc);

alter table public.application_answers enable row level security;
create policy owns_row on public.application_answers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on public.application_answers to anon, authenticated, service_role;

commit;

notify pgrst, 'reload schema';

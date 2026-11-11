-- jd_profile_cache — make JD skill extraction reproducible (spec 5.6).
--
-- Extraction is not reproducible and cannot be made so by prompt, tier or
-- temperature: measured across four real postings at temperature 0, two
-- identical runs agree on only 42-67% of the skills they return, and the
-- strong tier agrees with itself LESS (29%) because it samples a larger
-- candidate pool differently each time. Sampling twice and unioning (5.6)
-- raises recall but was measured NOT to raise agreement (62%, no better than
-- a single run). So re-scanning an unchanged posting kept producing a
-- different keyword set, and therefore a different score, for reasons that
-- had nothing to do with the job or the candidate.
--
-- The only way a stochastic step becomes reproducible is to stop re-running
-- it. This table is that: call 1's result, keyed by everything it actually
-- depends on, so an unchanged posting scored against an unchanged résumé
-- with unchanged settings returns the SAME skills forever.
--
-- cache_key covers all four inputs, and every one of them matters:
--   - the JD text (title + body — jdGroundingText, the same text grounding
--     runs against)
--   - the résumé skills block, because call 1 also emits ats_match, which is
--     a judgement about THIS candidate against that JD. Without the résumé in
--     the key, editing a résumé would keep serving the old ats_match.
--   - the extraction settings (tier + samples)
--   - the prompt version, so changing the system instruction invalidates
--     every row rather than silently serving answers from the old prompt.
-- Any of them changing produces a different key and a fresh extraction; none
-- of them changing can ever produce a different answer.
--
-- User-scoped like nearly everything else. The JD profile itself is derived
-- purely from public job text and could in principle be shared, but the row
-- also carries an ats_match computed against this user's résumé — so the row
-- as a whole is user data, and the schema's only non-user-scoped tables stay
-- the two ATS Direct registry tables plus their siblings (1.1).

create table public.jd_profile_cache (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  cache_key text not null,
  -- Kept alongside the composite key purely so a human can ask "do we have
  -- anything at all for this posting" without recomputing the full key.
  jd_hash text not null,
  jd_profile jsonb not null,
  ats_match numeric,
  model text,
  prompt_version text not null,
  hit_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create unique index jd_profile_cache_key_uniq on public.jd_profile_cache (user_id, cache_key);
create index jd_profile_cache_jd_hash on public.jd_profile_cache (user_id, jd_hash);

comment on table public.jd_profile_cache is
  'Call-1 (JD extraction) results, keyed by JD text + résumé skills + extraction settings + prompt version. Exists because extraction is stochastic even at temperature 0 (5.6); re-scanning an unchanged posting must not change its keywords.';
comment on column public.jd_profile_cache.cache_key is
  'sha256 over jdGroundingText, the résumé skills block, the extraction settings and the prompt version. Any input changing yields a new key and a fresh extraction.';

alter table public.jd_profile_cache enable row level security;

create policy "jd_profile_cache owner select" on public.jd_profile_cache
  for select using (auth.uid() = user_id);
create policy "jd_profile_cache owner insert" on public.jd_profile_cache
  for insert with check (auth.uid() = user_id);
create policy "jd_profile_cache owner update" on public.jd_profile_cache
  for update using (auth.uid() = user_id);
create policy "jd_profile_cache owner delete" on public.jd_profile_cache
  for delete using (auth.uid() = user_id);

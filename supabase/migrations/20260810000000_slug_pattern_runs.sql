-- CareerOS — slug-pattern mining run history (spec 4.6.11; Phase 4, §15 #25d).
--
-- One row per run of the periodic mining pass
-- (apps/server/src/companies/slugMining.js, behind
-- POST /api/internal/mine-slug-patterns). The pass reads
-- company_ats_registry's confirmed (display name, slug, platform) triples and
-- scores each candidate-generation rule on incremental coverage vs. wrong-hit
-- collisions; this table is where those numbers land so successive runs are
-- comparable as the registry grows.
--
-- REPORT ONLY — nothing reads this table back into detection. Promoting a rule
-- into live name-guessing is a human editing
-- tunables.atsDirect.detect.minedRules after reading a run, which is 4.6.11's
-- explicit carry-over of 4.6.2's false-positive discipline.
--
-- GLOBAL, like the two registry tables it analyses (4.6.5) — a rule's hit rate
-- is a fact about the registry, not about any user. Same consequence for RLS:
-- no owner column exists for a policy to key on, so RLS is enabled with NO
-- policy (Express uses the service-role key, which bypasses it; anon and
-- authenticated can read nothing). See 20260805010000_company_ats_registry.sql.

begin;

create table public.slug_pattern_runs (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz not null default now(),
  pairs_analyzed integer not null,
  live_mined_rules text[] not null default '{}',      -- what was promoted AT RUN TIME, so an old run stays interpretable
  recommended_promotions text[] not null default '{}',
  regressions text[] not null default '{}',           -- live rules that stopped clearing their gate
  report jsonb not null                               -- the full per-rule breakdown incl. hit/collision examples
);

create index slug_pattern_runs_run_at on public.slug_pattern_runs (run_at desc);

alter table public.slug_pattern_runs enable row level security;

commit;

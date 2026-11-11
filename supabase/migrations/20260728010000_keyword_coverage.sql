-- Session 20, Stage 1 (spec 15 #20 / 5.1 / 16.6). Additive nullable column
-- backing the scan-time deterministic keyword-match display ("N/M keywords
-- matched", the same shape 7.11's checksPassed.keywordCoverage already uses
-- on the generation side). Only written when tunables.scoring.useUnifiedAtsEngineV2
-- is on (scoreJob.js) — null on every existing row and on every row scored
-- while the flag stays off, which the frontend treats as "legacy AI-judged
-- ats_match, show the old label" (JobDetailView.jsx/DashboardView.jsx).

begin;

alter table public.jobs add column keyword_coverage jsonb;

commit;

notify pgrst, 'reload schema';

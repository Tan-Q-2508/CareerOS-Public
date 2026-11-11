-- company_ats_registry.probe_outcome — record WHAT a board probe found, not
-- just that one happened (spec 4.6.3, §15 #56).
--
-- scripts/park-dead-boards.js has three outcomes per row: the board answered
-- (ok), the board 404'd (moved to company_ats_unresolved), or the probe was
-- inconclusive — a timeout or a non-404 status, which is NOT evidence the board
-- is dead. The first and third both wrote the identical update: `probed_at` and
-- nothing else.
--
-- So an inconclusive row became indistinguishable from a healthy one the moment
-- the sweep finished. §15's park-dead-boards handoff flagged exactly this ("12
-- Workday rows came back inconclusive ... if it ever matters which of those are
-- genuinely dead, that needs a targeted re-probe of those 12") — and by the time
-- anyone went looking, the information needed to target those 12 no longer
-- existed anywhere. They are not recoverable; this column is what stops the next
-- sweep losing the same thing.
--
-- Nullable with no default on purpose. NULL means "probed before this column
-- existed, outcome unknown" — which is the honest state of every existing row,
-- and is different from asserting they were all fine.

alter table public.company_ats_registry
  add column probe_outcome text
    check (probe_outcome is null or probe_outcome = any (array['ok', 'inconclusive']::text[]));

comment on column public.company_ats_registry.probe_outcome is
  'Result of the last park-dead-boards probe: ok | inconclusive | NULL (probed before this column existed, or never probed). A 404 is not represented here — that row moves to company_ats_unresolved instead.';

-- Partial index: the only query this column exists to serve is "which rows need
-- a targeted re-probe", which is always the inconclusive ones.
create index company_ats_registry_inconclusive
  on public.company_ats_registry (platform, probed_at)
  where probe_outcome = 'inconclusive';

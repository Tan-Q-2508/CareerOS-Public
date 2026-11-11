-- Sector classification versioning (spec 4.6.9).
--
-- Before this, "is this company classified yet?" had exactly one answer:
-- row existence in company_sectors. That is enough for a backfill — a company
-- with zero rows needs classifying — but it cannot answer the question that
-- actually matters over time: "was this company classified by the CURRENT
-- classifier, or by an older prompt under an older taxonomy?"
--
-- Without that distinction every prompt or enum change forced an all-or-nothing
-- choice: re-run the entire registry with --force (no resumption — a crash at
-- 90% starts over, and there is no way to run it in nightly slices under a
-- daily cap), or leave stale assignments in place indefinitely. Session 51's
-- taxonomy expansion hit exactly this.
--
-- `classifier_version` makes the pass RESUMABLE and INCREMENTAL by
-- construction. The script selects companies with no rows at all, or whose rows
-- carry a version other than the current one; each applied write stamps the
-- current version. Re-running after a crash picks up precisely what is left,
-- and a completed pass selects nothing.
--
-- The stamp is denormalized across a company's rows (all of a company's sector
-- rows are written in one applySectors call and carry the same version) —
-- harmless, and it keeps the column on the row that actually records the
-- classification rather than inventing a per-company side table.
--
-- Purely additive: no existing column changes, no data is deleted, and the
-- unique index and both existing indexes are untouched.
--
-- Existing rows backfill to version 1 — they were genuinely classified, by the
-- 22-sector classifier. `classified_at` backfills from `assigned_at`, which is
-- the closest true value already recorded. The application constant
-- (SECTOR_CLASSIFIER_VERSION in packages/shared/src/constants.js) moves to 2
-- in the same change, because the classifier prompt changes alongside it — so
-- every row correctly reads as stale and the next pass re-flows the registry
-- through the new tiered lanes.
--
-- source='admin' overrides are NOT special-cased here. They stay untouched by
-- classifyAndApply regardless of version (see its own header), and the script
-- excludes them from selection so they do not get re-selected forever on a
-- version they will never be stamped with.

begin;

alter table public.company_sectors
  add column if not exists classifier_version integer not null default 0,
  add column if not exists classified_at timestamptz;

update public.company_sectors
   set classifier_version = 1,
       classified_at = assigned_at
 where classifier_version = 0;

-- The selection query filters on this column across the whole table every run.
create index if not exists company_sectors_classifier_version
  on public.company_sectors (classifier_version);

commit;

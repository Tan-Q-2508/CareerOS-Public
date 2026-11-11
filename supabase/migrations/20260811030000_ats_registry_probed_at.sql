-- F6 (carried-forward audit item, §4.6.1) — company_ats_registry has no
-- column distinguishing rows that were live-verified against their platform
-- from rows that were only ever bulk-imported and never actually probed.
-- import-ats-slugs.js's own --probe pass only ever sampled Workable (200 of
-- ~4,000+ rows, per that script's own IP-ban-risk caveat) — the sample's
-- pass/fail results were used to decide what to INSERT, but never persisted
-- back onto the rows themselves, so today there is no way to tell "this row
-- was verified reachable" from "this row was imported and nobody has ever
-- checked." 3,807 Workable rows currently sit in that unknown state.
--
-- Nullable, no backfill: existing rows (Tier 1 platforms detected live via
-- detectPlatform(), and Workable rows already touched by import's sampled
-- probe) are left NULL rather than guessed at — `probed_at IS NULL` is
-- exactly the "never verified" signal scripts/probe-workable-registry.js
-- (F6) selects on, and a wrong backfilled timestamp would corrupt that
-- signal rather than just be absent.

begin;

alter table public.company_ats_registry add column probed_at timestamptz;

commit;

notify pgrst, 'reload schema';

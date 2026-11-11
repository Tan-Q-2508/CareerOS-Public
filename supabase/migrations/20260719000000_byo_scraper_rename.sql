-- BYO Scraper rename (2026-07-19, explicit sign-off — see handoffs/byo_scraper_rename_handoff.md).
-- LD -> BYO Scraper. Renames the DB enum VALUES ('ld' -> 'byo', 'ld_scan' -> 'byo_scan')
-- that the CHECK constraints pin, and migrates the (small, Phase-1) existing data.
-- CS short code 'cs' / 'cs_scan' is unchanged (concept renamed to "Core Scraper").
-- The multi-actor BYOK runtime (multi-row provider_credentials, field mapping, etc.)
-- is a later, dedicated build — this migration only handles the value rename.

begin;

-- jobs.sources: drop the old constraint FIRST (it forbids 'byo'), migrate the
-- data, then re-add the widened {cs, byo, manual} constraint.
alter table public.jobs drop constraint jobs_sources_check;
update public.jobs set sources = array_replace(sources, 'ld', 'byo') where 'ld' = any (sources);
alter table public.jobs
  add constraint jobs_sources_check check (sources <@ array['cs', 'byo', 'manual']::text[]);

-- scan_history.sources is an unconstrained text[] (spec 12.3) — data only.
update public.scan_history set sources = array_replace(sources, 'ld', 'byo') where 'ld' = any (sources);

-- cos_transactions.action_type: 'ld_scan' -> 'byo_scan' (Phase-1 unbilled ledger,
-- migrated for consistency). Drop the constraint first (it forbids 'byo_scan'),
-- migrate, then re-add.
alter table public.cos_transactions drop constraint cos_transactions_action_type_check;
update public.cos_transactions set action_type = 'byo_scan' where action_type = 'ld_scan';
alter table public.cos_transactions
  add constraint cos_transactions_action_type_check check (
    action_type = any (array[
      'cs_scan', 'byo_scan', 'resume_generation', 'cover_letter_generation',
      'email_check', 'manual_entry', 'admin_grant'
    ]::text[])
  );

commit;

notify pgrst, 'reload schema';

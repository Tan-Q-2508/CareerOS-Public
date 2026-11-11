-- CareerOS — sponsor system tracklists (spec 19.5; Phase 5.5, §15 #49).
--
-- Two is_system tracklists populated from visa_sponsors (19.2), subscribed to
-- exactly like the 16 sector tracklists (4.6.9) via tracklist_subscriptions.
-- No scan-side code is needed: an ATS Direct scan already accepts any
-- subscribed system tracklist as its company selection (4.6.6).
--
-- Seeded here and never renamed, matching how 20260807000000_company_sectors.sql
-- seeds the sector lists — apps/server/src/visa/sponsorTracklists.js caches
-- their ids by name for the lifetime of the process, which is only safe because
-- system list names are not user-editable.
--
-- WHY TWO LISTS AND NOT ONE. 19.2 stores wage_level_distribution rather than a
-- bare filing count precisely because volume alone misleads: a company with 200
-- filings that are 90% Level III-IV is a poor target for an early-career
-- applicant regardless of its sponsor-volume reputation. A single "sponsors"
-- list would surface exactly that trap. The second list applies the wage-level
-- cut the data was collected to support.
--
-- MEMBERSHIP RULE (19.5): a company enters only where it has BOTH a
-- visa_sponsors row and an ACTIVE company_ats_registry row. A real sponsor with
-- no reachable job board cannot be scanned, so listing it as trackable would be
-- misleading. This is also why these lists are much smaller than visa_sponsors
-- itself — most DOL employers have no registry row at all.

begin;

insert into public.tracklists (user_id, name, is_system) values
  (null, 'H-1B Sponsors', true),
  (null, 'H-1B Sponsors — Entry-Level Friendly', true);

commit;

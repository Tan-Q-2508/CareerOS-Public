-- CareerOS — sector taxonomy expansion (spec 4.6.9; Phase 5.5, §15 #51).
--
-- Adds six sectors to the original sixteen and seeds their system tracklists.
-- The three-place pattern in full: this CHECK + system-tracklist insert here,
-- COMPANY_SECTORS and COMPANY_SECTOR_LABELS in packages/shared/src/constants.js.
--
-- WHY THESE SIX, from a real coverage analysis of the live registry rather than
-- from taste. Before this migration, 3,115 of 18,436 classified companies
-- (16.9%) carried `other` — and `other` is not a long tail of oddities, it is
-- several coherent industries the list simply had no room for. Sampling the
-- companies whose ONLY sector was `other` turned up, repeatedly:
--
--   * aerospace/space/defense   Kepler Communications, Redwire Space, Scout
--                               Space, Terrestar, Loft Federal, Spry Methods
--   * consulting/agencies/legal/staffing
--                               The Gunter Group, MorganFranklin, Interbrand,
--                               Koley Jessen P.C., GBD Talent, Verstela
--   * nonprofit/foundation/government/advocacy
--                               ACLU, GiveWell, Hillel International, Tides
--                               Network, Emerson Collective, One Acre Fund
--   * manufacturing/industrial/agriculture
--                               PBI-Gordon, Kodiak Equipment, Super-Sod
--   * food/restaurants/hospitality/travel
--                               Home Market Foods, Park Restaurant and Bar
--
-- Hardware & semiconductors is the sixth, and the one that isn't visible in the
-- `other` bucket — it is worse than invisible. Chip and device companies were
-- being absorbed into enterprise_saas/devtools/ai_ml, which is actively wrong
-- rather than merely vague: Texas Instruments and Synopsys are not SaaS
-- companies. A sector that silently mislabels is a worse failure than one that
-- says `other`.
--
-- What this migration deliberately does NOT add: insurance (fintech covers it
-- defensibly), telecom (too thin to justify a list of its own), and a separate
-- transportation sector (logistics already covers it). Restraint matters — a
-- system tracklist nobody would subscribe to is worse than no tracklist.

begin;

alter table public.company_sectors
  drop constraint if exists company_sectors_sector_check;

alter table public.company_sectors
  add constraint company_sectors_sector_check check (sector in (
    'fintech',
    'healthtech',
    'ecommerce',
    'devtools',
    'ai_ml',
    'gaming',
    'cybersecurity',
    'logistics',
    'real_estate',
    'edtech',
    'biotech',
    'enterprise_saas',
    'consumer',
    'media_entertainment',
    'climate_energy',
    'aerospace_defense',
    'manufacturing_industrial',
    'hardware_semiconductors',
    'professional_services',
    'nonprofit_government',
    'food_hospitality',
    'other'
  ));

-- One system tracklist per new sector, matching 20260807000000_company_sectors.sql's
-- seeding. Membership is filled in by syncSectorTracklists() on the
-- re-classification run, not here.
insert into public.tracklists (user_id, name, is_system) values
  (null, 'Aerospace & Defense', true),
  (null, 'Manufacturing & Industrial', true),
  (null, 'Hardware & Semiconductors', true),
  (null, 'Professional Services', true),
  (null, 'Nonprofit & Government', true),
  (null, 'Food & Hospitality', true);

notify pgrst, 'reload schema';

commit;

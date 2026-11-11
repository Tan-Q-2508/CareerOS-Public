-- CareerOS — company_sectors + system sector tracklists (spec 4.6.9; Phase 4,
-- §15 #25b, second of the 25a-25d split — see 20260806000000_tracklists.sql's
-- header for #25's split rationale and #25a's own scope).
--
-- Segregates the 11,534-company registry into built-in, sector-organized
-- tracklists every user can subscribe to (4.6.8's tracklist_subscriptions,
-- shipped in 25a specifically so 25b needs no schema change on that side)
-- instead of hand-curating from scratch. A company can legitimately belong to
-- more than one sector (a fintech-infra company is both Fintech and Developer
-- Tools), so this is many-to-many via a join table, not a single-category
-- column on company_ats_registry — sector membership needs to be queried from
-- the sector side (list every company in Fintech) as often as the company side.
--
-- Written/read by apps/server/src/companies/sectors.js (classification +
-- tracklist sync) and scripts/classify-sectors.js (the one-time bulk pass).
--
-- SCOPING/RLS — same global, no-owner-column exception as company_ats_registry
-- (20260805010000's header explains the reasoning in full): sector membership
-- is a fact about the company, not about any user, so this table gets RLS
-- enabled with NO policy (service-role only; anon/authenticated get nothing).
--
-- DEVIATION from 4.6.9's literal column list: `source` is new. Without it, a
-- re-classification pass (a new bulk rerun, or a future re-tag at a later
-- session) would silently overwrite an admin's manual correction — directly
-- contradicting 4.6.9's own "admin-editable override" requirement, since that
-- override then has no way to say "don't touch this." classifyAndApply()
-- checks this column and skips any company whose rows are all source='admin',
-- even when called with force=true.
--
-- This migration also seeds the 16 system tracklists (spec's 15 sectors + an
-- `other` catch-all, deterministic — no AI needed to create the lists
-- themselves, only to populate their membership). Names match
-- packages/shared/src/constants.js's COMPANY_SECTOR_LABELS exactly; the sector
-- KEYS (not display names) are the company_sectors.sector CHECK values and
-- also live in that same constants file as COMPANY_SECTORS — three-place
-- pattern (migration CHECK + constant + system-tracklist row), same as
-- company_ats_registry.platform. The is_system partial unique index
-- (tracklists_system_name_uniq, 20260806000000) guarantees exactly one row per
-- name; a user's own personal "Fintech" list lives under the other partial
-- index and is unaffected.
--
-- "Is this company classified yet?" has no dedicated column — row existence in
-- company_sectors IS the flag. Every classified company gets >=1 row (`other`
-- if nothing else fits), so "0 rows" always means "not yet classified."

begin;

-- ---------------------------------------------------------------------------
-- company_sectors (4.6.9). Global — see header.
-- ---------------------------------------------------------------------------
create table public.company_sectors (
  id uuid primary key default gen_random_uuid(),
  company_ats_registry_id uuid not null references public.company_ats_registry(id) on delete cascade,
  sector text not null check (sector in (
    'fintech', 'healthtech', 'ecommerce', 'devtools', 'ai_ml', 'gaming',
    'cybersecurity', 'logistics', 'real_estate', 'edtech', 'biotech',
    'enterprise_saas', 'consumer', 'media_entertainment', 'climate_energy',
    'other'
  )),
  source text not null default 'ai_bulk' check (source in ('ai_bulk', 'ai_detect', 'admin')),
  assigned_at timestamptz not null default now(),
  unique (company_ats_registry_id, sector)  -- plain unique (no WHERE) — onConflict IS safe here, same as tracklist_companies
);

create index company_sectors_sector on public.company_sectors (sector);
create index company_sectors_registry on public.company_sectors (company_ats_registry_id);

alter table public.company_sectors enable row level security;
-- No owner column — global table, same "RLS enabled, no policy" treatment as
-- company_ats_registry/company_ats_unresolved (20260805010000's header).
grant all on public.company_sectors to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Seed the 16 system sector tracklists (4.6.9's user-facing surface over
-- company_sectors). user_id NULL + is_system true, per 4.6.8's shape.
-- ---------------------------------------------------------------------------
insert into public.tracklists (user_id, name, is_system) values
  (null, 'Fintech', true),
  (null, 'Healthtech', true),
  (null, 'Ecommerce', true),
  (null, 'Developer Tools', true),
  (null, 'AI & ML', true),
  (null, 'Gaming', true),
  (null, 'Cybersecurity', true),
  (null, 'Logistics', true),
  (null, 'Real Estate', true),
  (null, 'Edtech', true),
  (null, 'Biotech', true),
  (null, 'Enterprise SaaS', true),
  (null, 'Consumer', true),
  (null, 'Media & Entertainment', true),
  (null, 'Climate & Energy', true),
  (null, 'Other', true);

commit;

notify pgrst, 'reload schema';

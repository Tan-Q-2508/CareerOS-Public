-- location_resolutions (new §4.6.16, Layer 2 of the ATS Direct location fix).
-- Persistent cache mapping a raw location string (as posted by an ATS board)
-- to its parsed structure, so an AI resolution call is only ever spent ONCE
-- per distinct string, platform-wide, forever — the same
-- global-table-as-cache shape as company_sectors (20260807000000's header).
--
-- Deliberately keyed on the location string ALONE, not on (string, filter):
-- the AI's job here is "parse this string into a place," a fact about the
-- string that is true for every user and every scan's filter. Matching a
-- parsed location against a scan's filter stays fully deterministic in
-- packages/shared/src/sourcing/locationMatch.js (Layer 1), on top of
-- whatever this table returns — keeps the cache O(distinct location
-- strings) instead of O(strings x filters), and keeps match logic testable
-- without any AI involved.
--
-- Written/read by apps/server/src/scan/locationResolver.js.
--
-- SCOPING/RLS — same global, no-owner-column exception as
-- company_ats_registry/company_sectors: a location string's resolution is a
-- fact about the string, not about any user. RLS enabled, no policy —
-- service-role only.

begin;

create table public.location_resolutions (
  id uuid primary key default gen_random_uuid(),
  location_norm text not null unique,
  city text,
  region text,
  country text,
  metro text,
  is_remote boolean not null default false,
  remote_scope text,
  confidence text not null check (confidence in ('high', 'low')),
  source text not null default 'ai' check (source in ('ai', 'admin')),
  resolved_at timestamptz not null default now()
);

create index location_resolutions_norm on public.location_resolutions (location_norm);

alter table public.location_resolutions enable row level security;
grant all on public.location_resolutions to anon, authenticated, service_role;

commit;

notify pgrst, 'reload schema';

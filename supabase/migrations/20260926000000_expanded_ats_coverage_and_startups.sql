-- CareerOS — expanded ATS Direct coverage + the built-in Startups tracklist
-- (spec 4.6.1, 4.6.5, 4.6.9a; §15 #65).
--
-- 1. company_ats_registry.platform gains the eleven platforms added this
--    session. Postgres has no ALTER CHECK, so the constraint is dropped and
--    recreated with the widened list, the same mechanism as every earlier
--    platform migration (20260827030000_meta_platform.sql).
--
-- 2. company_startup_profiles — which registry companies are startups, and the
--    source fact that says so. Global, like company_sectors: whether a company
--    is a YC startup is a fact about the company, not about any user. Holds
--    only facts copied verbatim from the source directory (batch, team size,
--    stage, industries, website, hiring flag) — nothing inferred. The Startups
--    tracklist's membership is derived from this table
--    (apps/server/src/companies/startupTracklist.js), never hand-maintained.
--
-- 3. The system tracklist itself, seeded here and never renamed — the sync
--    caches its id by name for the life of the process, the same reasoning the
--    sector and sponsor lists rest on (20260828010000_sponsor_tracklists.sql).

begin;

alter table public.company_ats_registry drop constraint company_ats_registry_platform_check;
alter table public.company_ats_registry
  add constraint company_ats_registry_platform_check
  check (platform in (
    'greenhouse', 'lever', 'ashby', 'workday', 'workable', 'oracle', 'eightfold', 'avature',
    'apple', 'amazon', 'google', 'meta', 'phenom',
    'smartrecruiters', 'recruitee', 'bamboohr', 'breezy', 'rippling',
    'successfactors', 'taleo', 'icims', 'jibe', 'radancy', 'ycombinator'
  ));

create table public.company_startup_profiles (
  company_ats_registry_id uuid primary key references public.company_ats_registry(id) on delete cascade,
  source text not null check (source in ('yc')),
  source_slug text not null,            -- the company's slug in the source directory
  batch text,                           -- e.g. 'Summer 2024'
  team_size integer,
  stage text,                           -- as the source states it ('Early', 'Growth', ...)
  industries text[] not null default '{}',
  website text,
  is_hiring boolean,
  synced_at timestamptz not null default now(),
  unique (source, source_slug)
);

create index company_startup_profiles_source on public.company_startup_profiles (source);

alter table public.company_startup_profiles enable row level security;
-- No owner column — global table, same "RLS enabled, no policy" treatment as
-- company_ats_registry / company_sectors.
grant all on public.company_startup_profiles to anon, authenticated, service_role;

insert into public.tracklists (user_id, name, is_system) values
  (null, 'Startups — Y Combinator', true);

commit;

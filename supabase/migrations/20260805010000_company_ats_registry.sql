-- CareerOS — ATS Direct registry, unresolved holding table, and per-user
-- tracking (spec 4.6.4/4.6.5; Phase 4, §15 #23).
--
-- §15 #22 (2026-08-05) shipped the Tier 1 adapters and the shared detection
-- service into packages/shared/src/sourcing/ats/, but deliberately wrote nothing
-- to the database — detectPlatform() had no caller outside its own package.
-- These three tables are what make it reachable: every company surfacing from a
-- scan, a manually-pasted JD, or a user request runs through 4.6.4's
-- normalized-name dedup gate and lands in exactly one of the first two tables.
--
-- Written/read by apps/server/src/companies/registry.js (dedup-then-detect,
-- tracking) and apps/server/src/companies/resweep.js (the periodic re-attempt
-- behind POST /api/internal/resweep-companies).
--
-- SCOPING — the first deliberate break from this schema's user_id-per-table rule
-- (4.6.5 calls this out explicitly). Which ATS a company uses is a fact about the
-- company, not about any user: FormFactor's Greenhouse slug is the same
-- regardless of who is asking, so re-detecting it per user would be pure waste.
-- company_ats_registry and company_ats_unresolved are therefore GLOBAL.
-- user_tracked_companies is what restores per-user scoping on top.
--
-- RLS — consequently also a break from the repo-wide `owns_row` policy. The two
-- global tables have no owner column for a policy to key on, so they get RLS
-- enabled with NO policy at all: Express always uses the service-role key (which
-- bypasses RLS), and anon/authenticated should be able to read nothing directly.
-- That is strictly safer than the alternative of leaving RLS off. The join table
-- has a user_id and gets the standard verbatim owns_row policy.
--
-- TWO DEVIATIONS from 4.6.5's literal column list, both deliberate:
--   * last_attempt_at (on unresolved) is new. Without it the periodic re-sweep
--     has no way to order "least recently retried" and would grind the same N
--     rows on every run forever. check_count cannot serve — 4.6.4 defines it as
--     a SIGHTING counter, and a sweep attempt is not a sighting.
--   * source allows 'manual' beyond 4.6.5's cs/byo_scraper/user_request. Manual
--     job entry is 4.6.3's fourth entry point but has no value in that enum;
--     folding it into 'user_request' would misreport how a company was found.

begin;

-- ---------------------------------------------------------------------------
-- Resolved companies (4.6.5). Global.
-- ---------------------------------------------------------------------------
create table public.company_ats_registry (
  id uuid primary key default gen_random_uuid(),
  company_name_normalized text not null unique,   -- 4.6.4's dedup key; this UNIQUE is the "indexed" the spec asks for
  company_name_display text not null,             -- first-seen original casing, for UI
  platform text not null
    check (platform in ('greenhouse', 'lever', 'ashby', 'workday')),  -- adding a platform (Tier 2/3, 4.6.1) means widening this
  slug_or_identifier text not null,               -- board token / slug / client name, per platform
  status text not null default 'active'
    check (status in ('active', 'pending_adapter')),  -- pending_adapter is unreachable today: detection only probes platforms that have adapters
  source text not null
    check (source in ('cs', 'byo_scraper', 'user_request', 'manual')),  -- how it was FIRST detected; not re-written on later sightings (4.6.5)
  detected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- Backs the "browse known companies" list (4.6.5) — filtered to active, ordered by display name.
create index company_ats_registry_status_name on public.company_ats_registry (status, company_name_display);

-- ---------------------------------------------------------------------------
-- Checked, no platform match found (4.6.5). Global. A working list for the
-- periodic human review (4.6.3), and the input to the re-sweep.
-- ---------------------------------------------------------------------------
create table public.company_ats_unresolved (
  id uuid primary key default gen_random_uuid(),
  company_name_normalized text not null unique,
  company_name_display text not null,
  match_attempt_type text not null
    check (match_attempt_type in ('url_no_match', 'name_guess_failed')),  -- persisted verbatim from detectPlatform's matchAttemptType, no translation
  careers_url_guess text,                         -- only ever a plausible company URL — aggregator links (linkedin/indeed/...) are filtered out upstream by isUsableCompanyLink
  source text not null
    check (source in ('cs', 'byo_scraper', 'user_request', 'manual')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),  -- last DETECTION attempt (see header); distinct from a sighting
  check_count int not null default 1              -- sightings, per 4.6.4 — a repeatedly-seen company is a review-priority signal
);

-- The re-sweep claims the least-recently-attempted rows.
create index company_ats_unresolved_sweep on public.company_ats_unresolved (last_attempt_at asc);

-- ---------------------------------------------------------------------------
-- Per-user tracking layered on the global registry (4.6.5). Feeds 4.6.6's
-- tracked-companies scan selector (§15 #24).
-- ---------------------------------------------------------------------------
create table public.user_tracked_companies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  company_ats_registry_id uuid not null references public.company_ats_registry(id) on delete cascade,
  tracked_at timestamptz not null default now(),
  unique (user_id, company_ats_registry_id)
);

create index user_tracked_companies_user on public.user_tracked_companies (user_id, tracked_at desc);

-- ---------------------------------------------------------------------------
-- RLS + grants — see the header note on why the two global tables get no policy.
-- ---------------------------------------------------------------------------
alter table public.company_ats_registry enable row level security;
alter table public.company_ats_unresolved enable row level security;

alter table public.user_tracked_companies enable row level security;
create policy owns_row on public.user_tracked_companies
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on public.company_ats_registry to anon, authenticated, service_role;
grant all on public.company_ats_unresolved to anon, authenticated, service_role;
grant all on public.user_tracked_companies to anon, authenticated, service_role;

commit;

notify pgrst, 'reload schema';

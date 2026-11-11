-- visa_sponsor_exclusions (spec 19.2) — the inverse of visa_sponsor_aliases:
-- a hand-reviewed list of filing entities that must NEVER be blended into a
-- registry company, even though the name matching says they should be.
--
-- WHY THIS EXISTS. 19.2's employer-name matching is a plain equality join on
-- normalizeCompanyName(). That is deliberate — a fuzzier matcher would import
-- errors faster than filings — but equality still collides, because two
-- unrelated real companies can share a name.
--
-- The registry row `vertex` is Vertex PHARMACEUTICALS: its Workday tenant slug
-- is `vrtx:wd501:vertex_careers`, and VRTX is that company's ticker. The DOL
-- file separately contains `Vertex, Inc.` — the tax-software company (NASDAQ:
-- VERX), an entirely different business — whose legal name also normalizes to
-- `vertex`. So the ETL joined it to the pharma company's registry row, and
-- aggregateSponsorRows then summed the two into one "company-wide" figure:
-- 154 filings across 2 entities, 17 of which belong to someone else. The
-- blended wage mix also dropped the company's entry-level share from 33.8%
-- (pharma alone) to 36.6%, which is a number describing no real company.
--
-- `Cadence, Inc.` (a contract manufacturer, 1 filing) collides with the
-- registry's `cadence` — Cadence Design Systems — the same way. Immaterial at
-- 0.3% of that company's total, and wrong regardless.
--
-- WHY IT IS A SEPARATE TABLE AND NOT A FIX TO THE ALIAS TABLE.
-- visa_sponsor_aliases is an INCLUSION map: it can only add a filing entity to
-- a company. There is no value that can be written into it to say "this entity
-- is NOT part of that company." Exclusion is the missing half, and it is a
-- different statement about the data, so it gets its own table rather than a
-- flag column that would make the alias table mean two things.
--
-- WHY NOT JUST NULL THE FK BY HAND. Two independent paths reach the same wrong
-- row, and nulling the FK only closes one:
--   1. visa_sponsors.company_ats_registry_id, set by the ETL's name join. A
--      hand-nulled FK is re-created by the next quarterly refresh.
--   2. sponsorLookup's EXACT-NAME tier, which queries
--      employer_name_normalized = normalizeCompanyName(job.company_name) and
--      never consults the FK at all. That tier finds `Vertex, Inc.` for a job
--      at "Vertex" whether or not the FK exists.
-- So the exclusion has to be consulted at BOTH the write and the read, which
-- is what the code around this table now does.
--
-- SCOPE, MEASURED RATHER THAN ASSUMED. Nine registry companies are currently
-- reached by both the exact-name join and the alias map with distinct filing
-- entities. SEVEN of those are legitimately one company and must NOT be
-- excluded: Morgan Stanley, Deloitte LLP, FedEx Corporation, Qualcomm
-- Incorporated, Aptiv Corporation, Arcadis Inc., and LexisNexis Risk
-- Solutions. Two are wrong. A 7-of-9 legitimate rate is exactly why this list
-- is hand-maintained and never generated: a rule that dropped every
-- same-name-different-entity pairing would delete far more real filings than
-- false ones.
--
-- HOW TO ADD A ROW. Confirm the registry row's real identity from its platform
-- and slug (not its display name — that is what collides), confirm the filing
-- entity is a different legal business, and record the evidence here. When in
-- doubt, leave it: an over-broad exclusion understates a company's filings,
-- which is 19.3's tolerated direction, but a wrong one hides real sponsorship.

begin;

create table public.visa_sponsor_exclusions (
  id uuid primary key default gen_random_uuid(),

  -- company_ats_registry.company_name_normalized. Deliberately NOT a foreign
  -- key, for the same reason visa_sponsor_aliases isn't: the exclusion is a
  -- fact about a NAME COLLISION and should survive the registry row being
  -- parked, re-detected, or deleted and re-inserted under a new id.
  registry_normalized_name text not null,

  -- visa_sponsors.employer_name_normalized — the filing entity to keep out.
  -- Note these two are frequently EQUAL: a name collision is precisely the case
  -- where the filer's normalized legal name matches the registry's own.
  filing_employer_name text not null,

  -- Human-readable, for maintenance only. Nothing reads these at lookup time.
  filing_employer_display text,

  -- Why this pairing was rejected. Required: an exclusion with no stated
  -- evidence is indistinguishable from a mistake six months from now.
  reason text not null,

  unique (registry_normalized_name, filing_employer_name)
);

create index visa_sponsor_exclusions_registry
  on public.visa_sponsor_exclusions (registry_normalized_name);

alter table public.visa_sponsor_exclusions enable row level security;
-- No owner column — global table, "RLS enabled, no policy" treatment, same as
-- company_ats_registry / company_sectors / visa_sponsors /
-- visa_sponsor_aliases / ats_contract_checks.

grant all on public.visa_sponsor_exclusions to anon, authenticated, service_role;

insert into public.visa_sponsor_exclusions
  (registry_normalized_name, filing_employer_name, filing_employer_display, reason) values
  ('vertex', 'vertex', 'Vertex, Inc.',
   'Registry row `vertex` is Vertex Pharmaceuticals (Workday tenant vrtx:wd501, VRTX ticker). '
   'Vertex, Inc. is the tax-software company, NASDAQ: VERX — a different business. 17 filings.'),
  ('cadence', 'cadence', 'Cadence, Inc.',
   'Registry row `cadence` is Cadence Design Systems (EDA software). Cadence, Inc. is a contract '
   'manufacturer — a different business. 1 filing.');

-- Correct the rows the ETL already linked, so the fix is live now rather than
-- at the next quarterly refresh. Written as a join against the exclusion table
-- rather than as two hardcoded updates, so re-running this after adding a row
-- does the right thing.
update public.visa_sponsors s
   set company_ats_registry_id = null
  from public.visa_sponsor_exclusions x
  join public.company_ats_registry r
    on r.company_name_normalized = x.registry_normalized_name
 where s.employer_name_normalized = x.filing_employer_name
   and s.company_ats_registry_id = r.id;

commit;

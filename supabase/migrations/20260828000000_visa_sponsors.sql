-- CareerOS — visa_sponsors (spec 19.2; Phase 5.5, §15 #48).
--
-- Aggregated U.S. DOL/OFLC H-1B LCA (Form ETA-9035) case-disclosure data, one
-- row per employer. GLOBAL, same reasoning as company_ats_registry
-- (20260805010000_company_ats_registry.sql:19), company_sectors
-- (20260807000000_company_sectors.sql:17) and ats_contract_checks
-- (20260827000000_ats_contract_checks.sql) — a company's real sponsorship
-- filing history is a fact about the company, not about any one user, so there
-- is no owner column and RLS is enabled with deliberately NO policy (only the
-- service-role key, used by the internal/admin routes and the quarterly batch
-- script, can touch this table — see global-tables-no-rls-policy for the
-- standing pattern).
--
-- NOT to be confused with the JD-text sponsorship-refusal detector
-- (detectVisaReject / tunables.visaRejectPatterns / scripts/audit-visa-
-- sponsorship.js). That reads a single posting's wording; this is
-- employer-level government filing data. They are never wired together.
--
-- employer_name_normalized is produced by 4.6.4's existing
-- normalizeCompanyName() (packages/shared/src/sourcing/ats/companyName.js),
-- reused verbatim rather than a second name-matching system — so it inherits
-- 4.6.4's documented limitation (won't catch a rename or fuzzy variant). A
-- filing whose legal name doesn't normalize to a registry row simply doesn't
-- join: company_ats_registry_id stays null and the row is still useful as a
-- standalone lookup.

begin;

create table public.visa_sponsors (
  id uuid primary key default gen_random_uuid(),

  employer_name_display text not null,
  -- 19.2's join key back to company_ats_registry. UNIQUE is the "indexed" the
  -- spec asks for, and it is a PLAIN unique (not partial), so it IS a safe
  -- .upsert({ onConflict: 'employer_name_normalized' }) target — unlike
  -- tracklists' partial name indexes (20260806000000_tracklists.sql).
  employer_name_normalized text not null unique,

  company_ats_registry_id uuid references public.company_ats_registry (id) on delete set null,

  filing_count_last_fy integer not null default 0,
  avg_wage numeric,
  -- Share of certified filings at each OES prevailing-wage level. Keys are the
  -- DOL PW_WAGE_LEVEL values confirmed against LCA_Record_Layout_FY2026_Q3.pdf:
  -- 'I', 'II', 'III', 'IV', 'N/A'. Stored deliberately, not just the count —
  -- 200 filings that are 90% Level III-IV is a poor early-career target
  -- regardless of raw sponsor-volume reputation (19.2).
  wage_level_distribution jsonb not null default '{}'::jsonb,
  top_job_titles text[] not null default '{}',

  -- 19.3: every surface displays the vintage next to the number, so no UI ever
  -- hardcodes or guesses it. These three exist precisely for that.
  source_fiscal_year integer not null,
  source_quarter integer not null,
  retrieved_at timestamptz not null default now()
);

-- Backs the registry-side lookup ("does this tracked company sponsor?") and
-- 19.5's sponsor tracklist population, which joins on this column.
create index visa_sponsors_registry_id
  on public.visa_sponsors (company_ats_registry_id)
  where company_ats_registry_id is not null;

-- Backs "biggest sponsors first" for the admin inspector and 20's watchlist
-- candidate slice.
create index visa_sponsors_filing_count
  on public.visa_sponsors (filing_count_last_fy desc);

alter table public.visa_sponsors enable row level security;
-- Deliberately no policy — service-role only, same as company_ats_registry.

grant all on public.visa_sponsors to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;

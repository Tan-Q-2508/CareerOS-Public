-- visa_sponsor_aliases (spec 19.2) — a hand-seeded bridge from a registry
-- company to the subsidiary legal names it files H-1B petitions under.
--
-- WHY THIS EXISTS. 19.2 records the load-bearing limitation: employer-name
-- matching reuses 4.6.4's normalizeCompanyName(), so a DOL filing under a
-- subsidiary legal name simply does not join. That bites the largest employers
-- hardest — "Amazon.com Services LLC" does not normalize to `amazon`, and
-- "Meta Platforms, Inc" does not normalize to `meta` — so the sponsors most
-- worth surfacing were among the least likely to join. Only 13% of registry
-- companies carried a sponsor row.
--
-- WHY IT IS A SEPARATE TABLE AND NOT A RENAME. company_ats_registry's
-- normalized name is 4.6.4's dedup/detection key. Renaming Amazon's registry
-- row to its filing name would desync it from every incoming job posting
-- normalized as `amazon`, silently creating a duplicate Amazon row. That was
-- considered and explicitly rejected. Nothing here touches
-- company_ats_registry, its normalization, or its dedup logic.
--
-- WHY IT DOES NOT VIOLATE 19.2's "no second matching system" RULE. That rule
-- is about automated fuzzy-matching logic. This is a short, hand-seeded,
-- MANUALLY MAINTAINED lookup list — both name columns hold values already run
-- through normalizeCompanyName(), so the lookup is a plain equality join, and
-- there is no algorithm here to drift.
--
-- HOW THE SEED WAS BUILT. Every unmatched filer with >= 70 certified filings
-- was tested against the registry by leading-word-prefix, and every hit was
-- reviewed BY HAND against the registry row's real platform and slug before
-- being kept. That review rejected genuine false positives a prefix rule alone
-- would have accepted: `tech` resolves to the New York Times' Workday tenant
-- (not Tech Mahindra), `columbia` to Columbia Sportswear (not Columbia
-- University), `milwaukee` to Milwaukee Tool (not the Milwaukee Board of
-- School Directors), and one `archer` row matched both Archer Aviation and
-- Archer Daniels Midland. 4.6.9's own false-positive history is why a famous
-- name is reviewed rather than trusted.

begin;

create table public.visa_sponsor_aliases (
  id uuid primary key default gen_random_uuid(),

  -- company_ats_registry.company_name_normalized. Deliberately NOT a foreign
  -- key: the alias is a fact about a NAME, and it should survive a registry
  -- row being parked, re-detected, or deleted and re-inserted under a new id.
  registry_normalized_name text not null,

  -- visa_sponsors.employer_name_normalized — the join key on the other side.
  filing_employer_name text not null,

  -- Human-readable, for maintenance only. Nothing reads this at lookup time.
  filing_employer_display text,

  unique (registry_normalized_name, filing_employer_name)
);

create index visa_sponsor_aliases_registry
  on public.visa_sponsor_aliases (registry_normalized_name);

create index visa_sponsor_aliases_filing
  on public.visa_sponsor_aliases (filing_employer_name);

alter table public.visa_sponsor_aliases enable row level security;
-- No owner column — global table, "RLS enabled, no policy" treatment, same as
-- company_ats_registry / company_sectors / visa_sponsors / ats_contract_checks.

grant all on public.visa_sponsor_aliases to anon, authenticated, service_role;

insert into public.visa_sponsor_aliases (registry_normalized_name, filing_employer_name, filing_employer_display) values
  ('amazon', 'amazon com services', 'Amazon.com Services LLC'),
  ('cognizant', 'cognizant technology solutions us', 'COGNIZANT TECHNOLOGY SOLUTIONS US CORP'),
  ('meta', 'meta platforms', 'Meta Platforms, Inc'),
  ('deloitte', 'deloitte consulting', 'Deloitte Consulting LLP'),
  ('amazon', 'amazon web services', 'Amazon Web Services, Inc.'),
  ('amazon', 'amazon development center us', 'Amazon Development Center U.S., Inc.'),
  ('fidelity', 'fidelity technology group llc d b a fidelity investments', 'Fidelity Technology Group, LLC d/b/a Fidelity Investments'),
  ('capgemini', 'capgemini america', 'Capgemini America Inc'),
  ('amazon', 'amazon data services', 'Amazon Data Services, Inc'),
  ('cisco', 'cisco systems', 'Cisco Systems, Inc.'),
  ('goldman sachs', 'goldman sachs and', 'GOLDMAN SACHS & CO. LLC'),
  ('capital one', 'capital one services', 'Capital One Services, LLC'),
  ('qualcomm', 'qualcomm technologies', 'Qualcomm Technologies, Inc.'),
  ('deloitte', 'deloitte and touche', 'Deloitte & Touche LLP'),
  ('oracle', 'oracle america', 'Oracle America, Inc.'),
  ('deloitte', 'deloitte tax', 'Deloitte Tax LLP'),
  ('morgan stanley', 'morgan stanley services group', 'Morgan Stanley Services Group Inc.'),
  ('goldman sachs', 'goldman sachs services', 'GOLDMAN SACHS SERVICES LLC'),
  ('capital one', 'capital one national association', 'Capital One, National Association'),
  ('barclays', 'barclays services', 'Barclays Services Corp.'),
  ('micron', 'micron technology', 'Micron Technology, Inc.'),
  ('wells fargo', 'wells fargo bank na', 'Wells Fargo Bank, N.A.'),
  ('blackrock', 'blackrock financial management', 'BlackRock Financial Management, Inc.'),
  ('comcast', 'comcast cable communications', 'Comcast Cable Communications, LLC'),
  ('nokia', 'nokia of america', 'Nokia of America Corporation'),
  ('goldman sachs', 'goldman sachs bank usa', 'Goldman Sachs Bank USA'),
  ('cadence', 'cadence design systems', 'Cadence Design Systems, Inc.'),
  ('visa', 'visa technology and operations', 'Visa Technology & Operations LLC'),
  ('regeneron', 'regeneron pharmaceuticals', 'Regeneron Pharmaceuticals, Inc.'),
  ('fis', 'fis management services', 'FIS Management Services, LLC'),
  ('visa', 'visa usa', 'Visa U.S.A. Inc.'),
  ('medline', 'medline industries', 'Medline Industries, LP.'),
  ('marvell', 'marvell semiconductor', 'Marvell Semiconductor, Inc.'),
  ('morgan stanley', 'morgan stanley and', 'Morgan Stanley & Co., LLC'),
  ('wsp', 'wsp usa', 'WSP USA Inc.'),
  ('openai', 'openai opco', 'OpenAI OpCo, LLC'),
  ('anthropic', 'anthropic pbc', 'Anthropic, PBC'),
  ('zoom', 'zoom communications', 'Zoom Communications, Inc.'),
  ('yahoo', 'yahoo holdings', 'Yahoo Holdings Inc.'),
  ('mastercard', 'mastercard technologies', 'Mastercard Technologies, LLC'),
  ('robinhood', 'robinhood markets', 'ROBINHOOD MARKETS, INC'),
  ('dell', 'dell usa', 'Dell USA L.P.'),
  ('montefiore', 'montefiore medical center', 'Montefiore Medical Center'),
  ('barclays', 'barclays capital', 'Barclays Capital Inc.'),
  ('vertex', 'vertex pharmaceuticals', 'Vertex Pharmaceuticals Incorporated'),
  ('dell', 'dell products', 'Dell Products L.P.'),
  ('citizens', 'citizens financial group', 'Citizens Financial Group, Inc.'),
  ('fca', 'fca us', 'FCA US LLC'),
  ('fedex', 'fedex freight', 'FedEx Freight, Inc.'),
  ('rbc', 'rbc capital markets', 'RBC Capital Markets LLC'),
  ('honeywell', 'honeywell international', 'Honeywell International Inc.'),
  ('amazon', 'amazon advertising', 'Amazon Advertising LLC'),
  ('stantec', 'stantec consulting services', 'Stantec Consulting Services Inc.'),
  ('nxp', 'nxp usa', 'NXP USA, Inc.'),
  ('pwc', 'pwc us tax', 'PwC US Tax LLP'),
  ('cincinnati childrens', 'cincinnati childrens hospital medical center', 'Cincinnati Children''s Hospital Medical Center'),
  ('target', 'target enterprise', 'Target Enterprise, Inc.'),
  ('crusoe', 'crusoe energy systems', 'Crusoe Energy Systems, Inc.'),
  ('cedars sinai', 'cedars sinai medical center', 'Cedars-Sinai Medical Center'),
  ('microchip', 'microchip technology', 'Microchip Technology Inc.'),
  ('ss and c', 'ss and c technologies', 'SS&C Technologies, Inc.'),
  ('astrazeneca', 'astrazeneca pharmaceuticals', 'AstraZeneca Pharmaceuticals LP'),
  ('samsung electronics', 'samsung electronics america', 'Samsung Electronics America, Inc.'),
  ('adventist health', 'adventist health system sunbelt', 'Adventist Health System/Sunbelt, Inc.'),
  ('deloitte', 'deloitte services', 'Deloitte Services LP'),
  ('pwc', 'pwc us consulting', 'PwC US Consulting LLP'),
  ('fujitsu', 'fujitsu north america', 'Fujitsu North America, Inc.'),
  ('new york life', 'new york life insurance', 'New York Life Insurance Company'),
  ('qualcomm', 'qualcomm atheros', 'Qualcomm Atheros, Inc.'),
  ('aptiv', 'aptiv us services general partnership', 'Aptiv US Services General Partnership'),
  ('globalfoundries', 'globalfoundries us', 'GlobalFoundries U.S., Inc.'),
  ('arcadis', 'arcadis us', 'Arcadis U.S., Inc.'),
  ('guidewire', 'guidewire software', 'Guidewire Software, Inc.'),
  ('novartis', 'novartis pharmaceuticals', 'NOVARTIS PHARMACEUTICALS CORPORATION'),
  ('mastercard', 'mastercard international', 'Mastercard International Incorporated'),
  ('godaddy', 'godaddy com', 'GoDaddy.com, LLC'),
  ('lexisnexis risk solutions', 'lexisnexis risk solutions fl', 'LexisNexis Risk Solutions FL, Inc.'),
  ('spotify', 'spotify usa', 'SPOTIFY USA, INC.'),
  ('abbott', 'abbott laboratories', 'ABBOTT LABORATORIES'),
  ('northwestern mutual', 'northwestern mutual life insurance', 'Northwestern Mutual Life Insurance Company'),
  ('cox', 'cox automotive corporate services', 'Cox Automotive Corporate Services, LLC'),
  ('fractal', 'fractal analytics', 'Fractal Analytics, Inc.'),
  ('centene', 'centene management', 'Centene Management Company, LLC'),
  ('brown', 'brown university', 'Brown University'),
  ('bayer', 'bayer research and development services', 'Bayer Research and Development Services LLC')
on conflict (registry_normalized_name, filing_employer_name) do nothing;

notify pgrst, 'reload schema';

commit;

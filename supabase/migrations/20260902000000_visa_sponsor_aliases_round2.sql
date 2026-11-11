-- CareerOS — visa_sponsor_aliases, second hand-reviewed pass (spec 19.2; §15 #53).
--
-- The first seed (20260830000000) covered 85 live pairings over 68 companies. §15 #53's
-- aggregation work then made the gaps matter more: with filing counts now SUMMED
-- across a company's entities, an entity missing from this table is no longer a
-- second-best answer that loses to a bigger row — it is filings silently absent
-- from the company's total. Amazon read 19,890 against 13 real filing entities,
-- of which only 5 were covered here.
--
-- SAME DISCIPLINE AS THE FIRST SEED, and it mattered more this time. Candidates
-- were found by leading-word prefix against unjoined sponsor rows above a
-- 20-filing group floor, then reviewed BY HAND, one row at a time, against the
-- registry row's real identity. The prefix rule proposed 27 groups; 3 were
-- rejected outright and individual rows were dropped from 6 more. This is not a
-- mining pass and must never become one (19.2) — the rejections below are the
-- reason.
--
-- REJECTED IN FULL, with cause:
--
--   brown      — the registry row is Brown University (workday/brown:wd5:
--                staff-careers-brown). The prefix matched Brown Brothers Harriman,
--                Brown-Forman, Brown Rudnick, Brown & Brown, Brown County Hospital,
--                Brown Immigration Law and five more. Not one is the university.
--   vertex     — the registry row is Vertex Pharmaceuticals (workday/vrtx). The
--                prefix matched Vertex Analytics, Vertex ETS, Vertex Computer
--                Systems, Vertex Elite, Vertex IT Systems, Vertex Consulting,
--                Vertex Education, Vertex Innovation and Vertex Resource Services
--                — ten unrelated IT/staffing/education firms, zero pharma.
--   adventist  — "Adventist Health System Sunbelt Healthcare Corp" (41 filings) is
--     health     AdventHealth, a legally separate organization from the registry's
--                Adventist Health. The two split; sharing a founding name is not
--                sharing an employer. Ambiguous, so excluded entirely rather than
--                partly — including only the small unambiguous row would leave the
--                misleading impression the group had been resolved.
--
-- REJECTED INDIVIDUALLY, from otherwise-accepted groups:
--
--   abbott     — Abbott Construction, Abbott Interfast, Abbott Anesthesiologist
--                Associates P.C. Unrelated firms sharing a common surname.
--   blackrock  — Blackrock Microsystems (a neurotech device maker, not the asset
--                manager) and BlackRock Resources (ambiguous).
--   meta       — META IT SYSTEMS, Meta Soft, Meta Hub IT Solutions, META IT CORP,
--                Meta Development, Meta Tools Technologies. Six unrelated IT
--                staffing firms. Only "Meta Payments Inc. (formerly known as
--                Facebook Payments, Inc)" is kept, and only because the filing name
--                itself states the lineage.
--   oracle     — ORACLE ROBOTICS CORP. Not Oracle Corporation.
--   fidelity   — Fidelity National Management Services (Fidelity National
--                Financial), Fidelity & Guaranty Life (F&G), Fidelity Memorial
--                Group, Fidelity Technology Group. Distinct companies; "Fidelity"
--                is one of the most collision-prone names in this dataset. Only the
--                entities whose filing name literally carries "d/b/a Fidelity
--                Investments" are kept — FMR states the relationship itself.
--
-- 82 accepted pairings over 24 companies, adding 1,351 certified filings. Every
-- filing_employer_name below was verified to exist EXACTLY in visa_sponsors, and
-- every registry_normalized_name already has rows in this table. Purely additive;
-- re-runnable.

begin;

insert into public.visa_sponsor_aliases (registry_normalized_name, filing_employer_name, filing_employer_display)
values
  -- abbott
  ('abbott', 'abbott diabetes care', 'ABBOTT DIABETES CARE INC.'),
  ('abbott', 'abbott diabetes care sales', 'ABBOTT DIABETES CARE SALES CORPORATION'),
  ('abbott', 'abbott cardiovascular systems', 'ABBOTT CARDIOVASCULAR SYSTEMS INC.'),
  ('abbott', 'abbott diagnostics scarborough', 'ABBOTT DIAGNOSTICS SCARBOROUGH, INC.'),
  ('abbott', 'abbott rapid diagnostics informatics', 'ABBOTT RAPID DIAGNOSTICS INFORMATICS, INC.'),
  ('abbott', 'abbott point of care', 'ABBOTT POINT OF CARE INC.'),
  -- amazon
  ('amazon', 'amazon retail', 'Amazon Retail LLC'),
  ('amazon', 'amazon media venture', 'Amazon Media Venture LLC'),
  ('amazon', 'amazon payments', 'Amazon Payments, Inc.'),
  ('amazon', 'amazon kuiper manufacturing enterprises', 'Amazon Kuiper Manufacturing Enterprises LLC'),
  ('amazon', 'amazon studios', 'Amazon Studios, LLC'),
  ('amazon', 'amazon web services puerto rico', 'Amazon Web Services Puerto Rico LLC'),
  ('amazon', 'amazon capital services', 'Amazon Capital Services, Inc.'),
  ('amazon', 'amazon digital services', 'Amazon Digital Services LLC'),
  ('amazon', 'amazon usa enterprise', 'Amazon USA Enterprise Corp.'),
  -- barclays
  ('barclays', 'barclays bank delaware', 'Barclays Bank Delaware'),
  ('barclays', 'barclays bank', 'Barclays Bank PLC'),
  -- bayer
  ('bayer', 'bayer cropscience', 'Bayer CropScience LP'),
  ('bayer', 'bayer us', 'Bayer U.S. LLC'),
  ('bayer', 'bayer healthcare', 'Bayer HealthCare LLC'),
  ('bayer', 'bayer healthcare pharmaceuticals', 'Bayer HealthCare Pharmaceuticals Inc.'),
  ('bayer', 'bayer production supply', 'Bayer Production Supply LLC'),
  -- blackrock
  ('blackrock', 'blackrock investment management', 'BlackRock Investment Management, LLC'),
  ('blackrock', 'blackrock institutional trust company na', 'BlackRock Institutional Trust Company, N.A.'),
  ('blackrock', 'blackrock corporation us', 'BlackRock Corporation US, Inc.'),
  ('blackrock', 'blackrock institutional services', 'BlackRock Institutional Services, Inc.'),
  ('blackrock', 'blackrock realty advisors', 'BlackRock Realty Advisors, Inc.'),
  -- cognizant
  ('cognizant', 'cognizant trizetto software group', 'Cognizant TriZetto Software Group, Inc.'),
  ('cognizant', 'cognizant mobility', 'Cognizant Mobility, Inc.'),
  ('cognizant', 'cognizant worldwide', 'COGNIZANT WORLDWIDE LIMITED'),
  -- dell
  ('dell', 'dell marketing', 'DELL MARKETING L.P.'),
  ('dell', 'dell puerto rico', 'DELL PUERTO RICO CORPORATION'),
  -- deloitte
  ('deloitte', 'deloitte touche tohmatsu services', 'Deloitte Touche Tohmatsu Services, LLC'),
  ('deloitte', 'deloitte transactions and business analytics', 'Deloitte Transactions and Business Analytics LLP'),
  ('deloitte', 'deloitte financial advisory services', 'Deloitte Financial Advisory Services LLP'),
  -- fedex
  ('fedex', 'fedex dataworks', 'FedEx Dataworks, Inc.'),
  ('fedex', 'fedex supply chain', 'FedEx Supply Chain, Inc.'),
  ('fedex', 'fedex custom critical', 'FedEx Custom Critical'),
  ('fedex', 'fedex logistics', 'FedEx Logistics, Inc.'),
  -- fidelity
  ('fidelity', 'fidelity brokerage services llc d b a fidelity investments', 'Fidelity Brokerage Services LLC d/b/a Fidelity Investments'),
  ('fidelity', 'fidelity management and research company llc d b a fidelity investments', 'Fidelity Management & Research Company LLC d/b/a Fidelity Investments'),
  ('fidelity', 'fidelity workplace investing llc d b a fidelity investments', 'Fidelity Workplace Investing LLC d/b/a Fidelity Investments'),
  ('fidelity', 'fidelity investments institutional operations company d b a fidelity investments', 'Fidelity Investments Institutional Operations Company d/b/a Fidelity Investments'),
  ('fidelity', 'fidelity service company inc d b a fidelity investments', 'Fidelity Service Company, Inc. d/b/a Fidelity Investments'),
  ('fidelity', 'fidelity private shares llc d b a fidelity investments', 'Fidelity Private Shares LLC d/b/a Fidelity Investments'),
  ('fidelity', 'fidelity digital asset services llc d b a fidelity investments', 'Fidelity Digital Asset Services LLC d/b/a Fidelity Investments'),
  ('fidelity', 'fidelity distributors company llc d b a fidelity investments', 'Fidelity Distributors Company LLC d/b/a Fidelity Investments'),
  ('fidelity', 'fidelity global brokerage group inc d b a fidelity investments', 'Fidelity Global Brokerage Group, Inc. d/b/a Fidelity Investments'),
  ('fidelity', 'fidelity health insurance services llc d b a fidelity investments', 'Fidelity Health Insurance Services, LLC d/b/a Fidelity Investments'),
  -- goldman sachs
  ('goldman sachs', 'goldman sachs wealth services', 'GOLDMAN SACHS WEALTH SERVICES, L.P.'),
  -- honeywell
  ('honeywell', 'honeywell aerospace us', 'Honeywell Aerospace US, LLC'),
  ('honeywell', 'honeywell electronic chemicals', 'Honeywell Electronic Chemicals LLC'),
  ('honeywell', 'honeywell security americas', 'Honeywell Security Americas, LLC'),
  -- meta
  ('meta', 'meta payments inc formerly known as facebook payments', 'Meta Payments Inc. (formerly known as Facebook Payments, Inc)'),
  -- micron
  ('micron', 'micron idaho semiconductor manufacturing triton', 'Micron Idaho Semiconductor Manufacturing (Triton) LLC'),
  ('micron', 'micron semiconductor products', 'Micron Semiconductor Products, Inc.'),
  -- montefiore
  ('montefiore', 'montefiore health system', 'Montefiore Health System, Inc.'),
  ('montefiore', 'montefiore new rochelle hospital', 'Montefiore New Rochelle Hospital'),
  ('montefiore', 'montefiore st lukes cornwall', 'Montefiore St. Luke''s Cornwall'),
  ('montefiore', 'montefiore mount vernon hospital', 'Montefiore Mount Vernon Hospital'),
  ('montefiore', 'montefiore nyack hospital', 'Montefiore Nyack Hospital'),
  -- morgan stanley
  ('morgan stanley', 'morgan stanley smith barney', 'Morgan Stanley Smith Barney LLC'),
  ('morgan stanley', 'morgan stanley investment management', 'Morgan Stanley Investment Management Inc.'),
  ('morgan stanley', 'morgan stanley fund services', 'Morgan Stanley Fund Services Inc.'),
  ('morgan stanley', 'morgan stanley bank na', 'Morgan Stanley Bank N.A.'),
  ('morgan stanley', 'morgan stanley private bank na', 'Morgan Stanley Private Bank NA'),
  ('morgan stanley', 'morgan stanley bank n a', 'Morgan Stanley Bank, N.A'),
  ('morgan stanley', 'morgan stanley capital group', 'Morgan Stanley Capital Group Inc.'),
  -- novartis
  ('novartis', 'novartis institutes for biomedical research', 'Novartis Institutes for BioMedical Research, Inc.'),
  ('novartis', 'novartis services', 'Novartis Services Inc.'),
  ('novartis', 'novartis gene therapies', 'Novartis Gene Therapies, Inc.'),
  -- oracle
  ('oracle', 'oracle financial services software', 'Oracle Financial Services Software, Inc.'),
  -- pwc
  ('pwc', 'pwc us business advisory', 'PwC US Business Advisory LLP'),
  ('pwc', 'pwc us group', 'PwC US Group LLP'),
  ('pwc', 'pwc product sales', 'PwC Product Sales LLC'),
  -- qualcomm
  ('qualcomm', 'qualcomm innovation center', 'Qualcomm Innovation Center, Inc.'),
  -- regeneron
  ('regeneron', 'regeneron genetics center', 'Regeneron Genetics Center, LLC'),
  ('regeneron', 'regeneron healthcare solutions', 'Regeneron Healthcare Solutions, Inc.'),
  -- stantec
  ('stantec', 'stantec architecture', 'Stantec Architecture Inc.'),
  -- wells fargo
  ('wells fargo', 'wells fargo securities', 'Wells Fargo Securities, LLC'),
  ('wells fargo', 'wells fargo clearing services', 'Wells Fargo Clearing Services, LLC'),
  -- wsp
  ('wsp', 'wsp usa buildings', 'WSP USA BUILDINGS INC.')
on conflict (registry_normalized_name, filing_employer_name) do nothing;

commit;

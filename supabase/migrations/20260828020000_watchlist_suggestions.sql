-- CareerOS — watchlist_suggestions (spec 20; Phase 5.5, §15 #50).
--
-- Staging table for the AI-curated watchlist. USER-SCOPED with the standard
-- owns_row RLS — deliberately unlike this arc's other new tables
-- (visa_sponsors, company_ats_registry, company_sectors, ats_contract_checks),
-- which are global because they describe companies. A suggestion is about one
-- user's search, so it gets the ordinary Session-1/2 treatment.
--
-- STAGED, NEVER AUTO-SAVED (spec 20, step 3). Rows land here as 'pending' and
-- the user accepts or rejects each one individually; accepting writes a real
-- tracklist_companies row through 4.6.8's existing multiselect-add flow.
-- Nothing is silently persisted wholesale, matching 4.4's
-- surfaced-not-silently-persisted posture for scan results. This table is the
-- entire mechanism by which that is true — without it, a curate run would have
-- to either write tracklist rows directly or hold results in memory.
--
-- `rationale` is not decoration. Spec 20's grounding rule, matching CLAUDE.md's
-- never-fabricate non-negotiable, is that every recommended company cites the
-- specific data point that justified it — a visa_sponsors stat, a
-- registry/sector fact, or a résumé-profile match. A candidate citing no real,
-- checkable data point is DROPPED BY THE VALIDATOR before it ever reaches this
-- table, the same enforcement posture 5.6's bullet-id grounding uses. So every
-- row here carries its citation, and a null/empty rationale is a bug.

begin;

create table public.watchlist_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,

  company_ats_registry_id uuid not null references public.company_ats_registry (id) on delete cascade,

  -- Rank within its own curate run, 1 = best. Kept rather than re-derived so
  -- the list renders in the order the model actually returned.
  rank integer not null,
  -- The grounded one-liner (see above).
  rationale text not null,
  -- Which kind of evidence the rationale cites, for the validator and for the
  -- UI to group by. Mirrored in packages/shared/src/constants.js — the same
  -- three-place pattern company_ats_registry.platform uses.
  evidence_type text not null check (evidence_type in ('visa_sponsor', 'sector', 'resume_match')),

  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),

  -- The free-text input for the run that produced this row (null when the user
  -- gave none — empty input is valid, spec 20). Kept so a user can see what
  -- they asked for when reviewing a list they generated yesterday.
  run_input text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,

  -- One live suggestion per company per user. Re-running curate should update
  -- an existing pending row rather than stack duplicates. PLAIN unique, so it
  -- IS a safe .upsert({ onConflict }) target.
  unique (user_id, company_ats_registry_id)
);

-- Backs the review list: this user's pending suggestions, best first.
create index watchlist_suggestions_user_status
  on public.watchlist_suggestions (user_id, status, rank);

alter table public.watchlist_suggestions enable row level security;

create policy owns_row on public.watchlist_suggestions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on public.watchlist_suggestions to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;

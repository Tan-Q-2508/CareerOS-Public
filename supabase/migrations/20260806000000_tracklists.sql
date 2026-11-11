-- Tracklists — personal, multi-list company organization (spec 4.6.8; Phase 4,
-- §15 #25a, first of the 25a-25d split — see the 2026-08-06 planning-update note
-- in Section 0.1 for why #25 split, and 4.6.8's header for the motivation:
-- company_ats_registry hit 11,534 rows (§23's bulk import) and a single flat
-- user_tracked_companies list per user stopped being a usable UX.
--
-- Replaces user_tracked_companies (20260805010000) as the write/read surface
-- for tracking — that table is left in place, unread after this migration, as
-- a rollback path in a live-only environment with no staging (dropped once
-- 25c has proven out, not here).
--
-- Written/read by apps/server/src/companies/tracklists.js (CRUD + membership)
-- and apps/server/src/companies/registry.js (retargeted trackCompany/
-- untrackCompany/listTrackedCompanies/listKnownCompanies/listScanCompanies).
--
-- THREE TABLES (4.6.8):
--   tracklists            — a named list, personal (user_id set) or system
--                            (user_id NULL, is_system true — populated by 25b,
--                            no system rows created by this migration).
--   tracklist_companies   — join: which companies are in which tracklist.
--   tracklist_subscriptions — how a user opts into a SYSTEM tracklist without
--                            copying its rows (25b's sector lists). Personal
--                            tracklists don't use this table — a user's own
--                            lists are implicitly "subscribed" by ownership.
--
-- RLS NOTE (4.6.8 describes this as two different policies — it's one). The
-- standard verbatim owns_row (auth.uid() = user_id) evaluates to NULL -> false
-- for a system row (user_id IS NULL), so a single owns_row policy on tracklists
-- already gives "owner can do anything to their own list" AND "nobody but
-- service-role can touch a system list" simultaneously. Do not add a second
-- policy for system rows — there is nothing for it to do that owns_row doesn't
-- already do by NULL falling out of the equality check.
--
-- PARTIAL UNIQUE INDEXES, CLAUDE.md gotcha flagged for whoever writes the JS:
-- both name-uniqueness indexes below have a WHERE clause, so Supabase's
-- .upsert({onConflict}) cannot target them (the upsert API exposes neither a
-- repeated WHERE nor a named-constraint reference). tracklists.js uses
-- select-then-insert-or-update, the same pattern provider_credentials already
-- uses for its own partial-index uniqueness.

begin;

-- ---------------------------------------------------------------------------
-- tracklists (4.6.8)
-- ---------------------------------------------------------------------------
create table public.tracklists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,  -- NULL for a system (sector) list
  name text not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A list is either personal-with-an-owner or system-with-no-owner; the two
  -- other combinations (owned system list, orphan personal list) would break
  -- the single-owns_row-policy RLS reasoning above.
  constraint tracklists_ownership_shape check (
    (is_system and user_id is null) or (not is_system and user_id is not null)
  )
);

-- A user can't have two personal lists with the same (case-insensitive) name.
create unique index tracklists_user_name_uniq
  on public.tracklists (user_id, lower(name))
  where user_id is not null;

-- One system list per sector name (25b populates these; unique from day one).
create unique index tracklists_system_name_uniq
  on public.tracklists (lower(name))
  where is_system;

create index tracklists_user on public.tracklists (user_id) where user_id is not null;

create trigger set_updated_at before update on public.tracklists
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- tracklist_companies (4.6.8) — which companies are in which tracklist.
-- ---------------------------------------------------------------------------
create table public.tracklist_companies (
  id uuid primary key default gen_random_uuid(),
  tracklist_id uuid not null references public.tracklists(id) on delete cascade,
  company_ats_registry_id uuid not null references public.company_ats_registry(id) on delete cascade,
  added_at timestamptz not null default now(),
  unique (tracklist_id, company_ats_registry_id)  -- plain unique (no WHERE) — onConflict IS safe here
);

create index tracklist_companies_registry on public.tracklist_companies (company_ats_registry_id);

-- ---------------------------------------------------------------------------
-- tracklist_subscriptions (4.6.8) — a user opting into a SYSTEM tracklist
-- without copying its rows; a new company the sector-tagging pipeline (25b)
-- adds is instantly visible to every subscriber, no backfill needed.
-- ---------------------------------------------------------------------------
create table public.tracklist_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  tracklist_id uuid not null references public.tracklists(id) on delete cascade,
  subscribed_at timestamptz not null default now(),
  unique (user_id, tracklist_id)
);

create index tracklist_subscriptions_user on public.tracklist_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.tracklists enable row level security;
create policy owns_row on public.tracklists
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.tracklist_companies enable row level security;
-- No user_id column on this table — access is via its parent tracklist's
-- ownership, same "inherits from parent" shape as any join table in this
-- schema without its own owner column.
create policy owns_row on public.tracklist_companies
  for all using (
    exists (select 1 from public.tracklists t where t.id = tracklist_id and t.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.tracklists t where t.id = tracklist_id and t.user_id = auth.uid())
  );

alter table public.tracklist_subscriptions enable row level security;
create policy owns_row on public.tracklist_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on public.tracklists to anon, authenticated, service_role;
grant all on public.tracklist_companies to anon, authenticated, service_role;
grant all on public.tracklist_subscriptions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Data migration: one-for-one, user_tracked_companies -> a new personal
-- tracklist per user named "My Tracked Companies" (4.6.8's specified default),
-- preserving tracked_at as added_at so first-tracked ordering survives. No data
-- loss, no re-tracking asked of anyone who already built up a list.
-- ---------------------------------------------------------------------------
with new_lists as (
  insert into public.tracklists (user_id, name, is_system)
  select distinct user_id, 'My Tracked Companies', false
  from public.user_tracked_companies
  returning id, user_id
)
insert into public.tracklist_companies (tracklist_id, company_ats_registry_id, added_at)
select nl.id, utc.company_ats_registry_id, utc.tracked_at
from public.user_tracked_companies utc
join new_lists nl on nl.user_id = utc.user_id;

commit;

notify pgrst, 'reload schema';

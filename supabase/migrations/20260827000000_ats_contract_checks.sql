-- CareerOS — ats_contract_checks (spec 18.3; Phase 5.5, §15 #44).
--
-- Custom Adapter Tier (18.2) contract-drift canary results. GLOBAL, same
-- reasoning as company_ats_registry (20260805010000_company_ats_registry.sql:19)
-- and company_sectors (20260807000000_company_sectors.sql:17) — a platform's
-- response shape is a fact about the platform, not about any one user, so
-- there is no owner column and RLS is enabled with deliberately NO policy
-- (only the service-role key, used by the internal/admin routes, can touch
-- this table — see global-tables-no-rls-policy for the standing pattern).

begin;

create table public.ats_contract_checks (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  checked_at timestamptz not null default now(),
  ok boolean not null,
  missing_fields text[] not null default '{}',
  error_message text
);

-- Backs "latest check per platform" (GET /api/admin/ats-contract-checks) and
-- a platform's own history.
create index ats_contract_checks_platform_checked_at
  on public.ats_contract_checks (platform, checked_at desc);

alter table public.ats_contract_checks enable row level security;
-- Deliberately no policy — service-role only, same as company_ats_registry.

grant all on public.ats_contract_checks to anon, authenticated, service_role;

commit;

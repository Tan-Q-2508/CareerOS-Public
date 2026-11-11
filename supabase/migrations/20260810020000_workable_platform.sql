-- CareerOS — widen company_ats_registry.platform to include 'workable' (spec
-- 4.6.1 Tier 2; Phase 4, §15 #27).
--
-- 'workday' was already allowed by 20260805010000_company_ats_registry.sql's
-- original check constraint (added speculatively ahead of the Tier 2 adapter
-- actually being built) — only 'workable' is new here. Postgres has no
-- ALTER CHECK, so the constraint is dropped and recreated with the widened list.

begin;

alter table public.company_ats_registry drop constraint company_ats_registry_platform_check;
alter table public.company_ats_registry
  add constraint company_ats_registry_platform_check
  check (platform in ('greenhouse', 'lever', 'ashby', 'workday', 'workable'));

commit;

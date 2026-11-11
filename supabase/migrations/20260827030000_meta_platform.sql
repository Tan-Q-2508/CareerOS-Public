-- CareerOS — widen company_ats_registry.platform to include 'meta' (spec
-- 18.2 Custom Adapter Tier; Phase 5.5, §15 #47).
--
-- Postgres has no ALTER CHECK, so the constraint is dropped and recreated
-- with the widened list, same mechanism as 20260826010000_oracle_platform.sql.

begin;

alter table public.company_ats_registry drop constraint company_ats_registry_platform_check;
alter table public.company_ats_registry
  add constraint company_ats_registry_platform_check
  check (platform in ('greenhouse', 'lever', 'ashby', 'workday', 'workable', 'oracle', 'eightfold', 'avature', 'apple', 'amazon', 'google', 'meta', 'phenom'));

commit;

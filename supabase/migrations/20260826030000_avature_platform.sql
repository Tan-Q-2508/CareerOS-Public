-- CareerOS — widen company_ats_registry.platform to include 'avature' (spec
-- 18.1 Tier 2.5; Phase 5.5, §15 #41).
--
-- Postgres has no ALTER CHECK, so the constraint is dropped and recreated
-- with the widened list, same mechanism as 20260826020000_eightfold_platform.sql.

begin;

alter table public.company_ats_registry drop constraint company_ats_registry_platform_check;
alter table public.company_ats_registry
  add constraint company_ats_registry_platform_check
  check (platform in ('greenhouse', 'lever', 'ashby', 'workday', 'workable', 'oracle', 'eightfold', 'avature'));

commit;

-- Widen company_ats_unresolved.match_attempt_type to allow a third reason:
-- a company that WAS resolved (had a working board in company_ats_registry)
-- but is now confirmed dead by a live probe (404). The existing two values
-- ('url_no_match', 'name_guess_failed') both describe "never found a board
-- in the first place" and don't honestly fit this case.
--
-- This is what makes scripts/park-dead-boards.js's registry -> unresolved
-- move possible: previously a company existed in exactly one of the two
-- tables, with 'unresolved -> registry' as the only direction (resweep.js's
-- promoteToRegistry). Now the reverse direction (registry -> unresolved) is
-- also legitimate, and needs its own reason code.
--
-- Constraint name looked up dynamically rather than assumed, since it's an
-- inline column-level check with an auto-generated name.

do $$
declare
  cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'public.company_ats_unresolved'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%match_attempt_type%';

  if cname is not null then
    execute format('alter table public.company_ats_unresolved drop constraint %I', cname);
  end if;
end $$;

alter table public.company_ats_unresolved
  add constraint company_ats_unresolved_match_attempt_type_check
  check (match_attempt_type in ('url_no_match', 'name_guess_failed', 'board_confirmed_dead'));

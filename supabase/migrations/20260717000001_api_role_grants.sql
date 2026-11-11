-- CareerOS — API role grants (Phase 1, Session 1)
--
-- The init migration created tables owned by `postgres` but did not grant the
-- Supabase API roles (anon / authenticated / service_role) the DML privileges
-- they need. RLS (enabled in the init migration) is what actually enforces
-- per-user row access; these grants are the base table privileges that sit
-- underneath it — the standard Supabase grant model. Without them the
-- service-role backend gets "permission denied for table ...".
--
-- Safe/idempotent to re-run.

grant usage on schema public to anon, authenticated, service_role;

grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

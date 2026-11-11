-- Phase 3 bug fix (2026-08-02): "Copilot for skill section" — user-editable
-- header/contact record, separate from parsed_profile (which is an immutable
-- per-résumé-version snapshot and the wrong home for something the user edits
-- independently of re-uploading their résumé). Mirrors the years_of_experience/
-- domain_keywords_manual precedent (20260725000000_bugs_batch.sql) — a manual
-- edit wins outright and is never silently overwritten by a later parse.
alter table public.users
  add column if not exists contact_name text,
  add column if not exists contact_city_state text,
  add column if not exists contact_phone text,
  add column if not exists contact_email text,
  add column if not exists contact_linkedin_url text,
  add column if not exists contact_portfolio_url text,
  add column if not exists contact_website_url text,
  add column if not exists contact_manual boolean not null default false;

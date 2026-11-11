-- Multi-actor BYO Scraper runtime — Stage 1 (2026-07-19, explicit sign-off).
-- provider_credentials becomes multi-row per user for sourcing (one row per saved
-- Apify actor), each with its own encrypted key, label, and per-actor job ceiling.
-- The old blanket UNIQUE(user_id, provider_name) blocked >1 apify row per user.

begin;

-- Drop the blanket uniqueness that forbade multiple 'apify' sourcing rows.
alter table public.provider_credentials
  drop constraint if exists provider_credentials_user_id_provider_name_key;

-- Spec-named per-actor columns (were carried loosely in config_json before).
alter table public.provider_credentials add column if not exists label text;
alter table public.provider_credentials add column if not exists job_count_max integer;

-- Keep one AI key per provider per user (partial: sourcing rows are exempt).
create unique index if not exists provider_credentials_ai_provider_unique
  on public.provider_credentials (user_id, provider_name)
  where provider_type = 'ai';

-- No duplicate actor labels within a user's sourcing actors.
create unique index if not exists provider_credentials_sourcing_label_unique
  on public.provider_credentials (user_id, label)
  where provider_type = 'sourcing';

commit;

notify pgrst, 'reload schema';

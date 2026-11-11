-- Session 10 — Gmail "Check Email for Updates" (spec §9.1).
-- Stores each user's Google OAuth *refresh token* (encrypted) so the server can
-- mint short-lived Gmail access tokens per "Check Email" click, without forcing
-- Gmail consent on every login. Acquisition is Supabase-mediated (a separate
-- opt-in "Connect Gmail" grant with the gmail.readonly scope + offline access);
-- Supabase hands back provider_refresh_token once, we encrypt + store it here.
--
-- Deliberately its own table, not a provider_credentials row: that table's
-- provider_type/provider_name CHECKs are tuned to sourcing/AI BYOK keys. This
-- table also serves Phase-2 Google Drive (11.3) under the same OAuth grant.
--
-- Encryption reuses apps/server/src/lib/secretCrypto.js (AES-256-GCM,
-- CREDENTIALS_MASTER_KEY) — the same Phase-2-KMS seam as provider_credentials.

begin;

create table public.google_oauth_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  google_email text,
  encrypted_refresh_token text not null,
  scopes text,
  validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.google_oauth_credentials
  for each row execute function public.set_updated_at();

-- RLS defense-in-depth (Express uses the service-role key and bypasses this;
-- the policy only matters for any future direct-to-Supabase client path).
alter table public.google_oauth_credentials enable row level security;
create policy owns_row on public.google_oauth_credentials
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

commit;

notify pgrst, 'reload schema';

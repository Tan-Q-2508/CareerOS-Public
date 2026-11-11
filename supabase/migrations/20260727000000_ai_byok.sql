-- Full AI BYOK (spec 13.3/15#14, Phase 2 session 14). A user can route every AI
-- call through their own key (Gemini/OpenAI-compatible/Anthropic) instead of
-- CAI. One active provider at a time — provider_credentials already allows at
-- most one row per (user_id, provider_name) where provider_type='ai' (the
-- Stage-1 sourcing migration's partial unique index), so a user can save keys
-- for more than one AI provider but only one is ever "live"; this column picks
-- which. null means CAI (the default, unchanged behavior).

alter table public.users add column if not exists active_ai_provider text;

alter table public.users
  add constraint users_active_ai_provider_check
  check (active_ai_provider is null or active_ai_provider in ('gemini', 'openai_compatible', 'anthropic'));

notify pgrst, 'reload schema';

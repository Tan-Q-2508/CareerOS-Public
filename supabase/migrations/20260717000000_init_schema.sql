-- CareerOS — initial schema (Phase 1, Session 1)
-- Covers every table in CareerOS_Spec_v2.md Section 2's canonical list.
-- Phase 1: cos_transactions logs unbilled; no enforcement anywhere in this migration.

-- ---------------------------------------------------------------------------
-- Shared helper: updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- users (extends auth.users)
-- ---------------------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  years_of_experience numeric,
  domain_keywords text[],
  off_domain_title_keywords text[],
  cos_balance numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.users
  for each row execute function public.set_updated_at();

-- Auto-create a public.users row whenever a new auth.users row appears
-- (email/password signup or Google OAuth both land here identically).
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- resume_versions
-- ---------------------------------------------------------------------------
create table public.resume_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  storage_path text not null,
  original_filename text,
  version_number int not null,
  is_active boolean not null default true,
  parsed_profile jsonb,
  created_at timestamptz not null default now()
);

create unique index resume_versions_one_active_per_user
  on public.resume_versions (user_id) where is_active;

-- ---------------------------------------------------------------------------
-- scan_history
-- ---------------------------------------------------------------------------
create table public.scan_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  sources text[],
  config jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  started_at timestamptz,
  completed_at timestamptz,
  jobs_found_count int,
  jobs_survived_prefilter_count int,
  jobs_scored_count int,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.scan_history
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  sources text[] not null default '{}',
  title text not null,
  company_name text,
  location text,
  posted_at timestamptz,
  link text,
  dedup_key text not null,
  description_text text,
  seniority_level text,
  employment_type text,
  salary_min numeric,
  salary_max numeric,
  scan_history_id uuid references public.scan_history(id) on delete set null,
  resume_version_id uuid references public.resume_versions(id),
  jd_profile jsonb,
  prompt_version text,
  status text not null default 'scored'
    check (status in ('prefiltered', 'scored', 'archived')),
  ats_match numeric(4,1),
  callback_odds numeric(4,1),
  overall_fit numeric(4,1),
  critical_missing jsonb,
  important_missing jsonb,
  nice_to_have_missing jsonb,
  already_demonstrated jsonb,
  transferable jsonb,
  hidden_strengths jsonb,
  risk_tags jsonb,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_sources_check check (sources <@ array['cs', 'ld', 'manual']::text[]),
  constraint jobs_user_dedup_key_unique unique (user_id, dedup_key)
);

create trigger set_updated_at before update on public.jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- applications
-- ---------------------------------------------------------------------------
create table public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  stage text not null default 'Saved'
    check (stage in ('Saved', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Accepted')),
  notes text,
  interview_date timestamptz,
  prep_link text,
  posting_link text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.applications
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- manual_entries
-- ---------------------------------------------------------------------------
create table public.manual_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  raw_jd_text text not null,
  title text,
  company_name text,
  link text,
  prefilter_passed boolean,
  prefilter_reject_reason text,
  override_used boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- cos_transactions (Phase 1: logged, never billed)
--   Cost actions record debits via flat_fee/sourcing_cost/ai_cost (-> total_cost).
--   Credits (admin_grant now, Stripe purchases in Phase 2) record credit_amount.
--   Balance delta for any row = credit_amount - total_cost.
-- ---------------------------------------------------------------------------
create table public.cos_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  action_type text not null
    check (action_type in (
      'cs_scan', 'ld_scan', 'resume_generation', 'cover_letter_generation',
      'email_check', 'manual_entry', 'admin_grant'
    )),
  flat_fee numeric not null default 0,
  sourcing_cost numeric,
  ai_cost numeric,
  total_cost numeric generated always as (flat_fee + coalesce(sourcing_cost, 0) + coalesce(ai_cost, 0)) stored,
  credit_amount numeric,
  note text,
  billed boolean not null default false,
  related_scan_id uuid references public.scan_history(id),
  related_job_id uuid references public.jobs(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- grant_cos — Phase 1 COS crediting (spec 13.4).
--   Atomically credits users.cos_balance AND writes an admin_grant ledger row.
--   security definer so the backend admin path works regardless of RLS.
-- ---------------------------------------------------------------------------
create or replace function public.grant_cos(
  p_user_id uuid,
  p_amount numeric,
  p_note text default null
)
returns public.cos_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cos_transactions;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'grant amount must be positive';
  end if;

  update public.users
    set cos_balance = cos_balance + p_amount
    where id = p_user_id;

  if not found then
    raise exception 'user % not found', p_user_id;
  end if;

  insert into public.cos_transactions (user_id, action_type, credit_amount, note)
  values (p_user_id, 'admin_grant', p_amount, p_note)
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- confirmed_skills
-- ---------------------------------------------------------------------------
create table public.confirmed_skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  skill_term text not null,
  context text,
  confirmed_at timestamptz not null default now(),
  unique (user_id, skill_term, context)
);

-- ---------------------------------------------------------------------------
-- scan_schedules
--   sources is unconstrained text[] on purpose: CS / LD / CS+LD are all valid
--   (spec 12.3) — a 2-value enum here would make LD-only unschedulable.
-- ---------------------------------------------------------------------------
create table public.scan_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  job_title text,
  location text,
  keywords text,
  visa_filter_on boolean not null default true,
  sources text[],
  frequency text check (frequency in ('daily', 'weekdays', 'weekly')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  active boolean not null default true,
  consecutive_skips int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.scan_schedules
  for each row execute function public.set_updated_at();

create index scan_schedules_due on public.scan_schedules (next_run_at) where active;

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null,
  message text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- provider_credentials
-- ---------------------------------------------------------------------------
create table public.provider_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider_type text not null check (provider_type in ('sourcing', 'ai')),
  provider_name text not null
    check (provider_name in ('apify', 'scraperapi', 'anthropic', 'openai_compatible', 'gemini')),
  encrypted_key text not null,
  config_json jsonb,
  validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider_name)
);

create trigger set_updated_at before update on public.provider_credentials
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security — defense-in-depth.
-- Express always uses the service-role key (bypasses RLS); these policies
-- only matter for any future direct-to-Supabase client path.
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;
alter table public.resume_versions enable row level security;
alter table public.scan_history enable row level security;
alter table public.jobs enable row level security;
alter table public.applications enable row level security;
alter table public.manual_entries enable row level security;
alter table public.cos_transactions enable row level security;
alter table public.confirmed_skills enable row level security;
alter table public.scan_schedules enable row level security;
alter table public.notifications enable row level security;
alter table public.provider_credentials enable row level security;

create policy users_self_access on public.users
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy owns_row on public.resume_versions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy owns_row on public.scan_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy owns_row on public.jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy owns_row on public.applications
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy owns_row on public.manual_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy owns_row on public.cos_transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy owns_row on public.confirmed_skills
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy owns_row on public.scan_schedules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy owns_row on public.notifications
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy owns_row on public.provider_credentials
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Email-check fair rotation (pre-Phase-5 cleanup batch, live bug: FluidStack
-- confirmation email never surfaced).
--
-- runEmailCheck.js sorts in-scope applications by stage priority then
-- newest-created-first, then packs their search terms into a bounded number
-- of Gmail query chunks (tunables.emailCheck.maxSearchQueries) and caps the
-- total merged candidate messages (tunables.emailCheck.maxCandidates). At
-- small application counts this never mattered; at real scale (427 Saved
-- applications on one account) it means an application's terms can be pushed
-- past the truncation point by a burst of newer Saved-stage applications
-- (e.g. a broad scan saving 95 new jobs in the hour after a real
-- application), silently and permanently burying it every single run since
-- "newest first" never changes its position relative to fresher jobs.
--
-- Fix: track when an application's terms last actually made it into an
-- executed (non-truncated) search query, and sort NULL/oldest-checked first
-- within each stage priority bucket instead of newest-created-first. This is
-- the same rotating-fairness idea already used for ATS Direct's company scan
-- cursor (spec §25c-2) — no application is perpetually buried, coverage
-- rotates across runs instead.

alter table public.applications
  add column last_email_checked_at timestamptz;

comment on column public.applications.last_email_checked_at is
  'Set by runEmailCheck.js whenever this application''s search terms are included in an executed (non-truncated) email-check query chunk — used to sort least-recently-checked applications first, so a burst of newer applications can never permanently bury an older one behind the maxSearchQueries/maxCandidates truncation caps.';

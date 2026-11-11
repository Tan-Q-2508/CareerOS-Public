-- Per-scan pre-filter drop reasons and job-board failures (spec §4.3, §4.6).
--
-- prefilter_drop_counts: how many sourced postings each deterministic step
--   removed before any AI call, keyed by reason family —
--   {"work_auth:no_sponsorship": 6, "work_auth:citizen_only": 4,
--    "years_gap": 11, "already_seen": 240, ...}. Makes "how much AI spend did
--   the pre-filter save, and did a no-sponsorship posting slip past it?"
--   answerable per scan instead of only as a survivor count.
-- board_failures: job boards that still failed after retries this scan —
--   [{company, platform, kind: timeout|rate_limited|board_gone|server_error|
--     parse_error, message}]. Replaces reading free-text notifications to find
--   out which boards failed and why.
--
-- Purely additive; written by apps/server/src/scan/scanCounters.js.

alter table public.scan_history
  add column if not exists prefilter_drop_counts jsonb not null default '{}'::jsonb,
  add column if not exists board_failures jsonb not null default '[]'::jsonb;

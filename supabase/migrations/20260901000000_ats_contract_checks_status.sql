-- CareerOS — ats_contract_checks.status_code (spec 18.3; Phase 5.5, §15 #53).
--
-- The canary could not tell throttling from drift. A thrown check recorded
-- `ok:false, missing_fields:[], error_message:'HTTP 429 from …'` — the same row
-- shape a 500, a DNS failure, a timeout and a genuine redesign all produced.
-- Every adapter already sets `err.status = resp.status` on the error it throws;
-- runContractChecks simply discarded it.
--
-- With this column the two questions separate cleanly:
--
--   status_code 429/503 + missing_fields '{}'  -> throttling. Not drift. The
--       endpoint asked us to slow down and never returned a payload.
--   missing_fields non-empty                   -> real drift. The endpoint
--       answered and its shape had changed.
--   status_code null + missing_fields '{}'     -> transport (DNS, timeout,
--       abort) — no HTTP status ever came back.
--
-- Nullable and purely additive: existing rows keep a null status_code, which
-- reads correctly as "this ran before the status was captured."

begin;

alter table public.ats_contract_checks
  add column if not exists status_code integer;

commit;

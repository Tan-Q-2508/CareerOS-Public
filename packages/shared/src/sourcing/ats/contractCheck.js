// Contract-drift canary (spec 18.3, Phase 5.5 §15 #44). An undocumented
// endpoint (every Custom Adapter Tier adapter, 18.2) breaks silently on a
// redesign — and a documented one can change a field's meaning just as
// quietly — and that failure is indistinguishable from "no matching
// jobs right now" — 12.4's per-company failure isolation swallows it by
// design, which is correct for an ordinary transient miss but wrong for "this
// adapter is now permanently broken and nobody knows." Each participating
// adapter registers a small, self-contained check: one known-good query, and
// the list of fields the adapter actually reads off the response.
//
// assertShape is a PURE function — no network, no adapter, just a payload and
// a field list — precisely so "a deliberately-broken response shape" (18.2's
// stated Session 44 deliverable) can be unit-tested without touching a real
// third-party site. runContractChecks is the only piece that does network
// I/O, and it isolates one platform's failure from the rest, same posture as
// detect.js's pooled probes (packages/shared/src/sourcing/ats/detect.js:170).

const { RETRYABLE_STATUS, parseRetryAfter, backoffMs, sleep } = require('./retry');

// One retry, not workable.js's five — see runOneCheck's header.
const MAX_CHECK_ATTEMPTS = 2;

// Registry of participating adapters: whatever the caller passes in, filtered
// to those exporting a usable `contractCheck`. All 13 adapters carry one as of
// the Phase <=5.5 residue sweep; the filter remains because an adapter without
// a stable board to point at should be skipped, not fabricate a canary.
// Kept as a passed-in list rather than a filesystem scan — the same
// "explicit over magic" posture as detect.js's BY_PLATFORM map.
function collectContractChecks(adapters) {
  return adapters
    .map((a) => a.contractCheck)
    .filter((c) => c && typeof c.run === 'function' && Array.isArray(c.requiredFields));
}

// Reads a dotted path ("data.job_search.all_jobs") out of a plain object,
// returning undefined on any missing segment. Deliberately dependency-free —
// this is the one place a required-field spec needs to reach into a nested
// shape (e.g. Meta's GraphQL envelope), and the paths here are short and
// fully within this codebase's control.
function getPath(obj, path) {
  return path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), obj);
}

/**
 * Pure shape assertion — no network. `requiredFields` is a list of dotted
 * paths (see getPath) that the adapter's normalizeItem/fetchJobs actually
 * reads; `payload` is the parsed response (or, for an HTML-scrape adapter,
 * whatever intermediate object its own `run()` extracted from the page).
 *
 * @returns {{ok: boolean, missingFields: string[]}}
 */
function assertShape(payload, requiredFields) {
  const missingFields = [];
  for (const path of requiredFields) {
    const v = getPath(payload, path);
    if (v === undefined || v === null) missingFields.push(path);
  }
  return { ok: missingFields.length === 0, missingFields };
}

/**
 * Runs every registered check against the real live endpoint, writes one
 * ats_contract_checks row per platform (18.3's global table — a contract's
 * shape is a fact about the platform, not about any user, same reasoning
 * company_ats_registry's globalness already rests on), and isolates one
 * platform's failure from the rest (12.4).
 *
 * @param {object} db Supabase admin client
 * @param {{platforms?: object[]}} opts adapters to check; defaults to none —
 *   the caller (internal.js's route) passes the real adapter list so this
 *   module itself never has to require every custom/*.js file directly.
 * @returns {Promise<{checked: number, ok: number, failed: number}>}
 */
async function runContractChecks(db, { adapters = [] } = {}) {
  const checks = collectContractChecks(adapters);
  let ok = 0;
  let failed = 0;

  for (const check of checks) {
    const row = await runOneCheck(check);
    if (row.ok) ok++;
    else failed++;

    // supabase-js RESOLVES with { data, error } rather than throwing on a
    // Postgres error, so the try/catch this used to carry was dead code and a
    // failed write vanished unlogged. Checked explicitly, the same way
    // sectors.js's logSectorUsage and curate.js's suggestion insert do. Still
    // non-fatal: one platform's unrecorded result must not abort the rest.
    const { error } = await db.from('ats_contract_checks').insert(row);
    if (error) {
      console.error(`ats-contract-check: failed to record result for "${check.name}":`, error.message || error);
    }
  }

  return { checked: checks.length, ok, failed };
}

/**
 * One platform's check, with a single retry on a throttling status.
 *
 * 18.3's canary answers "is this adapter permanently broken." A 429 answers a
 * different question — "not right now" — and the two were previously written
 * into the same undifferentiated bucket: `ok:false, missing_fields:[]`, with
 * the status code discarded even though every adapter sets `err.status` on the
 * error it throws. A maintainer reading a phenom 429 the morning after had no
 * way to tell it from a genuine redesign.
 *
 * Two changes fix that. The status is now recorded, so
 * `status_code` 429/503 with an EMPTY missing_fields is throttling, while a
 * NON-EMPTY missing_fields is real drift (the endpoint answered and its shape
 * had changed). And a throttled check is retried once, honouring Retry-After,
 * so ordinary rate limiting mostly resolves itself before it is ever recorded
 * — which is what stops the daily run crying wolf.
 *
 * Deliberately ONE retry, not workable.js's five: this runs daily against a
 * third party that just asked us to slow down, and a canary that hammers an
 * endpoint to prove it is reachable has become the problem it detects.
 */
async function runOneCheck(check) {
  for (let attempt = 1; ; attempt++) {
    const checked_at = new Date().toISOString();
    try {
      const payload = await check.run();
      const { ok: passed, missingFields } = assertShape(payload, check.requiredFields);
      return {
        platform: check.name,
        checked_at,
        ok: passed,
        missing_fields: missingFields,
        error_message: null,
        status_code: null,
      };
    } catch (e) {
      const status = Number.isFinite(e && e.status) ? e.status : null;
      if (attempt < MAX_CHECK_ATTEMPTS && status != null && RETRYABLE_STATUS.has(status)) {
        const retryAfter = parseRetryAfter(e.retryAfter);
        await sleep(retryAfter != null ? retryAfter : backoffMs(attempt));
        continue;
      }
      return {
        platform: check.name,
        checked_at,
        ok: false,
        missing_fields: [],
        error_message: e.message || String(e),
        status_code: status,
      };
    }
  }
}

module.exports = { assertShape, runContractChecks, runOneCheck, collectContractChecks, getPath };

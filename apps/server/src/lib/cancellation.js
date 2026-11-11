// cancellation.js — the one way long-running work is stopped on request.
//
// Résumé generation, cover-letter generation and scans all run detached from
// the request that started them (the route returns 202 and the work continues
// in-process), so there is no connection to drop and no promise for the caller
// to abort. The only thing shared between the user and the running job is the
// row in the database, so that row IS the signal: a cancel endpoint writes
// `status: 'cancelled'`, and the job notices at its next checkpoint and stops.
//
// COOPERATIVE, deliberately. Nothing here kills a process or aborts an
// in-flight AI call — a half-written .docx or a partially-debited COS ledger is
// worse than finishing one more step. A cancel therefore takes effect at the
// next milestone, which for generation is a few seconds and for a scan is the
// current job.
//
// A cancellation is NOT a failure and must never be reported as one. "Failed"
// tells a user the product broke; it also loses the distinction permanently,
// which matters because the other way a run ends up abandoned — the process
// being killed under it, by a deploy or a crash — genuinely IS a failure and
// reads identically afterwards if both write the same status.

class CancelledError extends Error {
  constructor(message = 'Cancelled by the user') {
    super(message);
    this.name = 'CancelledError';
    // A property rather than an instanceof check at the call sites: this error
    // crosses module boundaries and, in tests, module registries, where
    // instanceof is the thing that quietly stops working.
    this.cancelled = true;
  }
}

function isCancellation(err) {
  return Boolean(err && err.cancelled === true);
}

// The states a run can be cancelled FROM. Cancelling something already
// finished is not an error worth surfacing — it is a race the user lost by a
// second — but it must not overwrite a real terminal state.
const CANCELLABLE_STATUSES = ['queued', 'running'];

module.exports = { CancelledError, isCancellation, CANCELLABLE_STATUSES };

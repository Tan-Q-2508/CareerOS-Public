// cancelWatch.js — how a running scan finds out the user cancelled it.
//
// A scan's two scoring loops (runScan's sequential scoreScanJobs and
// atsDirectPipeline's concurrent worker pool) both isolate per-job failures on
// purpose: a thrown error is caught, logged, the job stays 'prefiltered', and
// the loop carries on (16.8). That is right for a bad job and exactly wrong for
// a cancellation — throwing from inside scoreOne would be swallowed by that
// same catch and the scan would keep going. So cancellation is a check the
// LOOPS make between jobs, never an exception the scorer raises.
//
// Throttled, because the alternative is one extra query per job and a scan
// scores hundreds. Five seconds is far finer than a user can perceive against
// work where a single job takes seconds anyway, and it bounds the extra reads
// to ~12/minute regardless of how fast jobs go by.
//
// Latching: once seen, it stays cancelled without re-reading. A scan must not
// resurrect itself because one later poll happened to fail.

const DEFAULT_INTERVAL_MS = 5000;

/**
 * @returns {() => Promise<boolean>} true once this scan has been cancelled
 */
function createCancelWatch(db, scanId, { intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  let cancelled = false;
  let lastCheckAt = 0;

  return async function isCancelled() {
    if (cancelled) return true;
    if (!db || !scanId) return false;
    const now = Date.now();
    if (now - lastCheckAt < intervalMs) return false;
    lastCheckAt = now;
    try {
      const { data, error } = await db
        .from('scan_history')
        .select('status')
        .eq('id', scanId)
        .maybeSingle();
      // A check that cannot run must never stop a scan that is working fine —
      // the failure mode of guessing "cancelled" here is abandoning real,
      // already-paid-for work.
      if (error || !data) return false;
      if (data.status === 'cancelled') cancelled = true;
    } catch (err) {
      console.error(`cancelWatch: status check failed for scan ${scanId}:`, err.message || err);
    }
    return cancelled;
  };
}

module.exports = { createCancelWatch, DEFAULT_INTERVAL_MS };

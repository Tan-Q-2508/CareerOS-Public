// Whole-scan heartbeat (spec §4.6.12/§16.9; Phase 4, §15 #26) — subsumes
// atsDirectRun.js's old `pingSelfIfDue`, which only ran during ATS Direct's
// sourcing loop and went silent the moment Stage A finished, exactly when a
// long scoring phase needed it most (confirmed live: a 43-minute run's last
// ~13 minutes had no self-ping at all). This module runs for the FULL
// lifetime of any scan — sourcing and scoring, any source — and does two
// things on a fixed interval:
//
//   1. Fire-and-forget GET {RENDER_EXTERNAL_URL}/health — Render's free-tier
//      web service spins the dyno down after ~15 minutes with no INBOUND HTTP
//      traffic (edge traffic, not internal process activity), which already
//      killed a real in-progress scan once before (2026-07-22). Generating
//      genuine external traffic keeps the dyno warm for as long as the loop
//      runs, without a paid plan. Best-effort and silent: RENDER_EXTERNAL_URL
//      is Render's own auto-injected env var (unset in local dev, a no-op
//      there), and a failed ping is swallowed — it must never affect the scan.
//
//   2. Write scan_history.heartbeat_at — what reapStaleScans (scheduler.js)
//      now reaps on instead of started_at, so a long but healthy run (e.g.
//      30 min sourcing + N min scoring) is never mistaken for a crashed one
//      just because it's been running a while. See the migration
//      (20260810010000_scan_heartbeat.sql) and scheduler.js for the full story.
//
// Both effects share one interval rather than two, since they're driven by
// the same "is this scan still alive" signal and firing them together halves
// the timer bookkeeping.

const { tunables } = require('@careeros/shared');

/**
 * @param {object} db Supabase admin client
 * @param {string} scanId
 * @returns {{ stop: () => void }}
 */
function startScanHeartbeat(db, scanId) {
  const intervalMs = tunables.scan.heartbeatIntervalMs || 300000;

  const tick = () => {
    const selfUrl = process.env.RENDER_EXTERNAL_URL;
    if (selfUrl) {
      // Fire-and-forget, failure swallowed — a dead health endpoint must
      // never slow down or fail the scan it's trying to keep alive.
      fetch(`${selfUrl}/health`).catch(() => {});
    }
    db.from('scan_history')
      .update({ heartbeat_at: new Date().toISOString() })
      .eq('id', scanId)
      .then(({ error }) => {
        if (error) console.error(`scanHeartbeat: heartbeat write failed for scan ${scanId}:`, error.message);
      });
  };

  const handle = setInterval(tick, intervalMs);
  // Node's default behavior would keep the process alive just for this timer
  // (irrelevant for the Express server, which is always alive anyway, but
  // correct hygiene) — no `unref()` needed here since the server process is
  // long-running regardless.

  return {
    stop: () => clearInterval(handle),
  };
}

module.exports = { startScanHeartbeat };

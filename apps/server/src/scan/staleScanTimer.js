// F5 (carried-forward audit item) — a persistent, server-wide reaper timer.
//
// Until now, reapStaleScans (scheduler.js) only ever ran when GitHub
// Actions' 30-minute cron hit POST /api/internal/run-due-scans
// (routes/internal.js). A real incident left a scan `running` for ~1 hour
// undetected because that external trigger itself didn't fire reliably —
// the reaper had no internal fallback of its own. This module is that
// fallback: a `setInterval` started once from index.js, right after
// app.listen, running independently of the external cron for the whole
// lifetime of the server process.
//
// This is a NEW pattern for this codebase — the only existing setInterval
// precedent (scanHeartbeat.js) is scan-scoped (one timer per in-flight scan,
// stopped when that scan ends). This one is server-scoped: started once,
// never stopped, for as long as the process lives. No per-tick teardown is
// needed for that reason.
//
// Structured as a LIST of reaper functions run each tick (not a single
// hardcoded reapStaleScans() call) so a second, unrelated reaper can be
// added later without touching the timer plumbing — used by D3 below (the
// 30-day job-retention sweep, spec §13's decision to protect only jobs moved
// past 'Saved').

const { reapStaleScans, reapStaleGenerations, reapExpiredJobs, reapStaleOnDemandScoring } = require('./scheduler');

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 min — well under the 30-min
// STALE_RUNNING_MINUTES cutoff in scheduler.js, so a genuinely orphaned scan
// is caught within one interval of crossing that threshold, independent of
// whether the external GitHub Actions cron happens to fire on time.

function defaultReapers(db) {
  return [
    { name: 'reapStaleScans', run: () => reapStaleScans(db) },
    // Same failure, different table: a deploy or crash that kills the process
    // mid-generation leaves a resume or cover letter at 'running' forever,
    // with the UI showing a spinner that can never resolve. Added after that
    // happened for real (2026-09-12) on rows reapStaleScans never looked at.
    { name: 'reapStaleGenerations', run: () => reapStaleGenerations(db) },
    // On-demand scoring claims (spec 4.7) orphaned by a restart mid-batch go
    // back to 'sourced', so they can be picked and scored again.
    { name: 'reapStaleOnDemandScoring', run: () => reapStaleOnDemandScoring(db) },
    // D3: runs every tick alongside reapStaleScans. Paginates the full set of
    // jobs older than tunables.jobRetentionDays (30 by default) each time —
    // bounded, cheap work at today's scale; if that backlog ever grows large
    // enough for the re-scan itself to matter, this reaper is the one to move
    // to a less frequent interval or a cursor of its own (see scheduler.js).
    { name: 'reapExpiredJobs', run: () => reapExpiredJobs(db) },
  ];
}

/**
 * Starts the server-wide reaper timer. Call ONCE, from index.js, after
 * app.listen — never per-request, never per-scan.
 *
 * @param {object} db Supabase admin client
 * @param {object} [opts]
 * @param {number} [opts.intervalMs] tick interval, defaults to 10 minutes
 * @param {Array<{name: string, run: () => Promise<any>}>} [opts.reapers]
 *   override the reaper list (mainly for tests) — defaults to defaultReapers(db)
 * @returns {{ stop: () => void }}
 */
function startStaleScanTimer(db, { intervalMs = DEFAULT_INTERVAL_MS, reapers } = {}) {
  const list = reapers || defaultReapers(db);

  const tick = async () => {
    for (const reaper of list) {
      try {
        const result = await reaper.run();
        if (result) console.log(`staleScanTimer: ${reaper.name} reaped ${result}`);
      } catch (e) {
        // Never let one reaper's failure stop the others, or stop future
        // ticks — same isolation posture as every other best-effort
        // background pass in this codebase (12.4, 16.8).
        console.error(`staleScanTimer: ${reaper.name} failed:`, e.message || e);
      }
    }
  };

  const handle = setInterval(() => {
    tick().catch((e) => console.error('staleScanTimer: tick failed unexpectedly:', e.message || e));
  }, intervalMs);

  return {
    stop: () => clearInterval(handle),
  };
}

module.exports = { startStaleScanTimer, defaultReapers, DEFAULT_INTERVAL_MS };

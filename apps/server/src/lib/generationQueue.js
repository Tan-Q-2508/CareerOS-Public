// In-process concurrency limiter for document generation (spec 12.7, 16.9).
//
// The Phase 3 regression pass found that "a burst of simultaneous generation
// requests ... can still degrade on the current single free-tier Render dyno"
// and deferred the fix to "Phase 4 §25 (API rate limiting)". §25 was then built
// as tracklists, sectors, the scan form and slug mining, and the Phase 3
// closeout re-deferred the limiter to the same place, which by then no longer
// existed — so it went unbuilt for two phases. §15 #56e finally built it here;
// routes/generate.js and routes/copilot.js are its two callers.
//
// WHAT THIS IS NOT: API rate limiting (13.7, Phase 6 §36). That protects the
// API surface from abuse and is per-IP/per-account. This protects one process
// from its own accepted work — four heavy AI+docx pipelines that already return
// 202 and run in the background, with nothing bounding how many run at once.
//
// Why a semaphore and not a queue service: every generation route already
// responds immediately and reports progress through its own DB row (16.9), so a
// request that waits here is indistinguishable to the caller from one that is
// simply taking a while — no timeout to tune, no new failure mode, no Redis.
// When the real trigger fires (12.7: scheduled scans timing out), this is one
// of the seams BullMQ replaces; until then a bounded pool is the whole fix.
//
// Deliberately per-PROCESS, not per-user: the resource being protected is the
// dyno, and one user with four tabs open costs it exactly what four users do.

const { tunables } = require('@careeros/shared');

function limit() {
  const n = tunables.generation && tunables.generation.maxConcurrentGenerations;
  return Number.isFinite(n) && n > 0 ? n : 2;
}

let active = 0;
const waiting = [];

function releaseOne() {
  active -= 1;
  const next = waiting.shift();
  if (next) {
    active += 1;
    next();
  }
}

/**
 * Run `fn` once a slot is free. Resolves/rejects with whatever `fn` does, so a
 * caller's own error handling is unchanged — the four dispatch sites all use
 * fire-and-forget `.catch(console.error)` and keep doing exactly that.
 *
 * A slot is released whether `fn` resolves or throws. A leaked slot here would
 * wedge generation for the whole process until a redeploy, which is a worse
 * failure than the contention this exists to prevent.
 */
function runGenerationJob(label, fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      const queuedFor = Date.now() - enqueuedAt;
      if (queuedFor > 1000) {
        console.log(`[generationQueue] ${label} waited ${queuedFor}ms for a slot (${active}/${limit()} busy)`);
      }
      // Release BEFORE settling the caller, not in a .finally() after it. With
      // .finally() the slot was still held for a microtask past the point the
      // caller's await resumed, so anything that awaited a job and then asked
      // for capacity read a stale answer. Releasing first makes "this job is
      // done" and "its slot is free" the same instant.
      Promise.resolve()
        .then(fn)
        .then(
          (v) => { releaseOne(); resolve(v); },
          (e) => { releaseOne(); reject(e); }
        );
    };

    const enqueuedAt = Date.now();
    if (active < limit()) {
      active += 1;
      start();
    } else {
      waiting.push(start);
    }
  });
}

// Exposed for the admin diagnostics surface and for tests; `active` and
// `waiting` are module state, so read them through this rather than importing
// the bindings.
function stats() {
  return { active, queued: waiting.length, limit: limit() };
}

module.exports = { runGenerationJob, stats };

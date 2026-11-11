// ATS Direct's concurrent producer/consumer pipeline (spec §4.6.12; Phase 4,
// §26) — replaces the old two sequential phases (source-everything, THEN
// score-everything) with two stages running at the same time inside one
// scan:
//
//   Stage A (producer) — atsDirectRun.js's bounded company-fetch pool. Every
//     time one company's postings survive the pre-filter, `persistAndEnqueue`
//     below durably writes them to `jobs` (status: 'prefiltered') and pushes
//     the newly-inserted rows onto a bounded queue.
//   Stage B (consumer) — a bounded pool of scoring workers, running THE
//     WHOLE TIME Stage A is still fetching later companies, draining that
//     queue via jobScorer.scoreOne (the same per-job scoring unit Core
//     Scraper / BYO Scraper use, just driven concurrently here instead of by
//     a single sequential loop).
//
// Net effect: wall-clock collapses toward max(sourcing, scoring) instead of
// sourcing + scoring (measured baseline before this session: ~30 min + ~13
// min = ~43 min for one real run against a 10k+-company selection — see the
// handoff for the after numbers).
//
// Backpressure is just the bounded queue's blocking push — no separate
// primitive. If pre-filter survivors arrive faster than Stage B can score
// them, `queue.push` in persistAndEnqueue simply doesn't resolve until a
// scoring worker frees a slot, which pauses the awaiting Stage A worker
// (never the fetch pool as a whole — the other in-flight fetches keep
// running). Given §4.3's ~45% typical pre-filter attrition and the tiny real
// survivor counts observed live (dozens per 10k-company run, not thousands),
// this is expected to rarely engage in practice, but the guard exists
// regardless, per spec.

const { tunables } = require('@careeros/shared');
const { linkJobsToRegistry } = require('../companies/registry');
const { runAtsDirectSourcing } = require('./atsDirectRun');
const { createCancelWatch } = require('./cancelWatch');

// Minimal bounded async queue — push() blocks while full, pop() blocks while
// empty, close() lets pop() drain whatever's left then report done, abort()
// discards everything immediately and unblocks every waiter with done:true.
// No dependency pulled in for this (repo is CommonJS; p-limit v4+ is
// ESM-only) — this is a small enough primitive that hand-rolling it, in the
// same spirit as the existing `pooled()` worker-pool helpers elsewhere in
// this codebase (packages/shared/src/sourcing/ats/detect.js,
// apps/server/src/companies/registry.js), is simpler than adding a package
// for it.
function createBoundedQueue(maxSize) {
  const items = [];
  let closed = false;
  let aborted = false;
  const pushWaiters = [];
  const popWaiters = [];

  function wake(waiters) {
    while (waiters.length) waiters.shift()();
  }

  // F1 (wall-clock overshoot under backpressure): `deadline` is an optional
  // epoch-ms instant. With no deadline this behaves exactly as before —
  // parks until a consumer frees a slot. With a deadline, each wait is
  // Promise.race'd against a timer for the REMAINING time until that
  // deadline, so a producer parked here can never outlive the scan's own
  // wall-clock budget (49 min actual vs 30 min budget, observed live — the
  // budget check only ran at the top of atsDirectRun.js's worker loop, which
  // a producer blocked inside push() never reaches). Returns
  // `{ expired: true }` when the deadline wins instead of resolving normally,
  // so the caller (persistAndEnqueue) can stop trying to push further items
  // and let the worker loop's own top-of-iteration budget check end things
  // cleanly on its next pass, rather than parking indefinitely.
  async function push(item, deadline) {
    if (aborted) return { expired: false }; // no-op once aborted (§26 abort protocol)
    while (items.length >= maxSize) {
      if (closed || aborted) return { expired: false };
      if (deadline != null) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { expired: true };
        let timer;
        const waited = await Promise.race([
          new Promise((resolve) => pushWaiters.push(() => resolve('woken'))),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve('expired'), remaining);
          }),
        ]);
        clearTimeout(timer);
        if (waited === 'expired') return { expired: true };
      } else {
        await new Promise((resolve) => pushWaiters.push(resolve));
      }
      if (aborted) return { expired: false };
    }
    if (closed || aborted) return { expired: false }; // closed while this call was parked
    items.push(item);
    wake(popWaiters);
    return { expired: false };
  }

  // Returns { value, done: false } for a real item, or { done: true } once
  // the queue is closed/aborted AND drained — the consumer's signal to stop.
  async function pop() {
    for (;;) {
      if (items.length) {
        const value = items.shift();
        wake(pushWaiters);
        return { value, done: false };
      }
      if (closed || aborted) return { value: undefined, done: true };
      await new Promise((resolve) => popWaiters.push(resolve));
    }
  }

  function close() {
    closed = true;
    wake(popWaiters);
    wake(pushWaiters);
  }

  function abort() {
    aborted = true;
    wake(popWaiters);
    wake(pushWaiters);
  }

  return { push, pop, close, abort };
}

/**
 * @param {object} input
 * @param {object} input.db
 * @param {string} input.userId
 * @param {string} input.scanId
 * @param {string} input.resumeVersionId active résumé version, stamped on every `jobs` row (spec 4.5)
 * @param {object} input.config scan config (same shape runAtsDirectSourcing takes)
 * @param {object} input.userProfile prefilter's userProfile shape
 * @param {Set<string>} input.seen dedup keys — mutated in place, see runAtsDirectSourcing
 * @param {{scoreOne: (job: object) => Promise<void>}} input.jobScorer already-constructed
 *   (jobScorer.js) — scoring preconditions (credential/parsed_profile) are the CALLER's
 *   responsibility to have checked before this is ever invoked (§26 rule 12).
 * @param {object} [input.counters] scanCounters.js bag — passed straight through to
 *   runAtsDirectSourcing so Stage A's live progress lands on scan_history (§26 regression fix).
 * @param {(job: object) => object} [input.storedAs] the status (+ triage) a survivor row is
 *   written with — runScan.js decides; defaults to 'prefiltered'.
 * @param {boolean} [input.scoreInline] false for an on-demand scan (spec 4.7): Stage A runs
 *   exactly as usual, and Stage B never starts — survivors are stored and left for the user.
 * @returns {Promise<ReturnType<typeof runAtsDirectSourcing> extends Promise<infer T> ? T : never>}
 *   the same shape runAtsDirectSourcing returns — this function is a thin wrapper around it
 *   from the caller's point of view, plus the concurrent scoring side-effect.
 */
async function runAtsDirectPipeline({
  db,
  userId,
  scanId,
  resumeVersionId,
  config,
  userProfile,
  seen,
  jobScorer,
  counters,
  storedAs = () => ({ status: 'prefiltered' }),
  scoreInline = true,
}) {
  const maxQueueSize = tunables.atsDirect.scoringQueueMaxSize || 100;
  const concurrency = Math.max(1, tunables.atsDirect.scoringConcurrency || 3);
  const queue = createBoundedQueue(maxQueueSize);
  // One watch shared by every worker, so a cancel drains the whole pool.
  const isCancelled = createCancelWatch(db, scanId);

  // F1: the SAME wall-clock budget/clock atsDirectRun.js's worker loop uses
  // for its own top-of-iteration check, computed once HERE (before sourcing
  // starts) and threaded down into both the queue's push() deadline and
  // runAtsDirectSourcing's own `startedAt`, so the two budget checks can
  // never drift apart from being computed a few statements apart.
  const wallClockBudgetMs = tunables.atsDirect.maxRunWallClockMs || Infinity;
  const startedAt = Date.now();
  const pushDeadline = Number.isFinite(wallClockBudgetMs) ? startedAt + wallClockBudgetMs : null;

  // Stage A's onSurvivors callback — persists one company's pre-filter
  // survivors, then feeds the newly-inserted rows to Stage B. Awaited by
  // atsDirectRun.js's worker loop, so this call's own await on queue.push is
  // exactly the backpressure point described in the module comment above.
  async function persistAndEnqueue(survivors) {
    const rows = survivors.map((j) => ({
      user_id: userId,
      sources: [j.source || 'ats_direct'],
      title: j.title,
      company_name: j.companyName,
      location: j.location,
      posted_at: j.postedAt,
      link: j.link,
      dedup_key: j.dedupKey,
      description_text: j.descriptionText,
      seniority_level: j.seniorityLevel,
      employment_type: j.employmentType,
      salary_min: j.salaryMin,
      salary_max: j.salaryMax,
      scan_history_id: scanId,
      resume_version_id: resumeVersionId,
      ...storedAs(j),
    }));

    // ignoreDuplicates -> ON CONFLICT DO NOTHING; .select() on that returns
    // exactly the rows actually inserted (safe on the installed supabase-js/
    // postgrest-js — confirmed this session), which is precisely the set
    // this company contributes to scoring. A survivor that conflicts already
    // has an existing `jobs` row from an earlier scan/company and is simply
    // not re-scored under this scan_history_id, same as today.
    const { data: inserted, error } = await db
      .from('jobs')
      .upsert(rows, { onConflict: 'user_id,dedup_key', ignoreDuplicates: true })
      // company_name / company_ats_registry_id: 19.4's sponsorship fact (§15 #49).
      .select('id, title, location, posted_at, salary_min, salary_max, seniority_level, description_text, dedup_key, company_name, company_ats_registry_id');
    if (error) throw error;
    const insertedRows = inserted || [];

    // Dedup memory survives independent of the jobs row's later fate (A2) —
    // written AFTER jobs (never before), and scoped to only the dedup_keys
    // this call actually inserted, so a crash between the two writes can
    // never burn a key with no row behind it (§26 rule 8).
    if (insertedRows.length) {
      const dedupRows = insertedRows.map((r) => ({ user_id: userId, dedup_key: r.dedup_key }));
      const { error: dedupErr } = await db
        .from('job_dedup_seen')
        .upsert(dedupRows, { onConflict: 'user_id,dedup_key', ignoreDuplicates: true });
      if (dedupErr) console.error('job_dedup_seen upsert failed:', dedupErr.message);
    }

    // Link already-registered companies onto the rows just stored — cheap,
    // reuses the survivors already in memory (§15 #25c-1), no requery. Fires
    // per company-with-survivors rather than once at the end of the scan
    // (unlike CS/BYO's single call) — at the real survivor rates observed
    // live (dozens per 10k-company run, not thousands), that's a modest
    // number of small extra registry lookups, not a bottleneck.
    await linkJobsToRegistry(db, userId, {
      scanId,
      jobs: survivors.map((j) => ({ companyName: j.companyName, dedupKey: j.dedupKey })),
    });

    // On demand (spec 4.7) the rows are the result; nothing consumes a queue.
    if (!scoreInline) return;

    for (const row of insertedRows) {
      const { expired } = await queue.push(row, pushDeadline);
      // F1: the wall-clock budget expired while this call was parked on a
      // full queue — stop trying to push this company's remaining rows (they
      // would just expire too) and return. atsDirectRun.js's worker loop
      // checks the same budget at the top of its next iteration and will
      // exit cleanly there; this just guarantees the CURRENT await can never
      // outlive the budget by an unbounded amount.
      if (expired) break;
    }
  }

  // ---- Stage B: bounded scoring worker pool ----
  const workerCount = scoreInline ? concurrency : 0;
  let liveWorkers = workerCount;
  async function scoringWorker() {
    try {
      for (;;) {
        const { value: job, done } = await queue.pop();
        if (done) return;
        // Between jobs, never inside scoreOne: the catch below isolates a bad
        // job (16.8) and would swallow a cancellation identically. Every worker
        // shares one watch, so a cancel drains the whole pool, not one worker.
        if (await isCancelled()) {
          console.log(`atsDirectPipeline: scan ${scanId} cancelled by user — worker stopping`);
          return;
        }
        try {
          await jobScorer.scoreOne(job);
        } catch (err) {
          // 16.8: per-job failure isolation — logged, the job stays
          // 'prefiltered', this worker keeps draining the queue rather than
          // exiting over one bad job.
          console.error(`atsDirectPipeline: scoring job ${job.id} failed, left prefiltered:`, err.message || err);
        }
      }
    } finally {
      liveWorkers -= 1;
      if (liveWorkers <= 0) {
        // Every scoring worker is gone. Without this, a Stage A worker
        // parked on a full queue (backpressure) would wait forever with
        // nothing left to drain it — the per-job try/catch above already
        // absorbs ordinary scoring failures without a worker ever exiting,
        // so reaching zero here means something genuinely unexpected broke
        // (e.g. the DB client itself throwing synchronously); this is the
        // backstop that keeps that from also hanging the sourcing side.
        queue.abort();
      }
    }
  }
  const scoringWorkers = Array.from({ length: workerCount }, () => scoringWorker());

  // ---- Stage A: bounded company-fetch pool ----
  let sourcingResult;
  try {
    sourcingResult = await runAtsDirectSourcing({
      db,
      userId,
      config,
      userProfile,
      seen,
      onSurvivors: persistAndEnqueue,
      counters,
      startedAt,
    });
  } finally {
    // Always close, even if sourcing threw above (e.g. resolveScanSelection
    // failed before the fetch pool even started) — a parked scoring worker
    // must see done:true once no more items are coming, not hang forever on
    // an empty queue (§26 abort protocol).
    queue.close();
  }

  await Promise.allSettled(scoringWorkers);

  return sourcingResult;
}

module.exports = { runAtsDirectPipeline };

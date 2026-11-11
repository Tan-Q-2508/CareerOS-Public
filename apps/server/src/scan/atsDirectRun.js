// ATS Direct sourcing orchestration (spec 4.6.6; Phase 4, §15 #25c-2, made
// concurrent §26/4.6.12) — owns what §24/25b's atsDirectAdapter.sourceJobs()
// used to own by itself: walking the selected companies, batching, and
// deciding when to stop. Runs server-side (DB access for the rotating
// cursor, the running dedup-seen set, and now the scoring-pipeline handoff).
//
// Four behaviors live here, all from 4.6.6/4.6.12:
//   1. Selector resolution — tracklists/subscriptions primary, an optional
//      narrow-to-companies sub-picker layered on (registry.js's
//      resolveScanSelection).
//   2. Bounded concurrent fetch pool (NEW, §26) — up to
//      tunables.atsDirect.companyFetchConcurrency companies in flight at
//      once, each pre-filtered and handed to the caller's `onSurvivors`
//      callback (which persists + feeds the concurrent scoring pipeline,
//      atsDirectPipeline.js) the moment ITS OWN fetch completes, instead of
//      the old plain sequential while-loop (confirmed by inspection this
//      session, per 4.6.12's "before refactoring" instruction — there was no
//      hidden concurrency; "batching" was purely a cursor-checkpoint
//      granularity device that bought zero parallelism).
//   3. Contiguous-completion rotating cursor (NEW, §26) — replaces the old
//      "last id in this batch" watermark, which assumed strictly in-order
//      batch completion. Under concurrent dispatch, companies can finish out
//      of order, so the cursor now tracks the longest CONTIGUOUS prefix of
//      `ordered` that has actually completed (success OR failure — see the
//      per-company loop below), and only ever checkpoints that. This
//      preserves scanCursor.js's `orderFromCursor` resume contract exactly
//      (resume = first id strictly greater than the saved cursor) across a
//      concurrent run, including across the selection's rotation wrap point.
//   4. Target-with-backfill — the job-count field is a TARGET scored-and-
//      stored count for ATS Direct, not a raw-pull ceiling: keep pulling
//      additional companies' postings until the target is met or the
//      selection is fully lapped. §15 #25c-1's decision (unchanged by this
//      session): the target is measured against POST-PREFILTER survivors,
//      not the literal post-scoring stored count — this keeps a paid AI call
//      from ever entering the backfill loop, at the cost of a small, flagged
//      deviation from 4.6.6's literal "scored-and-stored" wording (some
//      survivors can still fall below the scan's scoring threshold and get
//      deleted afterward, same as any other source). Concurrency widens the
//      overshoot past target from "up to one ~10-company batch" to "up to
//      `companyFetchConcurrency` companies in flight" — strictly tighter at
//      the default of 5 than the old default batch size of 10.

const { atsDirectAdapter, atsDirect, prefilter, tunables, scanTitles, scanLocations, locationMatch } = require('@careeros/shared');
const { resolveScanSelection } = require('../companies/registry');
const { selectionKey, orderFromCursor, saveCursor, loadCursor } = require('../companies/scanCursor');
const locationResolver = require('./locationResolver');

/**
 * §4.6.16 Layer 2 wiring — given a company's already Layer-1-filtered jobs
 * (confident mismatches already gone), resolves whichever ones the gazetteer
 * couldn't place against the AI cache, and reclassifies. No-op (zero DB/AI
 * calls) when no location filter is set or nothing came back 'unknown'.
 *
 *
 * Layer 3 (the unsure default) reads tunables.atsDirect.location.unknownPolicy.
 * "keep" is the default and the behaviour everything was built around; "drop"
 * existed as a config key with NO reader anywhere in the codebase — a promise
 * rather than a mode. It is wired here so the documented tightening is a
 * setting rather than a future session, and so the key cannot drift out of
 * agreement with the code.
 *
 * One case never obeys "drop": a THROWN resolution call. "We asked and still
 * cannot place this string" and "we never got to ask" are different facts, and
 * silently discarding postings because an AI call failed would turn a transient
 * outage into missing results the user cannot see or explain.
 *
 * @returns {Promise<{jobs: object[], aiFiltered: number, stillUnsure: number, unsureDropped: number}>}
 */
async function resolveLocationUnknowns(db, jobs, locations) {
  if (!locations.length || !jobs.length || !(tunables.atsDirect.location && tunables.atsDirect.location.aiResolveEnabled)) {
    return { jobs, aiFiltered: 0, stillUnsure: 0, unsureDropped: 0 };
  }

  // Multi-location scan (4.6.6): a posting passes if it matches ANY filter.
  const filterLocs = locations.map((l) => locationMatch.resolveLocation(l));
  const unknownJobs = [];
  const keptJobs = [];
  for (const j of jobs) {
    const status = locationMatch.matchLocation(j.location, locations);
    if (status === 'unknown') unknownJobs.push(j);
    else keptJobs.push(j); // 'match' — Layer 1 already excluded 'mismatch'
  }
  if (!unknownJobs.length) return { jobs: keptJobs, aiFiltered: 0, stillUnsure: 0, unsureDropped: 0 };

  const strings = Array.from(new Set(unknownJobs.map((j) => j.location).filter(Boolean)));
  let resolved;
  try {
    resolved = await locationResolver.resolveLocations(db, strings);
  } catch (e) {
    console.error('resolveLocationUnknowns: AI resolution failed, keeping all as unsure:', e.message || e);
    // Kept regardless of unknownPolicy — see this function's header.
    return { jobs: [...keptJobs, ...unknownJobs], aiFiltered: 0, stillUnsure: unknownJobs.length, unsureDropped: 0 };
  }

  const dropUnsure = ((tunables.atsDirect.location || {}).unknownPolicy || 'keep') === 'drop';
  let aiFiltered = 0;
  let stillUnsure = 0;
  let unsureDropped = 0;
  // Counted separately on purpose. stillUnsure measures how many postings
  // neither layer could place — the number §4.6.16 says to look at before
  // tightening this policy — and it must mean the same thing in both modes.
  // unsureDropped records what the policy then DID with them.
  const handleUnsure = (j) => {
    stillUnsure += 1;
    if (dropUnsure) { unsureDropped += 1; return; }
    keptJobs.push(j);
  };
  for (const j of unknownJobs) {
    const r = j.location ? resolved.get(j.location) : null;
    if (r && r.confidence === 'high') {
      const segLoc = locationMatch.structuredFromResolved(r);
      const status = locationMatch.bestStatus(filterLocs.map((f) => locationMatch.matchResolvedSegment(segLoc, f)));
      if (status === 'mismatch') {
        aiFiltered += 1;
        continue; // dropped — never reaches prefilter/scoring
      }
      if (status === 'unknown') { handleUnsure(j); continue; }
      keptJobs.push(j);
    } else {
      handleUnsure(j); // low confidence or resolution unavailable
    }
  }

  return { jobs: keptJobs, aiFiltered, stillUnsure, unsureDropped };
}

/**
 * @param {object} input
 * @param {object} input.db
 * @param {string} input.userId
 * @param {object} input.config scan config — job_titles (4.6.15, falls back to the
 *   legacy scalar job_title via scanTitles()), location, posted_within_days,
 *   tracklist_ids, tracked_company_ids (the narrow sub-picker / legacy selector),
 *   ats_job_count (the target), visa_filter_on
 * @param {object} input.userProfile prefilter's userProfile shape — {yearsOfExperience, domainKeywords, offDomainTitleKeywords}
 * @param {Set<string>} input.seen dedup keys already seen for this user — MUTATED in place as
 *   this run's own survivors accumulate, so a later company in the same run can't re-emit a
 *   posting another company already kept (companies can legitimately share postings across ATS
 *   boards). Every mutation happens inside one synchronous span together with the prefilter call
 *   that produced it (see the worker loop below) — that invariant is what keeps this safe under
 *   concurrent dispatch without needing a lock.
 * @param {(survivors: object[]) => Promise<void>} input.onSurvivors called once per company that
 *   produces at least one pre-filter survivor, with that company's survivors only. Expected to
 *   durably persist them (jobs -> job_dedup_seen -> linkJobsToRegistry) and feed the concurrent
 *   scoring pipeline (atsDirectPipeline.js) — the awaited call is what applies backpressure to
 *   this fetch pool when the scoring side falls behind.
 * @param {object} [input.counters] scanCounters.js bag (§26 progress-regression fix) — when
 *   given, live sourcing progress (companies_total_count, companies_queried_count,
 *   jobs_found_count, jobs_survived_prefilter_count) is written through it as this pool runs,
 *   instead of only landing once at the very end via the caller's own mark() calls.
 * @param {number} [input.startedAt] (F1) epoch ms this run's wall-clock budget started counting
 *   from — passed in by atsDirectPipeline.js so its queue.push() deadline and this loop's own
 *   budget check share one clock; defaults to Date.now() when called without it.
 * @returns {Promise<{found: object[], survivorCount: number, failures: object[], companiesQueried: number,
 *   totalSelected: number, lapped: boolean, lastCompanyId: string|null, resolvedTracklistIds: string[],
 *   missingTracklistIds: string[]}>}
 */
// A full-board fetch 404'd. One cheap probe of the same board (the same
// check park-dead-boards makes) confirms it before anything changes — a
// single 404 from a CDN edge is not proof. Confirmed: status 'board_gone',
// which scan selection skips (only 'active' is selected), so it stops failing
// every scan; park-dead-boards later moves it to company_ats_unresolved
// outside any scan. Never throws. Returns true when the board was retired.
async function retireGoneBoard(db, company) {
  try {
    const adapter = atsDirect.adapters[company.platform];
    if (!adapter || typeof adapter.probe !== 'function' || !company.id) return false;
    const probe = await adapter.probe(company.slug_or_identifier);
    if (probe.ok || (probe.status !== 404 && probe.status !== 410)) return false;
    const { error } = await db
      .from('company_ats_registry')
      .update({ status: 'board_gone', probed_at: new Date().toISOString() })
      .eq('id', company.id)
      .eq('status', 'active');
    if (error) {
      console.error(`atsDirectRun: could not retire gone board ${company.company_name_display}:`, error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`atsDirectRun: gone-board confirmation failed for ${company.company_name_display}:`, e.message || e);
    return false;
  }
}

async function runAtsDirectSourcing({ db, userId, config, userProfile, seen, onSurvivors, counters, startedAt: startedAtParam }) {
  const { companies, resolvedTracklistIds, missingTracklistIds } = await resolveScanSelection(db, userId, {
    tracklistIds: config.tracklist_ids,
    registryIds: config.tracked_company_ids,
  });

  if (!companies.length) {
    return {
      found: [],
      survivorCount: 0,
      failures: [],
      companiesQueried: 0,
      totalSelected: 0,
      lapped: true,
      resolvedTracklistIds,
      missingTracklistIds,
    };
  }

  const titles = scanTitles(config);
  const locations = scanLocations(config);
  // 4.6.15: the cursor is keyed by tracklist AND titles — changing the scan's
  // titles is meant to start a fresh rotation (a different search deserves a
  // fresh random start, not a resume mid-way through the old one's progress),
  // while each TRACKLIST keeps its own independent rotation regardless of
  // which other tracklist was run in between.
  const key = selectionKey({ tracklistIds: resolvedTracklistIds, registryIds: config.tracked_company_ids, titles });
  const lastCompanyId = await loadCursor(db, userId, key);
  const ordered = orderFromCursor(companies, lastCompanyId);
  const n = ordered.length;
  if (counters) await counters.set('companies_total_count', n);

  const target = config.ats_job_count || tunables.atsDirect.jobCount.default;
  const concurrency = Math.max(1, Math.min(tunables.atsDirect.companyFetchConcurrency || 5, n));
  // Wall-clock guard — target-met and full-lap are the real, intended
  // stopping conditions; this budget is a circuit breaker for the
  // pathological case (extremely slow/unreachable boards making even a
  // partial lap take unreasonably long), not the normal way a run ends. No
  // longer the mechanism protecting against a Render restart losing the
  // whole scan — that's now scanHeartbeat.js's job (keeps the dyno alive for
  // the scan's FULL duration, sourcing and scoring both), so this can stay
  // wide without needing to be re-tightened.
  const wallClockBudgetMs = tunables.atsDirect.maxRunWallClockMs || Infinity;
  // F1: use the caller's clock (atsDirectPipeline.js) when given one, so this
  // worker loop's own budget check and the queue's push() deadline it also
  // computes from are the exact same clock, not two Date.now() calls a few
  // statements apart. Falls back to a fresh Date.now() for any other/direct
  // caller (e.g. a future non-pipeline test harness) so this stays callable
  // standalone.
  const startedAt = startedAtParam || Date.now();

  const found = []; // lightweight stubs only — see the worker loop; never a full posting object
  const failures = [];
  const completed = new Array(n).fill(false);
  let watermarkIdx = 0; // longest contiguous PREFIX of `ordered` that has completed (success or failure)
  let survivorCount = 0;
  let dispatchIdx = 0;

  // Cursor checkpoint — throttled and single-writer. `checkpointInFlight` is
  // a plain synchronous flag, not a real lock, but that's sufficient here:
  // every check-and-set in maybeCheckpoint runs as one uninterrupted
  // synchronous span (no await before the flag is set), so two workers can
  // never both pass the guard and start a save concurrently — JS's
  // single-threaded execution serializes them for free. Because at most one
  // saveCursor() call is ever in flight, and watermarkIdx only ever grows
  // across a run, each successive save's id is monotonically non-decreasing
  // by construction — without needing scanCursor.js's own saveCursor to be
  // independently atomic-max.
  let checkpointInFlight = false;
  let lastSavedWatermarkIdx = 0;
  let lastCheckpointAt = startedAt;
  const checkpointEvery = tunables.atsDirect.backfillBatchSize || 10;
  const checkpointIntervalMs = 5000;

  // F7 (memory-growth instrumentation, §4.6.13) — `found` and `failures`
  // below are the two remaining monotonic-growth candidates flagged after a
  // 30-min soak run showed RSS ~155->248.5MB while the dispatcher's own
  // origin-stats map (already capped) and heapUsed both stayed flat. This is
  // deliberately "instrument, don't guess": periodically logging both
  // arrays' lengths alongside process.memoryUsage().rss so a future real
  // soak run has the data to say whether one of them is the actual
  // contributor, rather than blind-capping either — both are read in full by
  // this function's own final summary (found becomes the caller's found[],
  // failures drives runScan.js's per-company failure notifications), so
  // capping either would silently break that. Piggybacks this same
  // throttle-by-elapsed-time shape maybeCheckpoint already uses, rather than
  // starting a second setInterval alongside scanHeartbeat.js's.
  const memLogIntervalMs = 60000;
  let lastMemLogAt = startedAt;
  function maybeLogMemory() {
    const now = Date.now();
    if (now - lastMemLogAt < memLogIntervalMs) return;
    lastMemLogAt = now;
    const mem = process.memoryUsage();
    console.log(
      `atsDirectRun: memory check — companies ${watermarkIdx}/${n}, found.length=${found.length}, ` +
        `failures.length=${failures.length}, rss=${(mem.rss / 1024 / 1024).toFixed(1)}MB, ` +
        `heapUsed=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`
    );
  }

  async function maybeCheckpoint(force) {
    if (watermarkIdx <= lastSavedWatermarkIdx) return;
    if (checkpointInFlight) return; // the in-flight save will be superseded by the next call once it lands
    if (!force && watermarkIdx - lastSavedWatermarkIdx < checkpointEvery && Date.now() - lastCheckpointAt < checkpointIntervalMs) {
      return;
    }
    checkpointInFlight = true;
    const idxSnapshot = watermarkIdx; // snapshot before the await — see class comment above
    try {
      await saveCursor(db, userId, key, ordered[idxSnapshot - 1].id);
      lastSavedWatermarkIdx = idxSnapshot;
      lastCheckpointAt = Date.now();
    } finally {
      checkpointInFlight = false;
    }
  }

  function advanceWatermark() {
    while (watermarkIdx < n && completed[watermarkIdx]) watermarkIdx += 1;
  }

  async function worker() {
    for (;;) {
      if (survivorCount >= target || Date.now() - startedAt >= wallClockBudgetMs) return;
      const i = dispatchIdx;
      if (i >= n) return;
      dispatchIdx += 1; // claim — safe: no await between the read above and this write
      const company = ordered[i];

      try {
        const { jobs: sourced, failure, locationStats } = await atsDirectAdapter.sourceCompanyJobs({
          company,
          titles,
          location: locations,
          postedWithinDays: config.posted_within_days,
        });

        if (failure) {
          // Per-company failure isolation (12.4) — collected for the caller
          // to notify on (runScan.js), never thrown. Transient failures were
          // already retried inside sourceCompanyJobs; what reaches here failed
          // every attempt.
          if (failure.kind === 'board_gone') failure.retired = await retireGoneBoard(db, company);
          failures.push(failure);
          if (counters) await counters.addBoardFailure(failure);
        } else {
          // §4.6.16 Layer 2 — `sourced` still contains every job Layer 1's
          // gazetteer couldn't confidently place ('unknown'), alongside
          // confirmed matches; Layer 1 already dropped confident mismatches.
          // Resolve the unknowns against the location_resolutions AI cache
          // and drop any it can confirm at high confidence don't match,
          // BEFORE the deterministic §4.3 pre-filter runs — a location
          // mismatch must never reach paid AI scoring. Only spends anything
          // when a location filter is actually set; a genuinely new string
          // costs one cache write, ever, platform-wide. Counters reflect the
          // FINAL classification (Layer 1 confident mismatches + Layer 2
          // AI-confirmed mismatches as "filtered"; whatever's still
          // unresolved after both layers as "unsure").
          const { jobs, aiFiltered, stillUnsure, unsureDropped } = await resolveLocationUnknowns(db, sourced, locations);
          // unsureDropped is a real location-filter drop (only non-zero under
          // unknownPolicy: 'drop'), so it belongs in the same counter as the
          // confident ones; stillUnsure keeps counting the unresolvable strings
          // either way, so the measurement that gates the policy survives it.
          const totalFiltered = (locationStats ? locationStats.filtered : 0) + aiFiltered + unsureDropped;
          if (counters) {
            if (totalFiltered) await counters.add('jobs_location_filtered_count', totalFiltered);
            if (stillUnsure) await counters.add('jobs_location_unsure_count', stillUnsure);
          }

          // Lightweight detection stub, never the full posting (memory,
          // §26 — a NormalizedJob's descriptionText alone runs 5-20 KB, and
          // resolveCompaniesFromJobs, the only consumer, ever reads just
          // these three fields). Dropping the rest here is what lets a
          // company's full fetch response be GC'd at the end of THIS
          // iteration instead of retained for the whole run.
          for (const j of jobs) found.push({ companyName: j.companyName, link: j.link, source: j.source });
          if (counters && jobs.length) await counters.add('jobs_found_count', jobs.length);

          // prefilter -> seen.add stays ONE await-free synchronous block
          // (no await between them) — two companies racing on a posting
          // shared across ATS boards must never both count it as a survivor
          // before either commits its dedup key to `seen`. Persisting via
          // onSurvivors happens strictly AFTER this block, never inside it.
          let batchSurvivors = [];
          let batchDropped = [];
          if (jobs.length) {
            const { survivors, dropped } = prefilter({
              jobs,
              userProfile,
              seenDedupKeys: seen,
              visaFilterOn: config.visa_filter_on !== false,
            });
            for (const s of survivors) {
              batchSurvivors.push(s);
              if (s.dedupKey) seen.add(s.dedupKey);
            }
            batchDropped = dropped;
          }
          if (counters && batchDropped.length) await counters.addDrops(batchDropped);

          if (batchSurvivors.length) {
            survivorCount += batchSurvivors.length;
            if (counters) await counters.add('jobs_survived_prefilter_count', batchSurvivors.length);
            await onSurvivors(batchSurvivors);
          }
        }
      } catch (e) {
        // Distinct from a `failure` above (board-reachability, drives the
        // user-facing ats_direct_company_failed notification) — this is an
        // unexpected error AFTER a successful fetch (e.g. prefilter or the
        // onSurvivors persist/enqueue call throwing). Logged for operator
        // visibility, not surfaced as a per-company notification. The
        // company is still marked complete below so it can't stall this
        // selection's cursor forever; nothing was durably persisted for it
        // (job_dedup_seen for a failed persist is only ever written by a
        // SUCCESSFUL onSurvivors), so it will simply be reconsidered fresh
        // on a future run.
        console.error(`atsDirectRun: unexpected error processing company "${company.company_name_display}":`, e.message || e);
      }

      // Marked complete on EVERY outcome — success, a caught fetch failure,
      // or the catch-all above. A company that's always unreachable must
      // still advance the watermark, or it permanently pins the cursor at
      // its own position across every future run against this selection.
      completed[i] = true;
      advanceWatermark();
      if (counters) await counters.add('companies_queried_count', 1);
      try {
        await maybeCheckpoint(false);
      } catch (e) {
        console.error('atsDirectRun: cursor checkpoint failed:', e.message || e);
      }
      maybeLogMemory();
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.allSettled(workers);

  // Final checkpoint — unthrottled, so the cursor reflects exactly where the
  // watermark landed even if it didn't clear the throttle bar. Guaranteed no
  // save is still in flight here (every worker awaits its own
  // maybeCheckpoint call before its next loop iteration or return, so by the
  // time all workers have settled, checkpointInFlight is already false).
  try {
    await maybeCheckpoint(true);
  } catch (e) {
    console.error('atsDirectRun: final cursor checkpoint failed:', e.message || e);
  }

  const lapped = watermarkIdx >= n;
  const lastCompanyIdQueried = watermarkIdx > 0 ? ordered[watermarkIdx - 1].id : lastCompanyId || null;

  return {
    found,
    survivorCount,
    failures,
    companiesQueried: watermarkIdx,
    totalSelected: n,
    lapped,
    lastCompanyId: lastCompanyIdQueried,
    resolvedTracklistIds,
    missingTracklistIds,
  };
}

module.exports = { runAtsDirectSourcing };

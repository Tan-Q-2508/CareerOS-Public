const { getSupabaseAdmin, apifyAdapter, scraperApiAdapter, jsearchAdapter, prefilter, geminiAdapter, tunables, scanTitles } = require('@careeros/shared');
const { decryptSecret } = require('../lib/secretCrypto');
const { yearsOfExperience: deriveYearsOfExperience, hasGraduateDegree } = require('../resume/deriveProfile');
const cosGuard = require('../lib/cosGuard');
const aiRouter = require('../lib/aiRouter');
const { makeProgressLogger } = require('../lib/progress');
const { resolveCompaniesFromJobs, linkJobsToRegistry } = require('../companies/registry');
const { insertNotification } = require('../lib/notify');
const { runAtsDirectPipeline } = require('./atsDirectPipeline');
const { createJobScorer } = require('./jobScorer');
const { startScanHeartbeat } = require('./scanHeartbeat');
const { createScanCounters } = require('./scanCounters');
const { createCancelWatch } = require('./cancelWatch');
const { sweepOrphanedPrefilteredJobs } = require('./scheduler');
const { quickRead, buildTriageProfile } = require('./triage');

// One plain-language line per scan for the boards that failed after retries,
// grouped by cause: "2 job boards timed out after 3 tries (SpaceX, Stripe); 1
// board no longer exists and was removed from future scans (Postman)."
const FAILURE_PHRASES = {
  timeout: (n) => `${n} job board${n === 1 ? '' : 's'} timed out after retries`,
  rate_limited: (n) => `${n} job board${n === 1 ? '' : 's'} kept rate-limiting us`,
  server_error: (n) => `${n} job board${n === 1 ? '' : 's'} returned server errors`,
  network: (n) => `${n} job board${n === 1 ? '' : 's'} couldn't be connected to`,
  board_gone: (n) => `${n} job board${n === 1 ? '' : 's'} no longer exist${n === 1 ? 's' : ''}`,
  other: (n) => `${n} job board${n === 1 ? '' : 's'} returned something unreadable`,
};
function boardFailureSummary(failures) {
  const byKind = new Map();
  for (const f of failures) {
    const k = FAILURE_PHRASES[f.kind] ? f.kind : 'other';
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(f);
  }
  const parts = [];
  for (const [kind, list] of byKind) {
    const names = list.slice(0, 4).map((f) => f.company).join(', ') + (list.length > 4 ? `, +${list.length - 4} more` : '');
    let part = `${FAILURE_PHRASES[kind](list.length)} (${names})`;
    if (kind === 'board_gone' && list.some((f) => f.retired)) part += ' — removed from future scans';
    parts.push(part);
  }
  return `ATS Direct: ${parts.join('; ')}. The rest of the scan ran normally.`.slice(0, 500);
}

// C1: years-of-experience is live, not a frozen snapshot — recomputed fresh
// from the active résumé's parsed_profile every time it's needed for
// prefilter/scoring, UNLESS the user explicitly overrode it in Settings
// (years_of_experience_manual), in which case the stored value wins verbatim.
function liveYearsOfExperience(user, parsedProfile) {
  if (user.years_of_experience_manual) return user.years_of_experience;
  const derived = deriveYearsOfExperience(parsedProfile);
  return derived != null ? derived : user.years_of_experience;
}

// Resolve a scan's selected sources (spec 4.2 multi-actor) into runnable source
// descriptors. 'cs' = Core Scraper (house JSearch, no key needed from the user).
// A UUID = a saved provider_credentials BYO Scraper actor (its key is decrypted).
// Unknown/unowned ids or undecryptable keys are skipped. Empty => Core Scraper.
// (The old 'linkedin'/'byo' preset was removed when Core Scraper landed, 4.2.)
async function resolveActors(db, userId, sources, config) {
  const ids = sources && sources.length ? sources : ['cs'];
  // 'ats_direct' is a fixed id like 'cs', not a provider_credentials UUID —
  // excluded here too, or .in('id', uuidIds) below tries to cast it to uuid
  // and errors.
  const uuidIds = ids.filter((s) => s !== 'cs' && s !== 'ats_direct');
  let rows = [];
  if (uuidIds.length) {
    const { data } = await db
      .from('provider_credentials')
      .select('id, provider_name, encrypted_key, label, job_count_max, config_json')
      .eq('user_id', userId)
      .eq('provider_type', 'sourcing')
      .in('id', uuidIds);
    rows = data || [];
  }
  const actors = [];
  const seen = new Set();
  for (const s of ids) {
    if (seen.has(s)) continue;
    seen.add(s);
    if (s === 'cs') {
      // Core Scraper is temporarily disabled by product decision — enforced
      // here (not just hidden in the UI) so neither the manual scan route nor
      // a saved schedule can reach it while it's off. Skipped like an unknown
      // source, never a hard failure.
      if (tunables.coreScraperEnabled) {
        actors.push({ kind: 'cs', id: 'cs', label: 'Core Scraper', count: config.cs_job_count });
      }
    } else if (s === 'ats_direct') {
      // No credential lookup — ATS Direct is house-run against companies the
      // user already tracks (4.6.6), not a third-party actor.
      actors.push({ kind: 'ats_direct', id: 'ats_direct', label: 'ATS Direct', count: config.ats_job_count });
    } else {
      const row = rows.find((r) => r.id === s);
      if (!row) continue;
      const cfg = row.config_json || {};
      let token;
      try {
        token = decryptSecret(row.encrypted_key);
      } catch (e) {
        console.error(`runScan: could not decrypt key for actor ${row.label}:`, e.message);
        continue;
      }
      actors.push({
        kind: row.provider_name === 'scraperapi' ? 'scraperapi' : 'apify',
        id: row.id,
        label: row.label,
        board: cfg.board,
        actorId: cfg.actor_id,
        outputMapping: cfg.output_mapping,
        inputTemplate: cfg.input_template,
        token,
        // The per-scan requested count (New Scan's Advanced Options) actually
        // applies here, capped by the actor's own saved ceiling (Settings) as
        // a safety net — not the other way around. Previously this read
        // `row.job_count_max || config.ld_job_count`, so the saved ceiling
        // (always set — every actor gets a default) silently won every time,
        // making the per-scan field a no-op. Confirmed live: a scan asking
        // for 25 actually ran against the actor's saved ceiling of 100.
        count: Math.min(config.ld_job_count, row.job_count_max),
      });
    }
  }
  return actors;
}

// The single callable "run a scan" function (spec 12.1) — the Session 12
// scheduler will reuse it. Sourcing -> deterministic pre-filter -> store
// survivors as `prefiltered` -> AI scoring (Session 4) in one pass (spec 4.4).
async function runScan(scanId, userId, config) {
  const db = getSupabaseAdmin();
  const mark = (fields) => db.from('scan_history').update(fields).eq('id', scanId);
  const logProgress = makeProgressLogger(db, 'scan_history', scanId);
  // Live telemetry (§26 progress-regression fix, CareerOS_Changelog.md
  // §4.6.12) — one throttled single-writer for scan_history's counter
  // columns, fed by both the ATS Direct pipeline and jobScorer/CS-BYO so the
  // dashboard's console/summary strip has real numbers to show mid-run
  // instead of only after the whole scan completes.
  const counters = createScanCounters(db, scanId);

  // Billed incrementally as costs are actually incurred (flat fee here, then
  // sourcing cost right after sourcing, then AI cost per job as it's scored)
  // rather than one lump debit at the very end — a scan that dies partway
  // through (Render free-tier restart, no persistent queue) used to leak the
  // whole cost: real work already done, nothing ever billed for it. The
  // route-level checkCosBalance pre-check already confirmed the balance
  // covers at least this flat fee before runScan was dispatched.
  const actionType = scanActionType(config.sources);

  // On-demand scoring (spec 4.7): source and pre-filter exactly as always, but
  // store survivors as 'sourced' with a deterministic Quick read instead of
  // AI-scoring them — the user picks which to score afterwards
  // (scoreSelectedJobs.js). Nothing below the pre-filter changes shape: the
  // flat fee, dedup, detection, the cursor and the counters are identical.
  const onDemand = config.score_mode === 'on_demand';

  // Whole-scan heartbeat (§26/4.6.12) — covers BOTH sourcing and scoring, not
  // just ATS Direct's old sourcing-only self-ping, which went silent the
  // moment sourcing finished (exactly when a long scoring phase most needed
  // it). Keeps the Render free-tier dyno alive and lets reapStaleScans
  // (scheduler.js) tell a long-but-healthy run from a genuinely crashed one.
  const heartbeat = startScanHeartbeat(db, scanId);

  try {
    await mark({ status: 'running', started_at: new Date().toISOString() });

    // Single row for the whole scan (2026-08-15 fix — "46 jobs scored, only
    // 4 ledger rows" turned out to be aiFeeCosDelta's once-per-scan BYOK
    // floor correctly skipping $0 marginal debits, but every non-zero debit
    // was STILL its own row). This flat-fee insert is the one row; every
    // further cost this scan incurs (sourcing below, then AI cost per job in
    // jobScorer.js) folds into it via debitCosInto instead of inserting
    // again.
    const scanTitle = scanTitles(config).join(', ') || 'Untitled scan';
    const scanTransaction = await cosGuard.debitCos(db, userId, {
      actionType,
      flatFee: tunables.flatFees[actionType],
      relatedScanId: scanId,
      note: `Scan: ${scanTitle}`,
    });
    const scanTransactionId = scanTransaction?.id || null;

    const { data: user, error: userErr } = await db
      .from('users')
      .select('years_of_experience, domain_keywords, off_domain_title_keywords, years_of_experience_manual, auto_track_scraped_companies')
      .eq('id', userId)
      .single();
    if (userErr) throw userErr;

    const { data: resume } = await db
      .from('resume_versions')
      .select('id, parsed_profile')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    if (!resume) throw new Error('No active resume to scan against');

    // Overwrite the in-memory value with the live computation (C1) — every
    // downstream read of user.years_of_experience in this scan (prefilter +
    // scoring) sees the fresh number without touching call sites below.
    user.years_of_experience = liveYearsOfExperience(user, resume.parsed_profile);
    user.has_graduate_degree = hasGraduateDegree(resume.parsed_profile);

    // Scoring preconditions, hoisted above sourcing (§26 rule 12) — checked
    // once here instead of inside scoreScanJobs at the end, as they used to
    // be. Under the old fully-sequential pipeline that late check just meant
    // "return 0, leave everything prefiltered" after sourcing had already
    // happened — a fine place for it. Under ATS Direct's concurrent pipeline
    // it would mean up to 30 minutes of real sourcing work landing as instant
    // orphans the moment scoring tries and immediately fails on the first
    // job, so the check now happens before either path starts. `jobScorer` is
    // built either way (construction itself is pure/sync, no AI call) — when
    // scoring is unavailable it's a no-op stand-in (scoreOne resolves without
    // doing anything, count stays 0) rather than null, so both the ATS
    // pipeline's Stage B workers and CS/BYO's scoreScanJobs driver can call it
    // unconditionally without a special case.
    // On-demand scans make no AI call at all, so they neither need nor
    // resolve a credential.
    const credential = onDemand ? null : await aiRouter.resolveAiCredential(db, userId);
    let scoringPreconditionError = null;
    if (onDemand) {
      // Nothing to check — see above.
    } else if (credential.mode === 'cai' && !geminiAdapter.isConfigured()) {
      scoringPreconditionError = 'Gemini not configured';
    } else if (!resume.parsed_profile) {
      scoringPreconditionError = 'active resume has no parsed_profile';
    }
    if (scoringPreconditionError) {
      console.warn(`runScan: ${scoringPreconditionError} — skipping scoring, jobs will be left prefiltered`);
    }
    const jobScorer = scoringPreconditionError || onDemand
      ? { scoreOne: async () => {}, getScored: () => 0, getAboveThreshold: () => 0, flush: async () => {} }
      : await createJobScorer({ db, scanId, userId, user, resume, config, actionType, credential, counters, scanTransactionId });

    // Already-seen keys: union of job_dedup_seen (survives a below-threshold
    // job's row being deleted after scoring, A2) AND jobs.dedup_key currently
    // in the table. The union is defense-in-depth, not redundant: a real gap
    // shipped 2026-07-25 where job_dedup_seen wasn't backfilled from
    // already-existing jobs, so the prefilter thought every one of them was
    // brand new — they "survived" the prefilter, then silently failed to
    // insert on the (user_id, dedup_key) conflict, so almost nothing actually
    // got scored (confirmed live, fixed via a backfill migration 2026-07-26).
    // Checking jobs.dedup_key too means any future insertion path that forgets
    // to also write job_dedup_seen can't silently reproduce this.
    //
    // §15 #25c-2 moved this load ABOVE sourcing (it used to run right before
    // the single prefilter() call below) — the ATS Direct backfill loop
    // (atsDirectRun.js) needs a live `seen` set DURING sourcing, since it
    // pre-filters per company-batch rather than once over the full found set,
    // and each batch's survivors must be excludable from the next batch's
    // dedup check within the same run.
    //
    // Both reads are PAGED (2026-09-25): an unpaged select stops at
    // PostgREST's 1000-row page, and a real account had 6,218 seen keys — so
    // every posting past the first 1000 looked brand new again and was
    // re-scored. Found when 11 of an on-demand scan's 28 "new" survivors
    // turned out to be keys already in job_dedup_seen.
    const [seenRows, jobRows] = await Promise.all([
      selectAllRows(() => db.from('job_dedup_seen').select('dedup_key').eq('user_id', userId).order('id')),
      selectAllRows(() => db.from('jobs').select('dedup_key').eq('user_id', userId).order('id')),
    ]);
    const seen = new Set([...seenRows, ...jobRows].map((j) => j.dedup_key));

    // How a survivor row is stored: 'prefiltered' then AI-scored, or — on
    // demand — 'sourced' with its Quick read (triage.js, no AI).
    const threshold = config.threshold ?? tunables.storageCutoff;
    const triageProfile = onDemand
      ? buildTriageProfile({
          parsedProfile: resume.parsed_profile,
          domainKeywords: user.domain_keywords,
          years: user.years_of_experience,
          hasGraduateDegree: user.has_graduate_degree,
        })
      : null;
    const storedAs = (j) =>
      onDemand
        ? { status: 'sourced', triage: quickRead({ job: j, profile: triageProfile, threshold }) }
        : { status: 'prefiltered' };

    await logProgress('sourcing', 'Sourcing jobs from selected sources');
    // Sourcing (BYO Scraper via Apify) — one or more selected actors (spec 4.2).
    // Each actor sources independently; a failed actor is logged and skipped, never
    // taking down the whole scan (12.4). Results merge + dedup in the pre-filter.
    const actors = await resolveActors(db, userId, config.sources, config);
    let found = [];
    let usedCs = false;
    let jsearchRequests = 0;
    // ATS Direct sources, persists, AND scores concurrently inside
    // atsDirectPipeline.js (below) — 4.1/4.2's "exactly one source per scan"
    // rule means this can only ever be set alongside an empty `found`
    // contribution from every other branch. Its presence is what tells the
    // code after this loop to skip the shared prefilter/upsert/scoreScanJobs
    // path entirely (that path belongs to CS/BYO only now).
    let atsDirectResult = null;
    for (const actor of actors) {
      try {
        if (actor.kind === 'cs') {
          const { jobs, requests } = await jsearchAdapter.sourceJobs({
            title: config.job_title,
            location: config.location,
            keywords: config.keywords,
            count: actor.count,
            postedWithinDays: config.posted_within_days,
          });
          found = found.concat(jobs);
          usedCs = true;
          jsearchRequests += requests;
        } else if (actor.kind === 'ats_direct') {
          // 4.6.6/4.6.12: the company selection is tracklists/subscriptions
          // primary (config.tracklist_ids) with an optional narrow-to-
          // companies sub-picker (config.tracked_company_ids, also the
          // legacy §24 selector for schedules that only ever set that
          // field). Target-with-backfill + the rotating cursor both live in
          // atsDirectRun.js, driven concurrently by atsDirectPipeline.js
          // (§26) — it walks the selection via a bounded fetch pool,
          // pre-filters each company's postings as they land, persists
          // survivors immediately, and scores them via jobScorer.scoreOne
          // on a separate bounded worker pool running AT THE SAME TIME as
          // later companies are still being fetched, until the survivor
          // count hits the target or the selection fully laps. No
          // sourcing-cost debit follows this path (4.6.7 — the platform APIs
          // are free); only the flat fee billed above and the per-job AI
          // cost jobScorer.scoreOne bills internally.
          // §26 progress-regression fix: the ATS path used to emit no
          // 'scoring' milestone at all, since the old shared logProgress
          // call below (now guarded by `if (!atsDirectResult)`) never ran
          // for it — sourcing and scoring happen together here, not as two
          // sequential phases, so this line is emitted once up front rather
          // than after a count is known.
          await logProgress(
            'scoring',
            onDemand
              ? 'Finding and pre-filtering jobs — you choose which ones to score'
              : 'Scoring jobs as they are found (sourcing and scoring run together)'
          );
          const result = await runAtsDirectPipeline({
            db,
            userId,
            scanId,
            resumeVersionId: resume.id,
            config,
            userProfile: {
              yearsOfExperience: user.years_of_experience,
              hasGraduateDegree: user.has_graduate_degree,
              domainKeywords: user.domain_keywords,
              offDomainTitleKeywords: user.off_domain_title_keywords,
            },
            seen,
            jobScorer,
            counters,
            storedAs,
            scoreInline: !onDemand,
          });
          found = found.concat(result.found);
          atsDirectResult = result;
          await logProgress(
            'sourcing',
            `ATS Direct: queried ${result.companiesQueried} of ${result.totalSelected} selected companies` +
              (result.lapped ? ' (full lap)' : ' (cursor will resume here next time)')
          );
          // Per-company failure isolation (12.4) — fires for manual scans
          // too, not only scheduled ones, so an unreachable board is never
          // silently invisible just because nobody was watching the scan
          // run. ONE notification per scan, grouped by what actually went
          // wrong (every failure here already failed all its retries); the
          // per-board detail lives in scan_history.board_failures.
          if (result.failures.length) {
            await insertNotification(db, userId, 'ats_direct_company_failed', boardFailureSummary(result.failures));
          }
        } else {
          const adapter = actor.kind === 'scraperapi' ? scraperApiAdapter : apifyAdapter;
          const jobs = await adapter.sourceJobs({
            actor,
            title: config.job_title,
            location: config.location,
            keywords: config.keywords,
            count: actor.count,
            postedWithinDays: config.posted_within_days,
          });
          found = found.concat(jobs);
        }
      } catch (e) {
        console.error(`runScan: sourcing via "${actor.label || actor.actorId}" failed:`, e.message || e);
      }
    }
    await mark({ jobs_found_count: found.length });
    if (!atsDirectResult) await counters.set('jobs_found_count', found.length);

    if (usedCs && jsearchRequests > 0) {
      const sourcingUsd = jsearchRequests * tunables.sourcing.jsearch.costPerRequestUsd;
      const sourcingCos = Number((sourcingUsd * tunables.cosMargin * tunables.cosExchangeRate).toFixed(4));
      // No `note` here — debitCosInto's underlying RPC does
      // `note = coalesce(p_note, note)`, so omitting it keeps the row's
      // scan-level note (set once, above) instead of overwriting it with a
      // one-off sourcing/per-job note that would then hide the scan
      // identity the History panel actually needs to show.
      await cosGuard.debitCosInto(db, userId, scanTransactionId, {
        actionType,
        sourcingCost: sourcingCos,
        relatedScanId: scanId,
      });
    }

    // ATS Direct sources, persists, AND scores its own survivors incrementally
    // inside atsDirectPipeline.js above (§26) — nothing left to do for that
    // source below. Every other source still goes through exactly one shared
    // prefilter() -> upsert -> scoreScanJobs pass, unchanged.
    let survivorCount;
    if (!atsDirectResult) {
      await logProgress('prefilter', `Filtering ${found.length} job(s) found`);
      const { survivors, dropped } = prefilter({
        jobs: found,
        userProfile: {
          yearsOfExperience: user.years_of_experience,
          hasGraduateDegree: user.has_graduate_degree,
          domainKeywords: user.domain_keywords,
          offDomainTitleKeywords: user.off_domain_title_keywords,
        },
        seenDedupKeys: seen,
        visaFilterOn: config.visa_filter_on !== false,
      });
      await counters.addDrops(dropped);
      survivorCount = survivors.length;
      await mark({ jobs_survived_prefilter_count: survivorCount });
      await counters.set('jobs_survived_prefilter_count', survivorCount);

      if (survivors.length) {
        const rows = survivors.map((j) => ({
          user_id: userId,
          sources: [j.source || 'cs'],
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
          resume_version_id: resume.id,
          ...storedAs(j),
        }));
        const { error } = await db
          .from('jobs')
          .upsert(rows, { onConflict: 'user_id,dedup_key', ignoreDuplicates: true });
        if (error) throw error;

        // Dedup memory survives independent of the jobs row's later fate (A2) — a
        // below-threshold job gets deleted after scoring, but we still don't want
        // to re-pay to re-score the same posting on a future scan.
        const dedupRows = survivors.map((j) => ({ user_id: userId, dedup_key: j.dedupKey }));
        const { error: dedupErr } = await db
          .from('job_dedup_seen')
          .upsert(dedupRows, { onConflict: 'user_id,dedup_key', ignoreDuplicates: true });
        if (dedupErr) console.error('job_dedup_seen upsert failed:', dedupErr.message);

        // Link already-registered companies onto the rows just stored — the
        // majority case, since most companies a scan surfaces are already in
        // the registry from an earlier sighting and don't need to wait on the
        // detection pass below. Cheap: reuses the survivors already in memory,
        // no requery (§15 #25c-1).
        await linkJobsToRegistry(db, userId, {
          scanId,
          jobs: survivors.map((j) => ({ companyName: j.companyName, dedupKey: j.dedupKey })),
        });
      }
    } else {
      survivorCount = atsDirectResult.survivorCount;
      await mark({ jobs_survived_prefilter_count: survivorCount });
    }

    // ATS Direct company detection (spec 4.6.3, entry point 1) — dispatched
    // HERE, after the jobs upsert above (moved by §15 #25c-1 so
    // linkJobsToRegistry below has rows to link against). Detection itself
    // still sees the FULL sourced set (`found`, not `survivors`), preserving
    // 4.6's "must see every company before pre-filter/threshold attrition"
    // requirement verbatim — only the dispatch TIMING moved, not what it's
    // given to look at.
    //
    // Fire-and-forget and fully swallowed, same posture as the tracker
    // auto-populate block below: free, isolated, and a probe sweep against
    // three third-party APIs must never delay or fail a scan. autoTrack
    // (4.6.10) routes every company this pass resolves/re-sights into
    // "Scraped Companies" — never the curated default list — gated on this
    // user's Settings toggle, tunable-defaulted per the
    // config.threshold ?? tunables.storageCutoff precedent below.
    const autoTrackScraped = user.auto_track_scraped_companies ?? tunables.autoTrackScrapedCompanies;
    resolveCompaniesFromJobs(db, userId, found, { autoTrack: autoTrackScraped })
      .then(async (r) => {
        if (r.attempted) {
          console.log(
            `ats-detect: scan ${scanId} — ${r.resolved} resolved, ${r.unresolved} unresolved of ${r.attempted} attempted (${r.considered} distinct companies seen)`
          );
        }
        // Pick up companies this pass newly resolved (the ones the
        // survivors-scoped link call above couldn't have known about yet).
        await linkJobsToRegistry(db, userId, { scanId });
      })
      .catch((e) => console.error('ats-detect: company detection pass failed:', e.message || e));

    // ---- AI scoring (spec 5, 5.6, 4.6.12) ----
    // ATS Direct already scored concurrently with sourcing, inside
    // atsDirectPipeline.js above — jobScorer already holds the final count;
    // flush() (rule 11) must land before the 'completed' mark below writes
    // jobs_scored_count, or a late throttled write could regress it. Every
    // other source still runs the shared sequential scoreScanJobs pass.
    let scoredCount;
    if (onDemand) {
      scoredCount = 0;
      await counters.flush();
    } else if (atsDirectResult) {
      await jobScorer.flush();
      scoredCount = jobScorer.getScored();
    } else {
      await logProgress('scoring', `Scoring ${survivorCount} job(s) against your résumé`);
      scoredCount = await scoreScanJobs({ db, scanId, userId, jobScorer });
    }
    // D1: reconcile jobs_above_threshold_count at completion time too, same
    // as jobs_scored_count above it — jobScorer is the single accumulator for
    // both counters regardless of which path scored the scan (ATS Direct's
    // concurrent pipeline or CS/BYO's sequential scoreScanJobs), so a mid-run
    // failure that left the throttled scanCounters write behind the true
    // in-memory count can no longer leave a permanently skewed number on the
    // completed row.
    const aboveThresholdCount = jobScorer.getAboveThreshold();

    // `.eq('status', 'running')` so a scan the user cancelled while this was
    // finishing is not overwritten as 'completed'. The counters still land —
    // they are written by the same statement, and a cancelled scan should
    // still report honestly how much it got through before it stopped.
    const { data: finished } = await db
      .from('scan_history')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        jobs_scored_count: scoredCount,
        jobs_above_threshold_count: aboveThresholdCount,
      })
      .eq('id', scanId)
      .eq('status', 'running')
      .select('id')
      .maybeSingle();
    if (!finished) {
      await mark({
        completed_at: new Date().toISOString(),
        jobs_scored_count: scoredCount,
        jobs_above_threshold_count: aboveThresholdCount,
      });
      console.log(`runScan: scan ${scanId} ended while cancelled — counters recorded, status left as-is`);
    }
    // F3 follow-up (live-verified 2026-08-12): a per-job scoring failure
    // (16.8's isolation catch) leaves that job at 'prefiltered' by design so
    // the scan itself doesn't fail — but nothing ever retries it, and
    // reapStaleScans' sweep only covers scans it reaped. Once this scan has
    // reached 'completed', nothing will score that row, so sweep it now with
    // the exact same semantics as the reap path.
    await sweepOrphanedPrefilteredJobs(db, scanId);
    await logProgress(
      'done',
      onDemand ? `Done — ${survivorCount} job(s) ready. Pick the ones worth scoring.` : 'Done'
    );
  } catch (err) {
    console.error('runScan failed:', err);
    await logProgress('failed', String(err.message || err).slice(0, 200));
    await mark({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: String(err.message || err).slice(0, 500),
    });
  } finally {
    heartbeat.stop();
  }
}

// Every row a query matches, past PostgREST's 1000-row page. `build` returns
// a fresh, ordered query each call (a builder can't be re-ranged).
const PAGE_SIZE = 1000;
async function selectAllRows(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

// cos_transactions action type for a scan, from its sources.
function scanActionType(sources) {
  const list = Array.isArray(sources) ? sources : [];
  if (list.includes('cs')) return 'cs_scan';
  if (list.includes('ats_direct')) return 'ats_direct_scan';
  return 'byo_scan';
}

// Score every prefiltered job for this scan — Core Scraper / BYO Scraper
// only; ATS Direct scores concurrently inside atsDirectPipeline.js using the
// same jobScorer.scoreOne unit (§26/4.6.12). Thin sequential driver as of
// this session: the per-job logic (score -> threshold compare -> persist ->
// bill -> log) now lives in jobScorer.js, shared verbatim by both paths, so
// this function's only remaining job is to load the work set, loop it
// sequentially, and flush at the end. Scoring preconditions (credential,
// Gemini configured, parsed_profile present) are checked once by the caller
// before jobScorer is even built (§26 rule 12) — when they fail, `jobScorer`
// is a no-op stand-in, so this loop still runs safely and simply scores
// nothing. Returns the count of jobs successfully scored. Per-job failure
// isolation (16.8): a thrown error is caught here, logged, and that job
// stays `prefiltered` — never dropped silently, never fails the scan.
async function scoreScanJobs({ db, scanId, userId, jobScorer }) {
  const { data: jobsToScore, error: jErr } = await db
    .from('jobs')
    // company_name / company_ats_registry_id are here for 19.4's sponsorship
    // fact — the scorer had no view of the employer at all before §15 #49.
    .select('id, title, location, posted_at, salary_min, salary_max, seniority_level, description_text, company_name, company_ats_registry_id')
    .eq('user_id', userId)
    .eq('scan_history_id', scanId)
    .eq('status', 'prefiltered');
  if (jErr) throw jErr;
  if (!jobsToScore || !jobsToScore.length) return 0;

  // Checked between jobs, not inside scoreOne — the catch below exists to
  // isolate a bad job (16.8) and would swallow a cancellation just as happily.
  const isCancelled = createCancelWatch(db, scanId);

  for (const job of jobsToScore) {
    if (await isCancelled()) {
      console.log(`runScan: scan ${scanId} cancelled by user — stopping after ${jobScorer.getScored()} scored job(s)`);
      break;
    }
    try {
      await jobScorer.scoreOne(job);
    } catch (err) {
      console.error(`runScan: scoring job ${job.id} failed, left prefiltered:`, err.message || err);
    }
  }

  await jobScorer.flush();
  return jobScorer.getScored();
}

module.exports = { runScan, resolveActors, liveYearsOfExperience, scanActionType, selectAllRows };

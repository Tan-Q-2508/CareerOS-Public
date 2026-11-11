// Per-job scoring unit (spec §4.4/5, §16.8; extracted from runScan.js's old
// scoreScanJobs during Phase 4 §26/4.6.12) — the per-job body that used to be
// inline inside a single sequential `for` loop, lifted into its own
// `scoreOne(job)` so it can be driven from two different places with
// identical logic: `scoreScanJobs`'s thin sequential loop (Core Scraper / BYO
// Scraper, unchanged behavior) and atsDirectPipeline.js's bounded concurrent
// scoring worker pool (new, §26).
//
// Everything scoreOne does per job is unchanged verbatim from the old inline
// version: score -> threshold compare -> persist `scored` or delete
// below-threshold -> log AI usage -> bill the AI-fee delta -> track for
// tracker auto-population. `scan_history`'s live counter columns
// (jobs_scored_count, jobs_above_threshold_count) are written via the shared
// `counters` bag (scanCounters.js) rather than a private throttle here — that
// module is the single writer for every live counter on the row, including
// the ones the ATS Direct pipeline also contributes to, so there's exactly
// one throttled writer instead of jobScorer and the ATS pipeline racing their
// own absolute-value updates.

const { tunables } = require('@careeros/shared');
const { scoreJob, buildResumeProfileBlock } = require('../scoring/scoreJob');
const cosGuard = require('../lib/cosGuard');
const aiRouter = require('../lib/aiRouter');
const { createSponsorResolver } = require('../visa/sponsorLookup');

async function createJobScorer({ db, scanId, userId, user, resume, config, actionType, credential, counters, scanTransactionId }) {
  const parsedProfile = resume.parsed_profile;
  const resumeProfileBlock = buildResumeProfileBlock(parsedProfile);
  // Confirmed skills count toward every job's Keywords X/Y (keywordState),
  // the same as they do in the gap check — loaded once per scan.
  const { data: confirmedRows } = await db.from('confirmed_skills').select('skill_term').eq('user_id', userId);
  const confirmedSkills = confirmedRows || [];
  // No universal fallback (spec 4.3): with no derived keywords, domainOverlap()
  // downstream just reads an honest 0 rather than being computed against any
  // single domain's terms.
  const domainKeywords = user.domain_keywords && user.domain_keywords.length ? user.domain_keywords : [];
  // A1: the per-scan user-chosen threshold gates storage, falling back to the
  // old fixed floor for scan_history rows created before this change. Hoisted
  // to construction time (was previously computed inline inside scoreOne on
  // every call) so D2's early-abandon check in scoreJob() can also see it —
  // it's constant for the whole scan either way.
  const threshold = config.threshold ?? tunables.storageCutoff;

  let scored = 0;
  let aboveThreshold = 0;
  const autoSaveJobIds = []; // jobs >= tracker threshold → auto-populate the tracker (spec §9)
  // Running BYOK pre-floor total + what's actually been charged so far this
  // scan — threaded through aiRouter.aiFeeCosDelta so the once-per-scan floor
  // still applies to the scan's cumulative total, not to each job (see
  // aiFeeCosDelta's own comment). Unused on the CAI path (no floor there).
  // Safe under concurrent scoreOne calls: the read (`priorRawCos`/
  // `priorChargedCos`) -> compute (`aiFeeCosDelta`, pure/sync) -> write
  // (reassigning both) happens in one await-free synchronous span per call —
  // `debitCos` (the only await in this section) runs AFTER both are already
  // reassigned, so there's no read-modify-write race for two concurrent
  // scoreOne calls to interleave into (§26 rule 2).
  let priorRawCos = 0;
  let priorChargedCos = 0;

  // 19.4's grounded sponsorship fact. Built once per scan so the lookup is one
  // query per distinct EMPLOYER rather than one per job, and so its promise
  // cache is safe for atsDirectPipeline's concurrent workers — see
  // visa/sponsorLookup.js for why it caches promises rather than values.
  const sponsorResolver = createSponsorResolver(db);

  // Scores one `jobs` row already loaded at status='prefiltered'. Per-job
  // failure isolation (16.8): a thrown error here is caught by the caller
  // (scoreScanJobs' loop / atsDirectPipeline's worker), logged, and the job
  // stays at 'prefiltered' — never dropped silently, never fails the scan.
  async function scoreOne(job) {
    // Resolved before scoreJob so the fact is present for call 2's prompt.
    // Never throws (the resolver swallows its own failures) — a sponsorship
    // lookup problem must not cost the user a scored job.
    const sponsor = await sponsorResolver.resolve(job.company_name, job.company_ats_registry_id);

    const result = await scoreJob({
      resumeProfile: parsedProfile,
      confirmedSkills,
      resumeProfileBlock,
      job,
      userYears: user.years_of_experience,
      domainKeywords,
      scanLocation: config.location,
      credential,
      threshold,
      sponsor,
      db,
      // NOT `user.id`: the `users` row is SELECTed without its own id
      // (runScan.js), so `user.id` is undefined — which silently disabled the
      // JD extraction cache entirely, since jdAtsCall only builds a cache key
      // when it has a user. The id in scope here is the real one, and is what
      // every other write in this file already uses.
      userId,
    });

    const overall = result.scores.overallFit;
    const meetsThreshold = overall >= threshold;

    if (meetsThreshold) {
      const { error: upErr } = await db
        .from('jobs')
        .update({
          jd_profile: result.jdProfile,
          prompt_version: tunables.scoring.promptVersion,
          ats_match: result.scores.atsMatch,
          keyword_coverage: result.scores.keywordCoverage,
          callback_odds: result.scores.callbackOdds,
          overall_fit: overall,
          critical_missing: result.tiered.critical_missing,
          important_missing: result.tiered.important_missing,
          nice_to_have_missing: result.tiered.nice_to_have_missing,
          already_demonstrated: result.tiered.already_demonstrated,
          transferable: result.tiered.transferable,
          hidden_strengths: result.tiered.hidden_strengths,
          risk_tags: result.riskTags,
          note: result.note,
          status: 'scored',
        })
        .eq('id', job.id);
      if (upErr) throw upErr;
    }
    // Below-threshold deletion happens after ai_usage_log is written below —
    // related_job_id needs the row to still exist at insert time.

    // Log each AI call (16.10) — even below-threshold jobs cost tokens.
    for (const u of result.usages) {
      const { error: logErr } = await db.from('ai_usage_log').insert({
        user_id: userId,
        action_type: u.actionType,
        provider: credential.mode === 'cai' ? 'gemini' : credential.provider,
        connection_mode: u.connectionMode,
        model: u.model,
        input_tokens: u.usage.input_tokens,
        output_tokens: u.usage.output_tokens,
        cached_tokens: u.usage.cached_tokens,
        total_tokens: u.usage.total_tokens,
        raw_usage: u.usage.raw,
        cost_usd: u.costUsd,
        related_scan_id: scanId,
        related_job_id: job.id,
      });
      if (logErr) console.error('ai_usage_log insert failed:', logErr.message);
    }

    // Bill this job's AI-fee slice immediately (13.4) — see aiFeeCosDelta.
    const { delta, rawCos, chargedCos } = aiRouter.aiFeeCosDelta({
      credential,
      usages: result.usages,
      priorRawCos,
      priorChargedCos,
    });
    priorRawCos = rawCos;
    priorChargedCos = chargedCos;
    if (delta > 0) {
      // Folds into the scan's single cos_transactions row (2026-08-15 fix)
      // instead of inserting a new row per job — debitCosInto's underlying
      // RPC does `note = coalesce(p_note, note)`, so no `note`/`relatedJobId`
      // here deliberately preserves the scan-level note runScan.js set once
      // at scan start, rather than overwriting it with whichever job happened
      // to be scored last.
      await cosGuard.debitCosInto(db, userId, scanTransactionId, {
        actionType,
        aiCost: delta,
        relatedScanId: scanId,
      });
    }

    if (!meetsThreshold) {
      // A2: deleted outright, not archived — the dedup key already survives
      // in job_dedup_seen (inserted by the caller before scoring), so a
      // future scan skips re-scoring the same posting without keeping a dead
      // `jobs` row.
      const { error: delErr } = await db.from('jobs').delete().eq('id', job.id);
      if (delErr) console.error(`jobScorer: deleting below-threshold job ${job.id} failed:`, delErr.message);
    }

    // D1 (confirmed live bug — "scored 66, above 0 -> 67"): both counters are
    // credited together, ONLY here, after every persistence step above has
    // already succeeded (the jobs update/delete, ai_usage_log, the COS
    // debit). The old code incremented jobs_above_threshold_count right after
    // the threshold compare, before any of that persistence ran — so a throw
    // in that window (e.g. `if (upErr) throw upErr`) permanently credited
    // "above threshold" without ever crediting "scored" (the per-job
    // isolation catch in the caller swallows the throw). Moving both
    // increments to the same place, after the same guards, means a failed
    // job now credits neither counter — above can never outrun scored again.
    // autoSaveJobIds is deferred here for the same reason: pushing it earlier
    // (before the jobs update) meant a job whose update then threw would
    // still get auto-saved to the tracker as 'Saved' even though its `jobs`
    // row was never actually updated to 'scored'.
    if (meetsThreshold) {
      autoSaveJobIds.push(job.id);
      aboveThreshold += 1;
      if (counters) await counters.add('jobs_above_threshold_count', 1);
    }
    scored += 1;
    if (counters) await counters.add('jobs_scored_count', 1);
  }

  function getScored() {
    return scored;
  }

  function getAboveThreshold() {
    return aboveThreshold;
  }

  // Final unthrottled progress write, then tracker auto-population (spec §9):
  // every scored job is saved to the tracker at "Saved" (the dashboard-backing
  // bucket), deduped against what's already tracked. Free, isolated — a
  // tracker hiccup must never fail the scan.
  async function flush() {
    if (counters) await counters.flush();

    if (autoSaveJobIds.length) {
      try {
        const { data: already } = await db
          .from('applications')
          .select('job_id')
          .eq('user_id', userId)
          .in('job_id', autoSaveJobIds);
        const tracked = new Set((already || []).map((a) => a.job_id));
        const rows = autoSaveJobIds
          .filter((id) => !tracked.has(id))
          .map((id) => ({ user_id: userId, job_id: id, stage: 'Saved' }));
        if (rows.length) {
          const { error: appErr } = await db.from('applications').insert(rows);
          if (appErr) console.error('tracker auto-populate insert failed:', appErr.message);
        }
      } catch (e) {
        console.error('tracker auto-populate failed:', e.message || e);
      }
    }
  }

  return { scoreOne, getScored, getAboveThreshold, flush };
}

module.exports = { createJobScorer };

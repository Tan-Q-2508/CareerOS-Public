// On-demand scoring (spec 4.7) — AI-score the jobs a user picked from an
// on-demand scan's unscored survivors.
//
// The per-job work is jobScorer.js's scoreOne, reused verbatim, so a job scored
// here is scored, persisted, logged and billed exactly as it would have been
// inside the scan. Three deliberate differences, all set by what the user did:
//   - threshold 0: the user chose this job, so it is kept whatever it scores
//     (PASS included), the way a manual entry is — never deleted below the
//     scan's minimum. That also means early-abandon never fires.
//   - billing folds into the ORIGINATING scan's single cos_transactions row
//     (13.4): the scan already paid its flat fee, and scoring later is the
//     deferred half of the same scan, not a new action.
//   - scored against the ACTIVE résumé, stamped at claim time.

const { getSupabaseAdmin, tunables, geminiAdapter } = require('@careeros/shared');
const { hasGraduateDegree } = require('../resume/deriveProfile');
const aiRouter = require('../lib/aiRouter');
const cosGuard = require('../lib/cosGuard');
const { insertNotification } = require('../lib/notify');
const { createJobScorer } = require('./jobScorer');
const { liveYearsOfExperience, scanActionType } = require('./runScan');

// jobScorer.scoreOne's input columns, plus the grouping key.
const JOB_COLS =
  'id, title, location, posted_at, salary_min, salary_max, seniority_level, description_text, company_name, company_ats_registry_id, scan_history_id';

// Normalizes and bounds a request's ids. Returns { ids } or { error }.
function parseJobIds(raw) {
  const ids = Array.isArray(raw) ? [...new Set(raw.map((id) => String(id).trim()).filter(Boolean))] : [];
  if (!ids.length) return { error: 'job_ids is required' };
  const max = tunables.onDemandScoring.maxJobsPerRequest;
  if (ids.length > max) return { error: `Select at most ${max} jobs to score at a time` };
  return { ids };
}

// Atomic claim: only rows still 'sourced' and owned by this user move to
// 'scoring' — a double-click, a second tab, or someone else's id claims
// nothing. Stamps the active résumé, since that is what they will be scored
// against.
async function claimJobs(db, userId, ids, resumeVersionId) {
  const { data, error } = await db
    .from('jobs')
    .update({ status: 'scoring', resume_version_id: resumeVersionId })
    .eq('user_id', userId)
    .in('id', ids)
    .eq('status', 'sourced')
    .select(JOB_COLS);
  if (error) throw error;
  return data || [];
}

// The scan's own ledger row, so on-demand AI cost lands on the same line as
// its flat fee. A scan with no row (its row predates incremental billing, or
// the scan is gone) gets a fresh flat-fee-0 row instead — the AI cost is real
// either way.
async function scanTransactionFor(db, userId, scan, jobCount) {
  if (scan) {
    const { data } = await db
      .from('cos_transactions')
      .select('id')
      .eq('user_id', userId)
      .eq('related_scan_id', scan.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data) return data.id;
  }
  const row = await cosGuard.debitCos(db, userId, {
    actionType: scanActionType(scan && scan.sources),
    flatFee: 0,
    relatedScanId: scan ? scan.id : null,
    note: `Scored on demand: ${jobCount} job(s)`,
  });
  return (row && row.id) || null;
}

async function pooled(items, concurrency, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

/**
 * Background half of POST /api/jobs/score. Never throws — every job ends
 * either 'scored' or back at 'sourced'.
 * @param {string} userId
 * @param {object[]} jobs rows returned by claimJobs (status 'scoring')
 * @param {object} [deps] { db } override for tests
 */
async function scoreSelectedJobs(userId, jobs, { db = getSupabaseAdmin() } = {}) {
  try {
    const credential = await aiRouter.resolveAiCredential(db, userId);
    if (credential.mode === 'cai' && !geminiAdapter.isConfigured()) throw new Error('AI provider not configured');

    const { data: user, error: userErr } = await db
      .from('users')
      .select('years_of_experience, domain_keywords, off_domain_title_keywords, years_of_experience_manual')
      .eq('id', userId)
      .single();
    if (userErr) throw userErr;
    const { data: resume } = await db
      .from('resume_versions')
      .select('id, parsed_profile')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    if (!resume || !resume.parsed_profile) throw new Error('No active résumé to score against');
    user.years_of_experience = liveYearsOfExperience(user, resume.parsed_profile);
    user.has_graduate_degree = hasGraduateDegree(resume.parsed_profile);

    const groups = new Map();
    for (const job of jobs) {
      const key = job.scan_history_id || null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }

    for (const [scanId, groupJobs] of groups) {
      const { data: scan } = scanId
        ? await db.from('scan_history').select('id, sources, config').eq('id', scanId).eq('user_id', userId).maybeSingle()
        : { data: null };
      const scanTransactionId = await scanTransactionFor(db, userId, scan, groupJobs.length);
      const jobScorer = await createJobScorer({
        db,
        scanId: scan ? scan.id : null,
        userId,
        user,
        resume,
        // The scan's own location drives preference-fit, exactly as it would
        // have inside the scan.
        config: { ...((scan && scan.config) || {}), threshold: 0 },
        actionType: scanActionType(scan && scan.sources),
        credential,
        counters: null,
        scanTransactionId,
      });
      await pooled(groupJobs, tunables.onDemandScoring.concurrency, async (job) => {
        try {
          await jobScorer.scoreOne(job);
        } catch (err) {
          // 16.8: isolated — this job is released below, the rest carry on.
          console.error(`scoreSelectedJobs: job ${job.id} failed:`, err.message || err);
        }
      });
      await jobScorer.flush();
    }
  } catch (err) {
    console.error('scoreSelectedJobs: batch stopped:', err.message || err);
  }

  // Whatever did not reach 'scored' goes back to 'sourced' — a failed job, or
  // every job left when the batch stopped early. Only rows still at 'scoring'
  // move, so a job that did score is never touched. Billing happens per job
  // after its score is written, so a released job was never charged.
  const { data: released, error: relErr } = await db
    .from('jobs')
    .update({ status: 'sourced' })
    .eq('user_id', userId)
    .in('id', jobs.map((j) => j.id))
    .eq('status', 'scoring')
    .select('id, title');
  if (relErr) console.error('scoreSelectedJobs: releasing claims failed:', relErr.message);
  const failed = released || [];
  if (failed.length) {
    const names = failed.slice(0, 3).map((j) => j.title).join(', ') + (failed.length > 3 ? `, +${failed.length - 3} more` : '');
    await insertNotification(
      db,
      userId,
      'on_demand_scoring_failed',
      `${failed.length} job(s) could not be scored and are back in your list to try again (${names}). You were not charged for them.`.slice(0, 500)
    );
  }
  return { failed: failed.length, scored: jobs.length - failed.length };
}

module.exports = { scoreSelectedJobs, claimJobs, parseJobIds, JOB_COLS };

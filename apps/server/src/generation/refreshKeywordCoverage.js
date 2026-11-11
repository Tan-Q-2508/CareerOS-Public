const { tunables } = require('@careeros/shared');
const { computeKeywordState, coverageColumn } = require('./keywordState');

// Keeps every stored job's "Keywords X/Y" (jobs.keyword_coverage) and its ATS
// sub-score (jobs.ats_match) equal to what keywordState computes NOW — so the
// card never disagrees with the gap check, which is computed live. Runs:
//   - after a skill is confirmed or removed (confirmed_skills changes)
//   - after the active résumé changes
//   - for one job whenever its gap check or detail view is read
// Deterministic and AI-free; no COS.
//
// Overall Fit moves with the ATS sub-score by exactly its weight
// (0.4 × ΔATS, 16.4) — callback odds and preference fit are untouched — and
// never rises above a cap the scorer applied (the "(Score capped at X…" note).

const JOB_COLS =
  'id, title, description_text, jd_profile, already_demonstrated, transferable, hidden_strengths, ' +
  'ats_match, overall_fit, keyword_coverage, note';

const YIELD_EVERY_MS = 20;

function round1(n) {
  return Number(Number(n).toFixed(1));
}

function capFromNote(note) {
  const m = String(note || '').match(/Score capped at ([\d.]+)/);
  return m ? Number(m[1]) : null;
}

function samecoverage(a, b) {
  return a && b && a.matched === b.matched && a.total === b.total;
}

// Returns the patch for one job, or null when nothing changed.
function patchFor(job, profile, confirmed) {
  if (!job.jd_profile) return null;
  const state = computeKeywordState({ job, profile, confirmedSkills: confirmed });
  const coverage = coverageColumn(state);
  const oldAts = job.ats_match == null ? null : Number(job.ats_match);
  if (samecoverage(job.keyword_coverage, coverage) && oldAts === state.score) return null;
  const patch = { keyword_coverage: coverage, ats_match: state.score };
  if (job.overall_fit != null && oldAts != null) {
    let overall = round1(Number(job.overall_fit) + tunables.overallFitWeights.atsMatch * (state.score - oldAts));
    const cap = capFromNote(job.note);
    if (cap != null) overall = Math.min(overall, cap);
    patch.overall_fit = Math.max(0, Math.min(10, overall));
  }
  return patch;
}

async function loadInputs(db, userId) {
  const [{ data: resume }, { data: confirmed }] = await Promise.all([
    db.from('resume_versions').select('parsed_profile').eq('user_id', userId).eq('is_active', true).maybeSingle(),
    db.from('confirmed_skills').select('skill_term').eq('user_id', userId),
  ]);
  return { profile: resume && resume.parsed_profile, confirmed: confirmed || [] };
}

/**
 * Refresh one job (jobId) or every scored job the user has (no jobId).
 * Never throws — a failed refresh leaves the stored numbers as they were.
 * @returns {{ updated: number }}
 */
async function refreshKeywordCoverage(db, userId, { jobId = null } = {}) {
  try {
    const { profile, confirmed } = await loadInputs(db, userId);
    if (!profile) return { updated: 0 };
    let q = db.from('jobs').select(JOB_COLS).eq('user_id', userId).not('jd_profile', 'is', null);
    if (jobId) q = q.eq('id', jobId);
    const { data: jobs, error } = await q;
    if (error) throw error;
    let updated = 0;
    let sliceStart = Date.now();
    for (const job of jobs || []) {
      // Hundreds of jobs are a lot of CPU on a small instance. Hand the event
      // loop back every few ms so other requests and the health check are
      // served while this runs, instead of all hanging until it ends.
      if (Date.now() - sliceStart > YIELD_EVERY_MS) {
        await new Promise((r) => setImmediate(r));
        sliceStart = Date.now();
      }
      const patch = patchFor(job, profile, confirmed);
      if (!patch) continue;
      const { error: uErr } = await db.from('jobs').update(patch).eq('id', job.id).eq('user_id', userId);
      if (uErr) console.error(`refreshKeywordCoverage: job ${job.id} update failed:`, uErr.message);
      else updated += 1;
    }
    return { updated };
  } catch (e) {
    console.error('refreshKeywordCoverage failed:', e.message || e);
    return { updated: 0 };
  }
}

// Fire-and-forget form for request handlers: the response never waits on it.
// Coalesced per user: confirming five gaps in a row runs at most one refresh
// now and one more after it (which sees all five), not five overlapping ones.
const inFlight = new Map(); // userId -> { rerun: opts | null }
function refreshKeywordCoverageSoon(db, userId, opts) {
  const running = inFlight.get(userId);
  if (running) {
    // A pending whole-user refresh already covers any single job.
    const pendingAll = running.rerun && !running.rerun.jobId;
    running.rerun = pendingAll || !opts || !opts.jobId ? {} : opts;
    return;
  }
  const state = { rerun: null };
  inFlight.set(userId, state);
  setImmediate(async () => {
    let next = opts;
    try {
      do {
        state.rerun = null;
        await refreshKeywordCoverage(db, userId, next);
        next = state.rerun;
      } while (next);
    } finally {
      inFlight.delete(userId);
    }
  });
}

module.exports = { refreshKeywordCoverage, refreshKeywordCoverageSoon, patchFor, capFromNote };

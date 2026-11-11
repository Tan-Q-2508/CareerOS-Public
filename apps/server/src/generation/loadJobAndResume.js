const { sanitizeJdProfile, jdGroundingText } = require('@careeros/shared');

// Shared: load a scored job (owned) + the résumé version to generate against.
// `extraJobCols` pulls any doc-type-specific columns (e.g. location for cover
// letters, ats_match/callback_odds/overall_fit/risk_tags for résumé generation
// and Copilot Mode). Extracted out of routes/generate.js (2026-07-27, Copilot
// Mode Stage 1) so routes/copilot.js can reuse it without a route-to-route
// require.
//
// CHANGED 2026-08-02 (Phase 3 bug fix — "Drafted against an earlier résumé
// version"): every NEW generation/session now loads the user's CURRENT
// is_active résumé version, not job.resume_version_id (the version the job
// happened to be SCORED against, possibly long stale). This reverses the
// "quiet indicator, never silent re-seed" design spec §4.5/§7.14.9 originally
// mandated — see the dated notes at those sections. Falls back to
// job.resume_version_id only if the user somehow has no active version (an
// edge case, not the normal path). This is the single chokepoint every
// caller (routes/generate.js, routes/copilot.js's new-session and continue
// routes) goes through — an ALREADY-OPEN Copilot session never calls this
// again, so its frozen content_tree (whose bullet ids are positional within
// the profile it was seeded from — see parseResume.js's assignBulletIds) is
// untouched by this change.
async function loadJobAndResume(db, userId, jobId, extraJobCols = '') {
  const cols =
    'id, title, company_name, jd_profile, resume_version_id, status, description_text, ' +
    'already_demonstrated, transferable, hidden_strengths, critical_missing, important_missing, nice_to_have_missing' +
    (extraJobCols ? `, ${extraJobCols}` : '');
  const { data: job, error: jobErr } = await db.from('jobs').select(cols).eq('id', jobId).eq('user_id', userId).maybeSingle();
  if (jobErr) throw Object.assign(new Error(jobErr.message), { status: 500 });
  if (!job) return { httpError: { status: 404, error: 'Job not found' } };
  if (!job.jd_profile) return { httpError: { status: 400, error: 'Job has not been scored yet' } };

  const { data: activeResume, error: aErr } = await db
    .from('resume_versions')
    .select('id, storage_path, parsed_profile')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
  if (aErr) throw Object.assign(new Error(aErr.message), { status: 500 });

  let resume = activeResume;
  if (!resume || !resume.parsed_profile) {
    // Fallback: no active version on file (shouldn't happen for a user who's
    // uploaded a master résumé) — fall back to whatever the job was scored
    // against, same as the pre-2026-08-02 behavior, rather than hard-failing.
    if (!job.resume_version_id) return { httpError: { status: 400, error: 'Job has no associated résumé version' } };
    const { data: scoredResume, error: rErr } = await db
      .from('resume_versions')
      .select('id, storage_path, parsed_profile')
      .eq('id', job.resume_version_id)
      .eq('user_id', userId)
      .maybeSingle();
    if (rErr) throw Object.assign(new Error(rErr.message), { status: 500 });
    resume = scoredResume;
  }
  if (!resume || !resume.parsed_profile) {
    return { httpError: { status: 400, error: 'No résumé version is available to generate against' } };
  }
  job.jd_profile = sanitizeJdProfile(job.jd_profile, jdGroundingText(job));
  return { job, resume };
}

module.exports = { loadJobAndResume };

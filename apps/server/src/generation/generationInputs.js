const { jobRelevantConfirmedSkills } = require('./atsCheck');
const { resolveContact } = require('./extractContact');
const aiRouter = require('../lib/aiRouter');
const { sanitizeJdProfile, jdGroundingText } = require('@careeros/shared');

// Shared input-assembly for résumé generation — credential resolution,
// confirmed-skill scoping (7.13), contact extraction, and the jobContext
// shape generateResume()'s pipeline consumes. Extracted out of runGenerate.js
// (2026-07-27, Copilot Mode Stage 1) so runCopilotSeed.js seeds a Copilot
// session from the exact same inputs one-click generation uses — no second
// implementation of "how a job+resume becomes generateResume() arguments."
//
// Split into composable pieces (same date) — Copilot's bullet/rewrite and
// bullet/inject-keyword routes need jobContext + confirmed-skill scoping on
// every single edit call, but NOT contact (which costs a storage download +
// docx parse via extractContact); buildGenerationInputs stays the one-call
// convenience wrapper for the two full-pipeline entry points (one-click
// generation, Copilot session seeding) that do need all of it.

function buildJobContext(job) {
  return {
    title: job.title,
    company: job.company_name,
    // Redundant with the loaders (loadJobAndResume.js, copilot.js) that
    // already sanitize job.jd_profile before this is called — but this is
    // the single definition of jobContext.jdProfile, so any future/missed
    // loader is covered for free. Safe because sanitizeJdProfile is
    // idempotent (packages/shared/src/ats/keywordPipeline.js). Grounding
    // needs job.description_text; every current caller's `job` carries it
    // (loadJobAndResume.js selects it explicitly), and sanitizeJdProfile
    // degrades to junk-filter + atomize only when it's absent. Grounds
    // against title+body (jdGroundingText, 2026-08-14), not body alone —
    // must match what the loader that produced job.jd_profile already used,
    // or this redundant re-sanitize would strip title-only keywords the
    // loader just preserved.
    jdProfile: sanitizeJdProfile(job.jd_profile || {}, jdGroundingText(job)),
    // The posting's own wording, so the humanizer (spec 7.15) never flags a
    // word the JD itself uses ("leverage", "robust") as an AI tell.
    jdText: jdGroundingText(job),
    tiered: {
      already_demonstrated: job.already_demonstrated,
      transferable: job.transferable,
      hidden_strengths: job.hidden_strengths,
      critical_missing: job.critical_missing,
      important_missing: job.important_missing,
      nice_to_have_missing: job.nice_to_have_missing,
    },
    // The job's own scan scoring — surfaced to the generation AI so it can
    // close the specific gaps that hurt that job's fit score, truthfully.
    scanAnalysis: {
      atsMatch: job.ats_match,
      callbackOdds: job.callback_odds,
      overallFit: job.overall_fit,
      riskTags: job.risk_tags,
    },
  };
}

// Scoped to this job's own required/nice-to-have skills (2026-07-27 fix) —
// see atsCheck.js's jobRelevantConfirmedSkills for why: the unscoped list
// grows across every job the user has ever confirmed anything for, and
// dumping all of it into one generation's prompt drowns out (and starves
// bullet-budget from) the skills that actually matter for THIS job.
async function resolveConfirmedSkills(db, userId, job) {
  const { data: confirmed } = await db
    .from('confirmed_skills')
    .select('skill_term, context, entry_ref')
    .eq('user_id', userId);
  const relevantConfirmed = jobRelevantConfirmedSkills(confirmed, job.jd_profile || {});
  // Split by whether the user gave an explanation (7.13): a naked confirm
  // (no context) is safe to LIST in Skills but not to invent a bullet around;
  // one with a "how I used it" explanation must be woven into a real bullet.
  const confirmedNaked = relevantConfirmed.filter((c) => !c.context).map((c) => c.skill_term);
  // entry_ref (2026-08-05): when the user picked a specific role/project in the
  // Explain UI, thread it through so contentDirector.js/draftResume.js can
  // place the explanation deterministically instead of guessing.
  const confirmedContext = relevantConfirmed
    .filter((c) => c.context)
    .map((c) => ({ term: c.skill_term, context: c.context, entryRef: c.entry_ref || null }));
  return { confirmedNaked, confirmedContext };
}

async function buildGenerationInputs(db, userId, job, resume) {
  const credential = await aiRouter.resolveAiCredential(db, userId);
  const { data: user } = await db.from('users').select('full_name').eq('id', userId).single();
  const { confirmedNaked, confirmedContext } = await resolveConfirmedSkills(db, userId, job);
  const contact = await resolveContact(db, userId, db, resume.storage_path, user && user.full_name);
  const jobContext = buildJobContext(job);
  return { credential, contact, jobContext, confirmedNaked, confirmedContext };
}

module.exports = { buildGenerationInputs, buildJobContext, resolveConfirmedSkills };

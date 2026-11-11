const { tunables, sanitizeJdProfile, jdGroundingText, isConfirmableSkill, equivalentsFor } = require('@careeros/shared');
const { skillPresent, profileSkillText, transferableSkillText, jobRelevantConfirmedSkills } = require('./atsCheck');

// THE keyword state of one job against one candidate (spec 5.1 / 7.12 / 7.13).
// Every surface that shows or acts on "which of this posting's keywords does
// the candidate have" reads this one function:
//   - the job card / detail "Keywords X/Y" and its ATS sub-score (scan time via
//     scoreJob, and again whenever confirmed skills or the active résumé change
//     via refreshKeywordCoverage)
//   - the pre-generation gap check (generationGaps)
// so "Keywords 2/6" and "2 skill gaps" can no longer both be on screen: the
// gap list IS the unmatched terms, gaps.length === total − matched.
//
// Before this existed the card's X/Y was computed once at scan time against
// the résumé + scan-vouched skills, while the gap check was computed live
// against the CURRENT résumé + ALL confirmed skills + a re-cleaned term list,
// with vouched lists from a different scoring sample on borderline jobs.
//
// A term counts as held when it is:
//   present       literally in the master profile (skills, bullets, titles,
//                 degree), or the FUNCTION a held role title names ("Associate
//                 Product Manager" → product management)
//   confirmed     in a confirmed skill relevant to THIS job (7.13 scoping via
//                 jobRelevantConfirmedSkills — an unrelated job's confirmation
//                 is not evidence for this one)
//   transferable  a reword or hidden strength this job's scoring tied to a
//                 real bullet id (fitCall.js validates the id)
// Everything else is `missing`, and every missing term is a gap.
//
// already_demonstrated is deliberately NOT a source: it cites no bullet, and
// it is how a PM title came to "demonstrate" user research and consulting on
// live scores. An ATS matches the words on the page (and their synonyms); it
// does not infer. It also differed run to run, which is what moved the ATS
// score between self-consistency runs.
//
// A posting's alternative list ("product or program management, product
// marketing, business development or technology experience") is ONE
// requirement met by any member — jd_profile.any_of_groups, counted once.

// Parenthetical elaborations ("ERP platforms (SAP, Oracle)") are also matched
// on their core, same rule as atsCheck.vouchedSkills.
const coreOf = (s) => String(s).split('(')[0].trim();
// A true equivalent counts as the term itself (shared/ats/equivalents.js):
// "artificial intelligence" is met by "AI", "Microsoft Word" by a held
// "Microsoft Office", a Green Belt by a Black Belt. Paraphrases never are.
function hit(text, s) {
  if (!text) return false;
  if (skillPresent(text, s)) return true;
  const core = coreOf(s);
  if (core !== s && core.length > 0 && skillPresent(text, core)) return true;
  return equivalentsFor(core || s).some((v) => skillPresent(text, v));
}

// Role title → the function it names, so "Associate Product Manager" holds
// "Product Management". Roles only — a project title ("Program & Strategy
// Consultant | …") is not employment in that function.
const TITLE_FUNCTION = [
  [/\bmanagers?\b/gi, 'management'],
  [/\banalysts?\b/gi, 'analysis analytics'],
  [/\bengineers?\b/gi, 'engineering'],
  [/\bdevelopers?\b/gi, 'development'],
  [/\bdesigners?\b/gi, 'design'],
  [/\bconsultants?\b/gi, 'consulting'],
  [/\bcoordinators?\b/gi, 'coordination'],
];
function titleFunctionText(profile) {
  const out = [];
  for (const r of (profile && profile.roles) || []) {
    let t = String(r.title || '');
    if (!t) continue;
    for (const [re, to] of TITLE_FUNCTION) t = t.replace(re, to);
    out.push(t);
  }
  return out.join(' \n ').toLowerCase();
}

function shrinkScore(matched, total) {
  const k = Number((tunables.scoring && tunables.scoring.keywordShrinkage) ?? 2);
  return Number((((matched + k / 2) / (total + k)) * 10).toFixed(1));
}

// Deterministic, no-AI context for a gap — the JD sentence that mentions it.
function jdContextFor(descriptionText, skill) {
  const text = String(descriptionText || '');
  if (!text.trim()) return null;
  const term = String(skill).trim();
  if (!term) return null;
  const sentences = text.split(/(?<=[.!?;\n])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = /[^a-z0-9]/i.test(term) ? new RegExp(escaped, 'i') : new RegExp(`\\b${escaped}\\b`, 'i');
  const found = sentences.find((s) => re.test(s));
  if (!found) return null;
  const trimmed = found.replace(/^[•\-*\s]+/, '').trim();
  return trimmed.length > 220 ? `${trimmed.slice(0, 217)}…` : trimmed;
}

/**
 * @param job               { title, description_text, jd_profile, already_demonstrated, transferable, hidden_strengths }
 * @param profile           parsed 16.2 résumé profile (the ACTIVE version)
 * @param confirmedSkills   confirmed_skills rows ({skill_term}) or plain strings — all of the
 *                          user's; scoped to this job here
 * @param vouched           optional override of the job's scan-vouched lists
 *                          ({alreadyDemonstrated, transferable, hiddenStrengths}) — scoreJob passes
 *                          the run it is about to store
 */
function computeKeywordState({ job, profile, confirmedSkills = [], vouched = null }) {
  const jd = sanitizeJdProfile(job.jd_profile || {}, jdGroundingText(job));
  const rows = (confirmedSkills || []).map((c) => (typeof c === 'string' ? { skill_term: c } : c));
  const scopedConfirmed = jobRelevantConfirmedSkills(rows, jd).map((c) => c.skill_term);

  const profileText = profileSkillText(profile || {});
  const roleFunctionText = titleFunctionText(profile || {});
  const confirmedText = scopedConfirmed.join(' \n ').toLowerCase();
  const v = vouched || {
    alreadyDemonstrated: job.already_demonstrated,
    transferable: job.transferable,
    hiddenStrengths: job.hidden_strengths,
  };
  const transferableText = transferableSkillText({
    transferable: v.transferable || [],
    hiddenStrengths: v.hiddenStrengths || [],
  });

  const classifyOne = (skill) => {
    if (hit(profileText, skill) || hit(roleFunctionText, skill)) return 'present';
    if (hit(confirmedText, skill)) return 'confirmed';
    if (hit(transferableText, skill)) return 'transferable';
    return 'missing';
  };
  const RANK = { present: 0, confirmed: 1, transferable: 2, missing: 3 };
  const classify = (skill, members) => {
    if (!members) return classifyOne(skill);
    return members.map(classifyOne).sort((a, b) => RANK[a] - RANK[b])[0] || 'missing';
  };
  // Non-confirmable terms (credentials, authorization, soft traits) are not
  // keywords at all — sanitizeJdProfile already drops them; filtering again
  // here keeps the denominator and the gap list defined by the same rule.
  const groups = (jd.any_of_groups || [])
    .map((g) => (g || []).filter((m) => isConfirmableSkill(m)))
    .filter((g) => g.length)
    .map((members) => ({ skill: members.join(' / '), members, tier: 'required' }));
  const terms = [
    ...(jd.required_skills || []).map((skill) => ({ skill, tier: 'required' })),
    ...groups,
    ...(jd.nice_to_have_skills || []).map((skill) => ({ skill, tier: 'nice_to_have' })),
  ]
    .filter((t) => t.members || isConfirmableSkill(t.skill))
    .map((t) => ({ ...t, status: classify(t.skill, t.members) }));

  const total = terms.length;
  const matched = terms.filter((t) => t.status !== 'missing').length;
  const gaps = terms
    .filter((t) => t.status === 'missing')
    .map((t) => ({
      skill: t.skill,
      tier: t.tier,
      context:
        jdContextFor(job.description_text, t.members ? t.members[0] : t.skill) ||
        `Listed as a ${t.tier === 'required' ? 'required' : 'nice-to-have'} skill in the job's parsed profile, but not quoted verbatim in the posting text.`,
    }));

  return {
    jdProfile: jd,
    terms,
    matched,
    total,
    gaps,
    missing: gaps.map((g) => g.skill),
    score: shrinkScore(matched, total),
    counts: {
      required: terms.filter((t) => t.tier === 'required').length,
      niceToHave: terms.filter((t) => t.tier === 'nice_to_have').length,
      present: terms.filter((t) => t.status === 'present').length,
      confirmed: terms.filter((t) => t.status === 'confirmed').length,
      transferable: terms.filter((t) => t.status === 'transferable').length,
      missing: gaps.length,
      gaps: gaps.length,
    },
  };
}

// The jobs.keyword_coverage column shape.
function coverageColumn(state) {
  return { matched: state.matched, total: state.total, missing: state.missing };
}

module.exports = { computeKeywordState, coverageColumn, shrinkScore, jdContextFor, titleFunctionText };

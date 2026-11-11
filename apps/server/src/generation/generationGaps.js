const { isConfirmableSkill } = require('./atsCheck');
const { computeKeywordState, jdContextFor } = require('./keywordState');

// Pre-generation gap check (spec 7.12 step 3) — DETERMINISTIC, no AI, no COS.
// A thin view over keywordState.computeKeywordState, the one function that
// decides which of a posting's keywords the candidate holds — so the gap list
// here is exactly the unmatched terms behind the job card's "Keywords X/Y":
// gaps.length === total − matched, always.
//
// Confirmed skills are scoped to the ones relevant to THIS job (7.12/7.13), and
// the résumé is the user's CURRENT active version — the same inputs
// refreshKeywordCoverage uses to keep the card's X/Y current.

/**
 * @param job              { title, description_text, jd_profile, already_demonstrated, transferable, hidden_strengths }
 * @param profile          parsed 16.2 résumé profile
 * @param confirmedSkills  confirmed_skills rows or strings (all of the user's)
 * @returns {
 *   required: [{ skill, tier:'required', status }],
 *   niceToHave: [{ skill, tier:'nice_to_have', status }],
 *   gaps: [{ skill, tier, context }],
 *   matched, total, counts, coverage, coverageIfAllConfirmed
 * }
 */
function generationGaps({ job, profile = {}, confirmedSkills = [] }) {
  const state = computeKeywordState({ job, profile, confirmedSkills });
  const required = state.terms.filter((t) => t.tier === 'required');
  const niceToHave = state.terms.filter((t) => t.tier === 'nice_to_have');
  const coverage = state.total ? Number((state.matched / state.total).toFixed(4)) : 1;
  return {
    required,
    niceToHave,
    gaps: state.gaps,
    matched: state.matched,
    total: state.total,
    counts: state.counts,
    coverage,
    // Every gap is confirmable by construction, so confirming them all covers
    // every term.
    coverageIfAllConfirmed: 1,
  };
}

module.exports = { generationGaps, isConfirmableSkill, jdContextFor };

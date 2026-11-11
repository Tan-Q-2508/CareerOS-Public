const { calculateAtsScore, DEFAULT_WEIGHTS } = require('./calculateAtsScore');

// Reshapes calculateAtsScore's sectionBreakdown into ONE flat term list,
// shared by the Copilot server (spec 7.14.13's authoritative reconciliation)
// and the web client (7.14.13's optimistic local computation) so both run
// literally the same summarizer — the only divergence surface left is each
// caller's section-TEXT builder, which is exactly what the parity check
// (Session 21b handoff) exists to catch.
//
// `tier` maps 1:1 onto 7.14.12's chip states: core = green (demonstrated in
// a real bullet, M_i 0.8-1.0), skills_only = yellow (Skills/Summary only,
// M_i 0.4), missing = red (0.0). Anti-stuffing (7.14.12) falls out for free
// from calculateAtsScore's score1(), which returns on the FIRST match and
// pushes each term once — nothing extra to build here.
const TIER = { CORE: 'core', SKILLS: 'skills_only', MISSING: 'missing' };

function summarizeAts({ sections, jdProfile, weights, target }) {
  const r = calculateAtsScore({ sections, jdProfile, weights });
  const core = new Set(r.sectionBreakdown.core);
  const skillsOnly = new Set(r.sectionBreakdown.skillsOnly);
  const tierOf = (t) => (core.has(t) ? TIER.CORE : skillsOnly.has(t) ? TIER.SKILLS : TIER.MISSING);

  const terms = [
    ...(jdProfile.required_skills || []).map((t) => ({ term: t, tier: tierOf(t), required: true })),
    ...(jdProfile.nice_to_have_skills || []).map((t) => ({ term: t, tier: tierOf(t), required: false })),
  ];

  const counts = { core: 0, skills_only: 0, missing: 0 };
  for (const t of terms) counts[t.tier] += 1;

  return {
    score: r.score,
    target: target == null ? null : target,
    counts,
    weights: { ...DEFAULT_WEIGHTS, ...(weights || {}) },
    terms,
  };
}

module.exports = { summarizeAts, TIER };

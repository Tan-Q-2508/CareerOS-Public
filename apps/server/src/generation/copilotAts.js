const { tunables, summarizeAts, sanitizeJdProfile } = require('@careeros/shared');
const { coreKeywordText, skillsKeywordText, summaryTitleText } = require('./atsCheck');

// Server-authoritative half of spec 7.14.13's Live ATS Scoreboard / 7.14.12's
// Missing Keywords pane. ALWAYS the v2 four-tier engine (calculateAtsScore,
// via the shared summarizeAts wrapper) — v1 was removed from atsCheck.js
// entirely in the 2026-08-13 root-cause pass (it was already unreachable in
// practice; this file always used v2 regardless of the flag), so the
// divergence risk this comment used to flag no longer exists.
//
// CHANGED 2026-08-13: this was the one acknowledged structural gap the prior
// pass left open — every OTHER jd_profile consumer (gap-check ask-list,
// ATS score, keyword coverage) ran through a junk-filter/grounding pass,
// this one read required_skills/nice_to_have_skills raw. In practice every
// caller's `jdProfile` already comes pre-sanitized from a loader
// (loadJobAndResume.js / routes/copilot.js's loadSessionJobAndResume), so
// this call is now a defensive, idempotent no-op re-run of the same
// pipeline rather than the actual filter — but it means THIS file can never
// again be the one place that quietly reads an unsanitized profile, no
// matter what a future caller passes in. `jdText` is optional (grounding is
// skipped without it; the junk-filter and atomizer still run).
//
// `model` is assembleFromTree's own model (copilotTree.js) — the exact same
// object every Copilot route already builds via assembleFromTree, so this
// call is additive, not a second measurement pass.
function copilotAts({ model, jdProfile, jdText }) {
  const sanitized = sanitizeJdProfile(jdProfile, jdText);
  const required = (sanitized && sanitized.required_skills) || [];
  const nice = (sanitized && sanitized.nice_to_have_skills) || [];
  if (!sanitized || (!required.length && !nice.length)) return null;

  return summarizeAts({
    sections: {
      core: coreKeywordText(model),
      summaryTitle: summaryTitleText(model),
      skills: skillsKeywordText(model),
    },
    jdProfile: sanitized,
    weights: tunables.generation.atsWeightsV2,
    target: Math.round((tunables.atsKeywordMatchTarget || 0.9) * 100),
  });
}

module.exports = { copilotAts };

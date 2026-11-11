const synonymsRaw = require('./synonyms.json');
const tunables = require('../tunables.json');
const { matchesTerm } = require('./keywordPipeline');

// Shared keyword-matching engine (spec 5.6/7.11/15 #20 Stage 1). ONE matcher,
// TWO scoring entry points, so the scan-time number and the generation-time
// number can never drift onto separately-tuned logic:
//
//   - calculateKeywordMatch  — plain coverage (matched / total JD skills),
//     the scan-time score (5.1, maintainer decision 2026-07-28 — see the
//     spec §5.1 note this session rewrote for why placement-weighting
//     doesn't apply before a document exists to place anything IN).
//   - calculateAtsScore      — placement-weighted (7.11), generation-time
//     only: a keyword's placement in a real generated document (bullet vs.
//     summary/title vs. Skills-only) determines its weight.
//
// CHANGED 2026-08-13 (keyword-extraction root-cause pass): both used to run
// through a synonym-aware skillPresent() crediting a 26-entry hand-maintained
// map ("led" == "managed", "powerbi" == "power bi") — generous, but not what
// a real ATS keyword scanner does, and inconsistent with the strict-literal
// rule JD-grounding already enforces one stage upstream (jdAtsCall.js /
// keywordPipeline.js's isGrounded). "Exactly like ATS job boards" means one
// rule everywhere: literal substring/word match, tolerant of simple plurals,
// nothing else — that's keywordPipeline.matchesTerm. synonyms.json is kept,
// but demoted to two jobs that are NOT scoring: seeding the atomizer's
// do-not-split list (normalizeJdTerms.js), and powering Copilot's wording-
// swap suggestions (AtsPanel.jsx) — proposing "managed" for a JD's "led" is
// useful there and doesn't inflate a score a real ATS wouldn't give.
// Flag-gated (tunables.scoring.strictLiteralMatching) so rollback to the old
// synonym-credited behavior is a single boolean, matching the
// useUnifiedAtsEngineV2 / normalizeJdTerms precedent.

// ---- synonym index: bidirectional, built once at module load ----
function buildSynonymIndex(map) {
  const idx = new Map();
  const link = (a, b) => {
    if (!idx.has(a)) idx.set(a, new Set([a]));
    idx.get(a).add(b);
  };
  for (const [canon, variants] of Object.entries(map)) {
    if (canon.startsWith('_')) continue; // _comment
    const c = canon.toLowerCase().trim();
    for (const v of variants || []) {
      const vv = String(v).toLowerCase().trim();
      if (!vv) continue;
      link(c, vv);
      link(vv, c);
    }
  }
  return idx;
}
const SYN_INDEX = buildSynonymIndex(synonymsRaw);

function synonymsFor(term) {
  const t = String(term).toLowerCase().trim();
  const set = SYN_INDEX.get(t);
  return set ? [...set] : [t];
}

// Case-insensitive presence. `rawPresent` is the literal check (kept as its
// own name for callers that want it explicitly, e.g. the strict-mode branch
// below); `skillPresent` is the one all scoring call sites use, and its
// behavior is gated by tunables.scoring.strictLiteralMatching:
//   - strict (default, true): keywordPipeline.matchesTerm — literal +
//     simple-plural tolerance ONLY, no synonym credit. What a real ATS does.
//   - false (rollback path): the old synonym-expanded behavior, kept intact
//     so flipping the flag is a genuine one-line revert, not a code change.
function rawPresent(lcText, skill) {
  const k = String(skill).toLowerCase().trim();
  if (!k) return false;
  if (/[^a-z0-9]/.test(k)) return lcText.includes(k);
  return new RegExp(`\\b${k}\\b`).test(lcText);
}

function skillPresent(lcText, skill) {
  if (!(tunables.scoring && tunables.scoring.strictLiteralMatching === false)) {
    return matchesTerm(lcText, skill);
  }
  for (const variant of synonymsFor(skill)) {
    if (rawPresent(lcText, variant)) return true;
  }
  return false;
}

// ---- generation-time: placement-weighted, four tiers (7.11) ----
// 1.0 — real bullet AND summary/header title. 0.8 — real bullet only.
// 0.4 — Skills-only OR summary-only (a flat matcher can't tell a keyword
// dump apart from a genuinely demonstrated skill). 0.0 — missing entirely.
const DEFAULT_WEIGHTS = { full: 1.0, bulletOnly: 0.8, skillsOrSummaryOnly: 0.4 };
const REQUIRED_WEIGHT = 1.0;
const NICE_WEIGHT = 0.5;

/**
 * @param sections { core, summaryTitle, skills } — pre-joined lowercase-able
 *   text surfaces from the render model: core = title/summary/experience/
 *   projects bullets; summaryTitle = header title + summary bullets alone
 *   (the "did this ALSO land in the summary" check); skills = Skills section.
 * @param jdProfile { required_skills[], nice_to_have_skills[] }
 * @param weights   optional override of DEFAULT_WEIGHTS
 */
function calculateAtsScore({ sections, jdProfile, weights }) {
  const W = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const coreText = String(sections.core || '').toLowerCase();
  const summaryText = String(sections.summaryTitle || '').toLowerCase();
  const skillsText = String(sections.skills || '').toLowerCase();

  const required = jdProfile.required_skills || [];
  const nice = jdProfile.nice_to_have_skills || [];

  let matchedWeight = 0;
  let totalWeight = 0;
  const missingRequired = [];
  const missingNice = [];
  const matched = [];
  const sectionBreakdown = { core: [], skillsOnly: [] };

  const score1 = (s, base) => {
    totalWeight += base;
    const inCore = skillPresent(coreText, s);
    const inSummary = skillPresent(summaryText, s);
    if (inCore && inSummary) {
      matchedWeight += base * W.full;
      matched.push(s);
      sectionBreakdown.core.push(s);
      return true;
    }
    if (inCore) {
      matchedWeight += base * W.bulletOnly;
      matched.push(s);
      sectionBreakdown.core.push(s);
      return true;
    }
    if (inSummary || skillPresent(skillsText, s)) {
      matchedWeight += base * W.skillsOrSummaryOnly;
      matched.push(s);
      sectionBreakdown.skillsOnly.push(s);
      return true;
    }
    return false;
  };

  for (const s of required) if (!score1(s, REQUIRED_WEIGHT)) missingRequired.push(s);
  for (const s of nice) if (!score1(s, NICE_WEIGHT)) missingNice.push(s);

  const score = totalWeight ? Number(((matchedWeight / totalWeight) * 100).toFixed(1)) : 100;

  return { score, matched, missingRequired, missingNice, sectionBreakdown };
}

// ---- scan-time: plain coverage, no placement weighting (5.1) ----
// No document exists yet to place a keyword IN — the master profile (16.2)
// has no tailored summary/title, so the placement tiers above are
// unreachable pre-generation. Coverage instead: matched / total JD skills
// (required + nice, unweighted by tier), surfaced 0-10 for the existing
// scores.atsMatch slot. `haystacks` is caller-supplied and ordered so the
// caller decides what counts as "has it" — e.g. the master profile's text
// first, then the job's own scan-vouched already_demonstrated/transferable/
// hidden_strengths equivalents layered in afterward (scoreJob.js).
function calculateKeywordMatch({ jdProfile, haystacks }) {
  const required = jdProfile.required_skills || [];
  const nice = jdProfile.nice_to_have_skills || [];
  const text = (haystacks || []).filter(Boolean).join(' \n ').toLowerCase();

  const matched = [];
  const missing = [];
  for (const s of [...required, ...nice]) {
    if (skillPresent(text, s)) matched.push(s);
    else missing.push(s);
  }
  const total = required.length + nice.length;
  // Small-sample shrinkage: score = 10·(matched + k/2)/(total + k), k =
  // tunables.scoring.keywordShrinkage (2). A fraction over a tiny
  // denominator is weak evidence, so it is pulled toward the 5.0 midpoint in
  // proportion to how little there is: 2/2 → 7.5, 3/3 → 8.0, 6/6 → 8.8,
  // 12/12 → 9.3, 0/0 → 5.0. Raw coverage used to score 2/2 as a flat 10 — 61%
  // of postings with 0-3 extracted keywords scored ATS 10 against 7% of those
  // with 11+ — and an empty extraction fell back to the AI's own judged number,
  // which could also be 10. The displayed fraction is still the raw matched/
  // total; only the score is shrunk.
  const k = Number((tunables.scoring && tunables.scoring.keywordShrinkage) ?? 2);
  const pct = total ? matched.length / total : null;
  const shrunk = (matched.length + k / 2) / (total + k);
  return {
    score: Number((shrunk * 10).toFixed(1)),
    pctMatched: pct === null ? null : Number((pct * 100).toFixed(1)),
    matched: matched.length,
    total,
    matchedSkills: matched,
    missingSkills: missing,
  };
}

module.exports = { calculateAtsScore, calculateKeywordMatch, skillPresent, synonymsFor, DEFAULT_WEIGHTS };

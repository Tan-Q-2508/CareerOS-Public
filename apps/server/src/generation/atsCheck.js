const { tunables, calculateAtsScore, isConfirmableSkill, matchesTerm, equivalentsFor } = require('@careeros/shared');

// Step 4 of the 7.12 pipeline (deterministic — no AI): weighted keyword-match of
// the JD's required + nice-to-have skills against the rendered résumé (7.11).
// Gaps are only closable with skills the candidate genuinely has (present in the
// master profile) or has explicitly confirmed (7.13) — anything else is surfaced
// as a pending confirmation, never fabricated into the résumé.
//
// Section-aware: a keyword matched in core content (title/summary/experience/
// projects) scores full weight; one matched ONLY in Skills scores a fraction of
// that (tunables.generation.atsSkillsOnlyWeight). A flat matcher can't tell a
// keyword-dump in Skills apart from a genuinely woven-in mention, so a résumé
// could hit the ATS target by dumping every gap-check word at the bottom of the
// page — this scoring is what makes the draft prompt's core-content keyword
// target (draftResume.js) actually bite instead of being optional.

// isConfirmableSkill and skillPresent moved into packages/shared/src/ats/
// keywordPipeline.js (2026-08-13 root-cause pass) — this was one of two
// duplicate copies (the other lived in calculateAtsScore.js as
// rawPresent/skillPresent), and the class of bug that kept recurring
// (2026-07-26 through 2026-08-14) was exactly this: a fix landing in one
// copy without the other. `skillPresent` here is now just the shared
// matcher under its historical local name, so every existing importer in
// this file keeps working unchanged.
const skillPresent = matchesTerm;

// Core content: title/summary/experience/projects — what a keyword must land
// in to score full weight.
function coreKeywordText(model) {
  const parts = [model.header.title];
  for (const b of model.summary) parts.push(b);
  for (const r of model.experience) parts.push(r.title, ...(r.bullets || []));
  for (const p of model.projects) parts.push(p.title, ...(p.bullets || []));
  return parts.join(' \n ').toLowerCase();
}

// Skills section only — a keyword found ONLY here scores a fraction of full weight.
function skillsKeywordText(model) {
  const parts = [];
  for (const row of model.skills) parts.push(row.label, ...(row.items || []));
  return parts.join(' \n ').toLowerCase();
}

// Header title + Professional Summary alone — the "did this ALSO land in the
// summary" surface the v2 four-tier engine's top weight checks (7.11).
// Separate from coreKeywordText, which also includes Experience/Project
// bullets — the whole point of the top tier is bullet AND summary together.
function summaryTitleText(model) {
  const parts = [model.header.title, ...(model.summary || [])];
  return parts.join(' \n ').toLowerCase();
}

// Skills the candidate genuinely holds (master profile) — usable to close a gap
// without asking, since they're already true.
// CHANGED 2026-08-14: added role/project TITLES and education degree/field —
// found live (real user report, "the title itself is a keyword") that a
// candidate's own role title ("Product Manager", "Business Analyst") was
// invisible to scan-time matching/the gap check/vouchedSkills even though
// generation-time scoring (coreKeywordText below, and the web's
// sectionsFromTree) already counts titles — the same write/read-boundary
// consistency bug class round 1 (2026-08-13) was supposed to have
// eliminated, just for a text surface round 1 never touched. Company names
// and institution names are deliberately EXCLUDED — working AT a company
// doesn't mean the candidate HAS that company's name as a skill; degree/
// field are legitimately truthful credentials, so those stay in.
function profileSkillText(profile) {
  const parts = [...(profile.skills_declared || []), ...(profile.certifications || [])];
  for (const r of profile.roles || []) {
    if (r.title) parts.push(r.title);
    for (const b of r.bullets || []) parts.push(b.text, ...(b.skills_demonstrated || []));
  }
  for (const p of profile.projects || []) {
    if (p.title) parts.push(p.title);
    for (const b of p.bullets || []) parts.push(b.text, ...(b.skills_demonstrated || []));
  }
  for (const e of profile.education || []) {
    if (e.degree) parts.push(e.degree);
    if (e.field) parts.push(e.field);
  }
  return parts.join(' \n ').toLowerCase();
}

// Skills the job's own AI scoring already resolved as genuinely held — via
// D1a's "held the role" reasoning (already_demonstrated), a transferable
// reword (transferable[].reword_to), or a hidden strength (hidden_strengths[]
// .skill). These often aren't literal substrings of the master profile (that's
// exactly why scoring had to reason about them instead of a flat text match),
// so profileSkillText alone misses them. Shared with generationGaps.js so the
// pre-generation gap check and the post-generation ATS check agree on what
// counts as "already resolved, never re-ask" (2026-07-26 — previously only
// generationGaps consulted this, so a skill scoring had already vouched for
// could still land in atsCheck's `pendingConfirmations` and silently disable
// the repair round meant to fix exactly this kind of gap).
function transferableSkillText({ alreadyDemonstrated = [], transferable = [], hiddenStrengths = [] } = {}) {
  return [
    ...(alreadyDemonstrated || []),
    ...(transferable || []).map((t) => t && t.reword_to),
    ...(hiddenStrengths || []).map((h) => h && h.skill),
  ]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();
}

// Shared "what does this candidate truthfully have" predicate (Phase 3 #20
// Stage 2). Three call sites independently re-derived this from the same
// primitives (generationGaps.classify, this file's own heldSomewhere below,
// and routes/copilot.js's vouchedKeywords) — this is the one implementation,
// built from the exact same profileText/confirmedText/transferableText/
// coreOf primitives already used above, so a term that counts as "held" for
// the pre-generation gap check counts as "held" for the draft-time keyword
// injection and Skills-fabrication guard too (Stage 2), never a fourth
// independently-tuned notion of "genuinely has this."
function vouchedSkills({ profile, confirmedSkills = [], alreadyDemonstrated = [], transferable = [], hiddenStrengths = [] }) {
  const profileText = profileSkillText(profile);
  const confirmedText = confirmedSkills.join(' \n ').toLowerCase();
  const transferableText = transferableSkillText({ alreadyDemonstrated, transferable, hiddenStrengths });
  const heldText = [profileText, confirmedText, transferableText].filter(Boolean).join(' \n ');
  const coreOf = (s) => String(s).split('(')[0].trim();
  const isHeld = (s) => {
    if (skillPresent(profileText, s) || skillPresent(confirmedText, s) || skillPresent(transferableText, s)) return true;
    const core = coreOf(s);
    return core !== s && (skillPresent(profileText, core) || skillPresent(confirmedText, core) || skillPresent(transferableText, core));
  };
  return { heldText, isHeld };
}

/**
 * @param model            layout model of the current render
 * @param jdProfile        { required_skills[], nice_to_have_skills[] }
 * @param profile          parsed 16.2 résumé profile
 * @param confirmedSkills  string[] the user has confirmed (7.13)
 * @param alreadyDemonstrated, transferable, hiddenStrengths  the job's own scan
 *        scoring (D1a/D1b) — a required skill already resolved here is
 *        genuinely held, not an unconfirmed gap, even if it's not a literal
 *        substring of the master profile.
 * @returns { score, target, passed, missingRequired, missingNice, matched, addable, pendingConfirmations, sectionBreakdown }
 */
function atsCheck({ model, jdProfile, profile, confirmedSkills = [], alreadyDemonstrated = [], transferable = [], hiddenStrengths = [] }) {
  const target = Math.round((tunables.atsKeywordMatchTarget || 0.9) * 100);
  const coreText = coreKeywordText(model);
  const skillsText = skillsKeywordText(model);
  const required = jdProfile.required_skills || [];
  const nice = jdProfile.nice_to_have_skills || [];

  // Delegates to the shared, four-tier engine (7.11) — the same one
  // copilotAts.js always uses regardless of any flag (its own header
  // comment noted this as a latent, acknowledged divergence: the v1 inline
  // two-tier loop that used to live here couldn't express "Skills-or-
  // Summary only" as a distinct state at all, so it and the live ATS
  // panel's score COULD disagree if useUnifiedAtsEngineV2 were ever flipped
  // back off. Removed 2026-08-13 — v2 has been the only engine in real use
  // for weeks, so keeping a second, unreachable-in-practice implementation
  // around was exactly the kind of duplicate copy this pass exists to
  // eliminate.
  const { score, matched, missingRequired, missingNice, sectionBreakdown } = calculateAtsScore({
    sections: { core: coreText, summaryTitle: summaryTitleText(model), skills: skillsText },
    jdProfile,
    weights: tunables.generation.atsWeightsV2,
  });

  // A JD skill string sometimes carries a parenthetical elaboration
  // ("ERP or enterprise platforms (Salesforce, SAP, Oracle, ServiceNow)")
  // while the scoring AI's own already_demonstrated/transferable/hidden_strengths
  // record the SAME fact as a shorter paraphrase ("ERP or enterprise platforms")
  // — confirmed live (2026-07-27) on a real job where this caused a genuinely
  // held, scan-vouched required skill to be missed by addable-classification
  // entirely. Stripping to the text before the first "(" catches this without
  // loosening the PRIMARY score1 match above (which stays strict/literal).
  const heldSomewhere = vouchedSkills({ profile, confirmedSkills, alreadyDemonstrated, transferable, hiddenStrengths }).isHeld;

  // Per-tier bullet-coverage (Phase 3 bug fix, 2026-08-02): how much of what
  // the candidate GENUINELY HAS lands inside a real bullet, split required vs
  // nice-to-have, rather than one blended ratio across every JD term
  // (generation.coreKeywordRatioTarget, pre-existing). A term the candidate
  // doesn't hold must never count against coverage — that's what "held"
  // filters for. Denominator is 0 (ratio 1, vacuously satisfied) when the
  // candidate holds none of that tier's terms, so an empty/irrelevant tier
  // never drags the target down.
  const bulletCoverageFor = (terms) => {
    const held = terms.filter((s) => heldSomewhere(s));
    if (!held.length) return { held: 0, inBullet: 0, ratio: 1 };
    const coreSet = new Set(sectionBreakdown.core.map((s) => String(s).toLowerCase()));
    const inBullet = held.filter((s) => coreSet.has(String(s).toLowerCase())).length;
    return { held: held.length, inBullet, ratio: inBullet / held.length };
  };
  const bulletCoverage = {
    required: bulletCoverageFor(required),
    niceToHave: bulletCoverageFor(nice),
  };

  // Split missing skills (required AND nice-to-have — a nice-to-have gap the
  // candidate genuinely has is just as addable as a required one; excluding
  // nice-to-have here was a real bug, confirmed live: the same job's own
  // already_demonstrated list verbatim-vouched two nice-to-have skills that
  // never got a chance to be classified addable, so no repair round or
  // literal-keyword pass ever tried to include them) into "addable"
  // (genuinely held → a repair can naturally include them, or the literal-
  // keyword safety net in generateResume.js can guarantee it) vs "pending"
  // (unknown → ask the user, 7.11/7.13).
  const addable = [];
  const pendingConfirmations = [];
  for (const s of [...missingRequired, ...missingNice]) {
    if (heldSomewhere(s)) addable.push(s);
    else if (isConfirmableSkill(s)) pendingConfirmations.push(s); // drop credentials/soft traits
  }

  return {
    score,
    target,
    passed: score >= target,
    missingRequired,
    missingNice,
    matched,
    addable,
    pendingConfirmations,
    sectionBreakdown,
    bulletCoverage,
  };
}

// confirmed_skills (7.13) is a global, cross-job store — intentionally
// reusable without re-asking. But dumping the user's ENTIRE historical
// confirmation list into every generation regardless of whether it's
// relevant to the CURRENT job overloads the draft prompt: every entry (even
// ones from a completely unrelated prior job, e.g. "FloQast"/"Navan" for a
// finance role showing up in a Product Manager résumé's prompt) carries a
// "MUST weave into a bullet" instruction, all competing for a hard, fixed
// bullet budget the Content Director assigns per entry (2026-07-26's
// bullet_target enforcement) — with nothing left over for the skills that
// actually matter to THIS job. Confirmed 2026-07-27 on a real generation: a
// skill confirmed with real context minutes before generating simply never
// appeared anywhere in the output, no error, no signal. Scope to only the
// confirmed skills that are actually part of THIS job's required/nice-to-have
// list — this is exactly the same relevance check the pre-generation gap
// check already establishes (a term only needs "confirming" in the first
// place because some job's JD asked about it).
function jobRelevantConfirmedSkills(confirmed, jdProfile = {}) {
  // Alternative-group members are requirements too, and a confirmed skill
  // that is a true equivalent of a posting term (a confirmed "G Suite" for
  // "Google Workspace") is relevant to it.
  const jdSkills = [
    ...(jdProfile.required_skills || []),
    ...(jdProfile.nice_to_have_skills || []),
    ...(jdProfile.any_of_groups || []).flat(),
  ]
    .map((s) => String(s || '').toLowerCase().trim())
    .filter(Boolean)
    .map((js) => ({ js, eq: equivalentsFor(js) }));
  const isRelevant = (term) => {
    const t = String(term || '').toLowerCase().trim();
    if (!t) return false;
    return jdSkills.some(({ js, eq }) => js.includes(t) || t.includes(js) || eq.includes(t));
  };
  return (confirmed || []).filter((c) => isRelevant(c.skill_term));
}

module.exports = { atsCheck, skillPresent, profileSkillText, transferableSkillText, isConfirmableSkill, jobRelevantConfirmedSkills, vouchedSkills, coreKeywordText, skillsKeywordText, summaryTitleText };

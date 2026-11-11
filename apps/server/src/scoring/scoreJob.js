const { tunables, extractYearsRequired, domainOverlap, detectUsOnlySignal, detectWorkAuthReject, sanitizeJdProfile, jdGroundingText } = require('@careeros/shared');
const { experienceBreakdown, hasGraduateDegree } = require('../resume/deriveProfile');
const { runJdAts, buildResumeSkillsBlock } = require('./jdAtsCall');
const { runFit, buildResumeProfileBlock } = require('./fitCall');
const { postingLevel } = require('./postingLevel');
const { computeKeywordState } = require('../generation/keywordState');

// Orchestrates the two-call scoring for a single job (spec 5.6 "Call composition"):
//   call 1 (cheap tier): JD profile + ATS Match
//   call 2 (strong tier): callback odds, preference fit, tiered analysis, tags, note
// Overall Fit is computed here from the AI inputs (5.1/16.4) — never model-emitted.
// Self-consistency (5.6): borderline jobs are scored twice and the three numeric
// inputs averaged. No DB writes here — the caller persists.

const round1 = (n) => Number(Number(n).toFixed(1));
const avg = (a, b) => (a + b) / 2;

// Which ATS number survives the self-consistency re-run (5.6). Its own
// function so the rule is testable without standing up two AI calls, because
// the rule is easy to get wrong in a way nothing else catches: getting it
// wrong produces a score that merely looks a bit off, next to a keyword
// fraction that contradicts it.
//
// Under v2 the score is a COUNT rendered beside its own fraction, so it must
// come from whichever run's coverage is stored — never an average, which is
// the score of neither run. Under legacy it is an AI judgment with no fraction
// shown, so averaging two draws is the right smoothing.
function selfConsistentAts({ useV2, firstAts, secondAts }) {
  return useV2 ? secondAts : avg(firstAts, secondAts);
}

// Overall = 0.35·ATS + 0.55·Callback + 0.1·preference-fit (16.4). Callback —
// the recruiter's judgment — carries the most weight; preference-fit is
// location-only and near 10 on most jobs, so a larger weight on it just adds
// the same free points to every score.
function computeOverallFit(atsMatch, callbackOdds, preferenceFit) {
  const w = tunables.overallFitWeights;
  return round1(w.atsMatch * atsMatch + w.callbackOdds * callbackOdds + w.preferenceFit * preferenceFit);
}

// Verdict stamp (5.2): PURSUE ≥8.0, REVIEW 6.5–7.9, PASS <6.5.
function verdictFor(overallFit) {
  if (overallFit == null) return null;
  const t = tunables.verdictThresholds;
  if (overallFit >= t.pursue) return 'PURSUE';
  if (overallFit >= t.reviewMin) return 'REVIEW';
  return 'PASS';
}

// Within ~0.3 of a verdict boundary (6.5 or 8.0) — only these get double-scored.
// overall_fit is 1-decimal-rounded, so the boundary values (6.2, 6.8, 7.7, 8.3)
// sit exactly at distance 0.3; an epsilon keeps that boundary inclusive rather
// than at the mercy of float representation.
function isBorderline(overallFit) {
  const d = tunables.scoring.selfConsistencyBoundaryDelta + 1e-9;
  const t = tunables.verdictThresholds;
  return Math.abs(overallFit - t.reviewMin) <= d || Math.abs(overallFit - t.pursue) <= d;
}

// Deterministic US-only / citizenship-required override (bug fix 2026-07-28):
// the model's own `visa` risk tag is a judgment call and can miss a plain
// "U.S. Applicants Only" line (confirmed live: a real Visa req scored with no
// visa risk flagged at all). detectUsOnlySignal is a phrase match, zero AI
// cost — force the visa tag to `high` with a reason quoting the matched
// phrase whenever it fires, overwriting whatever the model returned for that
// one field. This only ever strengthens/adds the tag; it never drops the
// posting on its own (that's the pre-filter's `visaRejectPatterns`, applied
// separately in prefilter.js before scoring ever runs).
//
// Also runs detectVisaReject here (bug fix 2026-08-15) — the SAME detector
// the pre-filter uses to drop a posting outright now also feeds this tag, so
// the two mechanisms can't disagree the way they did for the U-Haul job (the
// filter said "not a match", and independently the model didn't rate `visa`
// as `high`, so no badge showed). This is a deliberate belt-and-suspenders:
// if the toggle is off, or a job was stored before this fix and never
// re-scored, the card still surfaces US-ONLY rather than looking clean.
const WORK_AUTH_MEANING = {
  no_sponsorship: 'this role does not sponsor work visas',
  citizen_only: 'this role is limited to U.S. citizens / permanent residents',
  us_person_export: 'this role requires U.S.-person status (export control)',
  clearance: 'this role requires a U.S. security clearance',
};

function applyUsOnlySignal(riskTags, jobText) {
  const usOnlyPhrase = detectUsOnlySignal(jobText);
  const authHit = detectWorkAuthReject(jobText);
  if (!usOnlyPhrase && !authHit) return riskTags;
  const tags = Array.isArray(riskTags) ? riskTags.map((t) => ({ ...t })) : [];
  const reason = authHit
    ? `Posting states "${authHit.match}" — ${WORK_AUTH_MEANING[authHit.category] || 'this role restricts work authorization'}.`
    : `Posting states "${usOnlyPhrase}" — confirm US work authorization/citizenship before applying.`;
  const i = tags.findIndex((t) => t && t.type === 'visa');
  if (i >= 0) tags[i] = { ...tags[i], severity: 'high', reason };
  else tags.push({ type: 'visa', severity: 'high', reason });
  return tags;
}

// Deterministic score caps (5.2), applied after Overall Fit is computed so no
// AI judgment can lift a job past them:
//   years gap in (0, 1)  → max 7.9 (a stretch is REVIEW, never PURSUE)
//   years gap in [1, 2)  → max 6.9 (a full year short is a real screen-out)
//   years gap ≥ 2        → max 6.4 (normally the pre-filter drops these; this
//                           catches manual entries and filter-off scans)
//   visa risk tag high   → max 7.9
//   unmet hard requirement (verified quote) → max 6.4 — PASS, kept visible so
//                           a misread knockout can still be overruled
// Each applied cap is stated in the note so the card says why.
function applyScoreCaps({ overall, jdYears, userYears, riskTags, note, hardRequirements = [] }) {
  const caps = tunables.scoreCaps;
  let capped = overall;
  const reasons = [];
  let tags = Array.isArray(riskTags) ? riskTags.map((t) => ({ ...t })) : [];
  const gap = jdYears != null && userYears != null ? Math.round((jdYears - userYears) * 10) / 10 : null;
  if (gap != null && gap > 0) {
    const cap = gap >= 2 ? caps.yearsGap2Plus : gap >= 1 ? caps.yearsGap1to2 : caps.yearsGapUnder1;
    if (capped > cap) {
      capped = cap;
      reasons.push(`capped at ${cap}: the posting asks for ${jdYears}+ years and you have ${userYears}`);
    }
    const severity = gap >= 2 ? 'high' : 'medium';
    const reason = `Posting asks for ${jdYears}+ years; you have ${userYears} (${gap} short).`;
    const i = tags.findIndex((t) => t && t.type === 'experience');
    const rank = { none: 0, low: 1, medium: 2, high: 3 };
    if (i < 0) tags.push({ type: 'experience', severity, reason });
    else if ((rank[tags[i].severity] || 0) < rank[severity]) tags[i] = { ...tags[i], severity, reason };
  }
  const unmet = (hardRequirements || []).filter((h) => h && h.status === 'unmet');
  if (unmet.length) {
    const reason = unmet.map((h) => `"${h.quote}"`).join('; ');
    const i = tags.findIndex((t) => t && t.type === 'requirements');
    const tag = { type: 'requirements', severity: 'high', reason: `Posting requires ${reason} — not shown on your résumé.` };
    if (i < 0) tags.push(tag);
    else tags[i] = tag;
    if (capped > caps.hardRequirementUnmet) {
      capped = caps.hardRequirementUnmet;
      reasons.push(`capped at ${caps.hardRequirementUnmet}: the posting requires ${reason}`);
    }
  }
  if (tags.some((t) => t && t.type === 'visa' && t.severity === 'high') && capped > caps.visaHigh) {
    capped = caps.visaHigh;
    reasons.push(`capped at ${caps.visaHigh}: the posting restricts work authorization`);
  }
  const outNote = reasons.length ? `${note ? `${note} ` : ''}(Score ${reasons.join('; ')}.)` : note;
  return { overall: capped, riskTags: tags, note: outNote, capped: capped !== overall };
}

function usageFrom(callResult, actionType) {
  return {
    actionType,
    model: callResult.model,
    connectionMode: callResult.connectionMode,
    usage: callResult.usage,
    costUsd: callResult.costUsd,
    tier: callResult.tier,
  };
}

/**
 * Score one job. Inputs:
 *   resumeProfile        parsed 16.2 profile (with stable bullet ids)
 *   confirmedSkills      the user's confirmed_skills rows — scoped per job by keywordState
 *   resumeProfileBlock   batch-invariant call-2 prefix (buildResumeProfileBlock)
 *   job                  { title, description_text, location, posted_at, salary_min, salary_max, seniority_level }
 *   userYears            candidate years of experience (precomputed signal)
 *   domainKeywords       effective domain keyword list (same list the pre-filter used)
 *   scanLocation         the location the user searched (preference-fit basis)
 *   threshold            (D2) this scan's storage threshold — config.threshold ?? tunables.storageCutoff,
 *                         already resolved by the caller. Enables the early-abandon check below; omit
 *                         (null/undefined) to always run both calls, same as before D2.
 *   sponsor              (19.4) this employer's matched `visa_sponsors` row, or null. Resolved once
 *                         per employer per scan by the caller. A null means "no filing record
 *                         matched", NEVER "this employer does not sponsor" — see fitCall.js.
 * Returns { scores, jdProfile, tiered, riskTags, note, usages, abandoned? }.
 */
async function scoreJob({ resumeProfile, resumeProfileBlock, job, userYears, domainKeywords, scanLocation, credential, threshold, sponsor = null, confirmedSkills = [], db = null, userId = null }) {
  const jobText = job.description_text || '';
  const jobMeta = {
    location: job.location,
    postedAt: job.posted_at,
    salaryMin: job.salary_min,
    salaryMax: job.salary_max,
    seniorityLevel: job.seniority_level,
    companyName: job.company_name || null,
  };

  // ATS Match is ALWAYS the deterministic keyword coverage (5.1). Call 1 no
  // longer produces an AI ats_match at all (it extracts from the JD alone), so
  // the legacy flag-off path has nothing to fall back to; the flag is kept
  // only for the generation code that still reads it.
  const useV2 = true;

  // Two-phase because the scan-vouched equivalents (already_demonstrated/
  // transferable/hidden_strengths) only exist AFTER call 2, which itself
  // takes atsMatch as an input signal: phase 1 (literal-only, from the
  // master profile alone) feeds call 2; phase 2 (literal + scan-vouched)
  // recomputes the number actually stored.
  // Both phases go through keywordState — the one function the gap check and
  // the card's refresh also use — so the X/Y stored here is the X/Y the gap
  // check will later agree with (confirmed skills relevant to this job count
  // as held in all three).
  const keywordJob = (jdProfile) => ({ ...job, jd_profile: jdProfile });
  const literalKeywordMatch = (jdProfile) =>
    computeKeywordState({ job: keywordJob(jdProfile), profile: resumeProfile, confirmedSkills, vouched: {} });
  const finalKeywordMatch = (jdProfile, fit) =>
    computeKeywordState({
      job: keywordJob(jdProfile),
      profile: resumeProfile,
      confirmedSkills,
      vouched: {
        alreadyDemonstrated: fit.already_demonstrated,
        transferable: fit.transferable,
        hiddenStrengths: fit.hidden_strengths,
      },
    });

  // Call 1 alone (cheap tier) — split out from the combined call so D2's
  // early-abandon check can look at ATS before ever paying for call 2
  // (strong tier). Sanitize here (not inside call1/jdAtsCall.js) so call 2
  // still receives the RAW jd_profile verbatim, unchanged. Only the
  // keyword-match computations and the profile actually persisted use the
  // sanitized version. sanitizeJdProfile (2026-08-13) is the single
  // pipeline — junk-filter, ground against jobText, atomize, RE-ground the
  // atoms — replacing the old split of grounding-at-extraction (jdAtsCall.js)
  // + atomization-at-write-with-no-re-grounding (here) that let an atom the
  // splitter manufactured slip through ungrounded. See
  // handoffs/jd_term_normalization_handoff.md for the original motivating bug.
  // Grounds against jdGroundingText (title+body, 2026-08-14) rather than
  // jobText alone — a keyword living only in the job title (29% of scored
  // jobs had a title absent from the JD body, confirmed live) would
  // otherwise be dropped as "ungrounded" even though it's a real requirement.
  async function runCall1() {
    // db/userId enable the extraction cache (5.6). Keyed on the same
    // title+body text grounding uses, so an unchanged posting re-scanned
    // against an unchanged résumé returns the identical skill set rather
    // than a fresh draw from a stochastic extractor.
    const call1 = await runJdAts({
      jobTitle: job.title,
      jobText,
      credential,
      db,
      userId,
      cacheText: jdGroundingText(job),
    });
    const rawJdProfile = call1.jdProfile;
    const jdProfile = sanitizeJdProfile(rawJdProfile, jdGroundingText(job));
    const phase1Kw = literalKeywordMatch(jdProfile);
    // Never null: keywordState shrinks small samples toward the
    // midpoint, so a JD with 0 extractable skills scores a neutral 5.0 rather
    // than borrowing an AI judgment (5.1).
    const atsForFit = phase1Kw.score;
    return { call1, rawJdProfile, jdProfile, phase1Kw, atsForFit };
  }

  // Years bar: the deterministic reading of the posting wins (it knows the
  // candidate's degree track — "or Master's + 3 years" — and ignores
  // preferred-section numbers); call 1's AI figure is the fallback when the
  // text states none the regex can read.
  const deterministicJdYears = extractYearsRequired(jdGroundingText(job), { candidateHasMasters: hasGraduateDegree(resumeProfile) });
  const breakdown = experienceBreakdown(resumeProfile);
  // Only describe the breakdown when it IS the number in use (a manual
  // Settings override replaces it).
  const yearsBreakdown = breakdown && userYears != null && breakdown.total === Number(userYears) ? breakdown : null;
  const jdYearsFor = (c1) => deterministicJdYears ?? c1.rawJdProfile.years_required ?? null;

  // Call 2 (strong tier), given an already-run call 1's output.
  async function runCall2(c1) {
    const precomputed = {
      jdYears: jdYearsFor(c1),
      userYears: userYears ?? null,
      yearsBreakdown,
      domainOverlap: domainOverlap(jobText, domainKeywords),
      // 19.4: real DOL/OFLC filing data replacing an unguarded AI guess in the
      // same slot years-gap and domain-overlap already occupy. No new AI call
      // and no new response field — callback_odds already weighs this.
      sponsor,
      // Support role / structured early-career program bounds on the rubric
      // (postingLevel.js); null for everything else, internships included.
      postingLevel: postingLevel({ title: job.title, text: jobText }),
    };
    const call2 = await runFit({
      resumeProfileBlock,
      resumeProfile,
      jdProfile: c1.rawJdProfile,
      // The posting itself, so knockouts extraction never carries into the
      // profile (a required MBA, a language, people management, enrollment)
      // are visible to the judge — see fitCall.js hard_requirements.
      postingText: jdGroundingText(job),
      atsMatch: c1.atsForFit,
      precomputed,
      jobMeta,
      scanLocation,
      credential,
    });
    const kw = useV2 ? finalKeywordMatch(c1.jdProfile, call2.fit) : null;
    return { call2, keywordMatch: kw };
  }

  // runOnce(c1) reuses an already-run call 1 when given one (the bound check
  // below always runs call 1 first); with no argument it runs a completely
  // fresh call1+call2 pair — used ONLY by the pre-existing self-consistency
  // re-run below, which must stay a full independent re-score, never routed
  // through the early-abandon check (guard (b) — the re-run only narrows
  // within the bound already cleared by the first run, it doesn't get a
  // second chance to abandon).
  const runOnce = async (c1) => {
    const call1Result = c1 || (await runCall1());
    const { call2, keywordMatch } = await runCall2(call1Result);
    return { call1: call1Result.call1, call2, keywordMatch, jdProfile: call1Result.jdProfile };
  };

  // ---- D2: provably-safe early-abandon (tunable-gated, default on) ----
  // After call 1 alone, ATS is fully known — deterministic under v2, since
  // it's the literal keyword-match score, not a model judgment. Callback and
  // preference fit (call 2's two outputs) are each capped at 10 (5.1), so
  // computeOverallFit(ats, 10, 10) — the EXACT SAME weights/rounding real
  // scores get, via the exact same function, not a re-implementation — is a
  // hard ceiling on what call 2 could ever produce for this job. If even that
  // ceiling can't clear the threshold, call 2 (strong tier, the expensive
  // call) is skipped entirely: call 1's tokens were still spent, so the
  // caller still logs/bills call 1's usage; the job just takes the
  // below-threshold path immediately instead of paying for a call that
  // provably cannot change the outcome. Reusing computeOverallFit for the
  // bound (rather than reimplementing "0.4*ats+6.0" inline) is what satisfies
  // guard (a): a job that could round up to exactly the threshold is never
  // wrongly dropped, because the bound is rounded identically to how a real
  // score would be.
  const earlyAbandonEnabled = !(tunables.scoring && tunables.scoring.earlyAbandonScoring === false);
  const firstCall1 = await runCall1();
  if (earlyAbandonEnabled && threshold != null) {
    const bound = computeOverallFit(firstCall1.atsForFit, 10, 10);
    if (bound < threshold) {
      return {
        scores: {
          atsMatch: round1(firstCall1.atsForFit),
          callbackOdds: null,
          preferenceFit: null,
          overallFit: bound,
          keywordCoverage: firstCall1.phase1Kw
            ? { matched: firstCall1.phase1Kw.matched, total: firstCall1.phase1Kw.total, missing: firstCall1.phase1Kw.missing }
            : null,
        },
        jdProfile: firstCall1.jdProfile,
        // Below-threshold jobs are deleted, not persisted (A2) — the caller
        // never reads these fields for an abandoned job, so empty/null is
        // correct here rather than fabricating call-2-shaped output.
        tiered: {
          critical_missing: [],
          important_missing: [],
          nice_to_have_missing: [],
          already_demonstrated: [],
          transferable: [],
          hidden_strengths: [],
        },
        riskTags: [],
        note: null,
        usages: [usageFrom(firstCall1.call1, 'score_jd_ats')],
        abandoned: true,
      };
    }
  }

  const first = await runOnce(firstCall1);
  let ats = first.keywordMatch.score;
  let callback = first.call2.fit.callback_odds;
  let pref = first.call2.fit.preference_fit;
  const overallFirst = computeOverallFit(ats, callback, pref);
  const usages = [usageFrom(first.call1, 'score_jd_ats'), usageFrom(first.call2, 'score_fit')];
  let keywordCoverage = first.keywordMatch;
  // The run whose keyword coverage is stored. Its tiered analysis
  // (already_demonstrated/transferable/hidden_strengths) is what that coverage
  // was computed against, so the stored vouched lists must come from the SAME
  // run — otherwise the gap check (which reads the stored lists) disagrees
  // with the card's "Keywords X/Y" on exactly the borderline jobs.
  let kept = first;

  let overall = overallFirst;
  if (isBorderline(overallFirst)) {
    // Self-consistency (5.6): re-score once, average the JUDGMENT inputs,
    // recompute.
    //
    // callback_odds and preference_fit are averaged because they are opinions,
    // and averaging two draws of an opinion is the whole point of this re-run.
    // The keyword match is NOT averaged, and that distinction is load-bearing:
    // it is a COUNT with a fraction shown next to it in the UI ("Keyword Match
    // · 7/7"). An average of two runs' scores is not the score of either run's
    // fraction, so averaging it puts a number on the card that its own
    // fraction contradicts — 7/7 displayed beside 9.5 rather than 10, found
    // live on 7 jobs (Box, Google, Amazon) from one scan.
    //
    // This used to be written as a no-op on the grounds that v2's keyword
    // match is deterministic. Call 1 genuinely is, since the extraction cache
    // landed. Call 2 is not, and phase 2's coverage folds call 2's
    // already_demonstrated/transferable/hidden_strengths in as a second
    // haystack — so the same JD skills can match a different number of times
    // across two runs. The score and the fraction must come from the SAME run;
    // the second is kept, matching what the coverage already did.
    const second = await runOnce();
    usages.push(usageFrom(second.call1, 'score_jd_ats'), usageFrom(second.call2, 'score_fit'));
    const secondAts = second.keywordMatch.score;
    const overallSecond = computeOverallFit(
      secondAts,
      second.call2.fit.callback_odds,
      second.call2.fit.preference_fit
    );
    ats = selfConsistentAts({ useV2, firstAts: ats, secondAts });
    callback = avg(callback, second.call2.fit.callback_odds);
    pref = avg(pref, second.call2.fit.preference_fit);
    overall = computeOverallFit(ats, callback, pref);
    keywordCoverage = second.keywordMatch;
    kept = second;
    if (verdictFor(overallFirst) !== verdictFor(overallSecond)) {
      console.warn(
        `scoreJob self-consistency disagreement: run1 overall=${overallFirst} (${verdictFor(overallFirst)}) vs run2 overall=${overallSecond} (${verdictFor(overallSecond)}); averaged=${overall}`
      );
    }
  }

  // Numeric judgment scores are averaged across runs; the qualitative
  // analysis (tiered arrays, risk tags, note) comes from the run whose
  // keyword coverage is stored (see `kept`).
  const fit = kept.call2.fit;
  const capped = applyScoreCaps({
    overall,
    jdYears: jdYearsFor(firstCall1),
    userYears: userYears ?? null,
    riskTags: applyUsOnlySignal(fit.risk_tags, jobText),
    note: fit.note,
    hardRequirements: fit.hard_requirements,
  });
  return {
    scores: {
      atsMatch: round1(ats),
      callbackOdds: round1(callback),
      preferenceFit: round1(pref),
      overallFit: capped.overall,
      // The plain "N of M" JD-skill coverage backing the deterministic
      // atsMatch above, for the UI's "Keywords N/M" surface
      // (jobs.keyword_coverage). Recomputed later by keywordState when
      // confirmed skills or the active résumé change.
      // MUST live under scores. (not as a sibling) — scan/runScan.js,
      // scoreManualJob.js, and the offline verification script all read it
      // as result.scores.keywordCoverage; a sibling placement here silently
      // dropped the field from the DB update entirely (undefined keys are
      // omitted from the JSON body), caught live in this session's
      // end-to-end verification pass — see the Stage 1 handoff.
      keywordCoverage: keywordCoverage
        ? { matched: keywordCoverage.matched, total: keywordCoverage.total, missing: keywordCoverage.missing }
        : null,
    },
    jdProfile: kept.jdProfile,
    tiered: {
      critical_missing: fit.critical_missing,
      important_missing: fit.important_missing,
      nice_to_have_missing: fit.nice_to_have_missing,
      already_demonstrated: fit.already_demonstrated,
      transferable: fit.transferable,
      hidden_strengths: fit.hidden_strengths,
    },
    riskTags: capped.riskTags,
    note: capped.note,
    usages,
  };
}

module.exports = {
  scoreJob,
  selfConsistentAts,
  computeOverallFit,
  verdictFor,
  isBorderline,
  applyUsOnlySignal,
  applyScoreCaps,
  buildResumeSkillsBlock,
  buildResumeProfileBlock,
  round1,
};

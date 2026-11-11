// The Quick read (spec 4.7) — a deterministic, zero-AI read of an unscored job,
// so the user can pick which on-demand-scan survivors are worth paying to score.
// Pure: no DB, no AI, no clock. Computed once at insert time and stored on
// `jobs.triage`.
//
// It is a HINT, never a fourth score. Two parts:
//
//   ceiling  The best Overall Fit this job can possibly reach. Not a guess —
//            every input to it is a deterministic bound the real scorer
//            applies too: the posting-level bounds on the callback rubric
//            (support role / structured program), the seniority ceiling and
//            gate from the years gap, and the score caps (years gap, a
//            work-authorization restriction). ATS Match, callback and
//            preference-fit are otherwise taken at their maximum of 10, and
//            the whole thing runs through the SAME computeOverallFit /
//            callbackFromRubric / applyScoreCaps the scorer uses, so a real
//            score can never exceed it. `scripts/triage-calibration.js` checks
//            that invariant against every stored scored job.
//
//   rank     How much of the candidate's own résumé vocabulary the posting
//            uses (the literal matcher ATS Match uses, `matchesTerm`) and how
//            close the posting's title is to roles the candidate has held,
//            scaled by the ceiling squared and halved for a senior title when
//            the candidate is early-career. Sorts the unscored list; weights and
//            band cut-points live in tunables.triage, set from
//            scripts/triage-calibration.js (the ceiling carries most of the
//            signal; term overlap alone barely orders jobs).

const { tunables, extractYearsRequired, detectUsOnlySignal, detectWorkAuthReject, matchesTerm, isConfirmableSkill, jdGroundingText } = require('@careeros/shared');
const { seniorRegex } = require('@careeros/shared/src/sourcing/prefilter');
const { computeOverallFit, applyScoreCaps, round1 } = require('../scoring/scoreJob');
const { callbackFromRubric, RUBRIC_KEYS } = require('../scoring/fitCall');
const { postingLevel, titleHead } = require('../scoring/postingLevel');

// Title words that say a role's level or shape, not its function — "Product
// Manager" and "Program Manager" share "manager" and are different jobs.
const GENERIC_TITLE_WORDS = new Set([
  'manager', 'management', 'lead', 'leader', 'specialist', 'associate', 'coordinator', 'senior', 'sr', 'junior', 'jr',
  'staff', 'principal', 'head', 'director', 'officer', 'executive', 'assistant', 'intern', 'internship', 'i', 'ii',
  'iii', 'iv', 'v', 'of', 'and', 'the', 'for', 'to', 'in', 'at', 'a', 'an', 'with', 'team', 'global', 'remote',
  'hybrid', 'new', 'grad', 'graduate', 'entry', 'level', 'mid', 'contract', 'temporary', 'part', 'time', 'full',
]);

function titleWords(title) {
  return String(titleHead(title) || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .map((w) => w.replace(/s$/, ''))
    .filter((w) => w && w.length > 1 && !GENERIC_TITLE_WORDS.has(w) && !GENERIC_TITLE_WORDS.has(`${w}s`));
}

function termText(t) {
  if (typeof t === 'string') return t.trim();
  if (t && typeof t === 'object') return String(t.name || t.title || '').trim();
  return '';
}

/**
 * Everything the Quick read needs about the candidate, built once per scan.
 * @param {object} input
 * @param {object} input.parsedProfile  active résumé's parsed_profile (16.2)
 * @param {string[]} [input.domainKeywords] users.domain_keywords
 * @param {number|null} input.years      live candidate years (runScan's liveYearsOfExperience)
 * @param {boolean} [input.hasGraduateDegree]
 */
function buildTriageProfile({ parsedProfile, domainKeywords = [], years = null, hasGraduateDegree = false } = {}) {
  const profile = parsedProfile || {};
  const byLower = new Map();
  for (const raw of [...(profile.skills_declared || []), ...(profile.certifications || []), ...(domainKeywords || [])]) {
    const t = termText(raw);
    if (t.length < 2 || byLower.has(t.toLowerCase())) continue;
    // Soft traits and credentials-as-sentences are not searchable terms (the
    // same rule the JD side uses) — "communication" in a posting says nothing.
    if (!isConfirmableSkill(t)) continue;
    byLower.set(t.toLowerCase(), t);
  }
  const roleWords = new Set();
  for (const role of profile.roles || []) for (const w of titleWords(role.title)) roleWords.add(w);
  return {
    terms: [...byLower.values()],
    roleWords,
    years: years == null ? null : Number(years),
    hasGraduateDegree: !!hasGraduateDegree,
  };
}

function fmtYears(n) {
  return String(Math.round(n * 10) / 10);
}

// The highest Overall Fit reachable, with the reasons it is below 10.
function ceilingFor({ title, description, profile }) {
  const grounding = jdGroundingText({ title, description_text: description });
  const jdYears = extractYearsRequired(grounding, { candidateHasMasters: profile.hasGraduateDegree });
  const userYears = profile.years;
  const gap = jdYears != null && userYears != null ? round1(jdYears - userYears) : null;
  const level = postingLevel({ title, text: description });

  const maxRubric = Object.fromEntries(RUBRIC_KEYS.map((k) => [k, 10]));
  const { callbackOdds } = callbackFromRubric(maxRubric, gap, { postingLevel: level });
  // scoreJob runs the work-authorization tag on the description alone.
  const restricted = !!(detectUsOnlySignal(description) || detectWorkAuthReject(description));
  const { overall } = applyScoreCaps({
    overall: computeOverallFit(10, callbackOdds, 10),
    jdYears,
    userYears,
    riskTags: restricted ? [{ type: 'visa', severity: 'high', reason: '' }] : [],
    note: '',
  });

  const reasons = [];
  if (gap != null && gap > 0) reasons.push(`asks for ${fmtYears(jdYears)}+ years, you have ${fmtYears(userYears)}`);
  if (level === 'support') reasons.push('an assistant/administrative role, below your level');
  if (level === 'program') reasons.push('a structured early-career program with a selective applicant pool');
  if (restricted) reasons.push('the posting restricts work authorization');
  return { ceiling: overall, reasons, jdYears, level };
}

/**
 * @param {object} input
 * @param {{title: string, description_text?: string, descriptionText?: string}} input.job
 * @param {ReturnType<typeof buildTriageProfile>} input.profile
 * @param {number} [input.threshold] the scan's minimum score; a ceiling under it bands as below_threshold
 */
function quickRead({ job, profile, threshold = null }) {
  const cfg = tunables.triage;
  const title = job.title || '';
  const description = job.description_text ?? job.descriptionText ?? '';
  const prof = profile || buildTriageProfile({});

  const { ceiling, reasons } = ceilingFor({ title, description, profile: prof });

  const lc = `${title}\n${description}`.toLowerCase();
  const hits = prof.terms.filter((t) => matchesTerm(lc, t));

  const postingWords = [...new Set(titleWords(title))];
  const shared = postingWords.filter((w) => prof.roleWords.has(w));
  const titleFit = postingWords.length && prof.roleWords.size ? shared.length / postingWords.length : null;
  const seniorTitle = seniorRegex(tunables.prefilter.seniorTitleTerms).test(title);

  const termScore = Math.min(1, hits.length / cfg.fullTermHits);
  // An unknown title fit (no role titles, or a title of only generic words)
  // is neutral rather than a penalty.
  const titleScore = titleFit == null ? 0.5 : titleFit;
  const base = 100 * (cfg.weights.terms * termScore + cfg.weights.title * titleScore);
  // A Senior/Staff/Lead title for an early-career candidate is the pattern the
  // recruiter gold set most often marks as a screen-out even when no years
  // bar is stated for the ceiling to catch.
  const seniorStretch = seniorTitle && prof.years != null && prof.years < cfg.seniorTitle.belowYears;
  const rank = Math.round(base * (ceiling / 10) ** cfg.ceilingPower * (seniorStretch ? cfg.seniorTitle.factor : 1));

  let band;
  if (threshold != null && ceiling < threshold) band = 'below_threshold';
  else if (rank >= cfg.bands.strongMin) band = 'strong';
  else if (rank >= cfg.bands.possibleMin) band = 'possible';
  else band = 'long_shot';

  const signals = [];
  if (prof.terms.length) {
    const shown = hits.slice(0, 4).join(', ');
    signals.push({
      kind: 'terms',
      tone: termScore >= 0.75 ? 'good' : termScore >= 0.375 ? 'neutral' : 'weak',
      text: hits.length
        ? `${hits.length} of your résumé terms ${hits.length === 1 ? 'appears' : 'appear'}${shown ? `: ${shown}${hits.length > 4 ? ', …' : ''}` : ''}`
        : 'None of your résumé terms appear in the posting',
    });
  }
  if (titleFit != null) {
    signals.push({
      kind: 'title',
      tone: titleFit >= 0.5 ? 'good' : titleFit > 0 ? 'neutral' : 'weak',
      text: titleFit >= 0.5 ? 'Title matches roles you have held' : titleFit > 0 ? 'Title partly matches your past roles' : 'Title is outside roles you have held',
    });
  }
  if (seniorTitle) signals.push({ kind: 'senior', tone: 'weak', text: 'Senior-level title' });
  if (reasons.length) {
    signals.push({ kind: 'ceiling', tone: 'weak', text: `Best possible score ${ceiling}: ${reasons.join('; ')}` });
  }

  return {
    v: cfg.version,
    band,
    rank,
    ceiling,
    ceiling_reasons: reasons,
    term_hits: hits.length,
    terms_total: prof.terms.length,
    hit_terms: hits.slice(0, cfg.maxHitTermsStored),
    title_fit: titleFit == null ? null : Math.round(titleFit * 100) / 100,
    senior_title: seniorTitle,
    signals,
  };
}

module.exports = { quickRead, buildTriageProfile, titleWords };

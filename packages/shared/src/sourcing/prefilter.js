const tunables = require('../tunables.json');
const { matchesTerm } = require('../ats/keywordPipeline');
const { detectWorkAuthReject, detectVisaReject } = require('./workAuth');

// Deterministic pre-filter (spec 4.3) — runs before any AI call, for every user.
// Zero AI cost. Do not weaken any step. Pure function, reusable + unit-testable.

// Years-of-experience requirement (spec 4.3 step 2). The real bar is the
// LARGEST required number outside preferred/nice-to-have text: "3+ years of X;
// 2+ years of SQL" means 3. Ranges take their lower bound ("3-5 years" → 3),
// since the bottom of a range is what the posting will accept.
//
// Matches every common phrasing — "5+ years in", "at least 3 years of relevant
// experience", "Five years", "5 or more years", "5+ yrs", "years'" — not just
// "N years (of) experience", which missed most real postings.
//
// Excluded: numbers that aren't requirements ("founded 20 years ago", "over
// the past 5 years", "N-year contract"), numbers offered as a SUBSTITUTE for a
// degree the candidate already holds ("Bachelor's degree or 4 years of
// experience"), doctorate-track numbers, and anything marked preferred. When
// the posting states a master's alternative ("…or Master's + 3 years") and the
// candidate holds a master's, the master's number is the bar.
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 };
const NUM = `(\\d{1,2}(?:\\.\\d)?|${Object.keys(NUM_WORDS).join('|')})`;
const YEARS_RE = new RegExp(
  `\\b${NUM}\\s*(?:\\+|plus)?\\s*(?:(?:-|to|–|—)\\s*${NUM}\\s*\\+?\\s*)?(?:or more\\s+|or greater\\s+)?(?:years?|yrs?)(?:'|’)?(?=\\W|$)`,
  'gi'
);
const NOT_REQUIREMENT_BEFORE = /\b(over the (?:past|last|next)|in the (?:past|last|next)|within(?: the (?:first|next))?|after|every|for (?:over|more than|nearly|almost)|founded|established|history of|since|up to|age|aged|ages|minimum age|at least \d+ years of age)\s*$/i;
const NOT_REQUIREMENT_AFTER = /^\s*(?:ago|old|of age|of (?:history|innovation|service|growth|excellence|experience serving|leadership in)\b|in business|running|straight|warranty|contract|term|commitment|vesting|cliff|(?:bachelor'?s? |university |college )?degree|college|university|program\b|plan|planning|roadmap)\b/i;
// "preferably in engineering" qualifies the domain, not the number — excluded.
const PREFERRED_NEAR = /\b(preferred|ideally|nice to have|nice-to-have|a plus|is a plus|are a plus|bonus|desired|desirable)\b/i;
const PREFERRED_HEADING = /(preferred qualifications|preferred skills|preferred experience|nice[- ]to[- ]haves?|bonus points|pluses|preferred requirements|desired qualifications|additional qualifications)/i;
const REQUIRED_HEADING = /(basic qualifications|minimum qualifications|required qualifications|requirements|what you(?:'|’)?ll need|what you need|what we(?:'|’)?re looking for|who you are|you have|must[- ]haves?)/i;

// The degree named closest before the number, within the same clause, is the
// one it pairs with: "Bachelor's … with 10+ years; or Master's … with 7+ years".
const ANY_DEGREE_RE = /\b(bachelor'?s?|bachelor’s|ba\/bs|bs\/ba|associate'?s?|high school|ged|master'?s?|master’s|ms|m\.s\.|mba|graduate degree|advanced degree|ph\.?d|doctorate|doctoral)\b/gi;
// Paired means conjunctive ("Master's … and/with 3 years"); "MBA, or 2+ years
// of X" offers the years INSTEAD of the degree, so it is not a degree track.
// "or a related field" inside the degree's own description doesn't count.
function degreeBefore(before, want) {
  const clause = before.split(/[.;\n]/).pop();
  let last = null;
  let lastEnd = 0;
  let m;
  ANY_DEGREE_RE.lastIndex = 0;
  while ((m = ANY_DEGREE_RE.exec(clause)) !== null) { last = m[0]; lastEnd = m.index + m[0].length; }
  if (last == null || !want.test(last)) return false;
  const between = clause.slice(lastEnd).replace(/\bor (?:an? )?(?:related|equivalent|similar|relevant)\b(?: \w+)?/gi, '');
  return !/\bor\b/i.test(between);
}

function toNum(s) {
  if (s == null) return null;
  const k = String(s).toLowerCase();
  return NUM_WORDS[k] != null ? NUM_WORDS[k] : parseFloat(k);
}

// A heading is a heading only when it stands on its own line or ends in a
// colon — "Even if you do not meet all of the preferred qualifications…" in
// body text must not open a preferred section (live: that exact Amazon line
// swallowed a posting's whole basic-qualifications list).
const STRICT_REQUIRED_HEADING = /(basic qualifications|minimum qualifications|required qualifications|must[- ]haves?)/i;
function headingSpans(text) {
  const src = `(?:^|\\n)[ \\t]*[-•*#]*[ \\t]*(${PREFERRED_HEADING.source}|${REQUIRED_HEADING.source})[ \\t]*(?:\\([^)\\n]{0,40}\\))?[ \\t]*(?::|(?=\\n))`;
  const re = new RegExp(src, 'gi');
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const h = m[1];
    marks.push({ at: m.index, kind: PREFERRED_HEADING.test(h) ? 'preferred' : STRICT_REQUIRED_HEADING.test(h) ? 'basic' : 'required' });
  }
  const spans = marks.map((mk, i) => ({ kind: mk.kind, from: mk.at, to: i + 1 < marks.length ? marks[i + 1].at : text.length }));
  return spans;
}

function extractYearsRequired(text, { candidateHasMasters = false } = {}) {
  if (!text) return null;
  const t = String(text).replace(/[ \t ]+/g, ' ');
  const spans = headingSpans(t);
  const spanAt = (i) => spans.find((s) => i >= s.from && i < s.to) || null;
  // When the posting labels its minimum/basic qualifications explicitly, that
  // section IS the bar — numbers in the "about the role" prose don't count.
  const hasBasic = spans.some((s) => s.kind === 'basic');
  const inPreferred = (i) => {
    const s = spanAt(i);
    if (s && s.kind === 'preferred') return true;
    return hasBasic && (!s || s.kind !== 'basic');
  };
  const found = [];
  YEARS_RE.lastIndex = 0;
  let m;
  while ((m = YEARS_RE.exec(t)) !== null) {
    const n = toNum(m[1]);
    if (n == null || Number.isNaN(n) || n <= 0 || n > 25) continue;
    const before = t.slice(Math.max(0, m.index - 60), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 60);
    const wideBefore = t.slice(Math.max(0, m.index - 160), m.index);
    if (NOT_REQUIREMENT_BEFORE.test(before) || NOT_REQUIREMENT_AFTER.test(after)) continue;
    // Must read as an experience requirement somewhere nearby.
    const ctx = `${before} ${m[0]} ${after}`;
    if (!/\b(experience|exp\b|working|work|managing|leading|in (?:a|an|the)?\s*\w+|of \w+|as an? |with|background|track record|industry|professional|relevant|related|progressive|hands-on)/i.test(after) && !/\b(experience|minimum|at least|requires?|required)\b/i.test(before)) continue;
    const degreeSubstitute = /\b(degree|diploma|bachelor'?s?|ba\/bs|bs\/ba)\b[^.]{0,25}\b(or|in lieu)\s*(?:equivalent\s*)?$/i.test(before)
      || /^[^.]{0,40}\b(in lieu of (?:a )?degree|instead of a degree|equivalent to a degree)\b/i.test(after);
    found.push({
      n,
      // Same line/sentence only — a "Preferred Qualifications:" heading on
      // the NEXT line says nothing about this one.
      preferred: inPreferred(m.index) || PREFERRED_NEAR.test(after.split(/[.\n;]/)[0].slice(0, 40)),
      // "Master's + 3 years", "Master's degree and 3 years", "3 years with a Master's"
      masters: degreeBefore(wideBefore, /\b(master'?s?|master’s|ms|m\.s\.|mba|graduate degree|advanced degree)\b/i)
        || /^[^.\d]{0,40}\b(with|and|plus)\s+(an?\s+)?(master|mba|graduate degree|advanced degree)/i.test(after),
      phd: degreeBefore(wideBefore, /\b(ph\.?d|doctorate|doctoral)\b/i)
        || /^[^.\d]{0,40}\b(with|and|plus)\s+(an?\s+)?(ph\.?d|doctorate)/i.test(after),
      // Associate's / high-school tracks: a bar for a lower degree than any
      // candidate this app scores against holds.
      lowerDegree: degreeBefore(wideBefore, /\b(associate'?s?|high school|ged)\b/i),
      degreeSubstitute,
    });
  }
  const usable = found.filter((f) => !f.preferred && !f.phd && !f.lowerDegree && !f.degreeSubstitute);
  if (!usable.length) return null;
  if (candidateHasMasters) {
    const mastersAlt = usable.filter((f) => f.masters);
    if (mastersAlt.length) return Math.min(...mastersAlt.map((f) => f.n));
  }
  const nonMasters = usable.filter((f) => !f.masters);
  const pool = nonMasters.length ? nonMasters : usable;
  return Math.max(...pool.map((f) => f.n));
}

// Kept for older callers (scripts); same rule, no degree context.
function maxYearsRequired(text) {
  return extractYearsRequired(text);
}

function seniorRegex(terms) {
  const parts = terms.map((t) => {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return t === 'sr' ? 'sr\\.?' : esc;
  });
  return new RegExp(`\\b(${parts.join('|')})\\b`, 'i');
}

function isOffDomainTitle(title, offDomainTerms) {
  const t = (title || '').toLowerCase();
  return offDomainTerms.some((term) => t.includes(String(term).toLowerCase()));
}

// Moved onto the shared matcher (2026-08-13 root-cause pass) — this was the
// third byte-identical copy of the literal presence rule (alongside
// atsCheck.js's and calculateAtsScore.js's), the only one with no plural
// tolerance at all. `keywordHit` kept as a local name so every call site
// below is unchanged.
const keywordHit = matchesTerm;

function domainOverlap(text, keywords) {
  if (!text) return 0;
  const lc = text.toLowerCase();
  let n = 0;
  for (const kw of keywords) if (keywordHit(lc, kw)) n += 1;
  return n;
}

// US-only / citizenship-required signal (bug fix 2026-07-28) — distinct from
// workAuth.js's detectWorkAuthReject. That one is an explicit "we do not sponsor"
// statement and stays a hard pre-filter drop. This one is weaker: phrases like
// "U.S. Applicants Only" show up as the HEADER of a routine pay-transparency
// block on a huge share of ordinary US postings (confirmed live: a real Visa
// req had that exact phrase immediately followed by "The estimated salary
// range for this position is $146,200.00…", with zero actual sponsorship
// language anywhere in the JD) — dropping on it would silently lose legitimate
// jobs. So this is surfaced as a loud `visa: high` risk tag (scoreJob.js) for
// the user to judge, never used to drop a posting pre-filter-side.
function detectUsOnlySignal(text, usOnlyPhrases) {
  if (!text) return null;
  const phrases = usOnlyPhrases && usOnlyPhrases.length ? usOnlyPhrases : tunables.prefilter.usOnlyPhrases;
  const lc = text.toLowerCase();
  for (const phrase of phrases || []) {
    if (lc.includes(String(phrase).toLowerCase())) return phrase;
  }
  return null;
}

// Work-authorization restrictions (no sponsorship, citizen-only, ITAR "U.S.
// person", security clearance) live in workAuth.js — see its header.

/**
 * @param jobs            NormalizedJob[] (must carry dedupKey, title, descriptionText)
 * @param userProfile     { yearsOfExperience, domainKeywords[], offDomainTitleKeywords[] }
 * @param seenDedupKeys   Set of dedup keys already in jobs/applications for this user
 * @param visaFilterOn    boolean (scan config, default on)
 * @returns { survivors, dropped:[{job, reason}] }
 */
function prefilter({ jobs, userProfile = {}, seenDedupKeys = new Set(), visaFilterOn = true }) {
  const pf = tunables.prefilter;
  const yearsThreshold = tunables.yearsGapSeniorityStretchThreshold;
  const overlapThreshold = tunables.offDomainKeywordOverlapThreshold;
  const userYears = userProfile.yearsOfExperience ?? null;
  // No universal fallback list (spec 4.3, corrected 2026-08-05): a user with
  // no derived domain keywords gets Step 3 skipped entirely below, rather
  // than being judged against any single domain's terms.
  const domainKeywords = userProfile.domainKeywords && userProfile.domainKeywords.length
    ? userProfile.domainKeywords
    : null;
  const offDomainTerms = userProfile.offDomainTitleKeywords && userProfile.offDomainTitleKeywords.length
    ? userProfile.offDomainTitleKeywords
    : [];
  const seniorRe = seniorRegex(pf.seniorTitleTerms);

  const survivors = [];
  const dropped = [];
  const seenInBatch = new Set();

  for (const job of jobs) {
    const key = job.dedupKey;
    const desc = job.descriptionText || '';

    // Step 1 — dedup & basic filters
    if (seenInBatch.has(key)) {
      dropped.push({ job, reason: 'duplicate_in_batch' });
      continue;
    }
    seenInBatch.add(key);
    if (seenDedupKeys.has(key)) {
      dropped.push({ job, reason: 'already_seen' });
      continue;
    }
    if (visaFilterOn) {
      const auth = detectWorkAuthReject(`${job.title || ''}
${desc}`);
      if (auth) {
        dropped.push({ job, reason: `work_auth:${auth.category}: "${auth.match}"` });
        continue;
      }
    }

    // Step 2 — years-of-experience gap
    const jdYears = extractYearsRequired(`${job.title || ''}\n${desc}`, { candidateHasMasters: !!userProfile.hasGraduateDegree });
    if (jdYears != null && userYears != null && jdYears - userYears >= yearsThreshold) {
      dropped.push({ job, reason: `years_gap(${jdYears} vs ${userYears})` });
      continue;
    }

    // Step 3 — off-domain / seniority title with low domain overlap.
    // Skipped entirely when the user has no derived domain-keyword list (spec
    // 4.3, corrected 2026-08-05) — there is no universal fallback list, and
    // judging against one would make overlap always 0 and drop every
    // senior/off-titled job regardless of actual fit.
    if (domainKeywords) {
      const seniorOrOff = seniorRe.test(job.title || '') || isOffDomainTitle(job.title, offDomainTerms);
      if (seniorOrOff) {
        const overlap = domainOverlap(desc, domainKeywords);
        if (overlap < overlapThreshold) {
          dropped.push({ job, reason: `off_domain_low_overlap(${overlap})` });
          continue;
        }
      }
    }

    survivors.push(job);
  }

  return { survivors, dropped };
}

module.exports = { prefilter, maxYearsRequired, extractYearsRequired, domainOverlap, seniorRegex, isOffDomainTitle, detectUsOnlySignal, detectVisaReject, detectWorkAuthReject };

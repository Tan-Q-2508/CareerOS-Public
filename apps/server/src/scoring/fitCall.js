const { tunables } = require('@careeros/shared');
const aiRouter = require('../lib/aiRouter');
const { sponsorVintage, wageLevelSummary } = require('../visa/sponsorLookup');
const { ANCHORS } = require('./anchors');
const { postingLevelFact } = require('./postingLevel');

// Call 2 — strong tier (spec 5.6 "Call composition"): the judgment calls.
// Callback Odds + preference-fit adjustment + tiered keyword analysis (5.3) +
// risk tags (5.4) + the one short note (5.5). Overall Fit is NOT emitted here —
// it's computed in code from ats/callback/preference (5.1/16.4). Gemini's native
// thinking is the hidden scratchpad (5.6); no prompted scratchpad needed.

const RISK_TYPES = ['experience', 'seniority', 'technology', 'domain', 'visa', 'requirements'];
const SEVERITIES = ['high', 'medium', 'low', 'none'];
const HARD_REQ_KINDS = ['degree', 'language', 'people_management', 'license_cert', 'enrollment', 'clearance', 'other'];
const HARD_REQ_STATUSES = ['met', 'unmet', 'unclear'];

// Callback odds is a RUBRIC, not one free-form number (5.1/5.6): the model
// scores five fixed sub-criteria against written anchors, code bounds
// seniority_fit by the precomputed years gap, and callback_odds is their
// weighted mean (tunables.scoring.callbackRubric). One holistic 0-10 drifted —
// the same 5+-year posting against a ~4-year candidate came back 8.0 on one job
// and 6.1 on the next, and a posting's explicit years bar could be outweighed
// by a strong keyword read.
//
// candidate_standing is where the applicant pool lives. Without it a candidate
// who clears every listed bar scored 10 at a highly selective program exactly
// as at a mid-market company — a real Meta rotational-PM posting came back
// callback 10.0 for a ~2-year APM.
const RUBRIC_KEYS = ['seniority_fit', 'skills_evidence', 'candidate_standing', 'domain_fit', 'authorization_fit'];

const FIT_SCHEMA = {
  type: 'object',
  properties: {
    callback_rubric: {
      type: 'object',
      properties: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, { type: 'number' }])),
      required: RUBRIC_KEYS,
    },
    hard_requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirement: { type: 'string' },
          kind: { type: 'string', enum: HARD_REQ_KINDS },
          quote: { type: 'string' },
          status: { type: 'string', enum: HARD_REQ_STATUSES },
        },
        required: ['requirement', 'kind', 'quote', 'status'],
      },
    },
    preference_fit: { type: 'number' },
    critical_missing: { type: 'array', items: { type: 'string' } },
    important_missing: { type: 'array', items: { type: 'string' } },
    nice_to_have_missing: { type: 'array', items: { type: 'string' } },
    already_demonstrated: { type: 'array', items: { type: 'string' } },
    transferable: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          have: { type: 'string' },
          reword_to: { type: 'string' },
          bullet_id: { type: 'string' },
        },
        required: ['have', 'reword_to', 'bullet_id'],
      },
    },
    hidden_strengths: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          skill: { type: 'string' },
          bullet_id: { type: 'string' },
          implied_by: { type: 'string' },
        },
        required: ['skill', 'bullet_id'],
      },
    },
    risk_tags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: RISK_TYPES },
          severity: { type: 'string', enum: SEVERITIES },
          reason: { type: 'string' },
        },
        required: ['type', 'severity', 'reason'],
      },
    },
    note: { type: 'string' },
  },
  required: [
    'callback_rubric',
    'hard_requirements',
    'preference_fit',
    'critical_missing',
    'important_missing',
    'nice_to_have_missing',
    'already_demonstrated',
    'transferable',
    'hidden_strengths',
    'risk_tags',
    'note',
  ],
};

function anchorsText() {
  const lines = ['CALIBRATION EXAMPLES (synthetic, not yet validated — for scoring scale only):'];
  for (const a of ANCHORS) {
    lines.push(
      `- Example [${a.label}]: JD="${a.jd}" | Résumé="${a.resumeSketch}" => ats_match=${a.scores.ats_match}, callback_rubric=${JSON.stringify(a.scores.callback_rubric)}, hard_requirements=${JSON.stringify(a.scores.hard_requirements || [])}, preference_fit=${a.scores.preference_fit}. Note: ${a.scores.note}`
    );
  }
  return lines.join('\n');
}

const SYSTEM_INSTRUCTION = [
  'You are the fit-judgment stage of a résumé/job scoring system. The mechanical ATS Match and the structured JD profile were already produced upstream — do not recompute ATS Match.',
  'Produce, as strict JSON matching the schema:',
  'You judge as the recruiter or hiring manager screening this application would: the full posting text is given, read its actual must-have qualifications, not only the extracted profile. Be calibrated, not encouraging — most applications to most postings do not get a call back, and a score of 8+ means this candidate would plausibly be in the short pile.',
  '- callback_rubric: how likely a human recruiter is to call this candidate back, scored as FIVE separate 0-10 sub-scores against these fixed anchors (callback odds is computed from them in code — do not output an overall number). Score each strictly by its anchor, independently of the others:',
  '    seniority_fit — years and level. Weigh FUNCTION-RELEVANT years: when the posting asks for "N years of product management" (or of any named function), count only the roles in the precomputed role list that are that function or directly adjacent to it — a business-analyst or supply-chain role is not product-management years; internships are already half-weighted. 10: relevant years meet the bar and the title level matches the candidate\'s last title. 7: under 1 year short. 5: 1-2 years short, or the role is one level above the candidate\'s last title (e.g. "Product Manager II"/"PM III" for an Associate PM). 3: 2+ years short, or the role is a Senior/Staff/Principal/Lead title for an early-career candidate. 0: executive role for a junior candidate. Level cuts both ways: 5 also when the role is clearly BELOW the candidate\'s level — an assistant, administrative or clerical support role for someone with professional experience — because overqualified applicants are usually screened out too. Never use your own count of total years — the precomputed total is fact; the relevant-years judgment can only lower this score.',
  '    skills_evidence — are the posting\'s must-have qualifications demonstrated in specific résumé bullets? A skill counts only when a bullet shows it being done; a job title shows only the function itself (a "Product Manager" title shows product management, NOT user research, business development, consulting, or any other sub-skill). 10: every must-have is demonstrated in a bullet. 7: most are, one real gap. 5: about half. 3: few. 0: none.',
  '    candidate_standing — how this résumé ranks in the applicant pool this posting realistically draws. 10: would be near the top of the pile (directly relevant titled experience at the stated level, standout outcomes). 7: a solid, clearly-qualified applicant. 5: a typical applicant — meets the basics, nothing that stands out. 3: below the typical applicant, e.g. an early-career profile applying to a highly selective employer or program (large-tech/frontier-AI PM roles, rotational/APM programs, roles that draw thousands of applicants). A structured graduate, rotational, development or leadership program at a large employer is a selective, high-volume pool — never above 4, however well the candidate matches its content. 1: well below the pool. Judge the pool from the posting and employer, not from the candidate\'s wishes.',
  '    domain_fit — function and industry. 10: same function and same industry. 7: same function, adjacent industry. 5: transferable function. 3: different function. 0: unrelated field.',
  '    authorization_fit — the candidate needs visa sponsorship. 10: the posting offers sponsorship, or is silent and the employer has a real H-1B filing record that includes entry/mid-level (Level I-II) roles. 7: the posting is silent and the filing record is unknown or concentrated at Level III-IV. 4: the posting carries US-only boilerplate (e.g. "U.S. Applicants Only" above a pay range). 0: the posting explicitly refuses sponsorship or requires citizenship/clearance.',
  '  Posting age and salary do not get their own sub-score; let a stale (45+ day) posting pull skills_evidence\'s confidence down by at most 1 point, never more.',
  '- hard_requirements: every MUST-HAVE knockout criterion the posting states that is not a years count or a skill — a specific degree ("MBA required", "PhD in X", a degree when a bachelor\'s is explicitly insufficient), a spoken language ("Fluent in Mandarin"), people management ("2+ years managing a team of direct reports"), a license or certification, current enrollment ("must be a current student", "graduating in 2027"), a security clearance, or another explicit must-have credential. Exclude anything under preferred/nice-to-have/bonus wording, and exclude "Bachelor\'s degree or equivalent" (the candidate holds a bachelor\'s and a master\'s). For each: `quote` is the posting\'s exact words, copied verbatim (it is checked against the posting text and dropped if not found); `status` is "met" if the résumé shows it, "unmet" if the résumé clearly does not (e.g. MBA required and the candidate\'s master\'s is an MS), "unclear" otherwise. People management means managing direct reports — leading a cross-functional team, an intern project, or a student team is NOT people management. When the posting states a people-management bar alongside a total years bar ("7+ years, including 2+ managing people"), the management years sit inside the total, not on top of it, but the candidate must meet each bar. Return an empty array when the posting has none.',
  '- preference_fit (0-10): LOCATION alignment only for now — how well the job location matches the location the candidate searched. A job location that is CONTAINED WITHIN the searched location counts as full alignment (score 9-10), not a partial one: e.g. searched "USA" and job is "San Jose, CA" is a full match, not a partial one just because the job is more specific than the search; searched "California" and job is "San Jose, CA" is likewise full alignment. Only score lower when the job location is genuinely outside the searched area, or unrelated. Remote/salary preferences are not collected yet; do not invent them. Neutral (~6) when location is unclear.',
  '- Tiered keyword analysis (5.3): critical_missing (genuinely disqualifying gaps), important_missing (should-have, not disqualifying), nice_to_have_missing (bonus), already_demonstrated (skills genuinely present in the résumé matching the JD).',
  '- already_demonstrated ALSO covers the function named by a role the candidate held: a role titled "Associate Product Manager" demonstrates "Product Management" even if no bullet says those words. It covers the FUNCTION ONLY — never the sub-skills a person in that role might have done (user research, market analysis, business development, consulting, people management). Those need a bullet that shows them; otherwise they are missing.',
  '- transferable: skills the candidate has under DIFFERENT terminology that a recruiter would accept as the same thing (e.g. "Tool X" -> "Tool Y", "supplier coordination" -> "vendor management"). Give the actual rewording. Never a stretch: tracking a KPI dashboard is not "demand planning"; building a side project is not "management consulting".',
  '- hidden_strengths: skills implied by a specific bullet that never appear as a named skill (e.g. "built dashboards" implies data visualization).',
  'GROUNDING (hard rule): every transferable and every hidden_strength MUST cite the exact bullet_id (e.g. "r0b2" or "p1b0") it is inferred from, drawn from the résumé profile provided. Never assert a skill is present without a real bullet_id backing it. If you cannot cite a real bullet, do not include the item.',
  'Never fabricate experience to close a gap: a gap closable by rewording gets the rewording; a gap the candidate genuinely lacks is stated plainly as missing.',
  '- risk_tags: one entry per checked risk with a severity (high/medium/low/none) and a one-line reason. Check every time: experience (years required vs held, and function-relevant years), seniority (does JD language imply a more senior role?), technology (a specific required tool the candidate lacks even if they have a similar one), domain (industry adjacency), visa (flag high if the JD explicitly states no sponsorship, OR states/implies a US-only requirement — "U.S. Applicants Only", citizenship required, work authorization required without sponsorship; note that a "U.S. Applicants Only" heading sitting directly above a salary-range/pay-transparency disclosure is common US-posting boilerplate, not itself a sponsorship statement, but still flag it — the candidate should judge for themselves, this pipeline never drops a job over it).',
  '- note: ONE short italic-worthy sentence (two at most) — the plain-language core fit rationale, not a restatement of the tags.',
  "Precomputed facts are given to you (years required, candidate years and how they break down, the years gap, domain-keyword overlap count, and where available the employer's real U.S. DOL/OFLC H-1B filing history) — treat them as ground truth, do not re-derive them from the JD or the résumé. In the note, when you mention the candidate's experience, use ONLY the precomputed candidate years figure, written plainly (\"4.2 years\", never \"4.2 precomputed years\") — never a number you counted yourself (internships are already half-weighted; degree time is not work experience and is not counted).",
  'On sponsorship specifically: where a filing record is given, weigh it in callback_odds as fact, including its prevailing-wage level mix (an employer that sponsors mostly Level III-IV roles is a weaker prospect for an early-career candidate than its raw filing count implies). Where the facts say NO MATCHING RECORD FOUND, treat sponsorship as UNKNOWN — never as evidence the employer does not sponsor, and never let it lower callback_odds on its own. The visa RISK TAG is a separate judgment about what THIS POSTING says, and is unaffected by the employer-level filing record either way.',
  anchorsText(),
].join('\n');

// Valid bullet ids in the parsed résumé profile (5.6 grounding target).
function bulletIdSet(profile) {
  const ids = new Set();
  (profile.roles || []).forEach((role, i) => {
    (role.bullets || []).forEach((b, j) => ids.add(b.id || `r${i}b${j}`));
  });
  (profile.projects || []).forEach((proj, i) => {
    (proj.bullets || []).forEach((b, j) => ids.add(b.id || `p${i}b${j}`));
  });
  return ids;
}

// The same ids as bulletIdSet(), but kept grouped by the entry they belong to
// instead of flattened into one set. A flat set can only answer "is this id
// real anywhere in the profile", which lets a bullet cite a REAL id belonging
// to a different role and pass unnoticed — the exact gap fillPass.js's
// computeSparePool() calls out and refuses to propagate. Derivation of a
// missing id is identical to bulletIdSet()'s on purpose: the two must agree,
// so the rule lives in one file.
function bulletIdsByEntry(profile) {
  const roles = new Map();
  const projects = new Map();
  (profile.roles || []).forEach((role, i) => {
    roles.set(i, new Set((role.bullets || []).map((b, j) => b.id || `r${i}b${j}`)));
  });
  (profile.projects || []).forEach((proj, i) => {
    projects.set(i, new Set((proj.bullets || []).map((b, j) => b.id || `p${i}b${j}`)));
  });
  return { roles, projects };
}

// Full résumé profile as a stable prefix block (identical across the batch, so
// it implicit-caches). Full bullets + ids are needed here for grounding.
function buildResumeProfileBlock(profile) {
  return `CANDIDATE RÉSUMÉ PROFILE (fixed context for this scan batch; cite bullet_id values from here):\n${JSON.stringify(profile)}`;
}

function makeValidateFit(validIds) {
  return function validateFit(p) {
    if (!p || typeof p !== 'object') return 'root is not an object';
    if (typeof p.preference_fit !== 'number' || p.preference_fit < 0 || p.preference_fit > 10) {
      return 'preference_fit must be a number in [0,10]';
    }
    if (!p.callback_rubric || typeof p.callback_rubric !== 'object') return 'callback_rubric must be an object';
    for (const key of RUBRIC_KEYS) {
      const v = p.callback_rubric[key];
      if (typeof v !== 'number' || v < 0 || v > 10) return `callback_rubric.${key} must be a number in [0,10]`;
    }
    for (const key of [
      'critical_missing',
      'important_missing',
      'nice_to_have_missing',
      'already_demonstrated',
      'transferable',
      'hidden_strengths',
      'risk_tags',
    ]) {
      if (!Array.isArray(p[key])) return `${key} must be an array`;
    }
    if (typeof p.note !== 'string') return 'note must be a string';
    // Grounding enforcement (5.6): cited bullet ids must exist in the résumé.
    for (const [i, t] of p.transferable.entries()) {
      if (!t || typeof t.bullet_id !== 'string') return `transferable[${i}].bullet_id must be a string`;
      if (!validIds.has(t.bullet_id)) {
        return `transferable[${i}].bullet_id "${t.bullet_id}" is not a real résumé bullet id — cite an existing bullet or drop the item`;
      }
    }
    for (const [i, h] of p.hidden_strengths.entries()) {
      if (!h || typeof h.bullet_id !== 'string') return `hidden_strengths[${i}].bullet_id must be a string`;
      if (!validIds.has(h.bullet_id)) {
        return `hidden_strengths[${i}].bullet_id "${h.bullet_id}" is not a real résumé bullet id — cite an existing bullet or drop the item`;
      }
    }
    if (!Array.isArray(p.hard_requirements)) return 'hard_requirements must be an array';
    for (const [i, h] of p.hard_requirements.entries()) {
      if (!h || typeof h.quote !== 'string') return `hard_requirements[${i}].quote must be a string`;
      if (!HARD_REQ_STATUSES.includes(h.status)) return `hard_requirements[${i}].status invalid`;
    }
    for (const [i, r] of p.risk_tags.entries()) {
      if (!RISK_TYPES.includes(r.type)) return `risk_tags[${i}].type invalid`;
      if (!SEVERITIES.includes(r.severity)) return `risk_tags[${i}].severity invalid`;
    }
    return null;
  };
}

/**
 * Run call 2. Returns { fit, usage, costUsd, model, connectionMode } where `fit`
 * is the validated parsed object (callback_odds, preference_fit, tiered arrays,
 * risk_tags, note). Throws on validation failure after retry (16.8).
 */
// 19.4's grounded sponsorship fact, in the same PRECOMPUTED FACTS slot
// jdYears/userYears/domainOverlap already occupy. Real U.S. DOL/OFLC H-1B
// filing records, resolved once per employer per scan by visa/sponsorLookup.js
// — this replaces an unguarded AI guess with ground truth feeding the SAME
// existing callback_odds judgment. No new AI call, no new schema field.
//
// The null branch is the important one and is stated as a fact rather than left
// to inference: absence of a filing is not evidence of refusal, and large
// employers routinely file under subsidiary legal names that never match their
// job-board name (19.2). Reading a null as "does not sponsor" would be worse
// than the guess this replaces.
function sponsorFacts(sponsor) {
  if (!sponsor) {
    return [
      'H-1B sponsorship filing record (precomputed, U.S. DOL/OFLC): NO MATCHING RECORD FOUND. ' +
        'This means only that no filing was matched to this employer name — it is NOT evidence that ' +
        'the employer does not sponsor, and must not be weighed as if it were. Treat sponsorship as ' +
        'unknown for this employer and judge callback odds on the other evidence.',
    ];
  }
  // The count is a COMPANY-WIDE total across the employer's filing entities
  // (19.2), so the prompt says so rather than letting the model read it as one
  // legal entity's volume and quietly discount it against a name it recognises.
  const entities = Number(sponsor.entity_count) > 1 ? Number(sponsor.entity_count) : 1;
  const parts = [
    `H-1B sponsorship filing record (precomputed, U.S. DOL/OFLC certified LCA filings, ${sponsorVintage(sponsor)}):`,
    entities > 1
      ? `  Filed as: ${(sponsor.entity_names || [sponsor.employer_name_display]).join('; ')}`
      : `  Filed as: ${sponsor.employer_name_display}`,
    entities > 1
      ? `  Certified H-1B filings: ${sponsor.filing_count_last_fy} (company-wide total across ${entities} filing entities)`
      : `  Certified H-1B filings: ${sponsor.filing_count_last_fy}`,
  ];
  const levels = wageLevelSummary(sponsor);
  if (levels) {
    parts.push(
      `  Prevailing-wage level mix: ${levels} (OES levels I-IV; I is entry-level, IV is expert — a ` +
        'filing history concentrated at III-IV means this employer sponsors mostly senior roles, which ' +
        'is a weaker signal for an early-career candidate than the raw count suggests)'
    );
  }
  if (sponsor.avg_wage) parts.push(`  Average annualized filed wage: $${Number(sponsor.avg_wage).toLocaleString('en-US')}`);
  if (sponsor.top_job_titles && sponsor.top_job_titles.length) {
    parts.push(`  Most-filed job titles: ${sponsor.top_job_titles.join('; ')}`);
  }
  parts.push(
    '  This is a real filing history, not an inference. It describes the EMPLOYER, not this posting — ' +
      "a posting's own explicit no-sponsorship language still overrides it."
  );
  return parts;
}

// A hard requirement only stands when its quote is really in the posting —
// the cap it triggers (scoreJob.applyScoreCaps) must never rest on words the
// model paraphrased or invented. Whitespace/case/quote-style insensitive.
const normQuote = (s) => String(s || '')
  .toLowerCase()
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();
function verifyHardRequirements(items, postingText) {
  const hay = normQuote(postingText);
  if (!hay) return [];
  return (items || []).filter((h) => {
    const q = normQuote(h && h.quote);
    return q.length >= 4 && hay.includes(q);
  });
}

// The posting as the judge reads it. Long postings keep their head (title,
// summary) and the qualifications block; boilerplate after it is what gets cut.
const POSTING_CHARS = 9000;
function postingForJudge(text) {
  const t = String(text || '');
  if (t.length <= POSTING_CHARS) return t;
  const q = t.search(/(minimum qualifications|basic qualifications|required qualifications|qualifications|requirements|what we(?:'|’)?re looking for|what you(?:'|’)?ll need|you have|about you|who you are)/i);
  if (q < 0 || q < 3000) return t.slice(0, POSTING_CHARS);
  return `${t.slice(0, 3000)}\n[…]\n${t.slice(q, q + POSTING_CHARS - 3000)}`;
}

// Years gap → the highest seniority_fit the rubric may hold (the anchors in
// SYSTEM_INSTRUCTION, enforced in code so a model that reads "5+ years" against
// a 4-year candidate as a 9 can't carry that into callback_odds).
function seniorityCeiling(gap) {
  if (gap == null || gap <= 0) return 10;
  const t = tunables.scoring.callbackRubric.seniorityCeilingByGap;
  if (gap < 1) return t.under1;
  if (gap < 2) return t.under2;
  return t.twoPlus;
}

// callback_odds = weighted mean of the bounded rubric (weights in tunables),
// then GATED: a recruiter's screen is a gate, not an average. A candidate the
// seniority read puts two levels or two years short is screened out however
// strong the sponsor record and domain are — as a plain mean, an authorization
// 10 and a domain 7 lifted real Senior-PM screen-outs to a 4.5 callback. So a
// low seniority_fit caps the callback just above itself
// (tunables.scoring.callbackRubric.seniorityGate), and an unmet hard
// requirement caps it at `hardRequirementCallbackMax`.
//
// A posting's level (postingLevel.js) bounds the sub-score the judge has been
// measured to misread for it (`postingLevel` in tunables): a support role holds
// seniority_fit to 5 (overqualified — the seniority gate then applies), and a
// structured early-career program holds candidate_standing to 4 and gates the
// callback at `callbackMax`, since averaged, a standing of 4 beside a 10 domain
// and sponsor record still read as 8.7 (a GSK graduate program scored 9.5).
// A general low-standing gate was tried and dropped: it pulled a Google PM role
// the recruiter gold set places at 6.5-8 down to 6.0.
function callbackFromRubric(rubric, gap, { unmetHardRequirement = false, postingLevel = null } = {}) {
  const cfg = tunables.scoring.callbackRubric;
  const w = cfg.weights;
  const bounded = { ...rubric, seniority_fit: Math.min(rubric.seniority_fit, seniorityCeiling(gap)) };
  const { callbackMax: levelCallbackMax, ...levelCaps } = (postingLevel && cfg.postingLevel && cfg.postingLevel[postingLevel]) || {};
  for (const [k, max] of Object.entries(levelCaps)) {
    if (bounded[k] != null) bounded[k] = Math.min(bounded[k], max);
  }
  let sum = 0;
  let wsum = 0;
  for (const k of RUBRIC_KEYS) {
    sum += w[k] * bounded[k];
    wsum += w[k];
  }
  let callback = sum / wsum;
  const gate = cfg.seniorityGate;
  if (gate && bounded.seniority_fit <= gate.appliesAtOrBelow) {
    callback = Math.min(callback, bounded.seniority_fit + gate.headroom);
  }
  if (levelCallbackMax != null) callback = Math.min(callback, levelCallbackMax);
  if (unmetHardRequirement && cfg.hardRequirementCallbackMax != null) {
    callback = Math.min(callback, cfg.hardRequirementCallbackMax);
  }
  return { callbackOdds: Math.round(callback * 10) / 10, rubric: bounded };
}

function fmtYears(n) {
  return n == null ? null : String(Math.round(n * 10) / 10);
}

async function runFit({ resumeProfileBlock, resumeProfile, jdProfile, postingText = '', atsMatch, precomputed, jobMeta, scanLocation, credential }) {
  const gap = precomputed.jdYears != null && precomputed.userYears != null
    ? Math.round((precomputed.jdYears - precomputed.userYears) * 10) / 10
    : null;
  const b = precomputed.yearsBreakdown;
  const facts = [
    `Years required by JD (precomputed): ${precomputed.jdYears ?? 'not stated'}`,
    `Candidate years of experience (precomputed): ${fmtYears(precomputed.userYears) ?? 'unknown'}` +
      (b ? ` (= ${fmtYears(b.fullTime)} full-time + ${fmtYears(b.internship)} internship credit at half weight; degree time not counted)` : ''),
    ...(b && Array.isArray(b.roles) && b.roles.length
      ? ['Candidate roles (precomputed — weigh function-relevant years from these):',
        ...b.roles.map((r) => `  - ${r.title}${r.company ? ` @ ${r.company}` : ''}: ${r.months} months, ${r.kind === 'internship' ? 'internship (half weight)' : 'full-time'}`)]
      : []),
    `Years gap (required minus held, precomputed): ${gap == null ? 'n/a' : gap > 0 ? `${gap} short` : 'meets the bar'}`,
    `Domain-keyword overlap count (precomputed): ${precomputed.domainOverlap ?? 0}`,
    `ATS Match already computed upstream: ${atsMatch}`,
    `Candidate searched location: ${scanLocation || 'not specified'}`,
    `Job location: ${jobMeta.location || 'not specified'}`,
    `Job posted at: ${jobMeta.postedAt || 'unknown'}`,
    `Job salary range: ${jobMeta.salaryMin ?? '?'} - ${jobMeta.salaryMax ?? '?'}`,
    `Job seniority level: ${jobMeta.seniorityLevel || 'unknown'}`,
    `Employer: ${jobMeta.companyName || 'unknown'}`,
    ...(postingLevelFact(precomputed.postingLevel) ? [postingLevelFact(precomputed.postingLevel)] : []),
    ...sponsorFacts(precomputed.sponsor),
  ].join('\n');
  const prompt = [
    resumeProfileBlock,
    '\n---\n',
    'STRUCTURED JD PROFILE (from upstream extraction):',
    JSON.stringify(jdProfile),
    '\n---\n',
    'PRECOMPUTED FACTS (ground truth — do not re-derive):',
    facts,
    '\n---\n',
    'THE POSTING (read its must-have qualifications yourself; quote hard_requirements from here verbatim):',
    postingForJudge(postingText) || '(posting text unavailable — judge from the structured profile)',
  ].join('\n');

  const result = await aiRouter.structuredCall(credential, {
    tier: 'strong',
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt,
    responseSchema: FIT_SCHEMA,
    validate: makeValidateFit(bulletIdSet(resumeProfile)),
    timeoutMs: tunables.scoring.callTimeoutMs,
  });
  const hardRequirements = verifyHardRequirements(result.parsed.hard_requirements, postingText);
  const { callbackOdds, rubric } = callbackFromRubric(result.parsed.callback_rubric, gap, {
    unmetHardRequirement: hardRequirements.some((h) => h.status === 'unmet'),
    postingLevel: precomputed.postingLevel,
  });
  return {
    fit: { ...result.parsed, callback_rubric: rubric, callback_odds: callbackOdds, hard_requirements: hardRequirements },
    usage: result.usage,
    costUsd: result.costUsd,
    model: result.model,
    connectionMode: result.connectionMode,
    tier: 'strong',
  };
}

module.exports = {
  runFit,
  buildResumeProfileBlock,
  bulletIdSet,
  bulletIdsByEntry,
  makeValidateFit,
  callbackFromRubric,
  seniorityCeiling,
  verifyHardRequirements,
  postingForJudge,
  RUBRIC_KEYS,
  FIT_SCHEMA,
  // exported for testing — the null branch carries 19.4's non-negotiable
  // "absence of a filing is not evidence of refusal" instruction, which is a
  // never-fabricate guardrail and should fail loudly if it is ever trimmed.
  sponsorFacts,
};

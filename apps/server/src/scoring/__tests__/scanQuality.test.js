#!/usr/bin/env node
// scanQuality.test.js — scan-quality and recruiter-calibration rules (spec 4.3,
// 5.1, 5.2, 5.6, 7.12): candidate years as a recruiter counts them, the
// callback rubric, the deterministic score caps (years, visa, hard
// requirements), and the one keyword state the card, the gap check and the
// stored coverage all read.
//
// Plain Node + assert, like every suite here:
//   node apps/server/src/scoring/__tests__/scanQuality.test.js

const assert = require('assert');
const { tunables, sanitizeJdProfile, isJdKeyword } = require('@careeros/shared');
const { experienceBreakdown, hasGraduateDegree } = require('../../resume/deriveProfile');
const { callbackFromRubric, seniorityCeiling, verifyHardRequirements, postingForJudge, RUBRIC_KEYS } = require('../fitCall');
const { applyScoreCaps, computeOverallFit } = require('../scoreJob');
const { computeKeywordState } = require('../../generation/keywordState');
const { generationGaps } = require('../../generation/generationGaps');
const { patchFor } = require('../../generation/refreshKeywordCoverage');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

const NOW = new Date('2026-09-22T12:00:00Z');

// Placeholder profile with the same SHAPE as a real early-career history:
// an internship, a full-time role, a master's with internships inside it,
// then a current full-time role.
const profile = {
  roles: [
    { title: 'Operations Intern', company: 'Company A', dates: { start: '2022-02', end: '2022-07' } },
    { title: 'Associate Product Manager', company: 'Company B', dates: { start: '2022-11', end: '2024-07' } },
    { title: 'Project Manager Intern', company: 'Company C', dates: { start: '2025-01', end: '2025-09' } },
    { title: 'Technical Program Manager Intern', company: 'Company D', dates: { start: '2025-06', end: '2025-12' } },
    { title: 'Business Analyst', company: 'Company E', dates: { start: '2026-05', end: 'present' } },
  ],
  education: [
    { degree: 'Master of Science', field: 'Engineering Management', dates: { start: '2024-08', end: '2026-05' } },
    { degree: 'B. Tech', field: 'Mechanical Engineering', dates: { start: '2018-07', end: '2022-07' } },
  ],
};

console.log('candidate years:');
check('full-time counts 1.0, internships 0.5, degree time 0, overlapping months once', () => {
  const b = experienceBreakdown(profile, NOW);
  // Full-time: 21 (B) + 5 (E, May-Sep 2026) = 26 months = 2.2 yr.
  // Internships: 6 (A) + 12 (C ∪ D, Jan-Dec 2025) = 18 months × 0.5 = 0.8 yr.
  assert.strictEqual(b.fullTime, 2.2);
  assert.strictEqual(b.internship, 0.8);
  assert.strictEqual(b.masters, 0);
  assert.strictEqual(b.total, 2.9);
});
check('a master\'s adds nothing — internships inside it still count at half weight', () => {
  const noInterns = { ...profile, roles: profile.roles.filter((r) => !/Company [CD]/.test(r.company)) };
  assert.ok(experienceBreakdown(noInterns, NOW).total < experienceBreakdown(profile, NOW).total);
});
check('a degree alone earns no experience credit', () => {
  const msOnly = { roles: [], education: [{ degree: 'Master of Science', dates: { start: '2020-01', end: '2024-12' } }] };
  assert.strictEqual(experienceBreakdown(msOnly, NOW), null);
  assert.strictEqual(experienceBreakdown({ roles: [], education: [profile.education[1]] }, NOW), null);
});
check('the breakdown lists each role for the judge\'s function-relevant years', () => {
  const b = experienceBreakdown(profile, NOW);
  assert.strictEqual(b.roles.length, 5);
  const apm = b.roles.find((r) => r.title === 'Associate Product Manager');
  assert.deepStrictEqual({ months: apm.months, kind: apm.kind }, { months: 21, kind: 'fullTime' });
  assert.strictEqual(b.roles.find((r) => r.company === 'Company A').kind, 'internship');
});
check('hasGraduateDegree', () => {
  assert.strictEqual(hasGraduateDegree(profile), true);
  assert.strictEqual(hasGraduateDegree({ education: [profile.education[1]] }), false);
});

console.log('\ncallback rubric:');
check('the rubric has five keys and its weights cover all of them', () => {
  assert.deepStrictEqual(Object.keys(tunables.scoring.callbackRubric.weights).sort(), [...RUBRIC_KEYS].sort());
});
check('seniority ceiling follows the years gap', () => {
  assert.strictEqual(seniorityCeiling(null), 10);
  assert.strictEqual(seniorityCeiling(0), 10);
  assert.strictEqual(seniorityCeiling(0.8), 7);
  assert.strictEqual(seniorityCeiling(1.5), 5);
  assert.strictEqual(seniorityCeiling(3), 3);
});
check('a model that ignores a years gap cannot carry a 9 into callback odds', () => {
  const rubric = { seniority_fit: 9, skills_evidence: 9, candidate_standing: 8, domain_fit: 9, authorization_fit: 7 };
  const clean = callbackFromRubric(rubric, null).callbackOdds;
  const gapped = callbackFromRubric(rubric, 1.5);
  assert.strictEqual(gapped.rubric.seniority_fit, 5);
  assert.ok(gapped.callbackOdds < clean);
});
check('a low standing in a selective pool pulls a clean sweep well below 10', () => {
  const r = callbackFromRubric({ seniority_fit: 10, skills_evidence: 10, candidate_standing: 3, domain_fit: 10, authorization_fit: 10 }, 0);
  assert.ok(r.callbackOdds <= 8.6, `callback ${r.callbackOdds}`);
});

check('a seniority screen-out gates callback, however strong authorization and domain are', () => {
  const r = callbackFromRubric({ seniority_fit: 3, skills_evidence: 6, candidate_standing: 4, domain_fit: 8, authorization_fit: 10 }, 2);
  assert.strictEqual(r.callbackOdds, 3.5);
});
check('posting level bounds the rubric: a program caps standing and callback, a support role caps seniority', () => {
  const sweep = { seniority_fit: 10, skills_evidence: 10, candidate_standing: 10, domain_fit: 10, authorization_fit: 7 };
  const program = callbackFromRubric(sweep, null, { postingLevel: 'program' });
  assert.strictEqual(program.rubric.candidate_standing, 4);
  assert.strictEqual(program.callbackOdds, 5);
  const support = callbackFromRubric(sweep, null, { postingLevel: 'support' });
  assert.strictEqual(support.rubric.seniority_fit, 5);
  assert.strictEqual(support.callbackOdds, 5.5);
  assert.ok(callbackFromRubric(sweep, null, { postingLevel: null }).callbackOdds > 9);
});
check('posting level: support roles and structured programs, never internships or new-grad roles', () => {
  const { postingLevel } = require('../postingLevel');
  const cases = {
    'Project Assistant': 'support',
    'Project Assistant - National Building Group': 'support',
    'Administrative Coordinator': 'support',
    'Executive Assistant to the CEO': 'support',
    'Assistant Project Manager': null,
    'Assistant Director, Operations': null,
    'Rotational Development Program': 'program',
    'Smart Manufacturing & CI Graduate Program, Zebulon, US, 2027': 'program',
    'Product Manager, Rotational Product Manager Program': 'program',
    'Associate Program Analyst (New Grad)': null,
    'Haptics Engineering Program Manager': null,
    'Population Health Project Intern': null,
    'Technical Program Manager': null,
  };
  for (const [title, want] of Object.entries(cases)) assert.strictEqual(postingLevel({ title }), want, title);
  const gskBody = "Our Graduate Programs are designed to accelerate the development of graduates who don't have significant previous professional work experience.";
  assert.strictEqual(postingLevel({ title: 'Manufacturing Operations Associate', text: gskBody }), 'program');
});
check('an unmet hard requirement gates callback at 3', () => {
  const rubric = { seniority_fit: 9, skills_evidence: 8, candidate_standing: 6, domain_fit: 9, authorization_fit: 10 };
  assert.strictEqual(callbackFromRubric(rubric, 0, { unmetHardRequirement: true }).callbackOdds, 3);
  assert.ok(callbackFromRubric(rubric, 0).callbackOdds > 7);
});

console.log('\noverall fit:');
check('weights are 35 ATS / 55 callback / 10 location and sum to 1', () => {
  const w = tunables.overallFitWeights;
  assert.deepStrictEqual([w.atsMatch, w.callbackOdds, w.preferenceFit], [0.35, 0.55, 0.1]);
  assert.strictEqual(computeOverallFit(10, 10, 10), 10);
});
check('a perfect location no longer lifts a weak callback into REVIEW', () => {
  // ATS 8, callback 4, location 10 → 2.8 + 2.2 + 1.0 = 6.0 (was 7.2 at 40/40/20).
  assert.strictEqual(computeOverallFit(8, 4, 10), 6);
});

console.log('\nscore caps:');
check('a years gap under 1 caps at 7.9 and tags experience', () => {
  const r = applyScoreCaps({ overall: 8.9, jdYears: 3, userYears: 2.4, riskTags: [], note: 'Strong match.' });
  assert.strictEqual(r.overall, 7.9);
  assert.ok(r.note.includes('Score capped at 7.9'));
  assert.ok(r.riskTags.some((t) => t.type === 'experience' && t.severity === 'medium'));
});
check('a years gap of 1-2 caps at 6.9', () => {
  const r = applyScoreCaps({ overall: 8.4, jdYears: 4, userYears: 2.9, riskTags: [], note: '' });
  assert.strictEqual(r.overall, 6.9);
});
check('a 2+ year gap caps at 6.4', () => {
  assert.strictEqual(applyScoreCaps({ overall: 8.1, jdYears: 5, userYears: 2.9, riskTags: [], note: '' }).overall, 6.4);
});
check('meeting the bar leaves the score alone', () => {
  const r = applyScoreCaps({ overall: 8.9, jdYears: 2, userYears: 2.9, riskTags: [], note: 'x' });
  assert.strictEqual(r.overall, 8.9);
  assert.strictEqual(r.note, 'x');
});
check('a high visa tag caps at 7.9', () => {
  const r = applyScoreCaps({ overall: 9.1, jdYears: null, userYears: 2.9, riskTags: [{ type: 'visa', severity: 'high', reason: 'x' }], note: '' });
  assert.strictEqual(r.overall, 7.9);
});
check('an unmet hard requirement caps at 6.4, quotes it, and tags requirements', () => {
  const r = applyScoreCaps({
    overall: 9.5,
    jdYears: null,
    userYears: 2.9,
    riskTags: [],
    note: 'Good match.',
    hardRequirements: [{ requirement: 'MBA', kind: 'degree', quote: 'MBA required from top-tier universities', status: 'unmet' }],
  });
  assert.strictEqual(r.overall, 6.4);
  assert.ok(r.note.includes('MBA required from top-tier universities'));
  assert.ok(r.riskTags.some((t) => t.type === 'requirements' && t.severity === 'high'));
});
check('met and unclear hard requirements never cap', () => {
  const r = applyScoreCaps({
    overall: 8.5,
    jdYears: null,
    userYears: 2.9,
    riskTags: [],
    note: '',
    hardRequirements: [
      { quote: 'Fluent in English', status: 'met' },
      { quote: 'Experience managing a team', status: 'unclear' },
    ],
  });
  assert.strictEqual(r.overall, 8.5);
});
check('a hard requirement survives only when its quote is really in the posting', () => {
  const posting = 'Qualifications\n- MBA  required from top-tier universities\n- Fluent in Mandarin Chinese and English.';
  const kept = verifyHardRequirements(
    [
      { quote: 'MBA required from top-tier universities', status: 'unmet' },
      { quote: 'Fluent in Mandarin Chinese', status: 'unmet' },
      { quote: 'Must hold a PhD', status: 'unmet' },
      { quote: 'MBA', status: 'unmet' },
    ],
    posting
  );
  assert.deepStrictEqual(kept.map((h) => h.quote), ['MBA required from top-tier universities', 'Fluent in Mandarin Chinese']);
});
check('a long posting keeps its head and its qualifications block', () => {
  const text = `${'About us. '.repeat(600)}\nMinimum qualifications:\n- MBA required\n${'Benefits. '.repeat(900)}`;
  const out = postingForJudge(text);
  assert.ok(out.length <= 9100);
  assert.ok(out.includes('MBA required'));
  assert.ok(out.startsWith('About us.'));
});

console.log('\nJD keyword quality:');
check('generic words, experience filler and languages are not JD keywords', () => {
  for (const t of ['building', 'planning', 'travel', 'Chat', 'Messaging', 'technology experience', 'Mandarin Chinese', 'English', 'Fluent in Mandarin']) {
    assert.strictEqual(isJdKeyword(t), false, t);
  }
  for (const t of ['SQL', 'AI', 'Product Management', 'Tableau', 'Demand Planning']) assert.strictEqual(isJdKeyword(t), true, t);
});
check('an alternatives list is one requirement, and its members never double-count', () => {
  const text = '5+ years of product or program management, product marketing, business development or technology experience. SQL.';
  const jd = sanitizeJdProfile(
    {
      required_skills: ['SQL', 'business development'],
      nice_to_have_skills: [],
      any_of_groups: [['product management', 'program management', 'product marketing', 'business development', 'technology experience']],
    },
    text
  );
  assert.deepStrictEqual(jd.required_skills, ['SQL']);
  assert.deepStrictEqual(jd.any_of_groups, [['product management', 'program management', 'product marketing', 'business development']]);
  assert.deepStrictEqual(sanitizeJdProfile(jd, text), jd); // idempotent
});

console.log('\nkeyword state — one source for the card and the gap check:');
const job = {
  title: 'Program Manager',
  description_text:
    'Qualifications: SQL, Tableau, JIRA, stakeholder management, Six Sigma, and supplier negotiation. Nice to have: Python.',
  jd_profile: {
    required_skills: ['SQL', 'Tableau', 'JIRA', 'Stakeholder management', 'Six Sigma', 'Supplier negotiation'],
    nice_to_have_skills: ['Python'],
  },
  already_demonstrated: ['Six Sigma'],
  transferable: [{ have: 'managed partner relationships', reword_to: 'Stakeholder management', bullet_id: 'r0b0' }],
  hidden_strengths: [],
};
const candidate = { skills_declared: ['SQL', 'JIRA'], roles: [], education: [] };
check('gaps.length === total − matched; a bullet-cited reword counts, an uncited "demonstrated" does not', () => {
  const s = computeKeywordState({ job, profile: candidate, confirmedSkills: [] });
  assert.strictEqual(s.total, 7);
  assert.strictEqual(s.matched, 3); // SQL, JIRA present; stakeholder management via the cited reword
  assert.ok(s.missing.includes('Six Sigma'));
  assert.strictEqual(s.gaps.length, s.total - s.matched);
});
check('a held role title covers its function, not its sub-skills', () => {
  const pmJob = {
    title: 'Product Manager',
    description_text: 'Product management and user research experience required.',
    jd_profile: { required_skills: ['Product management', 'User research'], nice_to_have_skills: [] },
  };
  const s = computeKeywordState({ job: pmJob, profile: { roles: [{ title: 'Associate Product Manager', bullets: [] }] }, confirmedSkills: [] });
  assert.deepStrictEqual(s.missing, ['User research']);
});
check('an alternatives group is matched once, by any member', () => {
  const grpJob = {
    title: 'Senior PM',
    description_text: '5+ years of product or program management, product marketing, business development or technology experience. SQL.',
    jd_profile: { required_skills: ['SQL'], nice_to_have_skills: [], any_of_groups: [['product management', 'program management', 'business development']] },
  };
  const s = computeKeywordState({ job: grpJob, profile: { skills_declared: ['SQL'], roles: [{ title: 'Program Manager Intern', bullets: [] }] }, confirmedSkills: [] });
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.matched, 2);
});
check('a confirmed skill relevant to THIS job counts as held; an unrelated one does not', () => {
  const s = computeKeywordState({ job, profile: candidate, confirmedSkills: [{ skill_term: 'Tableau' }, { skill_term: 'FloQast' }] });
  assert.strictEqual(s.matched, 4);
  assert.ok(!s.missing.includes('Tableau'));
  assert.strictEqual(s.gaps.length, s.total - s.matched);
});
check('the gap check reports exactly the card\'s fraction', () => {
  const confirmed = [{ skill_term: 'Tableau' }];
  const s = computeKeywordState({ job, profile: candidate, confirmedSkills: confirmed });
  const g = generationGaps({ job, profile: candidate, confirmedSkills: confirmed });
  assert.strictEqual(g.matched, s.matched);
  assert.strictEqual(g.total, s.total);
  assert.deepStrictEqual(g.gaps.map((x) => x.skill), s.missing);
});
check('refresh moves overall by the ATS weight × ΔATS and respects a stored cap', () => {
  const s = computeKeywordState({ job, profile: candidate, confirmedSkills: [] });
  const stored = { ...job, id: 'j', ats_match: 10, overall_fit: 7.9, keyword_coverage: { matched: 2, total: 2 }, note: 'x (Score capped at 7.9: …)' };
  const patch = patchFor(stored, candidate, []);
  assert.strictEqual(patch.ats_match, s.score);
  assert.deepStrictEqual({ m: patch.keyword_coverage.matched, t: patch.keyword_coverage.total }, { m: s.matched, t: s.total });
  assert.ok(patch.overall_fit <= 7.9);
});
check('refresh is a no-op when nothing changed', () => {
  const s = computeKeywordState({ job, profile: candidate, confirmedSkills: [] });
  const stored = { ...job, ats_match: s.score, overall_fit: 7, keyword_coverage: { matched: s.matched, total: s.total } };
  assert.strictEqual(patchFor(stored, candidate, []), null);
});

// §15 #63 keyword audit: true equivalents count as held; paraphrases do not.
console.log('\nkeyword equivalents:');
check('equivalents credit PowerBI, artificial intelligence, a held suite and a higher belt', () => {
  const eqJob = {
    title: 'Operations Graduate Program',
    description_text:
      'Use PowerBI and artificial intelligence daily. Tools: Google Workspace, Microsoft Word. ' +
      'Lean Six Sigma Green Belt preferred. Strong cross-functional collaboration.',
    jd_profile: {
      required_skills: ['PowerBI', 'artificial intelligence', 'Google Workspace', 'Microsoft Word', 'cross-functional collaboration'],
      nice_to_have_skills: ['Lean Six Sigma Green Belt'],
      any_of_groups: [],
    },
  };
  const eqProfile = {
    skills_declared: ['Power BI', 'AI Agents', 'Lean Six Sigma Black Belt'],
    roles: [{ title: 'Analyst', bullets: [{ text: 'Led cross-functional coordination across four teams.' }] }],
  };
  const s = computeKeywordState({ job: eqJob, profile: eqProfile, confirmedSkills: [{ skill_term: 'G Suite' }, { skill_term: 'Microsoft Office' }] });
  const status = Object.fromEntries(s.terms.map((t) => [t.skill, t.status]));
  assert.strictEqual(status.PowerBI, 'present');
  assert.strictEqual(status['artificial intelligence'], 'present');
  assert.strictEqual(status['Google Workspace'], 'confirmed', 'confirmed G Suite is scoped in and credits it');
  assert.strictEqual(status['Microsoft Word'], 'confirmed');
  assert.strictEqual(status['Lean Six Sigma Green Belt'], 'present');
  assert.strictEqual(status['cross-functional collaboration'], 'missing', 'coordination is not collaboration');
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) console.error('\nSome checks FAILED.');
else console.log('All checks passed.');

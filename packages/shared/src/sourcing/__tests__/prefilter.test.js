#!/usr/bin/env node
// prefilter.test.js — regression suite for detectVisaReject (bug fix
// 2026-08-15). Root cause: the old visaRejectPhrases list was a plain
// exact-substring match, and missed any real-world phrasing with a
// qualifier interposed between the negation and "sponsor" — confirmed live
// on a U-Haul JD reading "not eligible for EMPLOYER sponsorship", which
// matched none of 21 literal phrases because of that one extra word. This
// file exists so the next tunables/regex tweak doesn't silently reopen that
// gap, and so the regex doesn't drift the other way into false positives
// (a match here is a hard pre-filter DROP — it silently discards a job).
//
// No test framework in this repo (no jest/mocha) — plain Node + assert,
// runnable directly:
//   node packages/shared/src/sourcing/__tests__/prefilter.test.js
// Exits non-zero on any failure.

const assert = require('assert');
const { detectVisaReject, prefilter } = require('../prefilter');

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

console.log('detectVisaReject — should match (real sponsorship-refusal phrasing):');

// The exact live bug: a qualifier ("employer") between the negation and
// "sponsorship" that defeated every literal phrase in the old list.
check('U-Haul JD: "not eligible for employer sponsorship"', () => {
  const text = 'This position is not eligible for employer sponsorship.';
  assert.ok(detectVisaReject(text), 'expected a match, got null');
});

check('qualifier variant: "not eligible for work visa sponsorship"', () => {
  assert.ok(detectVisaReject('Candidates are not eligible for work visa sponsorship at this time.'));
});

check('qualifier variant: "does not provide immigration sponsorship"', () => {
  assert.ok(detectVisaReject('The company does not provide immigration sponsorship for this role.'));
});

check('qualifier variant: "will not sponsor H-1B visas"', () => {
  assert.ok(detectVisaReject('We will not sponsor H-1B visas for this position.'));
});

// All 21 originally-literal phrases, still expected to match.
const originalPhrases = [
  'no visa sponsorship', 'not able to sponsor', 'unable to sponsor',
  'cannot sponsor', 'do not sponsor', 'does not sponsor',
  'no sponsorship', 'must be authorized without sponsorship',
  'without the need for sponsorship', 'not provide sponsorship',
  'ineligible for visa sponsorship', 'ineligible for sponsorship',
  'not eligible for visa sponsorship', 'not eligible for sponsorship',
  'not require sponsorship', 'will not require sponsorship',
  'will not sponsor', 'not sponsor employment visas',
  'sponsorship is not available', 'sponsorship will not be provided',
  'no longer sponsor',
];
for (const phrase of originalPhrases) {
  check(`legacy phrase still matches: "${phrase}"`, () => {
    assert.ok(detectVisaReject(`Some JD text. ${phrase}. More text.`), `"${phrase}" did not match`);
  });
}

console.log('\ndetectVisaReject — should NOT match (affirmative / unrelated):');

check('affirmative: "sponsorship is available for qualified candidates"', () => {
  assert.strictEqual(detectVisaReject('We offer visa sponsorship. Sponsorship is available for qualified candidates.'), null);
});

check('affirmative: "we sponsor H-1B visas"', () => {
  assert.strictEqual(detectVisaReject('We sponsor H-1B visas and provide relocation assistance.'), null);
});

check('unrelated text with no sponsorship mention at all', () => {
  assert.strictEqual(detectVisaReject('This role requires 5 years of experience with React and Node.'), null);
});

check('null/empty text', () => {
  assert.strictEqual(detectVisaReject(''), null);
  assert.strictEqual(detectVisaReject(null), null);
});

console.log('\nprefilter() — visaFilterOn integration:');

check('drops a job whose JD has the U-Haul-style phrasing when visaFilterOn is true', () => {
  const jobs = [{ dedupKey: 'k1', title: 'Business Analyst', descriptionText: 'This position is not eligible for employer sponsorship.' }];
  const { survivors, dropped } = prefilter({ jobs, visaFilterOn: true });
  assert.strictEqual(survivors.length, 0);
  assert.strictEqual(dropped.length, 1);
  assert.ok(dropped[0].reason.startsWith('work_auth:no_sponsorship'));
});

check('keeps the same job when visaFilterOn is false', () => {
  const jobs = [{ dedupKey: 'k2', title: 'Business Analyst', descriptionText: 'This position is not eligible for employer sponsorship.' }];
  const { survivors } = prefilter({ jobs, visaFilterOn: false });
  assert.strictEqual(survivors.length, 1);
});

// ---- detectWorkAuthReject (2026-09-22) — every positive below is a real
// sentence from a job that reached AI scoring (and scored 7-9.3) before this
// detector existed; every negative is real boilerplate that must NOT drop. ----
const { detectWorkAuthReject, extractYearsRequired } = require('../prefilter');

console.log('\ndetectWorkAuthReject — real restrictions that must drop:');
const authPositives = [
  ['no_sponsorship', 'Centene', 'Must be authorized to work in the U.S. without the need for employment-based visa sponsorship now or in the future.'],
  ['no_sponsorship', 'Centene 2', 'Sponsorship and future sponsorship are not available for this opportunity, including employment-based visa types H-1B, L-1, O-1, H-1B1, F-1, J -1, OPT, or CPT.'],
  ['no_sponsorship', 'Addepar', 'Applicants must be legally authorized to work in the United States for any employer without requiring current or future visa sponsorship (for example, employment-based visas such as H-1B, F-1/OPT, or similar).'],
  ['no_sponsorship', 'Beghou', 'We are currently unable to consider candidates who require, or will require in the future, sponsorship for work authorization.'],
  ['no_sponsorship', 'C3 AI', 'Candidates must be authorized to work in the United States without the need for current or future company sponsorship.'],
  ['no_sponsorship', 'Entegris', 'Entegris does not provide immigration-related sponsorship for this role.'],
  ['no_sponsorship', 'McKesson', 'Relocation and visa sponsorship are not available.'],
  ['no_sponsorship', 'Medtronic', 'Roles below the principal level require candidates to possess unrestricted US work authorization at the time of hire and for the duration of employment.'],
  ['no_sponsorship', 'Medline', '- Unrestricted permanent US work authorization'],
  ['no_sponsorship', 'Roblox', 'For US based roles only, please note the company may not be able to employ candidates for this role who have United States work authorization related to certain US visa categories, or support future H1B sponsorship at this time.'],
  ['no_sponsorship', 'curly apostrophe', 'We don’t sponsor visas for this position.'],
  ['no_sponsorship', 'hyphenated H-1B', 'This role is not eligible for H-1B sponsorship.'],
  ['no_sponsorship', 'colon form', 'Visa sponsorship: No'],
  ['no_sponsorship', 'Alto/FuzeRx any employer', 'Employment Authorization Requirement: Applicants must be authorized to work for any employer in the U.S.'],
  ['citizen_only', 'Amazon Export Control', 'Export Control Requirement: Due to applicable export control laws and regulations, candidates must be a U.S. citizen or national, U.S. permanent resident (i.e., current Green Card holder), or lawfully admitted into the U.S. as a refugee or granted asylum.'],
  ['citizen_only', 'Leidos', '- US Citizenship required'],
  ['citizen_only', 'Guidehouse', '- US citizenship or green card status is required'],
  ['citizen_only', 'Marvell', 'Applicants must be U.S. citizens, lawful permanent residents, or protected individuals as defined by 8 U.S.C. 1324b(a)(3).'],
  ['citizen_only', 'refugee list', 'This position is open to U.S. citizens, permanent residents, refugees and asylees only.'],
  ['us_person_export', 'Woodward', 'Applicants must be U.S. persons within the meaning of the ITAR.'],
  ['us_person_export', 'Moog', '- Requires access to US export controlled information'],
  ['clearance', 'PingWind', 'Required Clearance: TS/SCI'],
  ['clearance', 'Guidehouse Secret', '- An ACTIVE and MAINTAINED "SECRET" Federal or DoD security clearance'],
  ['clearance', 'Palantir', '- Ability and willingness to obtain a US security clearance at the Secret designation or above'],
];
for (const [category, name, text] of authPositives) {
  check(`${category}: ${name}`, () => {
    const hit = detectWorkAuthReject(text);
    assert.ok(hit, `expected a ${category} match, got null`);
    assert.strictEqual(hit.category, category);
  });
}

console.log('\ndetectWorkAuthReject — boilerplate that must NOT drop:');
const authNegatives = [
  ['EEO citizenship status', 'All qualified applicants will receive consideration for employment without regard to age, ancestry, citizenship, color, family or medical care leave, gender identity or expression, genetic information, immigration status.'],
  ['E-Verify', 'Xometry participates in E-Verify and after a job offer is accepted, will provide the federal government with your Form I-9 information to confirm that you are authorized to work in the U.S.'],
  ['authorized to work alone', 'WellSky: U.S.-based positions must be legally authorized to work in the United States.'],
  ['executive sponsors', 'Manage the escalation process for at-risk engagements, coordinating between delivery teams, account leads, and executive sponsors.'],
  ['no ... executive sponsors', 'This is not a remote role; you will partner with executive sponsors weekly.'],
  ['company-sponsored events', 'We offer flexible time off, wellness resources, and company-sponsored team events.'],
  ['affinity groups', 'Our employee-led and company-sponsored affinity groups promote inclusion.'],
  ['clearance as pay factor', 'Compensation decisions depend on a wide range of factors, including but not limited to skill sets, experience and training, security clearances, licensure and certifications.'],
  ['route-and-clearance', '- Support route-and-clearance processes and records management'],
  ['sponsorship not guaranteed', 'Sponsorship for this role is not guaranteed.'],
  ['sponsorship offered', 'While Etsy supports visa sponsorship, sponsorship opportunities may be limited to certain roles and skills.'],
  ['otherwise authorized', 'Candidates must be a U.S. citizen, permanent resident, or otherwise authorized to work in the U.S.'],
  ['ads sponsorships', 'Our technology powers ads and sponsorships across several Apple services.'],
  ['any employer, no requirement', 'Our alumni have gone on to be authorized to work for any employer they choose.'],
];
for (const [name, text] of authNegatives) {
  check(`not a restriction: ${name}`, () => {
    assert.strictEqual(detectWorkAuthReject(text), null);
  });
}

console.log('\nextractYearsRequired:');
const yearsCases = [
  ['bullet list', '- 3+ years of program or project management experience\n- 3+ years of defining process improvements', {}, 3],
  ['largest required bar wins', '- 5+ years of program management experience\n- 2+ years of SQL', {}, 5],
  ['range takes lower bound', '3-5 years of experience in operations', {}, 3],
  ['number words', 'Five years of experience managing programs', {}, 5],
  ['"or more"', '5 or more years of relevant experience', {}, 5],
  ['"in" phrasing', '5+ years in supply chain operations', {}, 5],
  ['at least', 'At least 3 years of relevant professional experience', {}, 3],
  ['preferred section ignored', 'Basic Qualifications:\n- 3+ years of experience\nPreferred Qualifications:\n- 7+ years of experience', {}, 3],
  ['inline preferred ignored', '- 3+ years of experience\n- 8+ years of experience preferred', {}, 3],
  ['not a requirement: company age', 'Founded 20 years ago. 4+ years of operations experience.', {}, 4],
  ['not a requirement: "4 year degree"', '2+ years of relevant experience. 4 year Degree in CS or equivalent.', {}, 2],
  ['degree substitute ignored', "Bachelor's degree or 4 years of equivalent experience. 2+ years of SQL.", {}, 2],
  ['master track used when held', "Bachelor's degree with 10+ years of relevant experience; or Master's degree with 7+ years of experience", { candidateHasMasters: true }, 7],
  ['bachelor track when no master', "Bachelor's degree with 10+ years of relevant experience; or Master's degree with 7+ years of experience", {}, 10],
  ['Amgen tracks, master', "Master's degree and 2 years of relevant experience OR Bachelor's degree and 4 years of relevant experience OR Associate's degree and 8 years of relevant experience", { candidateHasMasters: true }, 2],
  ['Amgen tracks, bachelor', "Master's degree and 2 years of relevant experience OR Bachelor's degree and 4 years of relevant experience OR Associate's degree and 8 years of relevant experience", {}, 4],
  ['"MBA, or N years" is not a master track', '- 7+ years of TPM experience\n- MBA, or 2+ years of working with Data & AI technologies', { candidateHasMasters: true }, 7],
  ['nothing stated', 'Join our team to build great products.', {}, null],
];
for (const [name, text, opts, expected] of yearsCases) {
  check(`years: ${name}`, () => {
    assert.strictEqual(extractYearsRequired(text, opts), expected);
  });
}

check('prefilter drops a 2+ year gap and keeps a smaller one', () => {
  const jobs = [
    { dedupKey: 'y1', title: 'Program Manager', descriptionText: '- 7+ years of program management experience' },
    { dedupKey: 'y2', title: 'Program Manager', descriptionText: '- 5+ years of program management experience' },
  ];
  const { survivors, dropped } = prefilter({ jobs, userProfile: { yearsOfExperience: 4.2 }, visaFilterOn: true });
  assert.deepStrictEqual(survivors.map((j) => j.dedupKey), ['y2']);
  assert.ok(dropped[0].reason.startsWith('years_gap(7 vs 4.2)'));
});

check('prefilter drops a citizen-only job with the category in the reason', () => {
  const jobs = [{ dedupKey: 'c1', title: 'TPM', descriptionText: 'Candidates must be a U.S. citizen or national.' }];
  const { dropped } = prefilter({ jobs, visaFilterOn: true });
  assert.ok(dropped[0].reason.startsWith('work_auth:citizen_only'));
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('\nSome checks FAILED.');
} else {
  console.log('All checks passed.');
}

#!/usr/bin/env node
// keywordPipeline.test.js — regression suite for the keyword pipeline
// (2026-08-13 root-cause pass). One fixture per historical failure this
// exact class of bug has produced (changelog: 2026-07-26 through
// 2026-08-14, six-plus rounds of one-consumer-at-a-time patches). The
// point of this file existing is that the NEXT prompt tweak or matcher
// change gets caught here before it silently re-breaks a fix that already
// shipped once.
//
// No test framework in this repo (no jest/mocha anywhere) — plain Node +
// assert, runnable directly:
//   node packages/shared/src/ats/__tests__/keywordPipeline.test.js
// Exits non-zero on any failure, so it's CI-usable as-is if a runner is
// ever added.

const path = require('path');
const assert = require('assert');
const { calculateKeywordMatch } = require('../calculateAtsScore');
const {
  matchesTerm,
  isConfirmableSkill,
  sanitizeJdProfile,
  groundResumeProfile,
  jdGroundingText,
  buildJdIndex,
  isGrounded,
} = require('../keywordPipeline');
// Cross-package require, same precedent as scripts/backfill-keyword-coverage.js
// (which already reaches into apps/server/src/generation/atsCheck.js from
// outside packages/shared): profileSkillText is the résumé-side haystack
// builder these fixtures need to cover, and it isn't part of this package —
// it lives alongside the rest of the résumé/generation logic on purpose
// (it also needs vouchedSkills/atsCheck's other primitives it's coupled
// to). This is a local dev-only test script, not a published boundary, so
// the direction is safe here even though packages/shared doesn't otherwise
// depend on apps/server.
const { profileSkillText } = require(path.join(__dirname, '..', '..', '..', '..', '..', 'apps', 'server', 'src', 'generation', 'atsCheck'));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.message}`);
  }
}

console.log('keywordPipeline regression suite\n');

// ---------------------------------------------------------------------
// 1. Degree-clause fragment — changelog 2026-08-14 #1: "related field"
// surfaced as a required skill. The whole clause must yield nothing.
// ---------------------------------------------------------------------
test('degree clause with fallback yields no skill at all', () => {
  const jd = "Bachelor's degree in Engineering or a related field required.";
  const out = sanitizeJdProfile(
    { required_skills: ["Bachelor's degree in Engineering or a related field"], nice_to_have_skills: [] },
    jd
  );
  assert.deepStrictEqual(out.required_skills, []);
});

// ---------------------------------------------------------------------
// 2. Umbrella category with named examples — changelog 2026-08-14
// structural follow-up: "operational tools" swallowed Notion/Linear/Excel.
// Named items must replace the umbrella, not sit alongside it.
// ---------------------------------------------------------------------
test('umbrella category with named examples expands to the named items only', () => {
  const jd = 'Familiarity with operational tools such as Notion, Linear, Excel is a plus.';
  const out = sanitizeJdProfile({ required_skills: ['operational tools'], nice_to_have_skills: [] }, jd);
  assert.deepStrictEqual(out.required_skills.sort(), ['Excel', 'Linear', 'Notion'].sort());
});

// ---------------------------------------------------------------------
// 3. Mid-sentence lead-in — changelog 2026-08-12 B1: LEAD_IN_PATTERNS was
// ^-anchored only, so "BI tools such as Power BI, Tableau" survived whole.
// ---------------------------------------------------------------------
test('mid-sentence "such as" lead-in still yields the named tools', () => {
  const jd = 'BI tools such as Power BI, Tableau required.';
  const out = sanitizeJdProfile({ required_skills: ['BI tools such as Power BI, Tableau'], nice_to_have_skills: [] }, jd);
  assert.ok(out.required_skills.includes('Power BI'), `expected Power BI in ${JSON.stringify(out.required_skills)}`);
  assert.ok(out.required_skills.includes('Tableau'), `expected Tableau in ${JSON.stringify(out.required_skills)}`);
  // Never a mangled fragment like "Power BI required" or "BI tools such as Power BI".
  assert.ok(!out.required_skills.some((s) => /required|such as/i.test(s)), `junk fragment leaked: ${JSON.stringify(out.required_skills)}`);
});

// ---------------------------------------------------------------------
// 4. Recall guard — changelog 2026-08-14 recall follow-up: a same-day
// prompt over-correction suppressed real, explicitly-stated requirements
// (a live Palantir TPM JD). Grounding must not be mistaken for a reason to
// under-extract — this fixture checks the GROUNDING pass itself doesn't
// drop legitimately-stated process/collaboration skills.
// ---------------------------------------------------------------------
test('recall guard: explicitly-named process/collaboration skills survive grounding', () => {
  const jd = [
    'We need 2+ years of project/program management experience.',
    'Enhance cross-team collaboration across engineering and design.',
  ].join(' ');
  const out = sanitizeJdProfile(
    { required_skills: ['Project Management', 'Program Management', 'Cross-Team Collaboration'], nice_to_have_skills: [] },
    jd
  );
  assert.strictEqual(out.required_skills.length, 3, `expected all 3 to survive, got ${JSON.stringify(out.required_skills)}`);
});

// ---------------------------------------------------------------------
// 5. Bare years-of-experience phrase is never a skill.
// ---------------------------------------------------------------------
test('bare years-of-experience phrase yields no skill', () => {
  const jd = '3+ years of experience required.';
  const out = sanitizeJdProfile({ required_skills: ['3+ years of experience'], nice_to_have_skills: [] }, jd);
  assert.deepStrictEqual(out.required_skills, []);
});

// ---------------------------------------------------------------------
// 6. "go" must never match "django" — changelog 2026-08-12 B4: bare
// substring .includes() let "go" match inside "django" at the confirm-once
// gate. The shared matcher must never do a bare unanchored substring check
// for a plain single word.
// ---------------------------------------------------------------------
test('single-word term does not false-match as a substring of an unrelated word', () => {
  assert.strictEqual(matchesTerm('experienced with django framework', 'go'), false);
});

// ---------------------------------------------------------------------
// 7. A full requirement sentence copied verbatim as a "skill" must never
// survive whole into the stored list — atomized or dropped, never intact.
// ---------------------------------------------------------------------
test('a full requirement sentence is never stored whole as a single skill', () => {
  const jd = 'Product management, software engineering, or data science experience required.';
  const out = sanitizeJdProfile(
    { required_skills: ['Product management, software engineering, or data science experience'], nice_to_have_skills: [] },
    jd
  );
  const wholeSentenceSurvived = out.required_skills.some(
    (s) => s.toLowerCase() === 'product management, software engineering, or data science experience'
  );
  assert.strictEqual(wholeSentenceSurvived, false, `whole sentence leaked through: ${JSON.stringify(out.required_skills)}`);
});

// ---------------------------------------------------------------------
// 8. Every atom produced by sanitizeJdProfile must be literally grounded
// in the JD text — the actual structural fix (atomization runs BEFORE
// grounding used to mean an atom the splitter invented was never
// re-checked). This is a property test over several representative JDs.
// ---------------------------------------------------------------------
test('every atom sanitizeJdProfile emits is literally grounded in the JD text', () => {
  const cases = [
    {
      jd: 'Familiarity with operational tools such as Notion, Linear, Excel is a plus. BI tools such as Power BI, Tableau required.',
      required: ['operational tools', 'BI tools such as Power BI, Tableau'],
    },
    {
      jd: "Bachelor's degree in Engineering or a related field. 3+ years of experience with SQL required.",
      required: ["Bachelor's degree in Engineering or a related field", '3+ years of experience', 'SQL'],
    },
  ];
  const { buildJdIndex, isGrounded } = require('../keywordPipeline');
  for (const c of cases) {
    const out = sanitizeJdProfile({ required_skills: c.required, nice_to_have_skills: [] }, c.jd);
    const idx = buildJdIndex(c.jd);
    for (const term of out.required_skills) {
      assert.ok(isGrounded(term, idx), `atom "${term}" is not grounded in: ${c.jd}`);
    }
  }
});

// ---------------------------------------------------------------------
// 9. Idempotence — sanitizeJdProfile must be a true fixed point, since it
// runs at write AND every read boundary. Regression case: the mid-qualifier
// splitter exposes "BI tools" as a fresh standalone atom that, on a SECOND
// pass, looks like raw input eligible for named-example expansion — without
// re-expansion this atom survives pass 1 and vanishes on pass 2.
// ---------------------------------------------------------------------
test('sanitizeJdProfile is idempotent, including the umbrella-exposed-by-atomization case', () => {
  const jd = 'BI tools such as Power BI, Tableau required.';
  const out1 = sanitizeJdProfile({ required_skills: ['BI tools such as Power BI, Tableau'], nice_to_have_skills: [] }, jd);
  const out2 = sanitizeJdProfile(out1, jd);
  const out3 = sanitizeJdProfile(out2, jd);
  assert.deepStrictEqual(out1, out2, `pass 1 -> pass 2 changed: ${JSON.stringify(out1)} vs ${JSON.stringify(out2)}`);
  assert.deepStrictEqual(out2, out3, `pass 2 -> pass 3 changed: ${JSON.stringify(out2)} vs ${JSON.stringify(out3)}`);
});

test('sanitizeJdProfile is idempotent across a broader set of realistic JDs', () => {
  const jds = [
    'Familiarity with operational tools such as Notion, Linear, Excel is a plus.',
    "Bachelor's degree in Engineering or a related field. 3+ years of experience with SQL required.",
    'Strong communication skills and attention to detail required. Experience with React Native and CI/CD pipelines.',
  ];
  const rawSkillSets = [
    ['operational tools', 'excellent communication skills'],
    ["Bachelor's degree in Engineering or a related field", '3+ years of experience', 'SQL'],
    ['communication skills', 'React Native', 'CI/CD'],
  ];
  jds.forEach((jd, i) => {
    const out1 = sanitizeJdProfile({ required_skills: rawSkillSets[i], nice_to_have_skills: [] }, jd);
    const out2 = sanitizeJdProfile(out1, jd);
    assert.deepStrictEqual(out1, out2, `not idempotent for JD #${i}: ${JSON.stringify(out1)} vs ${JSON.stringify(out2)}`);
  });
});

// ---------------------------------------------------------------------
// 10. Résumé-side grounding (groundResumeProfile) — parseResume.js had NO
// grounding at all before this pass. A hallucinated skill (not present
// anywhere in the résumé text) must be dropped; a genuine one must survive.
// ---------------------------------------------------------------------
test('groundResumeProfile drops a hallucinated skill and keeps a genuine one', () => {
  const resumeText = 'Jane Doe. Built dashboards using Python and SQL at Acme Corp.';
  const profile = {
    skills_declared: ['Python', 'SQL', 'Quantum Computing'],
    certifications: [],
    roles: [{ title: 'Engineer', bullets: [{ text: 'Built dashboards using Python and SQL', skills_demonstrated: ['Python', 'SQL', 'Blockchain'] }] }],
    projects: [],
  };
  const out = groundResumeProfile(profile, resumeText);
  assert.ok(out.skills_declared.includes('Python'));
  assert.ok(out.skills_declared.includes('SQL'));
  assert.ok(!out.skills_declared.includes('Quantum Computing'), 'hallucinated skill survived grounding');
  assert.ok(!out.roles[0].bullets[0].skills_demonstrated.includes('Blockchain'), 'hallucinated bullet skill survived grounding');
});

// ---------------------------------------------------------------------
// 11. Soft traits and credentials are never confirmable, on either side of
// the pipeline (JD or résumé) — the single shared filter.
// ---------------------------------------------------------------------
test('isConfirmableSkill rejects soft traits, credentials, and years-only phrases', () => {
  assert.strictEqual(isConfirmableSkill('Excellent communication skills'), false);
  assert.strictEqual(isConfirmableSkill('Work authorization required'), false);
  assert.strictEqual(isConfirmableSkill('5-7 years of experience'), false);
  assert.strictEqual(isConfirmableSkill('Python'), true);
  assert.strictEqual(isConfirmableSkill('Power BI'), true);
});

// ---------------------------------------------------------------------
// 12. Strict-literal matching: no synonym credit by default (the
// user-facing decision this whole pass turned on) — "led" must not match
// "managed", but simple plurals must still be credited.
// ---------------------------------------------------------------------
test('strict literal matching: no synonym credit, but plurals are credited', () => {
  assert.strictEqual(matchesTerm('managed a team of five', 'led'), false);
  assert.strictEqual(matchesTerm('worked closely with stakeholders', 'Stakeholder'), true);
  assert.strictEqual(matchesTerm('collaborated with many stakeholder groups', 'Stakeholders'), true);
});

// ---------------------------------------------------------------------
// 13-16. "The title itself is a keyword" — 2026-08-14, real user report
// against a real job (a gap-check modal asked to confirm "Marketplace
// Operations" on a "Marketplace Operations Associate" posting). Found live:
// (a) the résumé's own role/project titles were invisible to matching even
// though generation-time scoring already counts them; (b) a JD keyword
// living only in the job title (29% of scored jobs, measured live) was
// dropped as "ungrounded" because grounding only ever saw description_text.
// ---------------------------------------------------------------------
test('a résumé role title is matched; the employer name alone is not', () => {
  const profile = {
    skills_declared: [],
    certifications: [],
    roles: [{ title: 'Product Manager', company: 'Acme Robotics', bullets: [{ text: 'Shipped a feature.', skills_demonstrated: [] }] }],
    projects: [],
    education: [],
  };
  const haystack = profileSkillText(profile);
  assert.strictEqual(matchesTerm(haystack, 'Product Manager'), true);
  assert.strictEqual(matchesTerm(haystack, 'Acme Robotics'), false);
});

test('education degree/field are matched; the institution name alone is not', () => {
  const profile = {
    skills_declared: [],
    certifications: [],
    roles: [],
    projects: [],
    education: [{ degree: 'Master of Science', field: 'Engineering Management', institution: 'Tufts University' }],
  };
  const haystack = profileSkillText(profile);
  assert.strictEqual(matchesTerm(haystack, 'Engineering Management'), true);
  assert.strictEqual(matchesTerm(haystack, 'Master of Science'), true);
  assert.strictEqual(matchesTerm(haystack, 'Tufts University'), false);
});

test('a JD keyword present only in the job title survives grounding when the title is included, and is dropped when grounded against the body alone', () => {
  const job = { title: 'Marketplace Operations Associate', description_text: 'You will manage day-to-day workflows across orders, vendors, and fulfillment.' };
  const withTitle = sanitizeJdProfile({ required_skills: ['Marketplace Operations'], nice_to_have_skills: [] }, jdGroundingText(job));
  const bodyOnly = sanitizeJdProfile({ required_skills: ['Marketplace Operations'], nice_to_have_skills: [] }, job.description_text);
  assert.ok(withTitle.required_skills.includes('Marketplace Operations'), `expected title-only term to survive: ${JSON.stringify(withTitle.required_skills)}`);
  assert.ok(!bodyOnly.required_skills.includes('Marketplace Operations'), `expected title-only term to be dropped when grounded against the body alone: ${JSON.stringify(bodyOnly.required_skills)}`);
  // Direct check on the grounding primitive too, not just the pipeline output.
  const idx = buildJdIndex(jdGroundingText(job));
  assert.ok(isGrounded('Marketplace Operations', idx));
});

test('jdGroundingText + sanitizeJdProfile stays idempotent with a title-only term in play', () => {
  const job = { title: 'Marketplace Operations Associate', description_text: 'You will manage day-to-day workflows across orders, vendors, and fulfillment.' };
  const out1 = sanitizeJdProfile({ required_skills: ['Marketplace Operations', 'Fulfillment'], nice_to_have_skills: [] }, jdGroundingText(job));
  const out2 = sanitizeJdProfile(out1, jdGroundingText(job));
  assert.deepStrictEqual(out1, out2, `not idempotent: ${JSON.stringify(out1)} vs ${JSON.stringify(out2)}`);
});

// ---------------------------------------------------------------------------
// Junk terms that reached a real stored jd_profile (2026-09-12). All of these
// came back from the extractor on live postings and were being scored as
// requirements - they pad the denominator with terms no ATS keys on, and
// because they are the terms the extractor is least consistent about, they add
// churn to the score on top of the padding.
// ---------------------------------------------------------------------------
test('a bare soft trait is not a skill, with or without a modifier', () => {
  for (const junk of [
    'written communication', 'verbal communication', 'Attention to detail', 'leadership',
    'Excellent interpersonal', 'strong problem-solving', 'multitasking', 'organizational',
  ]) {
    assert.strictEqual(isConfirmableSkill(junk), false, `should be filtered: ${junk}`);
  }
});

test('an umbrella or filler noun is not a skill — "others" came straight from a JD', () => {
  for (const junk of ['others', 'Other', 'etc', 'tools', 'software', 'computer', 'experience', 'processes']) {
    assert.strictEqual(isConfirmableSkill(junk), false, `should be filtered: ${junk}`);
  }
});

test('the junk filters never swallow a real compound term', () => {
  for (const real of [
    'Program Management', 'Stakeholder Communication Plan', 'cross-team collaboration',
    'Root Cause Analysis', 'software capitalization', 'cloud spend management',
    'Communications Strategy', 'Software Development', 'Product Lifecycle', 'FinOps',
  ]) {
    assert.strictEqual(isConfirmableSkill(real), true, `should be kept: ${real}`);
  }
});

// ---------------------------------------------------------------------------
// "Nothing to match against" is not a perfect match (2026-09-12). A real
// Fastly posting whose extraction came back empty rendered "10.0 - 0/0" and
// outranked every genuinely-matched job on the keyword metric.
// ---------------------------------------------------------------------------
test('a JD with no extracted skills scores a neutral 5.0, not a perfect 10', () => {
  const empty = calculateKeywordMatch({
    jdProfile: { required_skills: [], nice_to_have_skills: [] },
    haystacks: ['a resume mentioning all sorts of things'],
  });
  assert.strictEqual(empty.total, 0);
  assert.strictEqual(empty.score, 5, 'an empty denominator is no evidence either way');
  assert.strictEqual(empty.pctMatched, null);
});

// Small-sample shrinkage (5.1): 10·(matched+1)/(total+2). A tiny keyword list
// must not read as a perfect match — 2/2 used to score a flat 10.
test('small keyword lists are shrunk toward 5.0; large ones barely move', () => {
  const all = (n) => Array.from({ length: n }, (_, i) => `Skill${i}`);
  const score = (n) =>
    calculateKeywordMatch({ jdProfile: { required_skills: all(n), nice_to_have_skills: [] }, haystacks: [all(n).join(' ')] }).score;
  assert.strictEqual(score(2), 7.5);
  assert.strictEqual(score(3), 8);
  assert.strictEqual(score(6), 8.8);
  assert.strictEqual(score(12), 9.3);
});

test('a normal JD still scores plain coverage', () => {
  const r = calculateKeywordMatch({
    jdProfile: { required_skills: ['SQL', 'Python'], nice_to_have_skills: [] },
    haystacks: ['I have used SQL for years'],
  });
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.matched, 1);
  assert.strictEqual(r.score, 5);
});

// ---- 2026-09-24 keyword audit of three live scans (§15 #63). Every string
// below was extracted from a real stored posting. ----
const { isJdKeyword, stripContextSuffix, isVaguePhrase } = require('../keywordPipeline');
const { equivalentsFor } = require('../equivalents');

test('lifted qualification bullets and traits are not keywords', () => {
  for (const t of [
    'Strategic and critical thinking',
    'Visual communication and storytelling',
    'creative problem-solving',
    'business acumen',
    'organization',
  ]) {
    assert.strictEqual(isConfirmableSkill(t) && isJdKeyword(t), false, t);
  }
  for (const t of ['business vision and priorities', 'customer and user problem spaces', 'data and analysis', 'Digital technologies']) {
    assert.strictEqual(isJdKeyword(t), false, t);
  }
  for (const t of ['data analysis', 'data products', 'data quality', 'Data management', 'design thinking', 'Product storytelling']) {
    assert.strictEqual(isConfirmableSkill(t) && isJdKeyword(t), true, t);
  }
});

test('context words around a skill are stripped', () => {
  const cases = {
    'agile environments': ['agile'],
    'Agile development methodologies': ['Agile'],
    'lean methodologies': ['lean'],
    'BI tools': ['BI'],
    'data warehousing solutions': ['data warehousing'],
    'UAT testing': ['UAT'],
    'A/B testing': ['A/B testing'],
    'AI and low-code tooling': ['AI', 'low-code'],
    'Research and development teams': ['Research and development'],
    'data products': ['data products'],
  };
  for (const [raw, want] of Object.entries(cases)) assert.deepStrictEqual(stripContextSuffix(raw), want, raw);
});

test('escape clauses are not group members', () => {
  for (const t of ['equivalent experience', 'similar individual-contributor role', 'a related field']) {
    assert.strictEqual(isJdKeyword(t), false, t);
  }
});

test('degree-field groups drop, duplicate groups merge, sanitize stays idempotent', () => {
  const jdText = [
    'Product Management Analyst',
    '- At least 5 years of experience in product management, product analytics, or a related field within fintech.',
    "- Bachelor's degree in Business Administration, Marketing, Finance, Computer Science, Information Systems, Data Science, or a related field.",
    '- 1+ years of program management, logistics, operations, supply chain, transportation, or equivalent experience',
    '- Familiarity with Agile development methodologies and experience grooming product backlogs.',
  ].join('\n');
  const raw = {
    required_skills: ['Agile', 'Agile development methodologies'],
    nice_to_have_skills: [],
    any_of_groups: [
      ['product management', 'product analytics'],
      ['product management', 'product analytics', 'business Administration', 'Marketing', 'Finance', 'Computer Science', 'Information Systems', 'Data Science'],
      ['program management', 'logistics', 'operations', 'supply chain', 'transportation'],
      ['program management', 'logistics', 'operations', 'supply chain', 'transportation', 'equivalent experience'],
    ],
  };
  const once = sanitizeJdProfile(raw, jdText);
  assert.deepStrictEqual(once.required_skills, ['Agile']);
  assert.strictEqual(once.any_of_groups.length, 2, JSON.stringify(once.any_of_groups));
  assert.ok(!once.any_of_groups.flat().some((m) => /marketing|equivalent/i.test(m)));
  assert.deepStrictEqual(sanitizeJdProfile(once, jdText), once);
});

test('certification alternatives stay one group; "Master Change Agent" is not a degree', () => {
  const jd =
    'Certifications\nPreferred - Certified Associate in Project Management (CAPM) certification or equivalent (Lean Six Sigma Green Belt and/or Black Belt or Master Change Agent)';
  const raw = {
    required_skills: [],
    nice_to_have_skills: [],
    any_of_groups: [
      ['Certified Associate in Project Management', 'CAPM', 'Lean Six Sigma Green Belt', 'Lean Six Sigma Black Belt', 'Master Change Agent'],
      ['Certified Associate in Project Management', 'Lean Six Sigma Green Belt', 'Lean Six Sigma Black Belt', 'Master Change Agent'],
    ],
  };
  const out = sanitizeJdProfile(raw, jd);
  assert.strictEqual(out.any_of_groups.length, 1, JSON.stringify(out.any_of_groups));
  assert.ok(out.any_of_groups[0].includes('Lean Six Sigma Black Belt'));
});

test('a list of example tools is separate keywords; real alternatives stay one group', () => {
  const personalis =
    '- Prior experience with various project management tools like Smartsheet, Confluence, Tableau, Lucid, Jira, Microsoft Excel/PowerPoint/Word, Google Docs/Sheets/Slides etc.';
  const tools = ['Smartsheet', 'Confluence', 'Tableau', 'Lucid', 'Jira', 'Microsoft PowerPoint', 'Google Docs'];
  const out = sanitizeJdProfile({ required_skills: [], nice_to_have_skills: [], any_of_groups: [tools] }, personalis);
  assert.deepStrictEqual(out.any_of_groups, []);
  assert.deepStrictEqual(out.required_skills, tools);
  assert.deepStrictEqual(sanitizeJdProfile(out, personalis), out, 'idempotent');

  const openloop = 'Experience with project management platforms such as monday.com, Asana, Smartsheet, ClickUp, or similar tools.';
  const ol = sanitizeJdProfile({ required_skills: [], nice_to_have_skills: [], any_of_groups: [['monday.com', 'Asana', 'Smartsheet', 'ClickUp']] }, openloop);
  assert.deepStrictEqual(ol.required_skills, ['monday.com', 'Asana', 'Smartsheet', 'ClickUp']);

  const alto = '- 2+ years of experience in Product Management or a product-adjacent role (e.g., program management, clinical operations, analytics)';
  const functions = ['Product Management', 'program management', 'clinical operations', 'analytics'];
  assert.deepStrictEqual(sanitizeJdProfile({ required_skills: [], nice_to_have_skills: [], any_of_groups: [functions] }, alto).any_of_groups, [functions]);

  const langs = 'Proficiency in a language such as Python, Java, or Go.';
  assert.deepStrictEqual(
    sanitizeJdProfile({ required_skills: [], nice_to_have_skills: [], any_of_groups: [['Python', 'Java', 'Go']] }, langs).any_of_groups,
    [['Python', 'Java', 'Go']]
  );
});

test('a dated credential keeps its name, not its date', () => {
  const { normalizeJdTerm } = require('../normalizeJdTerms');
  assert.deepStrictEqual(normalizeJdTerm('Lean Six Sigma Black Belt (Oct 2025)'), ['Lean Six Sigma Black Belt']);
  assert.deepStrictEqual(normalizeJdTerm('SQL (2020)'), ['SQL']);
});

test('true equivalents are offered; paraphrases are not', () => {
  const has = (term, v) => equivalentsFor(term).includes(v);
  assert.ok(has('artificial intelligence', 'ai'));
  assert.ok(has('PowerBI', 'power bi'));
  assert.ok(has('Google Workspace', 'g suite'));
  assert.ok(has('Microsoft Word', 'microsoft office'), 'a held suite covers its member');
  assert.ok(!has('Microsoft Office', 'microsoft word'), 'a member never covers the suite');
  assert.ok(has('Lean Six Sigma Green Belt', 'lean six sigma black belt'), 'a higher belt covers a lower one');
  assert.ok(!has('Lean Six Sigma Black Belt', 'lean six sigma green belt'));
  assert.ok(has('CAPM', 'certified associate in project management'));
  assert.ok(has('cross-functional collaboration', 'cross functional collaboration'));
  assert.deepStrictEqual(equivalentsFor('led'), []);
  assert.ok(!has('cross-functional collaboration', 'cross-functional coordination'));
  assert.ok(!equivalentsFor('Google Drive').includes('drive'), 'a common English word is never a stand-in');
  assert.ok(has('road mapping', 'roadmapping'));
  assert.ok(has('cross functional team', 'cross-functional team'));
});

test('one thing named two ways is one requirement', () => {
  const jd = 'PMP (Project Management Professional) preferred. Microsoft Office Proficiency required. PMP a plus.';
  const out = sanitizeJdProfile(
    { required_skills: ['PMP', 'Project Management Professional', 'Microsoft Office Proficiency'], nice_to_have_skills: ['PMP'], any_of_groups: [] },
    jd
  );
  assert.deepStrictEqual(out.required_skills, ['PMP', 'Microsoft Office']);
  assert.deepStrictEqual(out.nice_to_have_skills, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}

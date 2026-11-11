#!/usr/bin/env node
// curate.test.js — regression suite for the AI-curated watchlist's grounding
// validator (spec 20, §15 #50). Covers makeValidator, the piece that makes
// 20's never-fabricate rule real: every returned suggestion is checked against
// the candidate rows the model was actually given, not against the prompt's
// wording.
//
// The two evidence-existence branches are the teeth and are covered hardest —
// a result citing visa_sponsor evidence for a company with no filing record,
// or sector evidence for a company with no sectors, is the exact shape of a
// fabricated citation this validator exists to reject.
//
// Numeric grounding (16.8) is covered too: a number written into the prose
// must be one this company's own candidate row actually showed the model.
// That check sits on structuredCall's schema-validation retry path, where a
// false rejection burns the single retry and fails the whole curate call, so
// the false-positive cases (the company's own name carrying digits, "H-1B"
// itself, a figure quoted back from the target spec) are covered as hard as
// the fabrication case, and the two retry legs are exercised end-to-end
// against a stubbed model rather than assumed.
//
// No test framework in this repo — plain Node + assert:
//   node apps/server/src/watchlist/__tests__/curate.test.js

const assert = require('assert');

// The two retry legs at the bottom of this file drive geminiAdapter's real
// validation-retry loop, which reaches the SDK through a binding captured at
// module load. Stubbing @google/genai in require.cache BEFORE anything else
// is required is therefore the only point at which it can be replaced — no
// network, no API key, no DB. Inert for every other test here.
const genaiPath = require.resolve('@google/genai');
let nextResponses = [];
const modelCalls = [];
require.cache[genaiPath] = {
  id: genaiPath,
  filename: genaiPath,
  loaded: true,
  exports: {
    GoogleGenAI: class {
      constructor() {
        this.models = {
          generateContent: async (params) => {
            modelCalls.push(params.contents);
            if (!nextResponses.length) throw new Error('stub ran out of scripted responses');
            return {
              text: nextResponses.shift(),
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
            };
          },
        };
      }
    },
  },
};

const { makeValidator } = require('../curate');
const { geminiAdapter } = require('@careeros/shared');
const tunables = require('@careeros/shared/src/tunables.json');

const MIN_RATIONALE = tunables.watchlist.minRationaleChars;

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

// A rationale comfortably over the length floor, so length never accidentally
// becomes the reason a case under test fails.
const R = 'Strong overlap with the target spec and this candidate profile.';
assert.ok(R.length >= MIN_RATIONALE, 'test fixture rationale must clear the floor');

// Three candidates spanning the evidence-existence matrix: one with both a
// sponsor record and sectors, one with sectors only, one with neither.
const SPONSORED = {
  id: 'c-sponsored',
  company_name_display: 'Sponsored Co',
  platform: 'greenhouse',
  sectors: ['fintech'],
  sponsor: { filing_count_last_fy: 120, source_fiscal_year: 2026, source_quarter: 3, wage_level_distribution: {} },
};
const SECTORED = { id: 'c-sectored', company_name_display: 'Sectored Co', platform: 'lever', sectors: ['devtools'], sponsor: null };
const BARE = { id: 'c-bare', company_name_display: 'Bare Co', platform: 'ashby', sectors: [], sponsor: null };

const CANDIDATES = [SPONSORED, SECTORED, BARE];
const MAX = 3;
const validate = makeValidator(CANDIDATES, MAX);

function result(over) {
  return { company_id: SPONSORED.id, rank: 1, evidence_type: 'resume_match', rationale: R, ...over };
}
function ok(results) {
  return validate({ results });
}

console.log('makeValidator — evidence existence (the never-fabricate teeth):');

check('visa_sponsor evidence on a company with NO sponsor record is rejected', () => {
  const err = ok([result({ company_id: SECTORED.id, evidence_type: 'visa_sponsor' })]);
  assert.ok(err, 'expected a rejection');
  assert.ok(err.includes('Sectored Co'), `error should name the company, got: ${err}`);
  assert.ok(err.includes('visa_sponsor'), `error should name the evidence type, got: ${err}`);
});

check('visa_sponsor evidence on a company WITH a sponsor record is accepted', () => {
  assert.strictEqual(ok([result({ evidence_type: 'visa_sponsor' })]), null);
});

check('sector evidence on a company with an EMPTY sectors array is rejected', () => {
  const err = ok([result({ company_id: BARE.id, evidence_type: 'sector' })]);
  assert.ok(err, 'expected a rejection');
  assert.ok(err.includes('Bare Co'), `error should name the company, got: ${err}`);
  assert.ok(err.includes('sector'), `error should name the evidence type, got: ${err}`);
});

check('sector evidence on a company WITH sectors is accepted', () => {
  assert.strictEqual(ok([result({ company_id: SECTORED.id, evidence_type: 'sector' })]), null);
});

check('resume_match needs neither a sponsor record nor sectors', () => {
  assert.strictEqual(ok([result({ company_id: BARE.id, evidence_type: 'resume_match' })]), null);
});

console.log('\nmakeValidator — candidate membership and duplicates:');

check('a company_id that was never a candidate is rejected', () => {
  const err = ok([result({ company_id: 'c-hallucinated' })]);
  assert.ok(err && err.includes('c-hallucinated'), `got: ${err}`);
  assert.ok(err.includes('not one of the candidate companies'), `got: ${err}`);
});

check('a duplicate company_id across two results is rejected', () => {
  const err = ok([result({ rank: 1 }), result({ rank: 2 })]);
  assert.ok(err && err.includes('duplicate'), `got: ${err}`);
});

check('distinct candidate ids are accepted', () => {
  const err = ok([result({ rank: 1 }), result({ company_id: SECTORED.id, rank: 2 })]);
  assert.strictEqual(err, null);
});

console.log('\nmakeValidator — evidence_type enum:');

check('an evidence_type outside WATCHLIST_EVIDENCE_TYPES is rejected', () => {
  const err = ok([result({ evidence_type: 'vibes' })]);
  assert.ok(err && err.includes('unknown evidence_type'), `got: ${err}`);
});

check('a missing evidence_type is rejected', () => {
  const err = ok([{ company_id: SPONSORED.id, rank: 1, rationale: R }]);
  assert.ok(err && err.includes('unknown evidence_type'), `got: ${err}`);
});

console.log('\nmakeValidator — rationale floor:');

check(`a rationale under ${MIN_RATIONALE} characters is rejected`, () => {
  const err = ok([result({ rationale: 'too short' })]);
  assert.ok(err && err.includes('no real rationale'), `got: ${err}`);
});

check('a whitespace-only rationale is rejected (trimmed before measuring)', () => {
  const err = ok([result({ rationale: ' '.repeat(MIN_RATIONALE + 40) })]);
  assert.ok(err && err.includes('no real rationale'), `got: ${err}`);
});

check('a non-string rationale is rejected', () => {
  const err = ok([result({ rationale: 42 })]);
  assert.ok(err && err.includes('no real rationale'), `got: ${err}`);
});

console.log('\nmakeValidator — rank:');

check('a non-numeric rank is rejected', () => {
  const err = ok([result({ rank: '1' })]);
  assert.ok(err && err.includes('invalid rank'), `got: ${err}`);
});

check('a rank below 1 is rejected', () => {
  const err = ok([result({ rank: 0 })]);
  assert.ok(err && err.includes('invalid rank'), `got: ${err}`);
});

console.log('\nmakeValidator — result count and malformed payloads:');

check(`more than max (${MAX}) results is rejected`, () => {
  const four = [
    result({ rank: 1 }),
    result({ company_id: SECTORED.id, rank: 2 }),
    result({ company_id: BARE.id, rank: 3 }),
    result({ company_id: 'c-extra', rank: 4 }),
  ];
  const err = validate({ results: four });
  assert.ok(err && err.includes(`at most ${MAX} results`), `got: ${err}`);
});

check('exactly max results is accepted', () => {
  const three = [result({ rank: 1 }), result({ company_id: SECTORED.id, rank: 2 }), result({ company_id: BARE.id, rank: 3 })];
  assert.strictEqual(validate({ results: three }), null);
});

check('a null / non-object / results-less payload is rejected, never throws', () => {
  for (const bad of [null, undefined, 'results', 42, {}, { results: null }, { results: 'nope' }]) {
    const err = validate(bad);
    assert.ok(err && err.includes('results must be an array'), `payload ${JSON.stringify(bad)} got: ${err}`);
  }
});

check('a non-object inside results is rejected', () => {
  const err = ok([null]);
  assert.ok(err && err.includes('each result must be an object'), `got: ${err}`);
});

check('an empty results array is accepted (a curate pass may legitimately find nothing)', () => {
  assert.strictEqual(ok([]), null);
});

// --- numeric grounding (16.8) ---------------------------------------------
//
// NUMERIC is a fourth candidate whose own row carries every kind of number
// candidateBlock() renders: a filing count, a fiscal year and quarter, and
// wage-level percentages that live in the DB as FRACTIONS and reach the model
// ROUNDED. It also carries digits in its display name, which must not be
// treated as a citation the model invented.
const NUMERIC = {
  id: 'c-numeric',
  company_name_display: '23andMe Holding',
  platform: 'greenhouse',
  sectors: ['biotech'],
  sponsor: {
    filing_count_last_fy: 4102,
    source_fiscal_year: 2026,
    source_quarter: 3,
    wage_level_distribution: { 'Level II': 0.24, 'Level I': 0.18, 'N/A': 0 },
  },
};
const NUM_CANDIDATES = [NUMERIC, SPONSORED, SECTORED];
const SPEC_NUMBERS = new Set([5]); // as if the target spec said "5+ years"
const vNum = makeValidator(NUM_CANDIDATES, MAX, SPEC_NUMBERS);

function numResult(rationale, over) {
  return { results: [{ company_id: NUMERIC.id, rank: 1, evidence_type: 'visa_sponsor', rationale, ...over }] };
}

console.log('\nmakeValidator — numeric grounding (16.8):');

check('a rationale citing the real filing count is accepted', () => {
  assert.strictEqual(vNum(numResult('Filed 4102 certified H-1B petitions in the most recent year.')), null);
});

check('the same count written with a thousands separator is accepted', () => {
  assert.strictEqual(vNum(numResult('Filed 4,102 certified H-1B petitions in the most recent year.')), null);
});

check('a FABRICATED filing count is rejected, and the message names the number', () => {
  const err = vNum(numResult('Filed 231 certified H-1B petitions in the most recent year.'));
  assert.ok(err, 'expected a rejection');
  assert.ok(err.includes('231'), `message must name the offending number, got: ${err}`);
  assert.ok(err.includes('23andMe Holding'), `message must name the company, got: ${err}`);
  assert.ok(err.includes('4102'), `message must list what WAS available, got: ${err}`);
});

check('the ROUNDED wage percentage the model was shown is accepted', () => {
  assert.strictEqual(vNum(numResult('Files 4102 petitions, 24% of them at Level II wages.')), null);
});

check('the raw fraction behind that percentage is rejected — it was never shown', () => {
  const err = vNum(numResult('Files 4102 petitions, 0.24 of them at Level II wages.'));
  assert.ok(err && err.includes('0.24'), `got: ${err}`);
});

check('a wage level with a ZERO share contributes no citable number', () => {
  // 'N/A' sits at 0 in the distribution, so candidateBlock never renders it
  // and 0 must not become quotable.
  const err = vNum(numResult('Files 4102 petitions with 0 at unclassified wage levels.'));
  assert.ok(err && err.includes('0'), `got: ${err}`);
});

check('the fiscal year and quarter the row carries are accepted', () => {
  assert.strictEqual(vNum(numResult('Sponsorship data from FY2026 Q3 shows sustained filing volume.')), null);
});

check('a WRONG fiscal year is rejected', () => {
  const err = vNum(numResult('Sponsorship data from FY2019 Q3 shows sustained filing volume.'));
  assert.ok(err && err.includes('2019'), `got: ${err}`);
});

check("digits in the company's OWN display name are not treated as a citation", () => {
  assert.strictEqual(
    vNum(numResult('23andMe Holding files at real volume and matches the biotech focus.', { evidence_type: 'sector' })),
    null
  );
});

check('"H-1B" alone does not contribute a spurious 1', () => {
  assert.strictEqual(
    vNum(numResult('A consistent H-1B sponsor whose filings match this candidate profile.', { evidence_type: 'sector' })),
    null
  );
});

check('a number from the TARGET SPEC is allowed on any company', () => {
  assert.strictEqual(
    vNum(numResult('Matches the stated 5 years of platform experience directly.', { evidence_type: 'resume_match' })),
    null
  );
});

check("another candidate's number cited on this company is rejected", () => {
  // 120 is SPONSORED's filing count, not NUMERIC's. Grounding is per-company:
  // a real number attached to the wrong company is still a false statement.
  const err = vNum(numResult('Filed 120 certified H-1B petitions in the most recent year.'));
  assert.ok(err && err.includes('120'), `got: ${err}`);
});

check('a rationale with no numbers at all is unaffected by this check', () => {
  assert.strictEqual(
    vNum(numResult('A biotech sponsor whose sector tags match the target spec.', { evidence_type: 'sector' })),
    null
  );
});

check('a company with no sponsor record can still cite digits from its own name', () => {
  const v = makeValidator([{ ...SECTORED, company_name_display: 'Route 66 Labs' }], MAX);
  const err = v({
    results: [
      { company_id: SECTORED.id, rank: 1, evidence_type: 'sector', rationale: 'Route 66 Labs is tagged devtools, matching the spec.' },
    ],
  });
  assert.strictEqual(err, null);
});

// --- the 16.8 retry path, end-to-end --------------------------------------
//
// These drive geminiAdapter.structuredCall itself against the stubbed SDK, so
// the claim "a mismatch retries once with the mismatch fed back, then fails
// loudly" is demonstrated rather than asserted about a validator in isolation.
const RETRY_ARGS = {
  model: 'gemini-3.5-flash-lite',
  systemInstruction: 'sys',
  prompt: 'CANDIDATE COMPANIES:\nid=c-numeric | name=23andMe Holding',
  responseSchema: {},
  apiKey: 'stub-key-not-a-real-credential',
};
const FABRICATED = JSON.stringify(numResult('Filed 231 certified H-1B petitions in the most recent year.'));
const CORRECTED = JSON.stringify(numResult('Filed 4102 certified H-1B petitions in the most recent year.'));

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('\nmakeValidator — resume_match must name a real overlap (§15 #53):');

// The spec terms a resume_match rationale is allowed to claim an overlap with.
// Built the same way curateWatchlist builds them: whole entries plus their
// words.
const SPEC_TERMS = new Set(['supply chain', 'supply', 'chain', 'logistics', 'program management', 'program', 'management']);
const grounded = makeValidator(CANDIDATES, MAX, new Set(), SPEC_TERMS);

check('a resume_match rationale naming NO spec term is rejected', () => {
  // The templated sentence that motivated this check. It clears the length
  // floor and cites nothing checkable.
  const err = grounded({
    results: [result({ evidence_type: 'resume_match', rationale: "Aligns well with the candidate's background and overall career direction." })],
  });
  assert.ok(err, 'expected a rejection');
  assert.ok(err.includes('names no specific overlap'), `got: ${err}`);
});

check('the rejection lists the terms the model should have used, so the retry can succeed', () => {
  // 16.8 feeds this string back verbatim on the single retry. A rejection that
  // does not say what would have been acceptable burns that retry for nothing.
  const err = grounded({ results: [result({ evidence_type: 'resume_match', rationale: 'A generally strong company for this person.' })] });
  assert.ok(err.includes('supply chain'), `error must name the available terms, got: ${err}`);
});

check('a resume_match rationale naming a real spec term is accepted', () => {
  assert.strictEqual(
    grounded({
      results: [result({ evidence_type: 'resume_match', rationale: 'Runs a large in-house logistics network, matching the supply chain focus.' })],
    }),
    null
  );
});

check('the term match is case-insensitive', () => {
  assert.strictEqual(
    grounded({ results: [result({ evidence_type: 'resume_match', rationale: 'Its Supply Chain division is the largest part of the business.' })] }),
    null
  );
});

check('a multi-word term is satisfied by naming it in running prose', () => {
  assert.strictEqual(
    grounded({
      results: [result({ evidence_type: 'resume_match', rationale: 'Hires heavily for program management roles across its hardware org.' })],
    }),
    null
  );
});

check('the check does NOT apply to sector or visa_sponsor evidence', () => {
  // Those two have their own existence checks; requiring a spec term of them
  // as well would reject a perfectly grounded "Filed 120 certified petitions".
  assert.strictEqual(
    grounded({ results: [result({ company_id: SECTORED.id, evidence_type: 'sector', rationale: 'Listed in the devtools sector in the candidate data.' })] }),
    null
  );
  assert.strictEqual(
    grounded({ results: [result({ evidence_type: 'visa_sponsor', rationale: 'Filed 120 certified H-1B petitions in the last fiscal year.' })] }),
    null
  );
});

check('with NO spec terms the check is inert — an empty spec must not reject everything', () => {
  // An empty free-text run whose spec yielded no domain focus or role families
  // would otherwise be unable to return any resume_match result at all.
  assert.strictEqual(
    makeValidator(CANDIDATES, MAX, new Set(), new Set())({
      results: [result({ evidence_type: 'resume_match', rationale: 'Aligns with the general shape of this profile.' })],
    }),
    null
  );
});

check('every prior caller is unaffected — the fourth argument defaults to empty', () => {
  // makeValidator(candidates, max) and makeValidator(candidates, max, numbers)
  // are both still valid call shapes.
  assert.strictEqual(makeValidator(CANDIDATES, MAX)({ results: [result({})] }), null);
  assert.strictEqual(makeValidator(CANDIDATES, MAX, new Set())({ results: [result({})] }), null);
});

async function retryLegs() {
  console.log('\nmakeValidator on 16.8 retry path:');

  await checkAsync('a fabricated number retries ONCE with the mismatch fed back, and the retry succeeds', async () => {
    nextResponses = [FABRICATED, CORRECTED];
    modelCalls.length = 0;
    const out = await geminiAdapter.structuredCall({ ...RETRY_ARGS, validate: vNum });
    assert.strictEqual(out.usage.attempts, 2, 'expected exactly two attempts');
    assert.strictEqual(out.parsed.results[0].rationale.includes('4102'), true);
    assert.strictEqual(modelCalls.length, 2);
    assert.ok(
      modelCalls[1].includes('previous response failed validation') && modelCalls[1].includes('231'),
      'the retry prompt must carry the specific mismatch, not a generic error'
    );
  });

  await checkAsync('failing twice is rejected LOUDLY — a 502 throw, never a silent persist', async () => {
    nextResponses = [FABRICATED, FABRICATED];
    modelCalls.length = 0;
    let threw = null;
    try {
      await geminiAdapter.structuredCall({ ...RETRY_ARGS, validate: vNum });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'expected a throw, not a resolved value');
    assert.strictEqual(threw.status, 502);
    assert.ok(threw.message.includes('231'), `the throw must name the mismatch, got: ${threw.message}`);
    assert.strictEqual(modelCalls.length, 2, 'must not retry more than once on a validation failure');
  });

  console.log(`\n${passed} checks passed`);
  process.exit(process.exitCode || 0);
}

retryLegs();


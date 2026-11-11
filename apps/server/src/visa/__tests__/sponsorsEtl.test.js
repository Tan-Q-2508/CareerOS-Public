#!/usr/bin/env node
// sponsorsEtl.test.js — regression suite for the DOL/OFLC LCA parser
// (spec 19.1/19.2, §15 #53).
//
// §15 #48 shipped this parser with no unit test at all: "coverage is the live
// run." A live run is a 252 MB download that OOMs on the server, so in
// practice the parser was covered by nothing that could be run on a change.
//
// Two things are covered hardest, both because they are silent when wrong:
//
//  1. The DBA fallback key's LENGTH GUARD. Session 49 found the unguarded
//     version linking `Mehta Mechanical Co. In.` (one filing) to the registry's
//     `Mmc` row via the DBA "MMC" — a household name's badge showing a
//     stranger's single filing on an immigration-relevant surface. The guard is
//     the fix; this pins it.
//  2. annualizeWage's two undocumented magic numbers — the 2,080-hour year and
//     the $1k-$10M sanity window. Both were called "defensible guesses" in the
//     §15 #48 handoff and left as open item 10. They stop being a guess once
//     their exact behaviour is written down, boundaries included.
//
// No test framework in this repo — plain Node + assert:
//   node apps/server/src/visa/__tests__/sponsorsEtl.test.js

const assert = require('assert');
const { tunables } = require('@careeros/shared');
const {
  annualizeWage,
  columnIndex,
  resolveColumns,
  absoluteDolUrl,
  createAggregator,
  distributionOf,
  topN,
  upperSet,
} = require('../sponsors');
const { entryLevelShare } = require('../sponsorTracklists');

const CFG = tunables.visaSponsors;

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

// A row reader shaped like the one aggregateFile hands to add(): a function
// from logical column key to raw cell value.
const row = (fields) => (key) => fields[key];

const CERTIFIED = { visaClass: 'H-1B', caseStatus: 'Certified' };

console.log('annualizeWage — the 2,080-hour year and the sanity window:');

check('an hourly wage is annualized at 2,080 hours', () => {
  assert.strictEqual(annualizeWage('50', 'Hour'), 104000);
});

check('the unit is matched case-insensitively, as DOL emits mixed case', () => {
  assert.strictEqual(annualizeWage('50', 'HOUR'), 104000);
  assert.strictEqual(annualizeWage('50', 'hour'), 104000);
});

check('week, bi-weekly, month and year all annualize', () => {
  assert.strictEqual(annualizeWage('2000', 'Week'), 104000);
  assert.strictEqual(annualizeWage('4000', 'Bi-Weekly'), 104000);
  assert.strictEqual(annualizeWage('10000', 'Month'), 120000);
  assert.strictEqual(annualizeWage('120000', 'Year'), 120000);
});

check('currency formatting is stripped', () => {
  assert.strictEqual(annualizeWage('$120,000', 'Year'), 120000);
});

check('an UNKNOWN unit returns null rather than guessing a multiplier', () => {
  // The honest failure. A guessed multiplier would silently skew an employer's
  // average, and avg_wage feeds the scoring prompt.
  assert.strictEqual(annualizeWage('120000', 'Fortnight'), null);
  assert.strictEqual(annualizeWage('120000', ''), null);
  assert.strictEqual(annualizeWage('120000', null), null);
});

check('a non-numeric or non-positive amount returns null', () => {
  assert.strictEqual(annualizeWage('', 'Year'), null);
  assert.strictEqual(annualizeWage('N/A', 'Year'), null);
  assert.strictEqual(annualizeWage('0', 'Year'), null);
  assert.strictEqual(annualizeWage('-50000', 'Year'), null);
});

check('the sanity window is STRICT at both ends — exactly $1,000 and exactly $10M are dropped', () => {
  // Surprising and previously undocumented. Worth pinning precisely so a future
  // change to these bounds is a decision, not an accident.
  assert.strictEqual(annualizeWage('1000', 'Year'), null, 'exactly 1000 is excluded');
  assert.strictEqual(annualizeWage('1001', 'Year'), 1001);
  assert.strictEqual(annualizeWage('10000000', 'Year'), null, 'exactly 10M is excluded');
  assert.strictEqual(annualizeWage('9999999', 'Year'), 9999999);
});

check('a unit/amount mismatch is caught by the window rather than skewing an average', () => {
  // $120,000 mistakenly filed as an HOURLY rate would annualize to $249.6M.
  assert.strictEqual(annualizeWage('120000', 'Hour'), null);
});

console.log('\ncreateAggregator — the row filter:');

check('a certified H-1B row is kept', () => {
  const agg = createAggregator();
  agg.add(row({ ...CERTIFIED, employerName: 'Acme Inc.' }));
  const { sponsors, stats } = agg.finish();
  assert.strictEqual(stats.kept, 1);
  assert.strictEqual(sponsors[0].filing_count_last_fy, 1);
});

check('a DENIED row is dropped — the table aggregates certified filings only', () => {
  const agg = createAggregator();
  agg.add(row({ visaClass: 'H-1B', caseStatus: 'Denied', employerName: 'Acme Inc.' }));
  const { sponsors, stats } = agg.finish();
  assert.strictEqual(stats.kept, 0);
  assert.strictEqual(sponsors.length, 0);
});

check('a non-H-1B visa class is dropped', () => {
  const agg = createAggregator();
  agg.add(row({ visaClass: 'H-1B1 Chile', caseStatus: 'Certified', employerName: 'Acme Inc.' }));
  assert.strictEqual(agg.finish().stats.kept, 0);
});

check('case status is compared case-INSENSITIVELY — DOL emits "Certified", not "CERTIFIED"', () => {
  // §15 #48 found this live: the spec said CERTIFIED and the file says
  // Certified. Both sides are uppercased; this asserts that stays true.
  const agg = createAggregator();
  agg.add(row({ visaClass: 'h-1b', caseStatus: 'CeRtIfIeD', employerName: 'Acme Inc.' }));
  assert.strictEqual(agg.finish().stats.kept, 1);
});

check('a row with an unnormalizable employer name is counted as skipped, not silently lost', () => {
  const agg = createAggregator();
  agg.add(row({ ...CERTIFIED, employerName: '   ' }));
  const { stats } = agg.finish();
  assert.strictEqual(stats.skippedNoName, 1);
  assert.strictEqual(stats.rows, 1, 'every row seen is counted, kept or not');
});

check('rows for the same employer fold into one accumulator', () => {
  const agg = createAggregator();
  for (let i = 0; i < 3; i++) agg.add(row({ ...CERTIFIED, employerName: 'Acme, Inc.' }));
  agg.add(row({ ...CERTIFIED, employerName: 'ACME INC' }));
  const { sponsors } = agg.finish();
  assert.strictEqual(sponsors.length, 1, 'normalizeCompanyName collapses the legal-suffix variants');
  assert.strictEqual(sponsors[0].filing_count_last_fy, 4);
});

console.log('\ncreateAggregator — the DBA fallback key and its length guard (the Mehta/MMC fix):');

check('a long DBA is kept as a second lookup key', () => {
  const agg = createAggregator();
  agg.add(row({ ...CERTIFIED, employerName: 'Meta Platforms, Inc.', tradeNameDba: 'Facebook' }));
  assert.strictEqual(agg.finish().sponsors[0].dba_normalized, 'facebook');
});

check('a SHORT DBA is rejected — this is the Mehta Mechanical / "MMC" false positive', () => {
  const agg = createAggregator();
  agg.add(row({ ...CERTIFIED, employerName: 'Mehta Mechanical Co. In.', tradeNameDba: 'MMC' }));
  assert.strictEqual(
    agg.finish().sponsors[0].dba_normalized,
    null,
    'a 3-character acronym collides with everything and must never become a join key'
  );
});

check('the guard is exactly minDbaKeyLength, inclusive', () => {
  const atLimit = 'a'.repeat(CFG.minDbaKeyLength);
  const below = 'a'.repeat(CFG.minDbaKeyLength - 1);

  const kept = createAggregator();
  kept.add(row({ ...CERTIFIED, employerName: 'Some Employer LLC', tradeNameDba: atLimit }));
  assert.strictEqual(kept.finish().sponsors[0].dba_normalized, atLimit);

  const dropped = createAggregator();
  dropped.add(row({ ...CERTIFIED, employerName: 'Some Employer LLC', tradeNameDba: below }));
  assert.strictEqual(dropped.finish().sponsors[0].dba_normalized, null);
});

check('a DBA identical to the legal name is not stored as a duplicate key', () => {
  const agg = createAggregator();
  agg.add(row({ ...CERTIFIED, employerName: 'Palantir Technologies', tradeNameDba: 'Palantir Technologies' }));
  assert.strictEqual(agg.finish().sponsors[0].dba_normalized, null);
});

check('the FIRST qualifying DBA wins and later ones do not overwrite it', () => {
  const agg = createAggregator();
  agg.add(row({ ...CERTIFIED, employerName: 'Holding Co LLC', tradeNameDba: 'Firstbrand' }));
  agg.add(row({ ...CERTIFIED, employerName: 'Holding Co LLC', tradeNameDba: 'Secondbrand' }));
  assert.strictEqual(agg.finish().sponsors[0].dba_normalized, 'firstbrand');
});

console.log('\ndistributionOf — wage-level shares, and why entryLevelShare re-normalizes:');

check('shares are rounded to 3dp and only present levels appear', () => {
  const levels = new Map([['I', 1], ['II', 3]]);
  assert.deepStrictEqual(distributionOf(levels, 4), { I: 0.25, II: 0.75 });
});

check('levels come back in the canonical I-IV-then-N/A order', () => {
  const levels = new Map([['N/A', 1], ['IV', 1], ['I', 2]]);
  assert.deepStrictEqual(Object.keys(distributionOf(levels, 4)), ['I', 'IV', 'N/A']);
});

check('an unexpected level DOL invents is passed through rather than dropped', () => {
  const dist = distributionOf(new Map([['I', 1], ['V', 1]]), 2);
  assert.strictEqual(dist.V, 0.5, 'a new level must surface, not vanish silently');
});

check('the distribution INCLUDES N/A in its denominator — which is exactly why entryLevelShare re-normalizes', () => {
  // The cross-reference that makes both functions make sense together.
  // distributionOf divides by every kept row, N/A included, so its shares sum
  // to ~1. entryLevelShare then EXCLUDES N/A from its own denominator, because
  // "the employer didn't determine a level" is not evidence of seniority.
  const dist = distributionOf(new Map([['I', 1], ['II', 1], ['N/A', 2]]), 4);
  assert.deepStrictEqual(dist, { I: 0.25, II: 0.25, 'N/A': 0.5 });

  const sum = Object.values(dist).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, `distributionOf shares should sum to ~1, got ${sum}`);

  assert.strictEqual(
    entryLevelShare(dist),
    1,
    'all GRADED filings here are Level I-II, so this employer is 100% entry-level friendly despite N/A being half the rows'
  );
});

check('an all-N/A employer yields a null entry-level share, not a zero', () => {
  // A zero would read as "files only senior roles" and wrongly exclude the
  // employer from the Entry-Level Friendly list. Null means "no evidence".
  assert.strictEqual(entryLevelShare(distributionOf(new Map([['N/A', 5]]), 5)), null);
});

check('entryLevelShare handles a missing or malformed distribution', () => {
  assert.strictEqual(entryLevelShare(null), null);
  assert.strictEqual(entryLevelShare(undefined), null);
  assert.strictEqual(entryLevelShare('nonsense'), null);
  assert.strictEqual(entryLevelShare({}), null);
});

check('a senior-heavy employer scores below the entry-level threshold', () => {
  // The §19.2 trap this data was collected to expose: high volume, wrong level.
  const dist = distributionOf(new Map([['I', 1], ['III', 5], ['IV', 4]]), 10);
  assert.ok(entryLevelShare(dist) < CFG.tracklists.entryLevelMinShare);
});

console.log('\ntopN, upperSet, columnIndex, absoluteDolUrl:');

check('topN returns the n most frequent titles, ties broken alphabetically', () => {
  const counts = new Map([['Zebra Engineer', 2], ['Alpha Engineer', 2], ['Rare Role', 1]]);
  assert.deepStrictEqual(topN(counts, 2), ['Alpha Engineer', 'Zebra Engineer']);
});

check('topN is stable when there are fewer titles than n', () => {
  assert.deepStrictEqual(topN(new Map([['Only Role', 1]]), 5), ['Only Role']);
  assert.deepStrictEqual(topN(new Map(), 5), []);
});

check('top_job_titles is capped at the tunable', () => {
  const agg = createAggregator();
  for (let i = 0; i < CFG.topJobTitles + 3; i++) {
    agg.add(row({ ...CERTIFIED, employerName: 'Acme Inc.', jobTitle: `Role ${i}` }));
  }
  assert.strictEqual(agg.finish().sponsors[0].top_job_titles.length, CFG.topJobTitles);
});

check('upperSet uppercases every member', () => {
  assert.deepStrictEqual([...upperSet(['h-1b', 'H-1B1'])], ['H-1B', 'H-1B1']);
  assert.deepStrictEqual([...upperSet(null)], []);
});

check('columnIndex converts a spreadsheet ref to a zero-based index', () => {
  assert.strictEqual(columnIndex('A1'), 0);
  assert.strictEqual(columnIndex('Z9'), 25);
  assert.strictEqual(columnIndex('AA1'), 26);
  assert.strictEqual(columnIndex('BC12'), 54);
});

check('absoluteDolUrl collapses the doubled slash the live page actually emits', () => {
  // Found live in §15 #48 — dol.gov serves `https://www.dol.gov//media/...`.
  assert.strictEqual(
    absoluteDolUrl('https://www.dol.gov//media/LCA_Disclosure.xlsx'),
    'https://www.dol.gov/media/LCA_Disclosure.xlsx'
  );
});

check('absoluteDolUrl resolves a site-root-relative path and preserves the scheme', () => {
  const out = absoluteDolUrl('/sites/dolgov/files/ETA/oflc/pdfs/LCA.xlsx');
  assert.ok(out.startsWith('https://'), `scheme must survive the slash collapse, got: ${out}`);
  assert.ok(out.endsWith('/sites/dolgov/files/ETA/oflc/pdfs/LCA.xlsx'));
});

console.log('\nresolveColumns — a renamed DOL column must fail loudly, never silently:');

const HEADER = ['VISA_CLASS', 'CASE_STATUS', 'EMPLOYER_NAME', 'TRADE_NAME_DBA', 'JOB_TITLE', 'WAGE_RATE_OF_PAY_FROM', 'WAGE_UNIT_OF_PAY', 'PW_WAGE_LEVEL'];

check('a complete header resolves every logical column', () => {
  const idx = resolveColumns(HEADER);
  assert.strictEqual(idx.visaClass, 0);
  assert.strictEqual(idx.employerName, 2);
  assert.strictEqual(idx.pwWageLevel, 7);
});

check('header matching is case- and whitespace-insensitive', () => {
  const idx = resolveColumns(HEADER.map((h) => `  ${h.toLowerCase()}  `));
  assert.strictEqual(idx.caseStatus, 1);
});

check('a missing REQUIRED column throws and names the column', () => {
  // The alternative is a table full of zeroes that looks like a successful run.
  const broken = HEADER.filter((h) => h !== 'EMPLOYER_NAME');
  assert.throws(() => resolveColumns(broken), /EMPLOYER_NAME/);
});

check('a missing OPTIONAL column resolves to -1 rather than throwing', () => {
  const idx = resolveColumns(HEADER.filter((h) => h !== 'TRADE_NAME_DBA'));
  assert.strictEqual(idx.tradeNameDba, -1, 'losing the DBA column degrades the join, it does not fail the run');
});

console.log(`\n${passed} checks passed`);
process.exit(process.exitCode || 0);

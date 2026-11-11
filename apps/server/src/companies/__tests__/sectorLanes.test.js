#!/usr/bin/env node
// sectorLanes.test.js — regression suite for the sector-classification pass's
// decision layer (spec 4.6.9, §15 #53).
//
// These four functions decide how ~19.6k companies and roughly a day's
// cheap-tier quota get spent, and until now nothing tested them — §15 #51 and
// #52 both closed with "no unit test covers the classifier or the lane
// assigner; coverage is the dry-run gates plus the live before/after." A live
// before/after costs real AI and cannot be run on every change.
//
// Covered hardest: selectStale, because it is what makes a full pass RESUMABLE
// (§15 #52's headline deliverable) and what protects a maintainer's admin
// override from being silently overwritten by the next automated run. A bug
// there either re-pays for work already done or destroys hand-set data.
//
// Also covers sectors.js's makeValidator and normalizeSectors — the two
// deterministic guards standing between the model's output and the database.
//
// No test framework in this repo — plain Node + assert:
//   node apps/server/src/companies/__tests__/sectorLanes.test.js

const assert = require('assert');
const { tunables, constants } = require('@careeros/shared');
const { assignLanes, selectStale, findCanary, stratify, LANES, CURRENT_VERSION } = require('../sectorLanes');
const { makeValidator, normalizeSectors } = require('../sectors');

const CFG = tunables.sectorClassification;

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

// --- fixtures -------------------------------------------------------------

const company = (id, extra = {}) => ({ id, company_name_display: id, platform: 'greenhouse', slug_or_identifier: id, ...extra });

// sectorState entries as fetchSectorState builds them.
const state = (count, { versions = [CURRENT_VERSION], adminLocked = false, sectors = [] } = {}) => ({
  count,
  sectors,
  versions: new Set(versions),
  adminLocked,
});

console.log('assignLanes — lane thresholds are read from tunables, not hardcoded:');

check('a top-N sponsor by filing volume goes solo regardless of its sector count', () => {
  // The registry must be bigger than soloTopSponsors for the ranking to
  // discriminate at all — see the RANK-not-magnitude check below.
  const registry = [company('big'), ...Array.from({ length: CFG.soloTopSponsors }, (_, i) => company(`mid${i}`))];
  const filings = new Map([['big', 999999]]);
  for (let i = 0; i < CFG.soloTopSponsors; i++) filings.set(`mid${i}`, 1000 + i);

  const lanes = assignLanes(registry, new Map(), filings);
  assert.ok(lanes.solo.some((c) => c.id === 'big'), 'the largest filer must be solo');
  assert.strictEqual(lanes.solo.length, CFG.soloTopSponsors, 'exactly soloTopSponsors companies go solo');
  // 'mid0' has the smallest count of the mids, so it is the one ranked out.
  assert.ok(!lanes.solo.some((c) => c.id === 'mid0'), 'the lowest-ranked filer is pushed out of solo');
});

check('a company already carrying >= soloMinSectors sectors goes solo with no filings at all', () => {
  const registry = [company('deep')];
  const lanes = assignLanes(registry, new Map([['deep', state(CFG.soloMinSectors)]]), new Map());
  assert.deepStrictEqual(lanes.solo.map((c) => c.id), ['deep']);
});

check('one sector below soloMinSectors does NOT go solo', () => {
  const registry = [company('shallow')];
  const lanes = assignLanes(registry, new Map([['shallow', state(CFG.soloMinSectors - 1)]]), new Map());
  assert.strictEqual(lanes.solo.length, 0, 'the threshold is >=, not >');
});

check('complexMinFilings puts a mid-volume filer in the complex lane', () => {
  // The solo lane is crowded out first: topSponsors takes the top
  // soloTopSponsors filers by RANK, so 'mid' only reaches the complex band
  // once enough bigger filers exist to push it out of that ranking.
  const registry = [company('mid'), ...Array.from({ length: CFG.soloTopSponsors }, (_, i) => company(`big${i}`))];
  const filings = new Map([['mid', CFG.complexMinFilings]]);
  for (let i = 0; i < CFG.soloTopSponsors; i++) filings.set(`big${i}`, 100000 + i);

  const lanes = assignLanes(registry, new Map(), filings);
  assert.deepStrictEqual(lanes.complex.map((c) => c.id), ['mid']);
  assert.strictEqual(lanes.solo.length, CFG.soloTopSponsors);
});

check('topSponsors is a RANK, not a magnitude — a tiny filer goes solo if nobody outranks it', () => {
  // Worth pinning because it is surprising and load-bearing. In a registry
  // where fewer than soloTopSponsors companies have ANY filings, every one of
  // them lands in the batch-1 lane regardless of how small its count is. That
  // is affordable at the real ratio (~2.6k of 19.6k companies join a filing
  // record) but would be expensive if the join ever got much thinner.
  const lanes = assignLanes([company('one')], new Map(), new Map([['one', 1]]));
  assert.deepStrictEqual(lanes.solo.map((c) => c.id), ['one']);
});

check('complexMinSectors puts a moderately-tagged company in the complex lane', () => {
  const registry = [company('tagged')];
  const lanes = assignLanes(registry, new Map([['tagged', state(CFG.complexMinSectors)]]), new Map());
  assert.deepStrictEqual(lanes.complex.map((c) => c.id), ['tagged']);
});

check('solo wins over complex when a company qualifies for both', () => {
  // A top sponsor that also carries enough sectors for the complex band must
  // land in solo exactly once, not in both lanes.
  const registry = [company('both')];
  const lanes = assignLanes(registry, new Map([['both', state(CFG.soloMinSectors)]]), new Map([['both', 99999]]));
  assert.strictEqual(lanes.solo.length, 1);
  assert.strictEqual(lanes.complex.length, 0);
});

check('everything else falls to standard', () => {
  const registry = [company('a'), company('b'), company('c')];
  const lanes = assignLanes(registry, new Map(), new Map());
  assert.strictEqual(lanes.standard.length, 3);
  assert.strictEqual(lanes.solo.length, 0);
  assert.strictEqual(lanes.complex.length, 0);
});

check('every company lands in exactly one lane — none dropped, none duplicated', () => {
  // The cost gate: a company silently in two lanes is paid for twice, and one
  // in no lane is never classified at all.
  const registry = Array.from({ length: 50 }, (_, i) => company(`c${i}`));
  const sectorState = new Map(registry.map((c, i) => [c.id, state(i % 7)]));
  const filings = new Map(registry.map((c, i) => [c.id, i * 3]));
  const lanes = assignLanes(registry, sectorState, filings);

  const all = [...lanes.solo, ...lanes.complex, ...lanes.standard].map((c) => c.id);
  assert.strictEqual(all.length, registry.length, 'total across lanes must equal the registry');
  assert.strictEqual(new Set(all).size, registry.length, 'no company may appear in two lanes');
});

check('LANES covers every lane assignLanes actually produces', () => {
  // LANES drives the script's per-lane loop. A lane produced here but missing
  // from LANES would silently never be classified.
  const lanes = assignLanes([company('x')], new Map(), new Map());
  for (const key of Object.keys(lanes)) {
    assert.ok(LANES.includes(key), `lane "${key}" is produced but missing from LANES`);
  }
  assert.strictEqual(LANES.length, Object.keys(lanes).length);
});

check('registry input order is preserved within each lane', () => {
  const registry = [company('z'), company('y'), company('x')];
  const lanes = assignLanes(registry, new Map(), new Map());
  assert.deepStrictEqual(lanes.standard.map((c) => c.id), ['z', 'y', 'x']);
});

console.log('\nselectStale — what makes the pass resumable, and what protects an admin override:');

check('a never-classified company is selected', () => {
  assert.strictEqual(selectStale([company('new')], new Map()).length, 1);
});

check('a company already at the current version is skipped', () => {
  const sectorState = new Map([['done', state(2, { versions: [CURRENT_VERSION] })]]);
  assert.strictEqual(selectStale([company('done')], sectorState).length, 0);
});

check('a company at an older version is selected', () => {
  const sectorState = new Map([['old', state(2, { versions: [CURRENT_VERSION - 1] })]]);
  assert.deepStrictEqual(selectStale([company('old')], sectorState).map((c) => c.id), ['old']);
});

check('a company with MIXED versions is selected — a half-written company is not done', () => {
  // Real state after an interrupted run: some tags stamped current, some not.
  // Treating it as done would leave the company permanently half-classified.
  const sectorState = new Map([['mixed', state(3, { versions: [CURRENT_VERSION - 1, CURRENT_VERSION] })]]);
  assert.deepStrictEqual(selectStale([company('mixed')], sectorState).map((c) => c.id), ['mixed']);
});

check('an admin-locked company is NEVER selected, even at an older version', () => {
  // The one that would destroy hand-set data. A maintainer's override must
  // survive every automated pass — that is the entire point of the mechanism
  // §4.6.9 offers as the remedy for a classifier the model gets wrong.
  const sectorState = new Map([['locked', state(5, { versions: [CURRENT_VERSION - 1], adminLocked: true })]]);
  assert.strictEqual(selectStale([company('locked')], sectorState).length, 0);
});

check('an admin-locked company is not selected even when never versioned', () => {
  const sectorState = new Map([['locked', state(5, { versions: [], adminLocked: true })]]);
  assert.strictEqual(selectStale([company('locked')], sectorState).length, 0);
});

check('re-running after a completed pass selects nothing — the resumability property', () => {
  const registry = Array.from({ length: 10 }, (_, i) => company(`c${i}`));
  const sectorState = new Map(registry.map((c) => [c.id, state(2, { versions: [CURRENT_VERSION] })]));
  assert.strictEqual(selectStale(registry, sectorState).length, 0, 'a finished pass must cost nothing to re-run');
});

console.log('\nfindCanary — the gate cannot be evaluated if the canary is not found:');

check('finds the canary by BOTH platform and slug, from tunables', () => {
  const registry = [
    company('decoy', { platform: 'greenhouse', slug_or_identifier: CFG.canary.slug }),
    company('real', { platform: CFG.canary.platform, slug_or_identifier: CFG.canary.slug }),
  ];
  assert.strictEqual(findCanary(registry).id, 'real', 'a slug match on the wrong platform is not the canary');
});

check('returns null rather than throwing when the canary is absent', () => {
  assert.strictEqual(findCanary([company('x')]), null);
});

console.log('\nstratify — a sample that exercises the mechanism, not a random one:');

function bigLanes() {
  const mk = (p, n) => Array.from({ length: n }, (_, i) => company(`${p}${i}`));
  return { solo: mk('s', 200), complex: mk('x', 200), standard: mk('t', 2000) };
}

check('solo and complex are each ~20% of the sample, not their share of the registry', () => {
  const size = 500;
  const picked = stratify(bigLanes(), new Map(), size, null);
  assert.strictEqual(picked.solo.length, Math.round(size * 0.2));
  assert.strictEqual(picked.complex.length, Math.round(size * 0.2));
  assert.strictEqual(picked.solo.length + picked.complex.length + picked.standard.length, size);
});

check('half the standard stratum is drawn from the current `other` bucket', () => {
  const lanes = bigLanes();
  const sectorState = new Map(lanes.standard.map((c, i) => [c.id, state(1, { sectors: i % 2 ? ['other'] : ['fintech'] })]));
  const picked = stratify(lanes, sectorState, 500, null);
  const others = picked.standard.filter((c) => (sectorState.get(c.id)?.sectors || []).includes('other'));
  assert.strictEqual(others.length, Math.floor(picked.standard.length / 2));
});

check('the canary is forced into the sample when it would otherwise be missed', () => {
  const lanes = bigLanes();
  const canary = company('canary');
  const picked = stratify(lanes, new Map(), 500, canary);
  assert.strictEqual(picked.solo[0].id, 'canary');
});

check('the canary is not duplicated when it is already in the solo stratum', () => {
  const lanes = bigLanes();
  const canary = lanes.solo[0];
  const picked = stratify(lanes, new Map(), 500, canary);
  assert.strictEqual(picked.solo.filter((c) => c.id === canary.id).length, 1);
});

check('a lane smaller than its quota is not over-drawn', () => {
  const lanes = { solo: [company('s0')], complex: [], standard: Array.from({ length: 100 }, (_, i) => company(`t${i}`)) };
  const picked = stratify(lanes, new Map(), 500, null);
  assert.strictEqual(picked.solo.length, 1);
  assert.strictEqual(picked.complex.length, 0);
});

console.log('\nnormalizeSectors — `other` cannot coexist with a determined sector:');

check('`other` is stripped when a real sector is also present', () => {
  assert.deepStrictEqual(normalizeSectors(['logistics', 'other']), ['logistics']);
});

check('a lone `other` survives — the honest answer for an unidentifiable name', () => {
  assert.deepStrictEqual(normalizeSectors(['other']), ['other']);
});

check('never returns an empty list', () => {
  assert.deepStrictEqual(normalizeSectors([]), []);
  assert.deepStrictEqual(normalizeSectors(['other', 'other']), ['other']);
});

check('duplicates are collapsed', () => {
  assert.deepStrictEqual(normalizeSectors(['fintech', 'fintech', 'ai_ml']), ['fintech', 'ai_ml']);
});

console.log('\nsectors.js makeValidator — the guard between the model and the database:');

const VALIDATOR_IDS = ['c1', 'c2'];
const result = (over) => ({ results: [{ company_id: 'c1', sectors: over }] });

check('a well-formed result passes', () => {
  assert.strictEqual(makeValidator(VALIDATOR_IDS)(result(['fintech'])), null);
});

check('a company_id not in the input set is rejected', () => {
  const err = makeValidator(VALIDATOR_IDS)({ results: [{ company_id: 'ghost', sectors: ['fintech'] }] });
  assert.ok(err && err.includes('ghost'), `got: ${err}`);
});

check('an invented sector is rejected', () => {
  const err = makeValidator(VALIDATOR_IDS)(result(['blockchain_web3']));
  assert.ok(err, 'a sector outside COMPANY_SECTORS must be rejected');
});

check('more than MAX_SECTORS_PER_COMPANY sectors is rejected', () => {
  const tooMany = constants.COMPANY_SECTORS.slice(0, constants.MAX_SECTORS_PER_COMPANY + 1);
  const err = makeValidator(VALIDATOR_IDS)(result(tooMany));
  assert.ok(err, `${tooMany.length} sectors must be rejected at a cap of ${constants.MAX_SECTORS_PER_COMPANY}`);
});

check('exactly MAX_SECTORS_PER_COMPANY is allowed — the cap is inclusive', () => {
  const atCap = constants.COMPANY_SECTORS.slice(0, constants.MAX_SECTORS_PER_COMPANY);
  assert.strictEqual(makeValidator(VALIDATOR_IDS)(result(atCap)), null);
});

check('an empty sector list is rejected — every company gets an answer, even if it is `other`', () => {
  assert.ok(makeValidator(VALIDATOR_IDS)(result([])));
});

console.log(`\n${passed} checks passed`);
process.exit(process.exitCode || 0);

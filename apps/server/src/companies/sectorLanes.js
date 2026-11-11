// Sector-classification lane assignment and pass selection (spec 4.6.9).
//
// These four functions are the decision layer of the registry-wide
// classification pass: which companies get which batch size, which ones this
// pass should touch at all, and which ones a dry run should sample. They are
// PURE — three plain inputs, no I/O, no db, no AI — and they decide how ~19.6k
// companies and roughly a day's cheap-tier quota get spent.
//
// They used to live inside scripts/classify-sectors.js, which has no
// module.exports and calls main() at module scope, so requiring it ran the ETL
// and none of this could be tested. Moved here for the same reason
// scripts/refresh-visa-sponsors.js is a thin wrapper over visa/sponsors.js
// (19.1): the script owns argv, progress output and the run loop; the module
// owns the logic, and is the thing a test can reach.
//
// LANES is exported alongside them because it is the iteration order the
// script's per-lane reporting depends on, and a lane added to tunables'
// batchSizes without being added here would silently never run.

const { constants, tunables } = require('@careeros/shared');

const CFG = tunables.sectorClassification;
const CURRENT_VERSION = constants.SECTOR_CLASSIFIER_VERSION;

const LANES = ['solo', 'complex', 'standard'];

/**
 * Split the registry into the three batch-size lanes.
 *
 * solo (batch 1)     — the top N employers by certified filing volume, plus
 *                      anything already carrying >= soloMinSectors sectors.
 *                      These are the companies whose depth batching costs.
 * complex (batch 5)  — a wider band of the same two signals.
 * standard (batch 50)— everything else, which is almost everything.
 *
 * Both signals are objective and already in the database. No name list.
 *
 * @param {Array<{id: string}>} registry every registry row, in output order
 * @param {Map<string, {count: number, sectors: string[], versions: Set, adminLocked: boolean}>} sectorState
 * @param {Map<string, number>} filings registry id -> certified filing count
 * @returns {{solo: object[], complex: object[], standard: object[]}}
 */
function assignLanes(registry, sectorState, filings) {
  const ranked = [...filings.entries()].sort((a, b) => b[1] - a[1]);
  const topSponsors = new Set(ranked.slice(0, CFG.soloTopSponsors).map(([id]) => id));

  const solo = new Set();
  const complex = new Set();
  for (const c of registry) {
    const n = sectorState.get(c.id)?.count || 0;
    const f = filings.get(c.id) || 0;
    if (topSponsors.has(c.id) || n >= CFG.soloMinSectors) solo.add(c.id);
    else if (f >= CFG.complexMinFilings || n >= CFG.complexMinSectors) complex.add(c.id);
  }

  const lanes = { solo: [], complex: [], standard: [] };
  for (const c of registry) {
    if (solo.has(c.id)) lanes.solo.push(c);
    else if (complex.has(c.id)) lanes.complex.push(c);
    else lanes.standard.push(c);
  }
  return lanes;
}

/**
 * Of a lane's companies, the ones this pass should actually classify:
 * never classified, or classified by a different classifier version.
 * Admin overrides are excluded — a maintainer's hand-set sectors survive every
 * automated pass, which is what makes the override mechanism worth having.
 *
 * This is what makes the pass resumable: re-running after an interruption
 * re-selects only what the previous run had not yet stamped with the current
 * version, so the work already paid for is not paid for twice.
 */
function selectStale(companies, sectorState) {
  return companies.filter((c) => {
    const e = sectorState.get(c.id);
    if (!e) return true; // never classified
    if (e.adminLocked) return false; // maintainer override, never touched
    return !(e.versions.size === 1 && e.versions.has(CURRENT_VERSION));
  });
}

/** The canary company (tunables.sectorClassification.canary), or null. */
function findCanary(registry) {
  return registry.find((c) => c.platform === CFG.canary.platform && c.slug_or_identifier === CFG.canary.slug) || null;
}

/**
 * A stratified sample, not a random one. A random 500 out of 19,647 is ~97%
 * ordinary standard-lane companies, which would tell us nothing about the
 * cases the tiering exists for. Each stratum is classified through its OWN
 * lane's batch size, so the dry run exercises the real mechanism rather than
 * a uniform approximation of it.
 */
function stratify(lanes, sectorState, size, canary) {
  const want = {
    solo: Math.min(lanes.solo.length, Math.round(size * 0.2)),
    complex: Math.min(lanes.complex.length, Math.round(size * 0.2)),
    standard: 0,
  };
  want.standard = Math.max(0, size - want.solo - want.complex);

  const isOther = (c) => (sectorState.get(c.id)?.sectors || []).includes('other');
  const std = lanes.standard;
  const others = std.filter(isOther);
  const rest = std.filter((c) => !isOther(c));

  // Half the standard stratum from the current `other` bucket — the population
  // whose classification is most in question — and half from everything else,
  // so the sample can show regressions on companies that are already right.
  const nOther = Math.min(others.length, Math.floor(want.standard / 2));
  const picked = {
    solo: lanes.solo.slice(0, want.solo),
    complex: lanes.complex.slice(0, want.complex),
    standard: [...others.slice(0, nOther), ...rest.slice(0, want.standard - nOther)],
  };

  // The canary must be in the sample or the gate cannot be evaluated.
  if (canary && !picked.solo.some((c) => c.id === canary.id)) picked.solo.unshift(canary);
  return picked;
}

module.exports = { assignLanes, selectStale, findCanary, stratify, LANES, CURRENT_VERSION };

#!/usr/bin/env node
// experiment-sector-batch-size.js — does the `complex` lane's batch size earn
// its place? (spec 4.6.9)
//
// WHY THIS EXISTS. 4.6.9 assigns each company to one of three lanes and gives
// each lane its own batch size (solo 1, complex 5, standard 50), on the finding
// that large multi-line-of-business companies lose sectors when batched. The
// pass that introduced the lanes measured, in ONE dry-run sample, that the
// complex lane went 2.52 -> 2.35 mean sectors while solo went 2.21 -> 2.42.
// That reads as "batch 5 is too large to buy the depth batch 1 buys", but it is
// a single sample of a noisy metric, and the obvious response — widen the solo
// lane — costs five times the AI calls across the whole band. So it gets
// measured properly first.
//
// WHAT IT DOES. Rebuilds the complex lane exactly as classify-sectors.js does,
// samples it deterministically, and runs THE SAME company set through several
// batch sizes, reporting mean sectors per company for each.
//
// WHAT IT DOES NOT DO — and this is the whole safety posture of the file:
//   * It never writes to company_sectors. It calls the PURE classifyCompanies()
//     from apps/server/src/companies/sectors.js, never classifyAndApply() or
//     applySectors().
//   * It never touches SECTOR_CLASSIFIER_VERSION.
//   * It writes no ai_usage_log row (classifyCompanies does not log; the cost
//     is returned and printed instead).
// It is a measurement, and applying its recommendation means a version bump and
// a full registry re-run, which is a separate deliberate session.
//
// COST. Real cheap-tier AI calls. The default 100-company sample across the
// default arms is ~206 calls, against a measured free-tier ceiling of roughly
// 500/day. Use --arms= to run fewer if quota is tight.
//
// Usage (from repo root):
//   node scripts/experiment-sector-batch-size.js
//   node scripts/experiment-sector-batch-size.js --sample=60 --arms=1,3,5
//   node scripts/experiment-sector-batch-size.js --lane=solo

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin, tunables } = require('@careeros/shared');
const sectorsModule = require(path.join(__dirname, '..', 'apps', 'server', 'src', 'companies', 'sectors'));
const { classifyCompanies } = sectorsModule;

const CFG = tunables.sectorClassification;
const REGISTRY_SELECT_COLS = 'id, company_name_display, platform, slug_or_identifier';
const DEFAULT_ARMS = [1, 2, 3, 5, 50];

function parseArgs(argv) {
  const args = { sample: 100, arms: DEFAULT_ARMS, lane: 'complex', concurrency: CFG.concurrency };
  for (const raw of argv) {
    if (raw.startsWith('--sample=')) args.sample = Number(raw.slice(9));
    else if (raw.startsWith('--arms=')) {
      args.arms = raw
        .slice(7)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    } else if (raw.startsWith('--lane=')) args.lane = raw.slice(7).trim();
    else if (raw.startsWith('--concurrency=')) args.concurrency = Number(raw.slice(14));
    else {
      console.error(`unknown argument: ${raw}`);
      process.exit(1);
    }
  }
  return args;
}

// PostgREST silently caps a select at 1000 rows. Copied per this directory's
// convention rather than shared — see classify-sectors.js's own copy.
async function selectAll(db, table, columns, filterFn) {
  const pageSize = 1000;
  const all = [];
  let offset = 0;
  for (;;) {
    let query = db.from(table).select(columns).order('id', { ascending: true }).range(offset, offset + pageSize - 1);
    if (filterFn) query = filterFn(query);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

// --- the same lane inputs classify-sectors.js uses -------------------------

async function fetchSectorState(db) {
  const rows = await selectAll(db, 'company_sectors', 'company_ats_registry_id, sector, source, classifier_version');
  const byCompany = new Map();
  for (const r of rows) {
    let e = byCompany.get(r.company_ats_registry_id);
    if (!e) {
      e = { count: 0, sectors: [], versions: new Set(), adminLocked: false };
      byCompany.set(r.company_ats_registry_id, e);
    }
    e.count += 1;
    e.sectors.push(r.sector);
    e.versions.add(r.classifier_version);
    if (r.source === 'admin') e.adminLocked = true;
  }
  return byCompany;
}

async function fetchSponsorFilings(db) {
  const rows = await selectAll(db, 'visa_sponsors', 'company_ats_registry_id, filing_count_last_fy', (q) =>
    q.not('company_ats_registry_id', 'is', null)
  );
  const byCompany = new Map();
  for (const r of rows) {
    const prev = byCompany.get(r.company_ats_registry_id) || 0;
    if (r.filing_count_last_fy > prev) byCompany.set(r.company_ats_registry_id, r.filing_count_last_fy);
  }
  return byCompany;
}

// Byte-identical to classify-sectors.js's assignLanes, thresholds and all, so
// the population measured here is the population that lane actually classifies.
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
 * One arm: the whole sample classified at `batchSize`, nothing written.
 * Returns the per-company sector arrays plus what the arm cost.
 */
async function runArm(sample, batchSize, concurrency) {
  const batches = chunk(sample, batchSize);
  let costUsd = 0;
  const byCompanyId = new Map();

  const results = await pooled(batches, concurrency, async (batch) => {
    try {
      return await classifyCompanies(batch);
    } catch (e) {
      console.error(`  arm batch-${batchSize}: a batch of ${batch.length} failed: ${e.message || e}`);
      return null;
    }
  });

  for (const r of results) {
    if (!r) continue;
    costUsd += r.costUsd || 0;
    for (const [id, sectors] of r.byCompanyId) byCompanyId.set(id, sectors);
  }
  return { batchSize, calls: batches.length, byCompanyId, costUsd };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.arms.length) {
    console.error('--arms= left no usable batch sizes');
    process.exit(1);
  }

  const db = getSupabaseAdmin();
  if (!db) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — check apps/server/.env');
    process.exit(1);
  }

  console.log('--- Reading registry state (read-only) ---');
  const registry = await selectAll(db, 'company_ats_registry', REGISTRY_SELECT_COLS);
  const sectorState = await fetchSectorState(db);
  const filings = await fetchSponsorFilings(db);
  const lanes = assignLanes(registry, sectorState, filings);

  console.log(`registry ${registry.length} companies`);
  console.log(`lanes: solo ${lanes.solo.length}, complex ${lanes.complex.length}, standard ${lanes.standard.length}`);

  const laneCompanies = lanes[args.lane];
  if (!laneCompanies) {
    console.error(`unknown lane "${args.lane}" — expected solo, complex or standard`);
    process.exit(1);
  }

  // classifyCompanies does NOT skip admin overrides (only classifyAndApply
  // does), so this excludes them itself. Nothing here writes, but including a
  // company the real pass would never classify would bias the comparison.
  const eligible = laneCompanies.filter((c) => !sectorState.get(c.id)?.adminLocked);

  // Deterministic: registry rows already come back ordered by id, so the same
  // invocation samples the same companies and every arm sees the same set.
  const sample = eligible.slice(0, args.sample);
  if (!sample.length) {
    console.error(`lane "${args.lane}" has no eligible companies to sample`);
    process.exit(1);
  }

  // Guard, not decoration: if a future edit ever reaches for the write path,
  // this catches it. Recorded before and asserted after.
  const rowsBefore = await countSectorRows(db);

  let before = 0;
  for (const c of sample) before += sectorState.get(c.id)?.count || 0;
  const beforeMean = before / sample.length;

  console.log(
    `\n--- Arms: batch ${args.arms.join(', ')} over the SAME ${sample.length} "${args.lane}"-lane companies ---`
  );
  console.log(`projected AI calls: ${args.arms.reduce((n, b) => n + Math.ceil(sample.length / b), 0)}`);
  console.log(`stored "before" mean over this sample: ${beforeMean.toFixed(2)} sectors/company\n`);

  const arms = [];
  for (const batchSize of args.arms) {
    process.stdout.write(`running batch-${batchSize} (${Math.ceil(sample.length / batchSize)} calls)... `);
    const arm = await runArm(sample, batchSize, args.concurrency);

    let after = 0;
    let counted = 0;
    let omitted = 0;
    const sectorHist = new Map();
    for (const c of sample) {
      const now = arm.byCompanyId.get(c.id);
      if (!now) {
        omitted += 1;
        continue;
      }
      after += now.length;
      counted += 1;
      for (const s of now) sectorHist.set(s, (sectorHist.get(s) || 0) + 1);
    }
    arm.mean = counted ? after / counted : 0;
    arm.counted = counted;
    arm.omitted = omitted;
    arm.otherShare = counted ? (sectorHist.get('other') || 0) / counted : 0;
    arms.push(arm);
    console.log(`mean ${arm.mean.toFixed(2)}`);
  }

  console.log('\n--- Results ---');
  console.log(
    'batch'.padStart(6) +
      'calls'.padStart(8) +
      'classified'.padStart(12) +
      'omitted'.padStart(9) +
      'mean'.padStart(8) +
      'vs stored'.padStart(11) +
      "'other'".padStart(9) +
      'cost USD'.padStart(11)
  );
  for (const a of arms) {
    const delta = a.mean - beforeMean;
    console.log(
      String(a.batchSize).padStart(6) +
        String(a.calls).padStart(8) +
        String(a.counted).padStart(12) +
        String(a.omitted).padStart(9) +
        a.mean.toFixed(2).padStart(8) +
        `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`.padStart(11) +
        `${(a.otherShare * 100).toFixed(1)}%`.padStart(9) +
        (a.costUsd ? a.costUsd.toFixed(4) : '—').padStart(11)
    );
  }

  const best = arms.reduce((a, b) => (b.mean > a.mean ? b : a));
  const current = arms.find((a) => a.batchSize === CFG.batchSizes[args.lane]);
  console.log(`\nDeepest arm: batch-${best.mean ? best.batchSize : '?'} at ${best.mean.toFixed(2)} sectors/company.`);
  if (current) {
    const gain = best.mean - current.mean;
    console.log(
      `The "${args.lane}" lane currently runs at batch-${current.batchSize} (${current.mean.toFixed(2)}). ` +
        `Switching to batch-${best.batchSize} would ${gain > 0 ? 'gain' : 'change'} ${gain.toFixed(2)} sectors/company ` +
        `at ${best.calls}/${current.calls} = ${(best.calls / current.calls).toFixed(1)}x the AI calls.`
    );
  }
  console.log(
    '\nNOTHING WAS APPLIED. Acting on this means bumping SECTOR_CLASSIFIER_VERSION\n' +
      'and re-running the registry, which is a separate session (4.6.9).'
  );

  const rowsAfter = await countSectorRows(db);
  console.log(`\ncompany_sectors rows: ${rowsBefore} before, ${rowsAfter} after — ${rowsBefore === rowsAfter ? 'UNCHANGED, as required' : 'CHANGED, which is a BUG in this script'}`);
  if (rowsBefore !== rowsAfter) process.exitCode = 1;
}

async function countSectorRows(db) {
  const { count, error } = await db.from('company_sectors').select('*', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  return count;
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

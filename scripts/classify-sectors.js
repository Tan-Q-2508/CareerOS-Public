#!/usr/bin/env node
// classify-sectors.js — the bulk AI sector-classification pass over
// company_ats_registry (spec 4.6.9; Phase 4, §15 #25b), plus its resumable
// rerun path.
//
// COMMITTED, not an ephemeral scratch script (a deliberate deviation from
// §24's precedent, maintainer decision): it's re-runnable for future
// backfills, needs both Supabase AND Gemini/Vertex credentials (fiddly to
// reconstruct from scratch), and imports classifyAndApply() straight from
// apps/server/src/companies/sectors.js — the exact code path production uses
// for the going-forward detection-time hook, so the bulk pass can't drift
// from it.
//
// Usage (from repo root):
//   node scripts/classify-sectors.js --dry-run                 (stratified 500-company sample, no writes)
//   node scripts/classify-sectors.js --dry-run --out=dry.json  (…and dump the full result)
//   node scripts/classify-sectors.js --apply                   (classify everything stale)
//   node scripts/classify-sectors.js --apply --lanes=solo,complex
//   node scripts/classify-sectors.js --apply --limit=500
//
// ---------------------------------------------------------------------------
// TWO IDEAS DO ALL THE WORK HERE. Both were measured, not assumed.
//
// 1. VERSIONED SELECTION (4.6.9). A company is "done" when its company_sectors
//    rows carry the current SECTOR_CLASSIFIER_VERSION — not merely when it has
//    rows at all. Selection is therefore "no rows, OR rows at another version",
//    which makes the pass resumable by construction (a crash at 90% resumes at
//    90%), sliceable under a daily cap, and a no-op once complete. The old
//    row-existence selector could only ever express "never classified", which
//    forced every prompt change into an all-or-nothing --force re-run.
//
//    source='admin' companies are excluded from selection entirely. Not
//    because classifyAndApply would overwrite them — it refuses to, even under
//    force — but because a company it refuses to write never gets stamped with
//    the current version, so a version-based selector would re-select it on
//    every run forever, burning a slot each time.
//
// 2. TIERED BATCH SIZING. Batch size materially degrades classification DEPTH
//    for large multi-line-of-business companies, and only for them. Amazon in a
//    100-company batch comes back `consumer, ecommerce, enterprise_saas`; the
//    identical row classified ALONE comes back with seven sectors including
//    `logistics`. But a controlled 25-company sample of ordinary companies
//    showed batch-25 vs batch-100 is pure noise (mean 1.96 -> 2.00 sectors, 16
//    of 25 identical), so shrinking the global batch would cost 4x the calls to
//    change nothing.
//
//    So difficulty decides batch size, per company, from two objective signals
//    already in the database — never a hand-picked list of famous names:
//      - certified H-1B filing volume in visa_sponsors (19.2), which is what a
//        company with many divisions looks like in that data; and
//      - the classifier's own breadth signal, the sector count it already
//        carries.
//    Lane thresholds live in tunables.sectorClassification.
// ---------------------------------------------------------------------------

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin, constants, tunables } = require('@careeros/shared');
const sectorsModule = require(path.join(__dirname, '..', 'apps', 'server', 'src', 'companies', 'sectors'));
const { classifyCompanies } = sectorsModule;

// The lane assigner, the stale selector, the canary finder and the stratified
// sampler live in the server module so they are reachable by a test — this
// script owns argv, progress output and the run loop, nothing more. Same split
// as refresh-visa-sponsors.js over visa/sponsors.js (19.1).
const {
  assignLanes,
  selectStale,
  findCanary,
  stratify,
  LANES,
  CURRENT_VERSION,
} = require(path.join(__dirname, '..', 'apps', 'server', 'src', 'companies', 'sectorLanes'));

const CFG = tunables.sectorClassification;
const REGISTRY_SELECT_COLS = 'id, company_name_display, platform, slug_or_identifier';

function parseArgs(argv) {
  const args = { dryRun: false, apply: false, limit: null, concurrency: CFG.concurrency, out: null, lanes: LANES };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--apply') args.apply = true;
    else if (raw.startsWith('--limit=')) args.limit = Number(raw.slice('--limit='.length));
    else if (raw.startsWith('--concurrency=')) args.concurrency = Number(raw.slice('--concurrency='.length));
    else if (raw.startsWith('--out=')) args.out = raw.slice('--out='.length);
    else if (raw.startsWith('--lanes=')) {
      args.lanes = raw
        .slice('--lanes='.length)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => LANES.includes(s));
    }
  }
  return args;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// PostgREST caps a single select at 1000 rows regardless of a missing
// .limit() — silently, no error, no truncation flag. At 19.6k+ registry
// companies and ~1.5 sectors/company, every unpaginated select in this script
// needs this helper or it silently underreports. (Bug caught live, 2026-08-06:
// printGoNoGoGates first ran without this and reported a false GATE FAILED off
// a 1000-row-truncated company_sectors read.)
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

// Small inline worker pool — same shape as registry.js's own inline pool.
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length)))
    .fill(0)
    .map(async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return out;
}

// --- state the lane assigner and the selector both need -------------------

/**
 * Every registry row. NO status filter, deliberately: a parked row keeps
 * whatever sectors it was last given, and skipping it means that staleness is
 * permanent and invisible. Classification is a fact about the company, not
 * about whether we're currently scanning its board.
 */
async function fetchRegistry(db) {
  return selectAll(db, 'company_ats_registry', REGISTRY_SELECT_COLS);
}

/**
 * Per-company sector state: how many sectors it carries, which classifier
 * versions those rows are stamped with, and whether an admin has overridden it.
 */
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

/** company_ats_registry_id -> certified H-1B filing count (19.2). */
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

// assignLanes / selectStale / findCanary live in
// apps/server/src/companies/sectorLanes.js — see the require at the top.

// --- reporting ------------------------------------------------------------

function sampleReport(byCompanyId, companies) {
  const bySector = new Map();
  const byId = new Map(companies.map((c) => [c.id, c]));
  for (const [companyId, sectorList] of byCompanyId.entries()) {
    for (const sector of sectorList) {
      if (!bySector.has(sector)) bySector.set(sector, []);
      bySector.get(sector).push(byId.get(companyId)?.company_name_display || companyId);
    }
  }
  const report = {};
  for (const sector of constants.COMPANY_SECTORS) {
    const names = bySector.get(sector) || [];
    report[sector] = { count: names.length, sample: names.slice(0, 10) };
  }
  return report;
}

function printLaneTable(lanes, stalePerLane) {
  console.log('\nLane assignment (batch size decided per company, see header):');
  let calls = 0;
  for (const lane of LANES) {
    const size = CFG.batchSizes[lane];
    const stale = stalePerLane[lane].length;
    const laneCalls = Math.ceil(stale / size);
    calls += laneCalls;
    console.log(`  ${lane.padEnd(9)} batch=${String(size).padStart(3)}  ${String(lanes[lane].length).padStart(6)} companies, ${String(stale).padStart(6)} stale -> ${laneCalls} calls`);
  }
  console.log(`  ${''.padEnd(9)}${''.padStart(11)}${''.padStart(6)}${''.padStart(21)}= ${calls} AI calls total`);
  return calls;
}

// --- dry run --------------------------------------------------------------

// stratify() lives in apps/server/src/companies/sectorLanes.js.

async function classifyLaneSample(lane, companies, concurrency) {
  const byCompanyId = new Map();
  let costUsd = 0;
  const batches = chunk(companies, CFG.batchSizes[lane]);
  let done = 0;
  await pooled(batches, concurrency, async (batch) => {
    const result = await classifyCompanies(batch);
    costUsd += result.costUsd || 0;
    for (const [id, sectorList] of result.byCompanyId.entries()) byCompanyId.set(id, sectorList);
    done += batch.length;
    if (batches.length > 4) console.log(`    ${lane}: ${done}/${companies.length}`);
  });
  return { byCompanyId, costUsd, calls: batches.length };
}

async function runDryRun(db, args) {
  const [registry, sectorState, filings] = await Promise.all([fetchRegistry(db), fetchSectorState(db), fetchSponsorFilings(db)]);
  const lanes = assignLanes(registry, sectorState, filings);
  const canary = findCanary(registry);
  const size = args.limit || CFG.dryRunSampleSize;
  const sample = stratify(lanes, sectorState, size, canary);

  const total = LANES.reduce((n, l) => n + sample[l].length, 0);
  console.log(`Dry run: ${total} companies, stratified across lanes, NO writes.`);
  for (const lane of LANES) console.log(`  ${lane.padEnd(9)} ${sample[lane].length} companies at batch=${CFG.batchSizes[lane]}`);

  const byCompanyId = new Map();
  let costUsd = 0;
  let calls = 0;
  for (const lane of LANES) {
    if (!sample[lane].length) continue;
    console.log(`\n  classifying ${lane} lane...`);
    const r = await classifyLaneSample(lane, sample[lane], args.concurrency);
    for (const [id, s] of r.byCompanyId.entries()) byCompanyId.set(id, s);
    costUsd += r.costUsd;
    calls += r.calls;
  }

  const all = [...sample.solo, ...sample.complex, ...sample.standard];
  const report = sampleReport(byCompanyId, all);
  console.log(`\nEstimated cost for this sample: $${costUsd.toFixed(4)} (${calls} calls)`);
  console.log('\nPer-sector counts + sample (first 10 names):');
  for (const [sector, info] of Object.entries(report)) {
    console.log(`  ${sector.padEnd(26)} ${String(info.count).padStart(4)}  ${info.sample.slice(0, 6).join(', ')}`);
  }

  // Before/after, so the sample answers "did this get better", not just
  // "what did it say".
  let before = 0;
  let after = 0;
  let counted = 0;
  for (const c of all) {
    const now = byCompanyId.get(c.id);
    if (!now) continue;
    before += sectorState.get(c.id)?.count || 0;
    after += now.length;
    counted += 1;
  }
  console.log(`\nMean sectors/company over the sample: ${(before / counted).toFixed(2)} before -> ${(after / counted).toFixed(2)} after (${counted} companies)`);

  const gatesOk = printDryRunGates(byCompanyId, all, canary, sectorState);

  if (args.out) {
    const fs = require('fs');
    const laneOf = new Map();
    for (const lane of LANES) for (const c of sample[lane]) laneOf.set(c.id, lane);
    const dump = all.map((c) => ({
      ...c,
      lane: laneOf.get(c.id),
      before: sectorState.get(c.id)?.sectors || [],
      after: byCompanyId.get(c.id) || [],
    }));
    fs.writeFileSync(args.out, JSON.stringify({ report, companies: dump }, null, 2));
    console.log(`\nFull dump written to ${args.out}`);
  }

  if (!gatesOk) process.exitCode = 1;
}

/**
 * The pre-apply gates. Deliberately NOT symmetrical with the post-apply ones:
 * this runs on a sample and can check the canary, which is the whole point.
 */
function printDryRunGates(byCompanyId, companies, canary, sectorState) {
  console.log('\n--- Pre-apply gates (dry run) ---');
  let ok = true;

  const zero = companies.filter((c) => {
    const s = byCompanyId.get(c.id);
    return s && s.length === 0;
  }).length;
  console.log(`Companies classified into 0 sectors: ${zero} (must be 0)`);
  if (zero > 0) ok = false;

  const over = [...byCompanyId.values()].filter((s) => s.length > constants.MAX_SECTORS_PER_COMPANY).length;
  console.log(`Companies over the ${constants.MAX_SECTORS_PER_COMPANY}-sector cap: ${over} (must be 0)`);
  if (over > 0) ok = false;

  const otherCount = [...byCompanyId.values()].filter((s) => s.includes('other')).length;
  const share = byCompanyId.size ? otherCount / byCompanyId.size : 0;
  // REPORTED, NOT GATED, on purpose. Without richer classifier input there is
  // no defensible threshold, and gating on it would pressure the classifier
  // into guessing at companies with no recoverable identity from a name alone
  // ("rcc", "lab37", "Stealth Co"). Guessing on those is the never-fabricate
  // rule broken for a nicer-looking number.
  console.log(`'other' share: ${(share * 100).toFixed(1)}% (${otherCount}/${byCompanyId.size}) — reported, not gated`);

  // The canary. §15 #51 raised the taxonomy specifically because Amazon had
  // lost `logistics`, and it never came back under any batch size above 1.
  // This asserts the MECHANISM recovered it — a hand-written source:'admin'
  // row would satisfy the metric while proving nothing, so it is not used.
  if (!canary) {
    console.log(`Canary company (${CFG.canary.platform}/${CFG.canary.slug}): NOT FOUND in registry — cannot evaluate`);
    ok = false;
  } else {
    const got = byCompanyId.get(canary.id) || [];
    const had = sectorState.get(canary.id)?.sectors || [];
    const hit = got.includes(CFG.canary.sector);
    console.log(`Canary ${canary.company_name_display}: was [${had.join(', ')}] -> now [${got.join(', ')}]`);
    console.log(`  must include "${CFG.canary.sector}": ${hit ? 'YES' : 'NO'}`);
    if (!hit) ok = false;
  }

  console.log(ok ? '\nAll pre-apply gates passed — safe to --apply.' : '\n*** GATE FAILED — do not apply. Re-tune the prompt or lane thresholds. ***');
  return ok;
}

// --- apply ----------------------------------------------------------------

async function runApply(db, args) {
  const [registry, sectorState, filings] = await Promise.all([fetchRegistry(db), fetchSectorState(db), fetchSponsorFilings(db)]);
  const lanes = assignLanes(registry, sectorState, filings);

  const stalePerLane = {};
  for (const lane of LANES) stalePerLane[lane] = selectStale(lanes[lane], sectorState);
  printLaneTable(lanes, stalePerLane);

  const adminLocked = [...sectorState.values()].filter((e) => e.adminLocked).length;
  console.log(`\nClassifier version: ${CURRENT_VERSION}. Admin-overridden companies excluded from selection: ${adminLocked}.`);

  const running = args.lanes;
  if (running.length !== LANES.length) console.log(`Running lanes: ${running.join(', ')} (of ${LANES.join(', ')})`);

  const touchedIds = [];
  let classified = 0;
  let skipped = 0;

  for (const lane of running) {
    let companies = stalePerLane[lane];
    if (args.limit) companies = companies.slice(0, args.limit);
    if (!companies.length) {
      console.log(`\n${lane} lane: nothing stale, skipping.`);
      continue;
    }
    const batches = chunk(companies, CFG.batchSizes[lane]);
    console.log(`\n${lane} lane: ${companies.length} companies in ${batches.length} batches of ${CFG.batchSizes[lane]}...`);
    let done = 0;
    await pooled(batches, args.concurrency, async (batch) => {
      // syncTracklists:false — the per-company tracklist sync is ~4 round trips
      // and dominates a registry-wide pass (measured live: ~125 companies/min,
      // essentially all of it tracklist bookkeeping redone one company at a
      // time). One batched sync over every touched id runs after the loop.
      const result = await sectorsModule.classifyAndApply(db, batch, { source: 'ai_bulk', force: true, syncTracklists: false });
      classified += result.classified;
      skipped += result.skipped;
      done += batch.length;
      if (done % (CFG.batchSizes[lane] * 10) < CFG.batchSizes[lane] || done === companies.length) {
        console.log(`  ${lane}: ${done}/${companies.length}`);
      }
    });
    touchedIds.push(...companies.map((c) => c.id));
  }

  console.log(`\nDone. classified=${classified} skipped=${skipped}`);

  if (!touchedIds.length) {
    console.log('Nothing was written — every selected company was already at the current classifier version.');
    return;
  }

  // The batched replacement for the per-company sync skipped above. Chunked
  // because syncSectorTracklists issues `.in(ids)` queries, and 19k ids in a
  // single filter is neither valid nor fast.
  //
  // This touches SECTOR tracklists only. The two sponsor tracklists (19.5) are
  // maintained by apps/server/src/visa/sponsorTracklists.js and are deliberately
  // NOT rebuilt here — a sector pass has no business touching them.
  console.log('\nRebuilding sector tracklist membership...');
  const SYNC_CHUNK = 400;
  for (let i = 0; i < touchedIds.length; i += SYNC_CHUNK) {
    await sectorsModule.syncSectorTracklists(db, touchedIds.slice(i, i + SYNC_CHUNK));
    if ((i / SYNC_CHUNK) % 10 === 0) console.log(`  synced ${Math.min(i + SYNC_CHUNK, touchedIds.length)}/${touchedIds.length}`);
  }
  console.log('  tracklist sync complete.');

  await printGoNoGoGates(db);
}

async function printGoNoGoGates(db) {
  console.log('\n--- Post-apply go/no-go gates ---');

  const registry = await fetchRegistry(db);
  const sectorState = await fetchSectorState(db);

  const counts = new Map();
  let tagRows = 0;
  for (const e of sectorState.values()) {
    for (const s of e.sectors) {
      counts.set(s, (counts.get(s) || 0) + 1);
      tagRows += 1;
    }
  }
  console.log(`Per-sector counts (${tagRows} tag rows):`);
  for (const sector of constants.COMPANY_SECTORS) console.log(`  ${sector.padEnd(26)} ${counts.get(sector) || 0}`);

  // Denominator is the WHOLE registry, matching what the pass now covers —
  // the status='active' filter was removed from selection, so keeping it here
  // would measure a different population than the one classified.
  const zeroSector = registry.filter((c) => !sectorState.has(c.id)).length;
  const overMax = [...sectorState.values()].filter((e) => e.count > constants.MAX_SECTORS_PER_COMPANY).length;
  const otherCount = counts.get('other') || 0;
  const totalClassified = registry.length - zeroSector;
  const otherShare = totalClassified ? otherCount / totalClassified : 0;
  const meanSectors = totalClassified ? tagRows / totalClassified : 0;

  const stale = registry.filter((c) => {
    const e = sectorState.get(c.id);
    return e && !e.adminLocked && !(e.versions.size === 1 && e.versions.has(CURRENT_VERSION));
  }).length;

  console.log(`\nRegistry companies: ${registry.length}`);
  console.log(`Companies with 0 sectors: ${zeroSector} (must be 0)`);
  console.log(`Companies with >${constants.MAX_SECTORS_PER_COMPANY} sectors: ${overMax} (must be 0)`);
  console.log(`Mean sectors/company: ${meanSectors.toFixed(2)}`);
  console.log(`'other' share: ${(otherShare * 100).toFixed(1)}% (${otherCount}/${totalClassified}) — reported, not gated (see header)`);
  console.log(`Still stale (not at classifier version ${CURRENT_VERSION}): ${stale} — re-run to finish`);

  const canary = findCanary(registry);
  if (canary) {
    const e = sectorState.get(canary.id);
    const got = e?.sectors || [];
    console.log(`Canary ${canary.company_name_display}: [${got.join(', ')}] — includes "${CFG.canary.sector}": ${got.includes(CFG.canary.sector) ? 'YES' : 'NO'}`);
  }

  if (zeroSector > 0 || overMax > 0) {
    console.log('\n*** GATE FAILED — see above. Do not consider this pass complete. ***');
    process.exitCode = 1;
  } else {
    console.log('\nAll gates passed.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !args.apply) {
    console.error('Usage: node scripts/classify-sectors.js (--dry-run | --apply) [--limit=N] [--concurrency=N] [--lanes=solo,complex,standard] [--out=path]');
    process.exit(1);
  }

  const db = getSupabaseAdmin();
  if (!db) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — check apps/server/.env');
    process.exit(1);
  }

  if (args.dryRun) await runDryRun(db, args);
  else await runApply(db, args);
}

// Guarded so this file can be REQUIRED without running the ETL. It used to call
// main() at module scope, which meant a test importing it kicked off a
// registry-wide classification pass — so parseArgs, chunk and the reporting
// helpers were unreachable by any test, and both Phase 5.5 closeouts carried
// that forward as an open item. The pure argv/chunking layer is exported below;
// the run loop and the reporting helpers stay private, and a later session
// extending this script should move what it touches out to
// companies/sectorLanes.js rather than adding to the untestable part.
if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });
}

module.exports = { parseArgs, chunk, main };

#!/usr/bin/env node
// backfill-job-registry-ids.js — one-time backfill of jobs.company_ats_registry_id
// for jobs rows that predate the column (spec 4.6.10's "previously unflagged
// gap"; Phase 4, §15 #25c-1).
//
// COMMITTED, following scripts/classify-sectors.js's precedent (re-runnable,
// imports linkJobsToRegistry() straight from
// apps/server/src/companies/registry.js — the exact code path runScan.js and
// manualEntry.js use going forward, so this backfill can't drift from it).
//
// Usage (from repo root):
//   node scripts/backfill-job-registry-ids.js --dry-run
//   node scripts/backfill-job-registry-ids.js --apply
//
// Resumable by construction: only ever selects `jobs` rows with a null
// company_ats_registry_id, so re-running after a partial run or a crash
// simply picks up whatever's still unlinked — no cursor/state file needed.
// A row stays permanently unlinked only if its company name never resolved
// into the registry (never scanned/detected) or it's missing company_name/
// dedup_key — neither is a bug in this script.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin } = require('@careeros/shared');
const { linkJobsToRegistry } = require(path.join(__dirname, '..', 'apps', 'server', 'src', 'companies', 'registry'));

function parseArgs(argv) {
  const args = { dryRun: false, apply: false };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--apply') args.apply = true;
  }
  return args;
}

// PostgREST caps a single select at 1000 rows regardless of a missing
// .limit() — silently, no error, no truncation flag. Same gotcha §15 #25b
// caught in scripts/classify-sectors.js; every unpaginated select here goes
// through this helper.
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

async function fetchUnlinked(db) {
  return selectAll(db, 'jobs', 'id, user_id, company_name, dedup_key', (q) => q.is('company_ats_registry_id', null));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !args.apply) {
    console.error('Usage: node scripts/backfill-job-registry-ids.js (--dry-run | --apply)');
    process.exit(1);
  }

  const db = getSupabaseAdmin();
  if (!db) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — check apps/server/.env');
    process.exit(1);
  }

  const rows = await fetchUnlinked(db);
  console.log(`Found ${rows.length} jobs row(s) with no company_ats_registry_id.`);

  // linkJobsToRegistry is scoped to one user_id per call (jobs is user-scoped/
  // RLS'd), so group before dispatching.
  const byUser = new Map();
  let skippedNoKey = 0;
  for (const r of rows) {
    if (!r.company_name || !r.dedup_key) {
      skippedNoKey += 1;
      continue;
    }
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push({ companyName: r.company_name, dedupKey: r.dedup_key });
  }
  console.log(`${byUser.size} distinct user(s); ${skippedNoKey} row(s) skipped (missing company_name/dedup_key).`);

  if (args.dryRun) {
    console.log('Dry run — no writes.');
    return;
  }

  let totalLinked = 0;
  let usersDone = 0;
  for (const [userId, jobs] of byUser.entries()) {
    const { linked } = await linkJobsToRegistry(db, userId, { jobs });
    totalLinked += linked;
    usersDone += 1;
    if (usersDone % 25 === 0 || usersDone === byUser.size) {
      console.log(`  progress: ${usersDone}/${byUser.size} users, ${totalLinked} linked so far`);
    }
  }

  console.log(`\nDone. ${totalLinked} job row(s) linked across ${byUser.size} user(s).`);

  const stillUnlinked = await fetchUnlinked(db);
  console.log(
    `Remaining unlinked: ${stillUnlinked.length} (no matching registry row, or missing company_name/dedup_key — not a bug).`
  );
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

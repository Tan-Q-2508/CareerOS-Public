#!/usr/bin/env node
// audit-visa-sponsorship.js — retro-audit of every already-stored job
// against the fixed visa/sponsorship-refusal detector (bug fix 2026-08-15,
// see packages/shared/src/sourcing/prefilter.js's detectVisaReject and its
// tunables.json visaRejectPatterns). Root cause: the OLD prefilter used a
// plain exact-substring phrase list that missed any real-world phrasing with
// a qualifier interposed between the negation and "sponsor" — confirmed
// live on a U-Haul JD reading "This position is not eligible for EMPLOYER
// sponsorship.", which matched none of 21 literal phrases. Every job scanned
// before that fix shipped was checked against the broken list, so some
// no-sponsorship postings slipped through and are sitting in the dashboard
// right now.
//
// This script re-runs the NEW detector against every stored job's full JD
// text and reports what it finds. It mirrors the exact keep/delete rule
// already used by DELETE /api/scan/:id (apps/server/src/routes/scan.js):
// a matched job still at application stage 'Saved' with no generated
// document is exactly what a scan-time drop would have discarded, so
// --apply deletes it. A matched job the user has already acted on (moved
// past Saved, or generated a résumé/cover letter for) is NEVER deleted —
// instead it gets the same deterministic `visa: high` risk tag the fixed
// scoreJob.js now forces going forward, so it starts showing the US-ONLY
// badge instead of looking clean.
//
// Usage (from repo root):
//   node scripts/audit-visa-sponsorship.js --dry-run     (default; report only, no writes)
//   node scripts/audit-visa-sponsorship.js --apply       (deletes/flags per the rule above)
//
// Always run --dry-run first and read the printed matches before --apply —
// a false positive under --apply silently deletes a job.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin, detectVisaReject } = require('@careeros/shared');

function parseArgs(argv) {
  const args = { dryRun: false, apply: false };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--apply') args.apply = true;
  }
  return args;
}

// PostgREST caps a single select at 1000 rows regardless of a missing
// .limit() — silently, no error, no truncation flag (same gotcha
// scripts/backfill-keyword-coverage.js, scripts/classify-sectors.js, and
// scripts/backfill-job-registry-ids.js already document). Every unpaginated
// select here goes through this.
async function selectAll(db, table, columns, filterFn) {
  const pageSize = 1000;
  const all = [];
  let offset = 0;
  for (;;) {
    let query = db.from(table).select(columns).order('id', { ascending: true }).range(offset, offset + pageSize - 1);
    if (filterFn) query = filterFn(query);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !args.apply) {
    console.error('Usage: node scripts/audit-visa-sponsorship.js (--dry-run | --apply)');
    process.exit(1);
  }

  const db = getSupabaseAdmin();
  if (!db) {
    console.error('SUPABASE_URL / SUPABASE_SECRET_KEY not set — check apps/server/.env');
    process.exit(1);
  }

  const jobs = await selectAll(
    db,
    'jobs',
    'id, user_id, title, company_name, scan_history_id, risk_tags, description_text',
    (q) => q.not('description_text', 'is', null)
  );
  console.log(`Scanned ${jobs.length} job(s) with a stored JD.`);

  const matches = [];
  for (const job of jobs) {
    const match = detectVisaReject(job.description_text || '');
    if (match) matches.push({ job, match });
  }

  console.log(`Matched ${matches.length} job(s) against the fixed detector.\n`);
  if (!matches.length) {
    console.log('Nothing to do.');
    return;
  }

  const scanIds = [...new Set(matches.map((m) => m.job.scan_history_id).filter(Boolean))];
  const jobIds = matches.map((m) => m.job.id);

  const [{ data: scans }, { data: nonSaved }, { data: withDocs }] = await Promise.all([
    scanIds.length ? db.from('scan_history').select('id, config').in('id', scanIds) : { data: [] },
    db.from('applications').select('job_id, stage').in('job_id', jobIds).neq('stage', 'Saved'),
    db.from('generated_documents').select('job_id').in('job_id', jobIds),
  ]);
  const scanById = new Map((scans || []).map((s) => [s.id, s]));
  const keepIds = new Set([...(nonSaved || []).map((a) => a.job_id), ...(withDocs || []).map((d) => d.job_id)]);

  const toDelete = [];
  const toFlag = [];
  for (const { job, match } of matches) {
    const scanTitle = job.scan_history_id
      ? (scanById.get(job.scan_history_id)?.config?.job_titles || []).join(', ') || '(manual/other)'
      : '(manual entry)';
    const row = { job, match, scanTitle };
    if (keepIds.has(job.id)) toFlag.push(row);
    else toDelete.push(row);
  }

  console.log(`  ${toDelete.length} job(s) still at 'Saved' with no documents → would be DELETED.`);
  console.log(`  ${toFlag.length} job(s) already acted on → would be KEPT and flagged US-ONLY.\n`);

  function printRow({ job, match, scanTitle }) {
    console.log(`  [${job.id}] ${job.company_name || '(unknown company)'} — "${job.title}" (scan: ${scanTitle})`);
    console.log(`      matched: "${match}"`);
  }

  if (toDelete.length) {
    console.log('--- To delete (Saved, no generated documents) ---');
    toDelete.forEach(printRow);
    console.log('');
  }
  if (toFlag.length) {
    console.log('--- To keep + flag US-ONLY (already acted on) ---');
    toFlag.forEach(printRow);
    console.log('');
  }

  if (!args.apply) {
    console.log('Dry run only — nothing changed. Re-run with --apply to make these changes.');
    return;
  }

  if (toDelete.length) {
    const deleteIds = toDelete.map((r) => r.job.id);
    const { error } = await db.from('jobs').delete().in('id', deleteIds);
    if (error) throw new Error(`delete failed: ${error.message}`);
    console.log(`Deleted ${deleteIds.length} job(s).`);
  }

  if (toFlag.length) {
    let flagged = 0;
    for (const { job, match } of toFlag) {
      const tags = Array.isArray(job.risk_tags) ? job.risk_tags.map((t) => ({ ...t })) : [];
      const reason = `Posting states "${match}" — this role does not sponsor work visas.`;
      const i = tags.findIndex((t) => t && t.type === 'visa');
      if (i >= 0) tags[i] = { ...tags[i], severity: 'high', reason };
      else tags.push({ type: 'visa', severity: 'high', reason });
      const { error } = await db.from('jobs').update({ risk_tags: tags }).eq('id', job.id);
      if (error) {
        console.error(`  failed to flag job ${job.id}: ${error.message}`);
        continue;
      }
      flagged += 1;
    }
    console.log(`Flagged ${flagged} job(s) with a forced visa/high risk tag.`);
  }

  console.log(`\nDone. Scanned ${jobs.length}, matched ${matches.length}, deleted ${toDelete.length}, kept+flagged ${toFlag.length}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

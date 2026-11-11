#!/usr/bin/env node
// park-dead-boards.js — ATS board health sweep, out-of-band maintenance
// batch (2026-08-18). Supersedes probe-ats-registry.js and
// probe-workable-registry.js: same probe-reuse approach (each platform's own
// adapter.probe(slug) — the exact call ATS Direct itself makes at scan
// time), extended to also cover Workday (never probed before this) and to
// actually finish the job — a confirmed-dead board now moves into
// company_ats_unresolved (the "unidentified job boards" table) instead of
// being left flagged status='pending_adapter' inside company_ats_registry.
//
// Requires migration 20260818000000_ats_unresolved_board_dead.sql applied
// first (adds 'board_confirmed_dead' to company_ats_unresolved's
// match_attempt_type check).
//
// Two steps:
//   A. Sweep rows already flagged status='pending_adapter' (from the prior
//      session's partial probe runs) or status='board_gone' (a scan's fetch
//      404'd and a follow-up probe confirmed it) straight into
//      company_ats_unresolved — already confirmed dead, no need to re-probe.
//   B. Probe every row with probed_at IS NULL, per platform. 404 -> move
//      into company_ats_unresolved directly. Success -> stamp probed_at.
//      Inconclusive (timeout, non-404) -> stamp probed_at AND
//      probe_outcome='inconclusive', leave in registry (not evidence the
//      board is actually dead, but now findable for a targeted re-probe:
//      `--only-inconclusive`). A successful probe records
//      probe_outcome='ok' for the same reason.
//
// RATE LIMITS: Workable already gates itself (tunables.atsDirect.platforms.
// workable.minRequestIntervalMs) — no extra pacing added here. Greenhouse/
// Lever/Ashby/Workday have no built-in gate, so this script adds its own
// conservative sequential delay (default 750ms, --interval-ms=N) between
// requests, per platform, run one at a time.
//
// SAFETY: never hard-deletes a company — a "dead" board just moves tables;
// the periodic resweep (resweep.js, every 2-3 days) will keep re-checking it
// and can promote it back to the registry if it comes back.
//
// Usage:
//   node scripts/check-no-running-scans.js       (or let this script's own guard catch it)
//   node scripts/park-dead-boards.js --dry-run [--platform=lever] [--limit=20]
//   node scripts/park-dead-boards.js --apply    [--platform=lever]

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin, atsDirect } = require('@careeros/shared');

const PLATFORMS = ['greenhouse', 'lever', 'ashby', 'workable', 'workday', 'oracle', 'eightfold', 'avature', 'apple', 'amazon', 'google', 'meta', 'phenom', 'smartrecruiters', 'recruitee', 'bamboohr', 'breezy', 'rippling', 'successfactors', 'taleo', 'icims', 'jibe', 'radancy', 'ycombinator'];
const NO_BUILTIN_GATE = new Set(['greenhouse', 'lever', 'ashby', 'workday', 'oracle', 'eightfold', 'avature', 'apple', 'amazon', 'google', 'meta', 'phenom', 'smartrecruiters', 'recruitee', 'bamboohr', 'breezy', 'rippling', 'successfactors', 'taleo', 'icims', 'jibe', 'radancy', 'ycombinator']);

function parseArgs(argv) {
  const args = { dryRun: true, limit: null, platform: null, intervalMs: 750, onlyInconclusive: false };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.dryRun = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--limit=')) args.limit = Number(a.split('=')[1]);
    else if (a.startsWith('--platform=')) args.platform = a.split('=')[1];
    else if (a.startsWith('--interval-ms=')) args.intervalMs = Number(a.split('=')[1]);
    // Re-probe rows a previous sweep could not resolve, instead of rows never
    // probed at all. A timeout is not evidence a board is dead, so those rows
    // stay in the registry — but they also stop being reachable by the default
    // `probed_at IS NULL` selection, which is how a batch of them once became
    // permanently unidentifiable.
    else if (a === '--only-inconclusive') args.onlyInconclusive = true;
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUniqueViolation(error) {
  return error && (error.code === '23505' || /duplicate key value/i.test(error.message || ''));
}

/**
 * Move a company_ats_registry row into company_ats_unresolved (the reverse
 * of resweep.js's promoteToRegistry). Insert-then-delete, race-tolerant: if
 * a concurrent path already parked the same normalized name, that's still a
 * successful outcome — just count it as a sighting bump instead of losing it.
 */
async function demoteToUnresolved(db, row, { dryRun }) {
  if (dryRun) return { ok: true };

  const { error: insErr } = await db.from('company_ats_unresolved').insert({
    company_name_normalized: row.company_name_normalized,
    company_name_display: row.company_name_display,
    match_attempt_type: 'board_confirmed_dead',
    careers_url_guess: null,
    source: row.source,
  });

  if (insErr && !isUniqueViolation(insErr)) {
    return { ok: false, error: insErr.message };
  }
  if (insErr && isUniqueViolation(insErr)) {
    await db
      .from('company_ats_unresolved')
      .update({ last_seen_at: new Date().toISOString(), last_attempt_at: new Date().toISOString() })
      .eq('company_name_normalized', row.company_name_normalized);
  }

  const { error: delErr } = await db.from('company_ats_registry').delete().eq('id', row.id);
  if (delErr) return { ok: false, error: delErr.message };
  return { ok: true };
}

async function assertNoRunningScans(db) {
  const { data, error } = await db.from('scan_history').select('id').eq('status', 'running').limit(1);
  if (error) {
    console.error('park-dead-boards: could not check scan_history, proceeding anyway:', error.message);
    return;
  }
  if (data && data.length) {
    console.error('park-dead-boards: BLOCKED — a scan is currently running. Wait for it to finish and re-run.');
    process.exit(1);
  }
}

async function sweepFlagged(db, { dryRun, platform }) {
  let query = db
    .from('company_ats_registry')
    .select('id, company_name_normalized, company_name_display, platform, source')
    // 'board_gone': a scan's full-board fetch 404'd and a follow-up probe
    // confirmed it (atsDirectRun.retireGoneBoard) — already confirmed dead.
    .in('status', ['pending_adapter', 'board_gone']);
  if (platform) query = query.eq('platform', platform);

  const { data: rows, error } = await query;
  if (error) throw new Error(`sweepFlagged query failed: ${error.message}`);

  console.log(`Step A: ${(rows || []).length} row(s) already flagged 'pending_adapter' or 'board_gone'${platform ? ` (platform=${platform})` : ''}.`);
  let moved = 0;
  for (const row of rows || []) {
    const result = await demoteToUnresolved(db, row, { dryRun });
    if (result.ok) {
      moved++;
      if (dryRun) console.log(`  [dry-run] would move ${row.company_name_display} (${row.platform}) -> unresolved`);
    } else {
      console.error(`  ${row.company_name_display}: move failed: ${result.error}`);
    }
  }
  console.log(`Step A done: ${moved}/${(rows || []).length} moved.`);
  return moved;
}

async function probePlatform(db, platform, { dryRun, limit, intervalMs, onlyInconclusive }) {
  const adapter = atsDirect.adapters[platform];
  if (!adapter || typeof adapter.probe !== 'function') {
    console.error(`park-dead-boards: no probe() found for platform "${platform}", skipping.`);
    return;
  }

  const PAGE_SIZE = 1000;
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let q = db
      .from('company_ats_registry')
      .select('id, company_name_normalized, company_name_display, slug_or_identifier, source')
      .eq('platform', platform)
      .order('detected_at', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    q = onlyInconclusive ? q.eq('probe_outcome', 'inconclusive') : q.is('probed_at', null);
    const { data: page, error } = await q;
    if (error) {
      console.error(`park-dead-boards: query failed for ${platform}:`, error.message);
      return;
    }
    rows.push(...(page || []));
    if (!page || page.length < PAGE_SIZE) break;
    if (limit && rows.length >= limit) break;
  }
  if (limit && rows.length > limit) rows.length = limit;

  const total = rows.length;
  console.log(`\nStep B (${platform}): ${total} ${onlyInconclusive ? 'previously-inconclusive' : 'unprobed'} row(s)${limit ? ` (capped at --limit=${limit})` : ''}.`);
  if (!total) return;

  const paced = NO_BUILTIN_GATE.has(platform);
  if (paced) {
    const estMinutes = Math.ceil((total * intervalMs) / 60000);
    console.log(`  Estimated duration at ${intervalMs}ms/request: ~${estMinutes} minute(s).`);
  }

  let ok = 0;
  let deadMoved = 0;
  let inconclusive = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let result;
    try {
      result = await adapter.probe(row.slug_or_identifier);
    } catch (e) {
      result = { ok: false, status: 0, boardName: null, error: e.message || String(e) };
    }

    if (result.ok) {
      ok++;
      if (!dryRun) {
        const { error: upErr } = await db
          .from('company_ats_registry')
          .update({ probed_at: new Date().toISOString(), probe_outcome: 'ok' })
          .eq('id', row.id);
        if (upErr) console.error(`  [${i + 1}/${total}] ${row.company_name_display}: probed_at write failed:`, upErr.message);
      } else {
        console.log(`  [${i + 1}/${total}] OK   ${row.company_name_display} (${row.slug_or_identifier})`);
      }
    } else if (result.status === 404) {
      deadMoved++;
      const moveResult = await demoteToUnresolved(db, row, { dryRun });
      if (dryRun) {
        console.log(`  [${i + 1}/${total}] DEAD (404) ${row.company_name_display} (${row.slug_or_identifier}) -> would move to unresolved`);
      } else if (!moveResult.ok) {
        console.error(`  [${i + 1}/${total}] ${row.company_name_display}: move-to-unresolved failed:`, moveResult.error);
      }
    } else {
      inconclusive++;
      if (!dryRun) {
        // probe_outcome is what makes this row findable again. Before it
        // existed, an inconclusive probe wrote the SAME update as a healthy
        // one — so the rows stopped being distinguishable the moment the
        // sweep ended, and a later "re-probe just the inconclusive ones"
        // had nothing to select on.
        const { error: upErr } = await db
          .from('company_ats_registry')
          .update({ probed_at: new Date().toISOString(), probe_outcome: 'inconclusive' })
          .eq('id', row.id);
        if (upErr) console.error(`  [${i + 1}/${total}] ${row.company_name_display}: probed_at write failed:`, upErr.message);
      } else {
        console.log(`  [${i + 1}/${total}] INCONCLUSIVE (status=${result.status}) ${row.company_name_display} (${row.slug_or_identifier}): ${result.error}`);
      }
    }

    if ((i + 1) % 200 === 0) {
      console.log(`  progress: ${i + 1}/${total} (ok=${ok}, dead=${deadMoved}, inconclusive=${inconclusive})`);
    }

    if (paced && i < rows.length - 1) await sleep(intervalMs);
  }

  console.log(`Step B (${platform}) done: ok=${ok}, dead-moved=${deadMoved}, inconclusive=${inconclusive}, total=${total}.`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.platform && !PLATFORMS.includes(args.platform)) {
    console.error(`park-dead-boards: --platform must be one of ${PLATFORMS.join('|')}`);
    process.exit(1);
  }

  const db = getSupabaseAdmin();
  if (!db) {
    console.error('park-dead-boards: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — check apps/server/.env');
    process.exit(1);
  }

  await assertNoRunningScans(db);

  console.log(
    args.dryRun
      ? 'DRY RUN — no writes will be made. Pass --apply to actually run this.'
      : 'APPLYING — this WILL write to production (company_ats_registry, company_ats_unresolved).'
  );

  await sweepFlagged(db, { dryRun: args.dryRun, platform: args.platform });

  const platformsToRun = args.platform ? [args.platform] : PLATFORMS;
  for (const platform of platformsToRun) {
    await probePlatform(db, platform, { dryRun: args.dryRun, limit: args.limit, intervalMs: args.intervalMs, onlyInconclusive: args.onlyInconclusive });
  }

  console.log(args.dryRun ? '\nDry run complete — re-run with --apply to write.' : '\nDone.');
}

main().catch((e) => {
  console.error('park-dead-boards: unexpected error:', e.message || e);
  process.exit(1);
});

#!/usr/bin/env node
// check-no-running-scans.js — pre-push safety check (2026-08-10 incident: a
// routine end-of-session `git push` auto-triggered a Render redeploy that
// killed an in-progress ATS Direct scan 42 seconds after it started, leaving
// it stuck at status='running' until the next reap cycle. Render's deploy-on-
// push isn't configurable from this repo (no `autoDeploy` key in render.yaml
// — it's a per-service dashboard setting), so the guard lives here instead:
// refuse to push at all while any scan_history row is still 'running'.
//
// Invoked by .git/hooks/pre-push (untracked, machine-local — this repo is
// only ever pushed from this one checkout). Exit 0 = safe to push, exit 1 =
// blocked. Bypass is git's own `--no-verify`, deliberately not a custom env
// var — see CLAUDE.md's global rule against skipping hooks without explicit
// user request, which doubles as the override gate here.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin } = require('@careeros/shared');

async function main() {
  const db = getSupabaseAdmin();
  if (!db) {
    console.error('check-no-running-scans: SUPABASE_URL / SUPABASE_SECRET_KEY not set — check apps/server/.env');
    console.error('check-no-running-scans: cannot verify scan state, allowing push');
    process.exit(0);
  }

  const { data, error } = await db
    .from('scan_history')
    .select('id, config, started_at, heartbeat_at')
    .eq('status', 'running');

  if (error) {
    console.error('check-no-running-scans: query failed, allowing push:', error.message);
    process.exit(0);
  }

  // Generation was NOT covered here until 2026-09-12, and the omission cost
  // exactly what the scan half was written to prevent: three deploys in one
  // evening killed two in-flight résumés, which then sat at 'running' for over
  // four hours with the UI spinning on them. The guard understood that a deploy
  // destroys in-process work; it just only knew about one of the two tables
  // where that work is tracked.
  const { data: genData, error: genError } = await db
    .from('generated_documents')
    .select('id, doc_type, status, created_at, updated_at')
    .in('status', ['queued', 'running']);
  if (genError) {
    console.error('check-no-running-scans: generation query failed, ignoring:', genError.message);
  }

  const rows = data || [];
  const gens = genData || [];
  if (!rows.length && !gens.length) process.exit(0);

  const what = [rows.length && 'a scan', gens.length && 'a document generation'].filter(Boolean).join(' and ');
  console.error('');
  console.error(`BLOCKED: push refused — ${what} is currently running.`);
  console.error('A deploy kills the process running it (scans confirmed 2026-08-10, generation 2026-09-12).');
  console.error('Wait for it to finish, or bypass with `git push --no-verify` if you mean it.');
  console.error('');
  for (const row of rows) {
    const title = (row.config && row.config.job_title) || 'Untitled scan';
    const runningMs = Date.now() - new Date(row.started_at).getTime();
    const minutes = Math.floor(runningMs / 60000);
    console.error(`  - scan "${title}" (${row.id}) — running ${minutes}m, last heartbeat ${row.heartbeat_at}`);
  }
  for (const row of gens) {
    const minutes = Math.floor((Date.now() - new Date(row.created_at).getTime()) / 60000);
    console.error(`  - ${row.doc_type || 'document'} (${row.id}) — ${row.status} ${minutes}m, last progress ${row.updated_at}`);
  }
  console.error('');
  process.exit(1);
}

main().catch((e) => {
  console.error('check-no-running-scans: unexpected error, allowing push:', e.message || e);
  process.exit(0);
});

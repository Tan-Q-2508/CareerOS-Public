#!/usr/bin/env node
// backfill-keyword-coverage.js — recompute jobs.keyword_coverage (and
// jobs.jd_profile) for every job whose stored jd_profile predates the
// current keyword pipeline. Originally written 2026-08-12 (B3) for the
// JD-term-normalization layer alone; extended 2026-08-13 for the full
// root-cause pass (packages/shared/src/ats/keywordPipeline.js) — the
// original version only re-ran atomization (normalizeJdProfile), so it
// could not clean junk terms (degree-clause fragments, un-grounded
// hallucinations, umbrella categories that should have expanded to their
// named examples) out of a job scored before grounding/junk-filtering
// shipped. Now runs the SAME single pipeline every read boundary runs
// (sanitizeJdProfile), so a job backfilled here reads identically to one
// scored fresh today.
//
// Purely deterministic — sanitizeJdProfile + calculateKeywordMatch, the
// SAME shared engine scoreJob.js uses at scan time. No AI calls, no new
// scoring. Targets every job whose RECOMPUTED jd_profile OR keyword_coverage
// differs from what's stored — not jd_profile alone (2026-08-14 correction:
// the résumé-side haystack, profileSkillText, can change without jd_profile
// moving at all — e.g. this round's fix, which widened it to include résumé
// titles/education — so a jd_profile-only staleness check would have
// silently skipped every already-sanitized row and recomputed nothing).
// Safe/idempotent to re-run either way: an already-correct row is a no-op.
//
// CAVEAT (documented, not glossed over): the résumé used for recomputation
// is each user's CURRENT active resume_versions row, not necessarily the
// version active at the job's original scoring time — `jobs` carries no
// resume_version_id to recover that. The prior handoff explicitly scoped a
// backfill out for exactly this reason ("would need to re-run scoring math
// per job against its résumé-version-at-scoring-time"). Recomputing against
// the CURRENT résumé is the best available approximation, and matches what
// Copilot's own live ATS panel already does when a session is freshly
// started against a job. A user with no active résumé version is skipped
// (flagged in the summary) rather than guessing.
//
// Usage (from repo root):
//   node scripts/backfill-keyword-coverage.js --dry-run
//   node scripts/backfill-keyword-coverage.js --apply

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin, sanitizeJdProfile, jdGroundingText, calculateKeywordMatch } = require('@careeros/shared');
const { profileSkillText, transferableSkillText } = require(path.join(__dirname, '..', 'apps', 'server', 'src', 'generation', 'atsCheck'));

// CHANGED 2026-08-14: found live, while dry-running this exact fix — a
// PLAIN `JSON.stringify(a) === JSON.stringify(b)` comparison against a
// value that came back from Postgres JSONB is unreliable, because JSONB
// does NOT preserve object key insertion order on storage/round-trip (it
// canonicalizes to its own internal order) — array element order IS
// preserved, only object KEY order isn't. That meant every row with a
// semantically-identical keyword_coverage (same matched/total/missing
// content, keys just reordered by the round-trip) registered as "changed,"
// making the staleness check meaningless for entire-repo dry-runs. Sorts
// object keys recursively (never reorders array elements, where our
// first-seen-wins ordering IS semantically meaningful) before comparing.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

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
// scripts/classify-sectors.js and scripts/backfill-job-registry-ids.js
// already document) — every unpaginated select here goes through this.
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

async function fetchScoredJobs(db) {
  return selectAll(
    db,
    'jobs',
    'id, user_id, title, jd_profile, description_text, keyword_coverage, already_demonstrated, transferable, hidden_strengths',
    (q) => q.eq('status', 'scored').not('jd_profile', 'is', null)
  );
}

async function fetchActiveResumesByUser(db) {
  const rows = await selectAll(db, 'resume_versions', 'id, user_id, parsed_profile', (q) => q.eq('is_active', true));
  const byUser = new Map();
  for (const r of rows) byUser.set(r.user_id, r);
  return byUser;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !args.apply) {
    console.error('Usage: node scripts/backfill-keyword-coverage.js (--dry-run | --apply)');
    process.exit(1);
  }

  const db = getSupabaseAdmin();
  if (!db) {
    console.error('SUPABASE_URL / SUPABASE_SECRET_KEY not set — check apps/server/.env');
    process.exit(1);
  }

  const [jobs, resumeByUser] = await Promise.all([fetchScoredJobs(db), fetchActiveResumesByUser(db)]);
  console.log(`Found ${jobs.length} scored job(s) with a jd_profile.`);

  let staleCount = 0;
  let skippedNoResume = 0;
  const updates = [];

  for (const job of jobs) {
    const sanitized = sanitizeJdProfile(job.jd_profile, jdGroundingText(job));

    const resume = resumeByUser.get(job.user_id);
    if (!resume) {
      skippedNoResume += 1;
      continue;
    }

    // CHANGED 2026-08-14: staleness used to be "did jd_profile itself
    // change" — correct for the 2026-08-13 pipeline (junk-filter/grounding/
    // atomization all rewrite jd_profile), but wrong for this round's fix
    // (profileSkillText widened to include résumé titles/education): the
    // stored jd_profile can be byte-identical while keyword_coverage still
    // needs recomputing, because the HAYSTACK changed, not the JD terms. As
    // written before this fix, every already-round-1-sanitized row would
    // have been silently skipped and this script would have recomputed
    // nothing. Compare the recomputed coverage instead — jd_profile is only
    // written when it actually changed, but coverage is recomputed whenever
    // EITHER input moved.
    const haystacks = [
      profileSkillText(resume.parsed_profile),
      transferableSkillText({
        alreadyDemonstrated: job.already_demonstrated,
        transferable: job.transferable,
        hiddenStrengths: job.hidden_strengths,
      }),
    ];
    const kw = calculateKeywordMatch({ jdProfile: sanitized, haystacks });
    const newCoverage = { matched: kw.matched, total: kw.total, missing: kw.missingSkills };
    const coverageUnchanged = stableStringify(newCoverage) === stableStringify(job.keyword_coverage);
    const jdProfileUnchanged = stableStringify(sanitized) === stableStringify(job.jd_profile);
    if (coverageUnchanged && jdProfileUnchanged) continue;
    staleCount += 1;

    updates.push({
      id: job.id,
      before: job.keyword_coverage,
      after: newCoverage,
      jd_profile: sanitized,
    });
  }

  console.log(`${staleCount} job(s) need a keyword_coverage/jd_profile update.`);
  console.log(`${skippedNoResume} job(s) skipped entirely — user has no active résumé version.`);
  console.log(`${updates.length} job(s) ready to update.`);

  const sample = updates.slice(0, 10);
  for (const u of sample) {
    const beforeStr = u.before ? `${u.before.matched}/${u.before.total}` : '(none)';
    console.log(`  ${u.id} — ${beforeStr} -> ${u.after.matched}/${u.after.total}`);
  }
  if (updates.length > sample.length) console.log(`  ... and ${updates.length - sample.length} more`);

  if (args.dryRun) {
    console.log('\nDry run — no writes.');
    return;
  }

  let done = 0;
  for (const u of updates) {
    // eslint-disable-next-line no-await-in-loop -- one-off backfill script, sequential is fine and keeps failures attributable
    const { error } = await db
      .from('jobs')
      .update({ jd_profile: u.jd_profile, keyword_coverage: u.after })
      .eq('id', u.id);
    if (error) {
      console.error(`  FAILED ${u.id}: ${error.message}`);
      continue;
    }
    done += 1;
    if (done % 25 === 0 || done === updates.length) console.log(`  progress: ${done}/${updates.length}`);
  }

  console.log(`\nDone. ${done}/${updates.length} job row(s) updated.`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

#!/usr/bin/env node
// rescore-jd-profiles.js — re-run JD skill extraction for already-scored jobs
// and recompute the keyword numbers that depend on it.
//
// WHY THIS EXISTS, and why backfill-keyword-coverage.js is not enough: that
// script is purely deterministic — it re-sanitizes the jd_profile already
// stored on the row. It cannot recover a skill the extractor never returned,
// and the 2026-09-12 finding was that the extractor's output is a draw from a
// wide distribution (two identical runs at temperature 0 agree on 42-67% of
// their terms; some runs return nothing at all). So every score written before
// that fix was computed against one arbitrary sample of each JD's real
// requirements, and 7 jobs whose sample happened to be EMPTY were stored with
// a fabricated 10.0 keyword match. Fixing that needs a fresh extraction, which
// means AI calls, which is why this is a separate, deliberately-manual script
// rather than part of the deterministic backfill.
//
// Call 2 (the strong-tier fit call) is NOT re-run. Its outputs — the tiered
// analysis, callback odds, risk tags, the note — do not depend on which skills
// call 1 extracted, and they are already stored on the row. Re-running it would
// multiply the cost of this pass several times over for outputs that would not
// change. The scan-vouched haystacks it produced (already_demonstrated /
// transferable / hidden_strengths) are read straight off the job, exactly as
// backfill-keyword-coverage.js reads them.
//
// Overall Fit is recomputed rather than left stale: it is 0.4*ats +
// 0.4*callback + 0.2*preference-fit (16.4), and ats is changing here.
// preference_fit is not stored as its own column, so it is recovered from the
// stored trio — the formula is exact and invertible, and the recovered value
// is sanity-checked against [0,10] before use. A row whose stored numbers
// cannot produce a sane preference-fit keeps its existing overall_fit and is
// reported, never silently patched with a guess.
//
// Extraction runs THROUGH the cache (jd_profile_cache), so this pass also
// warms it: after this, re-scanning any of these postings against the same
// résumé returns the identical skill set instead of a fresh random draw.
//
// Usage (from repo root):
//   node scripts/rescore-jd-profiles.js --dry-run
//   node scripts/rescore-jd-profiles.js --dry-run --limit=5
//   node scripts/rescore-jd-profiles.js --apply
//   node scripts/rescore-jd-profiles.js --apply --only-empty   (just the 0/0 rows)
//   node scripts/rescore-jd-profiles.js --apply --only-inconsistent  (rows whose
//       stored ats_match is not the score of their own stored keyword fraction)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.secrets', 'deploy.env') });
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const {
  getSupabaseAdmin,
  sanitizeJdProfile,
  jdGroundingText,
  calculateKeywordMatch,
  tunables,
} = require('@careeros/shared');
const serverSrc = path.join(__dirname, '..', 'apps', 'server', 'src');
const { profileSkillText, transferableSkillText } = require(path.join(serverSrc, 'generation', 'atsCheck'));
const { runJdAts, buildResumeSkillsBlock } = require(path.join(serverSrc, 'scoring', 'jdAtsCall'));
const aiRouter = require(path.join(serverSrc, 'lib', 'aiRouter'));

// The SAME weights scoreJob.computeOverallFit uses (16.4) — read from
// tunables, never re-stated, so this script cannot drift from live scoring.
const WEIGHTS = tunables.overallFitWeights;
const round1 = (n) => Math.round(n * 10) / 10;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    apply: false,
    limit: null,
    onlyEmpty: false,
    onlyInconsistent: false,
    intervalMs: 250,
  };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--apply') args.apply = true;
    else if (raw === '--only-empty') args.onlyEmpty = true;
    else if (raw === '--only-inconsistent') args.onlyInconsistent = true;
    else if (raw.startsWith('--limit=')) args.limit = Number(raw.split('=')[1]);
    else if (raw.startsWith('--interval-ms=')) args.intervalMs = Number(raw.split('=')[1]);
  }
  return args;
}

async function fetchJobs(db) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from('jobs')
      .select(
        'id, user_id, title, company_name, description_text, jd_profile, keyword_coverage, ' +
          'ats_match, callback_odds, overall_fit, already_demonstrated, transferable, hidden_strengths'
      )
      .not('jd_profile', 'is', null)
      .not('description_text', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + 499);
    if (error) throw new Error(`fetch jobs: ${error.message}`);
    rows.push(...data);
    if (data.length < 500) break;
    from += 500;
  }
  return rows;
}

async function fetchActiveResumesByUser(db) {
  const { data, error } = await db
    .from('resume_versions')
    .select('user_id, parsed_profile, created_at')
    .not('parsed_profile', 'is', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`fetch resumes: ${error.message}`);
  const byUser = new Map();
  for (const row of data) if (!byUser.has(row.user_id)) byUser.set(row.user_id, row);
  return byUser;
}

// overall = wA*ats + wC*callback + wP*pref  =>  solve for pref.
function recoverPreferenceFit(job) {
  if (job.overall_fit == null || job.ats_match == null || job.callback_odds == null) return null;
  const pref =
    (Number(job.overall_fit) - WEIGHTS.atsMatch * Number(job.ats_match) - WEIGHTS.callbackOdds * Number(job.callback_odds)) /
    WEIGHTS.preferenceFit;
  // Rounding in the stored trio can push a legitimate 0 or 10 slightly out of
  // range; anything further out means the stored numbers are not consistent
  // with the formula and must not be extrapolated from.
  if (!Number.isFinite(pref) || pref < -0.6 || pref > 10.6) return null;
  return Math.min(10, Math.max(0, pref));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !args.apply) {
    console.error('Usage: node scripts/rescore-jd-profiles.js (--dry-run | --apply) [--limit=N] [--only-empty] [--only-inconsistent]');
    process.exit(1);
  }
  if (args.dryRun && args.apply) {
    console.error('Pass either --dry-run or --apply, not both.');
    process.exit(1);
  }

  const db = getSupabaseAdmin();
  if (!db) {
    console.error('SUPABASE_URL / SUPABASE_SECRET_KEY not set.');
    process.exit(1);
  }

  console.log(
    args.apply
      ? 'APPLYING — this re-runs AI extraction and WILL write to production (jobs, jd_profile_cache).'
      : 'DRY RUN — extraction still runs (and still costs money); nothing is written to `jobs`.'
  );

  let jobs = await fetchJobs(db);
  const resumeByUser = await fetchActiveResumesByUser(db);
  if (args.onlyEmpty) {
    jobs = jobs.filter((j) => !(j.jd_profile.required_skills || []).length && !(j.jd_profile.nice_to_have_skills || []).length);
  }
  // Rows whose stored ats_match is not the score of their own stored keyword
  // fraction — the card reads "7/7" above a 9.5. Produced by the
  // self-consistency re-run averaging two runs' scores while keeping only the
  // second run's coverage (fixed in scoreJob.selfConsistentAts); this selects
  // the rows that were written before the fix, without re-extracting the
  // hundreds that were always consistent.
  if (args.onlyInconsistent) {
    jobs = jobs.filter((j) => {
      const cov = j.keyword_coverage;
      if (!cov || !cov.total || j.ats_match == null) return false;
      return Math.abs(Math.round((cov.matched / cov.total) * 100) / 10 - j.ats_match) >= 0.06;
    });
  }
  if (args.limit) jobs = jobs.slice(0, args.limit);
  console.log(`${jobs.length} job(s) to re-extract.\n`);

  const credentialByUser = new Map();
  const blockByUser = new Map();
  const stats = { changed: 0, unchanged: 0, skipped: 0, failed: 0, cost: 0, cacheHits: 0, prefUnrecoverable: 0 };
  const deltas = { ats: [], overall: [], skills: [], fabricatedTens: 0 };
  const updates = [];

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const resume = resumeByUser.get(job.user_id);
    if (!resume) {
      stats.skipped += 1;
      continue;
    }

    if (!blockByUser.has(job.user_id)) {
      blockByUser.set(job.user_id, buildResumeSkillsBlock(resume.parsed_profile));
      credentialByUser.set(job.user_id, await aiRouter.resolveAiCredential(db, job.user_id));
    }
    const resumeSkillsBlock = blockByUser.get(job.user_id);

    let call1;
    try {
      call1 = await runJdAts({
        resumeSkillsBlock,
        jobTitle: job.title,
        jobText: job.description_text,
        credential: credentialByUser.get(job.user_id),
        db,
        userId: job.user_id,
        cacheText: jdGroundingText(job),
      });
    } catch (e) {
      stats.failed += 1;
      console.log(`  FAILED ${job.id} ${String(job.company_name).slice(0, 20)} — ${String(e.message).slice(0, 80)}`);
      continue;
    }
    stats.cost += Number(call1.costUsd || 0);
    if (call1.fromCache) stats.cacheHits += 1;

    const sanitized = sanitizeJdProfile(call1.jdProfile, jdGroundingText(job));
    const haystacks = [
      profileSkillText(resume.parsed_profile),
      transferableSkillText({
        alreadyDemonstrated: job.already_demonstrated,
        transferable: job.transferable,
        hiddenStrengths: job.hidden_strengths,
      }),
    ];
    const kw = calculateKeywordMatch({ jdProfile: sanitized, haystacks });
    const coverage = { matched: kw.matched, total: kw.total, missing: kw.missingSkills };
    const newAts = kw.score ?? (call1.atsMatch == null ? null : round1(call1.atsMatch));

    const pref = recoverPreferenceFit(job);
    let newOverall = job.overall_fit;
    if (newAts != null && pref != null && job.callback_odds != null) {
      newOverall = round1(
        WEIGHTS.atsMatch * newAts + WEIGHTS.callbackOdds * Number(job.callback_odds) + WEIGHTS.preferenceFit * pref
      );
    } else if (pref == null) {
      stats.prefUnrecoverable += 1;
    }

    const oldTotal = (job.keyword_coverage && job.keyword_coverage.total) || 0;
    const changed = oldTotal !== coverage.total || Number(job.ats_match) !== Number(newAts);
    if (changed) stats.changed += 1;
    else stats.unchanged += 1;
    if (oldTotal === 0 && Number(job.ats_match) === 10) deltas.fabricatedTens += 1;
    if (job.ats_match != null && newAts != null) deltas.ats.push(Number(newAts) - Number(job.ats_match));
    if (job.overall_fit != null && newOverall != null) deltas.overall.push(Number(newOverall) - Number(job.overall_fit));
    deltas.skills.push(coverage.total - oldTotal);

    const flag = oldTotal === 0 && Number(job.ats_match) === 10 ? '  <-- was a fabricated 10.0' : '';
    console.log(
      `  [${i + 1}/${jobs.length}] ${String(job.company_name || '').slice(0, 18).padEnd(18)} ` +
        `${String(job.title || '').slice(0, 30).padEnd(30)} ` +
        `skills ${String(oldTotal).padStart(2)}->${String(coverage.total).padEnd(2)} ` +
        `ats ${String(job.ats_match).padStart(4)}->${String(newAts).padEnd(4)} ` +
        `overall ${String(job.overall_fit).padStart(4)}->${String(newOverall).padEnd(4)}${call1.fromCache ? ' (cached)' : ''}${flag}`
    );

    if (changed) {
      updates.push({
        id: job.id,
        jd_profile: sanitized,
        keyword_coverage: coverage,
        ats_match: newAts,
        overall_fit: newOverall,
      });
    }

    if (!call1.fromCache && args.intervalMs) await new Promise((r) => setTimeout(r, args.intervalMs));
  }

  console.log(
    `\n${stats.changed} changed, ${stats.unchanged} unchanged, ${stats.skipped} skipped (no résumé), ` +
      `${stats.failed} failed, ${stats.cacheHits} served from cache. AI cost $${stats.cost.toFixed(4)}.`
  );
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const median = (a) => {
    if (!a.length) return 0;
    const s2 = [...a].sort((x, y) => x - y);
    return s2[Math.floor(s2.length / 2)];
  };
  console.log(
    `skills/job ${mean(deltas.skills) >= 0 ? '+' : ''}${mean(deltas.skills).toFixed(1)} mean ` +
      `(median ${median(deltas.skills) >= 0 ? '+' : ''}${median(deltas.skills)})  |  ` +
      `ats ${mean(deltas.ats).toFixed(2)} mean (median ${median(deltas.ats).toFixed(1)})  |  ` +
      `overall ${mean(deltas.overall).toFixed(2)} mean (median ${median(deltas.overall).toFixed(1)})`
  );
  console.log(`${deltas.fabricatedTens} row(s) were showing a fabricated 10.0 against zero keywords.`);
  if (stats.prefUnrecoverable) {
    console.log(`${stats.prefUnrecoverable} row(s) had no recoverable preference-fit — overall_fit left as stored.`);
  }

  if (!args.apply) {
    console.log('\nDry run — nothing written to `jobs`. (jd_profile_cache WAS populated; that is the point of it.)');
    return;
  }

  let done = 0;
  for (const u of updates) {
    // eslint-disable-next-line no-await-in-loop -- one-off script; sequential keeps failures attributable
    const { error } = await db
      .from('jobs')
      .update({
        jd_profile: u.jd_profile,
        keyword_coverage: u.keyword_coverage,
        ats_match: u.ats_match,
        overall_fit: u.overall_fit,
      })
      .eq('id', u.id);
    if (error) {
      console.error(`  update failed for ${u.id}: ${error.message}`);
      continue;
    }
    done += 1;
    if (done % 25 === 0 || done === updates.length) console.log(`  progress: ${done}/${updates.length}`);
  }
  console.log(`\nDone. ${done}/${updates.length} job row(s) updated.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
// reapply-prefilter.js — re-run the CURRENT deterministic pre-filter and
// score caps over one user's already-scored jobs (2026-09-22 scan-quality
// pass; supersedes audit-visa-sponsorship.js, whose single-phrase detector
// this replaces).
//
// Jobs scanned before the pass reached AI scoring through three gaps:
//   - work authorization: only "we don't sponsor" phrasing was caught — not
//     citizen/green-card/refugee-only, ITAR "U.S. person", security clearance,
//     "without current or future sponsorship", curly apostrophes, "H-1B"
//   - years: most "N+ years" phrasings went unread, and only a 4+ year gap
//     dropped a job
//   - keywords: 2/2 scored a flat 10 (no small-sample shrinkage)
//
// For each scored job this script:
//   ARCHIVES  a work-auth restriction, or a years gap ≥ 2 (what the pre-filter
//             now drops) — status 'archived', reversible, nothing deleted
//   CAPS      a years gap under 2 at 7.9 with the same note + experience tag
//             scoreJob now writes
//   REFRESHES Keywords X/Y and the ATS sub-score through keywordState
//             (shrinkage + confirmed skills), moving Overall by 0.4 × ΔATS
// A job the user has ACTED ON (moved past Saved, or generated a document for)
// is never archived — it is capped/tagged instead, so nothing they are working
// on disappears.
//
// No AI calls, no COS.
//
// Usage (repo root):
//   node scripts/reapply-prefilter.js --user=<uuid>            dry run (default): prints every change
//   node scripts/reapply-prefilter.js --user=<uuid> --apply    writes them
//   add --no-visa for a user who does not need sponsorship (skips work-auth archiving)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin, detectWorkAuthReject, extractYearsRequired, tunables } = require('@careeros/shared');
const serverSrc = path.join(__dirname, '..', 'apps', 'server', 'src');
const { yearsOfExperience, hasGraduateDegree } = require(path.join(serverSrc, 'resume', 'deriveProfile'));
const { applyScoreCaps } = require(path.join(serverSrc, 'scoring', 'scoreJob'));
const { patchFor } = require(path.join(serverSrc, 'generation', 'refreshKeywordCoverage'));

function parseArgs(argv) {
  const args = { apply: false, userId: null, visa: true };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a === '--no-visa') args.visa = false;
    else if (a.startsWith('--user=')) args.userId = a.slice('--user='.length);
  }
  return args;
}

async function selectAll(db, userId) {
  const cols =
    'id, title, company_name, status, description_text, jd_profile, already_demonstrated, transferable, hidden_strengths, ' +
    'ats_match, overall_fit, keyword_coverage, note, risk_tags';
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from('jobs')
      .select(cols)
      .eq('user_id', userId)
      .eq('status', 'scored')
      .order('id')
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.userId) {
    console.error('Usage: node scripts/reapply-prefilter.js --user=<uuid> [--apply] [--no-visa]');
    process.exit(1);
  }
  const db = getSupabaseAdmin();

  const [{ data: user }, { data: resume }, { data: confirmed }] = await Promise.all([
    db.from('users').select('years_of_experience, years_of_experience_manual').eq('id', args.userId).single(),
    db.from('resume_versions').select('parsed_profile').eq('user_id', args.userId).eq('is_active', true).maybeSingle(),
    db.from('confirmed_skills').select('skill_term').eq('user_id', args.userId),
  ]);
  const profile = resume && resume.parsed_profile;
  if (!profile) throw new Error('No active résumé for that user.');
  const userYears = user.years_of_experience_manual ? Number(user.years_of_experience) : yearsOfExperience(profile);
  const masters = hasGraduateDegree(profile);
  console.log(`Candidate years: ${userYears} (graduate degree: ${masters}). Visa rules: ${args.visa ? 'on' : 'off'}.`);

  const jobs = await selectAll(db, args.userId);
  const ids = jobs.map((j) => j.id);
  const [{ data: acted }, { data: docs }] = await Promise.all([
    db.from('applications').select('job_id, stage').in('job_id', ids).neq('stage', 'Saved'),
    db.from('generated_documents').select('job_id').in('job_id', ids),
  ]);
  const actedOn = new Set([...(acted || []).map((a) => a.job_id), ...(docs || []).map((d) => d.job_id)]);

  const threshold = tunables.yearsGapSeniorityStretchThreshold;
  const archive = [];
  const updates = [];
  for (const job of jobs) {
    const text = `${job.title || ''}\n${job.description_text || ''}`;
    const auth = args.visa ? detectWorkAuthReject(text) : null;
    const jdYears = extractYearsRequired(text, { candidateHasMasters: masters });
    const gap = jdYears != null ? Math.round((jdYears - userYears) * 10) / 10 : null;

    const reason = auth
      ? `work_auth:${auth.category} "${auth.match.slice(0, 90)}"`
      : gap != null && gap >= threshold
        ? `years_gap ${jdYears} vs ${userYears}`
        : null;
    if (reason && !actedOn.has(job.id)) {
      archive.push({ job, reason });
      continue;
    }

    // Keyword refresh first (it moves overall), then the caps on the result.
    const kw = patchFor(job, profile, confirmed || []) || {};
    const overallAfterKw = kw.overall_fit != null ? kw.overall_fit : Number(job.overall_fit);
    const capped = applyScoreCaps({
      overall: overallAfterKw,
      jdYears,
      userYears,
      riskTags: auth
        ? [...(job.risk_tags || []).filter((t) => t.type !== 'visa'), { type: 'visa', severity: 'high', reason: `Posting states "${auth.match}".` }]
        : job.risk_tags,
      note: /Score capped at/.test(job.note || '') ? job.note : job.note,
    });
    const patch = { ...kw };
    if (capped.overall !== Number(job.overall_fit)) patch.overall_fit = capped.overall;
    if (capped.note !== job.note && !/Score capped at/.test(job.note || '')) patch.note = capped.note;
    if (JSON.stringify(capped.riskTags) !== JSON.stringify(job.risk_tags)) patch.risk_tags = capped.riskTags;
    if (Object.keys(patch).length) updates.push({ job, patch, kept: !!reason });
  }

  console.log(`\n${jobs.length} scored job(s).`);
  console.log(`ARCHIVE ${archive.length}:`);
  for (const { job, reason } of archive.sort((a, b) => b.job.overall_fit - a.job.overall_fit)) {
    console.log(`  ${String(job.overall_fit).padStart(4)}  ${job.company_name} — ${job.title.slice(0, 55)}  [${reason}]`);
  }
  const changed = updates.filter((u) => u.patch.overall_fit != null && u.patch.overall_fit !== Number(u.job.overall_fit));
  console.log(`\nUPDATE ${updates.length} (overall changes on ${changed.length}):`);
  for (const { job, patch, kept } of changed.sort((a, b) => b.job.overall_fit - a.job.overall_fit)) {
    const kwNote = patch.keyword_coverage ? ` kw ${patch.keyword_coverage.matched}/${patch.keyword_coverage.total} ats ${job.ats_match}→${patch.ats_match}` : '';
    console.log(`  ${job.overall_fit} → ${patch.overall_fit}  ${job.company_name} — ${job.title.slice(0, 50)}${kwNote}${kept ? '  (kept: you acted on it)' : ''}`);
  }

  if (!args.apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to write.');
    return;
  }
  for (const { job } of archive) {
    const { error } = await db.from('jobs').update({ status: 'archived' }).eq('id', job.id).eq('user_id', args.userId);
    if (error) console.error(`archive ${job.id}: ${error.message}`);
  }
  for (const { job, patch } of updates) {
    const { error } = await db.from('jobs').update(patch).eq('id', job.id).eq('user_id', args.userId);
    if (error) console.error(`update ${job.id}: ${error.message}`);
  }
  console.log(`\nApplied: ${archive.length} archived, ${updates.length} updated.`);
}

main().catch((e) => {
  console.error('reapply-prefilter:', e.message || e);
  process.exit(1);
});

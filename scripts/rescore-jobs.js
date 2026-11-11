#!/usr/bin/env node
// rescore-jobs.js — re-run the FULL scoring pipeline (fresh call 1 extraction
// + call 2 fit judgment) on specific stored jobs, and optionally write the
// result back exactly as jobScorer writes a scored job (§15 #63).
//
// rescore-jd-profiles.js re-runs call 1 only; reapply-prefilter.js is purely
// deterministic. This is for jobs whose whole score is suspect — after a
// prompt change (promptVersion bump) or a keyword audit.
//
// Before scoring, the CURRENT work-authorization pre-filter runs on the posting
// (unless --no-visa). A job it now rejects is ARCHIVED with --apply (status
// 'archived' — reversible, never deleted), not re-scored. A re-scored job that
// lands below its scan's threshold is kept and reported, not deleted: the user
// has already seen it.
//
// AI calls are real (~$0.03 per job) and not billed to the user's COS; they
// are not written to ai_usage_log either, same as score-calibration.js.
//
// Usage (repo root):
//   node scripts/rescore-jobs.js --user=<uuid> --ids=<id>,<id>   dry run: prints before → after
//   node scripts/rescore-jobs.js --user=<uuid> --scans=<id>,<id> every stored job of those scans
//   add --apply to write; --no-visa to skip the work-auth check

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin, detectWorkAuthReject, tunables } = require('@careeros/shared');
const serverSrc = path.join(__dirname, '..', 'apps', 'server', 'src');
const { scoreJob, buildResumeProfileBlock } = require(path.join(serverSrc, 'scoring', 'scoreJob'));
const { yearsOfExperience } = require(path.join(serverSrc, 'resume', 'deriveProfile'));
const aiRouter = require(path.join(serverSrc, 'lib', 'aiRouter'));
const { createSponsorResolver } = require(path.join(serverSrc, 'visa', 'sponsorLookup'));

function parseArgs(argv) {
  const args = { userId: null, ids: null, scans: null, apply: false, visa: true };
  for (const a of argv) {
    if (a.startsWith('--user=')) args.userId = a.slice(7);
    else if (a.startsWith('--ids=')) args.ids = a.slice(6).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--scans=')) args.scans = a.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--apply') args.apply = true;
    else if (a === '--no-visa') args.visa = false;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.userId || (!args.ids && !args.scans)) {
    console.error('Usage: node scripts/rescore-jobs.js --user=<uuid> (--ids=<id>,… | --scans=<id>,…) [--apply] [--no-visa]');
    process.exit(1);
  }
  const db = getSupabaseAdmin();

  const [{ data: resume }, { data: user }, { data: confirmed }] = await Promise.all([
    db.from('resume_versions').select('parsed_profile').eq('user_id', args.userId).eq('is_active', true).single(),
    db.from('users').select('years_of_experience, years_of_experience_manual, domain_keywords').eq('id', args.userId).single(),
    db.from('confirmed_skills').select('skill_term').eq('user_id', args.userId),
  ]);
  const profile = resume.parsed_profile;
  const userYears = user.years_of_experience_manual ? Number(user.years_of_experience) : yearsOfExperience(profile);
  const credential = await aiRouter.resolveAiCredential(db, args.userId);
  const sponsorResolver = createSponsorResolver(db);
  const resumeProfileBlock = buildResumeProfileBlock(profile);

  let q = db.from('jobs').select('*').eq('user_id', args.userId).eq('status', 'scored');
  q = args.ids ? q.in('id', args.ids) : q.in('scan_history_id', args.scans);
  const { data: jobs, error } = await q;
  if (error) throw new Error(error.message);
  const scanIds = [...new Set(jobs.map((j) => j.scan_history_id).filter(Boolean))];
  const { data: scans } = scanIds.length ? await db.from('scan_history').select('id, config').in('id', scanIds) : { data: [] };
  const configOf = new Map((scans || []).map((s) => [s.id, s.config || {}]));

  console.log(`Candidate years ${userYears}. ${jobs.length} job(s). Prompt ${tunables.scoring.promptVersion}. ${args.apply ? 'APPLY' : 'dry run'}.\n`);
  const rows = [];
  for (const job of jobs) {
    const label = `${job.company_name} — ${String(job.title).slice(0, 55)}`;
    const config = configOf.get(job.scan_history_id) || {};
    const threshold = config.threshold ?? tunables.storageCutoff;

    const auth = args.visa ? detectWorkAuthReject(`${job.title || ''}\n${job.description_text || ''}`) : null;
    if (auth) {
      console.log(`ARCHIVE  ${String(job.overall_fit).padStart(4)}  ${label}  [work_auth:${auth.category} "${auth.match.slice(0, 80)}"]`);
      rows.push({ job, archive: true });
      continue;
    }

    let res;
    try {
      const sponsor = await sponsorResolver.resolve(job.company_name, job.company_ats_registry_id);
      res = await scoreJob({
        resumeProfile: profile,
        confirmedSkills: confirmed || [],
        resumeProfileBlock,
        job,
        userYears,
        domainKeywords: user.domain_keywords || [],
        scanLocation: config.location,
        credential,
        threshold,
        sponsor,
        db,
        userId: args.userId,
      });
    } catch (e) {
      console.log(`ERROR    ${label}: ${e.message}`);
      continue;
    }
    const s = res.scores;
    const kc = s.keywordCoverage || {};
    const below = s.overallFit < threshold ? `  (below scan threshold ${threshold})` : '';
    console.log(
      `${String(job.overall_fit).padStart(4)} → ${String(s.overallFit).padStart(4)}  ATS ${job.ats_match}→${s.atsMatch}  CB ${job.callback_odds}→${s.callbackOdds}  ` +
        `kw ${kc.matched}/${kc.total}  ${label}${below}`
    );
    if (res.note) console.log(`         note: ${res.note.slice(0, 220)}`);
    rows.push({ job, res });
  }

  if (!args.apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to write.');
    return;
  }
  let archived = 0;
  let updated = 0;
  for (const { job, archive, res } of rows) {
    const patch = archive
      ? { status: 'archived' }
      : {
          jd_profile: res.jdProfile,
          prompt_version: tunables.scoring.promptVersion,
          ats_match: res.scores.atsMatch,
          keyword_coverage: res.scores.keywordCoverage,
          callback_odds: res.scores.callbackOdds,
          overall_fit: res.scores.overallFit,
          critical_missing: res.tiered.critical_missing,
          important_missing: res.tiered.important_missing,
          nice_to_have_missing: res.tiered.nice_to_have_missing,
          already_demonstrated: res.tiered.already_demonstrated,
          transferable: res.tiered.transferable,
          hidden_strengths: res.tiered.hidden_strengths,
          risk_tags: res.riskTags,
          note: res.note,
        };
    const { error: upErr } = await db.from('jobs').update(patch).eq('id', job.id).eq('user_id', args.userId);
    if (upErr) console.error(`write ${job.id}: ${upErr.message}`);
    else if (archive) archived += 1;
    else updated += 1;
  }
  console.log(`\nApplied: ${updated} re-scored, ${archived} archived.`);
}

main().catch((e) => {
  console.error('rescore-jobs:', e.message || e);
  process.exit(1);
});

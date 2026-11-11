#!/usr/bin/env node
// replay-scan.js — look again at the jobs a past ATS Direct scan scored and
// DELETED for landing below its threshold (§15 #63). Read-only.
//
// jobScorer deletes a below-threshold job, so nothing of it survives in `jobs`.
// What does survive: its dedup key in job_dedup_seen (written during the scan
// window, `ats:{platform}:{slug}:{id}` — names the board) and its call-1
// extraction in jd_profile_cache (keyed by sha256 of title + description).
// This script re-fetches just those boards, keeps the postings whose dedup key
// the scan saw and that were not stored, and for each one reports:
//   the extraction the scan used (cache row matched by jd_hash, the one
//   written in the scan window) read through TODAY's sanitizer and
//   keywordState — the deleted job's own stored X/Y is gone, so this shows
//   what the free read-time fixes alone would make of it
// With --score it re-runs the FULL scoring pipeline (fresh extraction under
// the current prompt, fit call) on the likely wrongful cuts — title matched
// the scan and the keyword score now reads ≥ --min-kw — capped at --max, and
// prints the overall against the scan's threshold. Nothing is written to
// `jobs`; the extraction cache is warmed as a scan would.
//
// A posting that has closed since the scan cannot be re-fetched and is
// counted as unrecoverable.
//
// Usage (repo root):
//   node scripts/replay-scan.js --user=<uuid> --scan=<id> [--score] [--min-kw=6] [--max=15] [--out=report.md]

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin, tunables, jdGroundingText, scanTitles, detectWorkAuthReject } = require('@careeros/shared');
const atsDirectAdapter = require('@careeros/shared/src/sourcing/atsDirectAdapter');
const serverSrc = path.join(__dirname, '..', 'apps', 'server', 'src');
const { resolveScanSelection } = require(path.join(serverSrc, 'companies', 'registry'));
const { computeKeywordState } = require(path.join(serverSrc, 'generation', 'keywordState'));
const jdProfileCache = require(path.join(serverSrc, 'scoring', 'jdProfileCache'));
const { scoreJob, buildResumeProfileBlock } = require(path.join(serverSrc, 'scoring', 'scoreJob'));
const { yearsOfExperience } = require(path.join(serverSrc, 'resume', 'deriveProfile'));
const aiRouter = require(path.join(serverSrc, 'lib', 'aiRouter'));
const { createSponsorResolver } = require(path.join(serverSrc, 'visa', 'sponsorLookup'));

function parseArgs(argv) {
  const args = { userId: null, scanId: null, score: false, minKw: 6, max: 15, out: null };
  for (const a of argv) {
    if (a.startsWith('--user=')) args.userId = a.slice(7);
    else if (a.startsWith('--scan=')) args.scanId = a.slice(7);
    else if (a === '--score') args.score = true;
    else if (a.startsWith('--min-kw=')) args.minKw = Number(a.slice(9));
    else if (a.startsWith('--max=')) args.max = Number(a.slice(6));
    else if (a.startsWith('--out=')) args.out = a.slice(6);
  }
  return args;
}

async function selectAll(query) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await query().range(offset, offset + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const boardOf = (key) => String(key).split(':').slice(0, -1).join(':').toLowerCase();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.userId || !args.scanId) {
    console.error('Usage: node scripts/replay-scan.js --user=<uuid> --scan=<id> [--score] [--min-kw=6] [--max=15] [--out=report.md]');
    process.exit(1);
  }
  const db = getSupabaseAdmin();
  const { data: scan, error } = await db.from('scan_history').select('*').eq('id', args.scanId).eq('user_id', args.userId).single();
  if (error) throw new Error(error.message);
  const config = scan.config || {};
  const from = scan.started_at || scan.created_at;
  const to = scan.completed_at || new Date().toISOString();

  const [seenRows, storedRows, cacheRows] = await Promise.all([
    selectAll(() => db.from('job_dedup_seen').select('dedup_key').eq('user_id', args.userId).gte('created_at', from).lte('created_at', to).order('id')),
    selectAll(() => db.from('jobs').select('dedup_key').eq('user_id', args.userId).order('id')),
    selectAll(() => db.from('jd_profile_cache').select('jd_hash, jd_profile, created_at').eq('user_id', args.userId).lte('created_at', to).gte('last_used_at', from).order('created_at')),
  ]);
  const stored = new Set(storedRows.map((r) => r.dedup_key));
  const windowKeys = new Set(seenRows.map((r) => r.dedup_key).filter((k) => !stored.has(k)));
  const cacheByHash = new Map();
  for (const c of cacheRows) if (!cacheByHash.has(c.jd_hash)) cacheByHash.set(c.jd_hash, c);
  const boards = new Set([...windowKeys].map(boardOf));

  const { companies } = await resolveScanSelection(db, args.userId, { tracklistIds: config.tracklist_ids, registryIds: config.tracked_company_ids });
  const titles = scanTitles(config);
  const daysSince = Math.ceil((Date.now() - new Date(from).getTime()) / 86400000);
  const postedWithinDays = (config.posted_within_days || tunables.postedWithinDays) + daysSince + 1;

  const [{ data: resume }, { data: user }, { data: confirmed }] = await Promise.all([
    db.from('resume_versions').select('parsed_profile').eq('user_id', args.userId).eq('is_active', true).single(),
    db.from('users').select('years_of_experience, years_of_experience_manual, domain_keywords').eq('id', args.userId).single(),
    db.from('confirmed_skills').select('skill_term').eq('user_id', args.userId),
  ]);
  const profile = resume.parsed_profile;

  // Fetch only the boards the scan actually drew below-cut postings from —
  // dedupKey is `ats:{platform}:{slug_or_identifier}:{id}`.
  const wanted = companies.filter((c) => boards.has(`ats:${c.platform}:${c.slug_or_identifier}`.toLowerCase()));
  console.error(`[replay] ${boards.size} board(s) to re-fetch; ${wanted.length} matched in the tracklist.`);
  const found = [];
  await Promise.all(
    Array.from({ length: Math.min(6, wanted.length) }, async (_, w) => {
      for (let i = w; i < wanted.length; i += 6) {
        const { jobs } = await atsDirectAdapter
          .sourceCompanyJobs({ company: wanted[i], titles, location: config.location, postedWithinDays })
          .catch(() => ({ jobs: [] }));
        for (const j of jobs || []) if (windowKeys.has(j.dedupKey)) found.push(j);
      }
    })
  );

  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };
  say(`## Replay of scan ${scan.id.slice(0, 8)} (${from.slice(0, 16)}) — titles ${JSON.stringify(titles)}, threshold ${config.threshold}`);
  say(`${windowKeys.size} below-cut dedup keys in the scan window; ${found.length} re-fetched; ${windowKeys.size - found.length} closed or unreachable since.`);
  say();

  const rows = [];
  for (const j of found) {
    const job = { title: j.title, company_name: j.companyName, description_text: j.descriptionText };
    const cached = cacheByHash.get(jdProfileCache.hashJdText(jdGroundingText(job)));
    const auth = detectWorkAuthReject(`${j.title}\n${j.descriptionText || ''}`);
    const st = cached ? computeKeywordState({ job: { ...job, jd_profile: cached.jd_profile }, profile, confirmedSkills: confirmed || [] }) : null;
    rows.push({ j, job, cached, st, auth });
  }
  rows.sort((a, b) => (b.st ? b.st.score : -1) - (a.st ? a.st.score : -1));
  for (const { j, cached, st, auth } of rows) {
    const raw = cached ? [...(cached.jd_profile.required_skills || []), ...(cached.jd_profile.nice_to_have_skills || [])].length : null;
    say(`- ${j.companyName} — ${j.title}${auth ? `  [now visa-dropped: ${auth.match.slice(0, 60)}]` : ''}`);
    say(
      st
        ? `  - cached extraction ${raw} raw terms → now ${st.matched}/${st.total}, keyword score ${st.score}; missing: ${st.missing.slice(0, 8).join(', ') || '—'}`
        : '  - no cached extraction matched (posting text changed since the scan)'
    );
  }

  if (args.score) {
    const candidates = rows.filter((r) => !r.auth && r.st && r.st.score >= args.minKw).slice(0, args.max);
    say();
    say(`### Full re-score of ${candidates.length} likely wrongful cut(s) (keyword score ≥ ${args.minKw})`);
    const userYears = user.years_of_experience_manual ? Number(user.years_of_experience) : yearsOfExperience(profile);
    const credential = await aiRouter.resolveAiCredential(db, args.userId);
    const sponsorResolver = createSponsorResolver(db);
    const resumeProfileBlock = buildResumeProfileBlock(profile);
    for (const { j } of candidates) {
      const job = {
        title: j.title, company_name: j.companyName, location: j.location, posted_at: j.postedAt,
        description_text: j.descriptionText, seniority_level: j.seniorityLevel, salary_min: j.salaryMin, salary_max: j.salaryMax,
      };
      try {
        const res = await scoreJob({
          resumeProfile: profile, confirmedSkills: confirmed || [], resumeProfileBlock, job, userYears,
          domainKeywords: user.domain_keywords || [], scanLocation: config.location, credential,
          threshold: config.threshold, sponsor: await sponsorResolver.resolve(j.companyName, null), db, userId: args.userId,
        });
        const s = res.scores;
        const verdict = s.overallFit >= config.threshold ? 'WOULD NOW CLEAR' : 'still below';
        say(`- ${verdict} ${config.threshold}: ${s.overallFit} (ATS ${s.atsMatch}, CB ${s.callbackOdds}, kw ${s.keywordCoverage.matched}/${s.keywordCoverage.total}) — ${j.companyName} — ${j.title}`);
        say(`  - ${String(res.note || '').slice(0, 240)}`);
      } catch (e) {
        say(`- ERROR ${j.companyName} — ${j.title}: ${e.message}`);
      }
    }
  }

  if (args.out) {
    fs.appendFileSync(args.out, `${lines.join('\n')}\n\n`);
    console.log(`\nAppended to ${args.out}`);
  }
}

main().catch((e) => {
  console.error('replay-scan:', e.message || e);
  process.exit(1);
});

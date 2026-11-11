#!/usr/bin/env node
// keyword-audit.js — how the CURRENT keyword pipeline reads the jobs a scan
// stored, next to what was stored at scan time (§15 #63). Deterministic, no AI,
// read-only.
//
// For each stored job it prints:
//   stored   keyword_coverage X/Y and ats_match as written at scan time
//   now      the same job's jd_profile re-sanitized by today's pipeline and
//            classified by keywordState (the numbers the card shows after the
//            free read-time refresh), with every term's status
// A term that disappeared between the two was dropped by a junk/vague/degree
// filter; a term whose status moved from missing to held was credited by a
// true equivalent or a stripped context word.
//
// Usage (repo root):
//   node scripts/keyword-audit.js --user=<uuid> [--scans=<id>,<id>] [--last=3] [--out=report.md]

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin } = require('@careeros/shared');
const { computeKeywordState } = require(path.join(__dirname, '..', 'apps', 'server', 'src', 'generation', 'keywordState'));

function parseArgs(argv) {
  const args = { userId: null, scans: null, last: 3, out: null };
  for (const a of argv) {
    if (a.startsWith('--user=')) args.userId = a.slice(7);
    else if (a.startsWith('--scans=')) args.scans = a.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--last=')) args.last = Number(a.slice(7)) || 3;
    else if (a.startsWith('--out=')) args.out = a.slice(6);
  }
  return args;
}

const STATUS = { present: 'held', confirmed: 'confirmed', transferable: 'transferable', missing: 'MISSING' };

function storedTerms(job) {
  const jd = job.jd_profile || {};
  return [
    ...(jd.required_skills || []),
    ...(jd.any_of_groups || []).map((g) => (g || []).join(' / ')),
    ...(jd.nice_to_have_skills || []),
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.userId) {
    console.error('Usage: node scripts/keyword-audit.js --user=<uuid> [--scans=<id>,…] [--last=3] [--out=report.md]');
    process.exit(1);
  }
  const db = getSupabaseAdmin();

  let q = db.from('scan_history').select('id, created_at, config, jobs_scored_count').eq('user_id', args.userId);
  q = args.scans ? q.in('id', args.scans) : q.order('created_at', { ascending: false }).limit(args.last);
  const { data: scans, error } = await q;
  if (error) throw new Error(error.message);

  const [{ data: resume }, { data: confirmed }] = await Promise.all([
    db.from('resume_versions').select('parsed_profile').eq('user_id', args.userId).eq('is_active', true).maybeSingle(),
    db.from('confirmed_skills').select('skill_term').eq('user_id', args.userId),
  ]);
  const profile = resume && resume.parsed_profile;
  if (!profile) throw new Error('No active résumé for that user.');

  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };

  for (const scan of scans) {
    const { data: jobs, error: jErr } = await db
      .from('jobs')
      .select('id, title, company_name, status, description_text, jd_profile, ats_match, overall_fit, keyword_coverage, already_demonstrated, transferable, hidden_strengths')
      .eq('scan_history_id', scan.id)
      .order('overall_fit', { ascending: false });
    if (jErr) throw new Error(jErr.message);
    say(`## Scan ${scan.id.slice(0, 8)} — ${scan.created_at.slice(0, 16)} — "${(scan.config.job_titles || [scan.config.job_title]).join(', ')}", threshold ${scan.config.threshold}`);
    say(`${jobs.length} stored of ${scan.jobs_scored_count} scored.`);
    say();
    for (const job of jobs) {
      const st = computeKeywordState({ job, profile, confirmedSkills: confirmed || [] });
      const kc = job.keyword_coverage || {};
      say(`### ${job.company_name} — ${job.title} (${job.status}, overall ${job.overall_fit})`);
      say(`- stored: ${kc.matched}/${kc.total}, ATS ${job.ats_match}  →  now: ${st.matched}/${st.total}, ATS ${st.score}`);
      const now = new Set(st.terms.map((t) => t.skill.toLowerCase()));
      const dropped = storedTerms(job).filter((t) => !now.has(String(t).toLowerCase()));
      say(`- terms now: ${st.terms.map((t) => `${t.skill} (${STATUS[t.status]}${t.tier === 'nice_to_have' ? ', nice' : ''})`).join('; ') || '(none)'}`);
      if (dropped.length) say(`- stored terms no longer scored (dropped, stripped or merged): ${dropped.join('; ')}`);
      say();
    }
  }

  if (args.out) {
    fs.writeFileSync(args.out, `# Keyword audit\n\n${lines.join('\n')}\n`);
    console.log(`\nWrote ${args.out}`);
  }
}

main().catch((e) => {
  console.error('keyword-audit:', e.message || e);
  process.exit(1);
});

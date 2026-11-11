#!/usr/bin/env node
// humanizer-compare.js — generate the same résumé, cover letter and
// application answers twice for one real job: once with the humanizer
// (spec 7.15 / 8.7) off, once on, and write both sets side by side with the
// AI-tell counts for each. Nothing is written to the database or storage; the
// .docx files and compare.md land in --out.
//
//   node scripts/humanizer-compare.js --user=<uuid> --job=<jobId prefix or id> --out=<dir>
//       [--questions="Why do you want to work here?|Tell us about a project you led"]
//       [--only=new]   (skip the old run)
//
// Real AI calls (strong tier): roughly 4-7 per mode.

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin, tunables, humanizer } = require('@careeros/shared');
const serverSrc = path.join(__dirname, '..', 'apps', 'server', 'src');
const { loadJobAndResume } = require(path.join(serverSrc, 'generation', 'loadJobAndResume'));
const { buildGenerationInputs } = require(path.join(serverSrc, 'generation', 'generationInputs'));
const { generateResume } = require(path.join(serverSrc, 'generation', 'generateResume'));
const { generateCoverLetter } = require(path.join(serverSrc, 'generation', 'generateCoverLetter'));
const { runDraft: runAnswer } = require(path.join(serverSrc, 'generation', 'draftQuestionAnswer'));
const mammoth = require('mammoth');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// A provider-wide 503 ("high demand") fails every model in aiRouter's
// fallback chain within seconds; wait it out rather than losing the run.
async function withRetry(label, fn, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const transient = /(503|UNAVAILABLE|high demand|429|RESOURCE_EXHAUSTED)/.test(`${e && e.status} ${e && e.message} ${e}`);
      if (!transient || i >= tries) throw e;
      const waitMs = 60000 * i;
      console.log(`[retry] ${label} failed transiently (attempt ${i}/${tries}); waiting ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// Each finished piece is kept in --out and reused on a re-run, so an outage
// mid-run never costs the pieces already generated.
function cached(outDir, name) {
  const f = path.join(outDir, name);
  return fs.existsSync(f) ? f : null;
}

async function docxText(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value.split('\n').map((l) => l.trim()).filter(Boolean);
}

function stats(lines, bulletLines, allow) {
  const text = lines.join('\n');
  const hits = humanizer.aiTellHits(text, { allow });
  const byRule = {};
  for (const h of hits) byRule[h.rule] = (byRule[h.rule] || 0) + 1;
  const dashes = (text.replace(/\d\s*[—–]\s*\d/g, '').match(/[—–]/g) || []).length;
  const doc = humanizer.documentTells(bulletLines);
  return { hits, byRule, dashes, doc };
}

async function resolveJobId(db, userId, prefix) {
  if (prefix.length === 36) return prefix;
  const { data } = await db.from('jobs').select('id').eq('user_id', userId).not('jd_profile', 'is', null).limit(2000);
  const m = (data || []).filter((j) => j.id.startsWith(prefix));
  if (m.length !== 1) throw new Error(`job prefix ${prefix} matched ${m.length} jobs`);
  return m[0].id;
}

async function runMode(enabled, ctx) {
  tunables.humanizer.enabled = enabled;
  const tag = enabled ? 'NEW' : 'OLD';
  const { job, resume, inputs, questions, outDir } = ctx;
  const { credential, contact, jobContext, confirmedNaked, confirmedContext } = inputs;
  const log = (m) => console.log(`[${tag}] ${m}`);

  let r;
  const rFile = cached(outDir, `resume_${tag}.docx`);
  if (rFile) {
    log('résumé: reusing the file from an earlier run');
    const meta = cached(outDir, `resume_${tag}.json`);
    r = { docxBuffer: fs.readFileSync(rFile), ...(meta ? JSON.parse(fs.readFileSync(meta, 'utf8')) : { atsScore: 'n/a', checksPassed: { onePage: 'n/a' } }) };
  } else {
    log('résumé');
    r = await withRetry('résumé', () => generateResume({ profile: resume.parsed_profile, contact, jobContext, confirmedNaked, confirmedContext, credential, onProgress: async (s, m) => log(`  ${s}: ${m}`) }));
    fs.writeFileSync(path.join(outDir, `resume_${tag}.docx`), r.docxBuffer);
    fs.writeFileSync(path.join(outDir, `resume_${tag}.json`), JSON.stringify({ atsScore: r.atsScore, checksPassed: { onePage: r.checksPassed.onePage } }));
  }
  const resumeLines = await docxText(r.docxBuffer);

  const confirmedSkills = [...confirmedNaked, ...confirmedContext.map((c) => c.term)];
  let cl;
  const clFile = cached(outDir, `coverletter_${tag}.docx`);
  if (clFile) {
    log('cover letter: reusing the file from an earlier run');
    cl = { docxBuffer: fs.readFileSync(clFile) };
  } else {
    log('cover letter');
    cl = await withRetry('cover letter', () => generateCoverLetter({ profile: resume.parsed_profile, contact, jobContext, confirmedSkills, confirmedContext, credential }));
    fs.writeFileSync(path.join(outDir, `coverletter_${tag}.docx`), cl.docxBuffer);
  }
  const letterLines = await docxText(cl.docxBuffer);

  const aFile = path.join(outDir, `answers_${tag}.json`);
  const answers = fs.existsSync(aFile) ? JSON.parse(fs.readFileSync(aFile, 'utf8')) : [];
  for (const q of questions) {
    if (answers.some((x) => x.q === q)) continue;
    log(`answer: ${q}`);
    const a = await withRetry('answer', () => runAnswer({ profile: resume.parsed_profile, jobContext, question: q, confirmedSkills, confirmedContext, credential }));
    answers.push({ q, a: a.answer });
    fs.writeFileSync(aFile, JSON.stringify(answers, null, 2));
  }
  return { tag, resume: r, resumeLines, letter: cl, letterLines, answers, jobTitle: job.title };
}

function bulletsOf(lines) {
  // Bullet lines are the long ones; headers, contact lines and skills rows are short or colon-led.
  return lines.filter((l) => l.length > 60 && !/^[A-Za-z &/]+:/.test(l));
}

function section(title, run, allow) {
  const rb = bulletsOf(run.resumeLines);
  const rs = stats(run.resumeLines, rb, allow);
  const ls = stats(run.letterLines, run.letterLines.filter((l) => l.length > 120), allow);
  const as = stats(run.answers.map((x) => x.a), [], allow);
  const fmt = (s) => `AI-tell hits: ${s.hits.length} (${Object.entries(s.byRule).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}); dashes: ${s.dashes}`;
  return [
    `## ${title}`,
    '',
    `**Résumé** — ATS ${run.resume.atsScore}%, one page: ${run.resume.checksPassed.onePage}. ${fmt(rs)}. Opening verbs repeated >2x: ${rs.doc.repeatedOpeners.map((o) => `${o.verb} ×${o.count}`).join(', ') || 'none'}; result tails: ${rs.doc.resultTails}; sentence-length spread (stdev, words): ${rs.doc.lengthStdev}`,
    rs.hits.length ? `Hits: ${rs.hits.map((h) => `\`${h.match}\``).join(', ')}` : '',
    '',
    '```',
    ...run.resumeLines,
    '```',
    '',
    `**Cover letter** — ${run.letterLines.filter((l) => l.length > 120).join(' ').split(/\s+/).length} body words. ${fmt(ls)}. Sentence-length spread: ${ls.doc.lengthStdev}`,
    ls.hits.length ? `Hits: ${ls.hits.map((h) => `\`${h.match}\``).join(', ')}` : '',
    '',
    ...run.letterLines.map((l) => `> ${l}\n>`),
    '',
    `**Application answers** — ${fmt(as)}`,
    '',
    ...run.answers.flatMap((x) => [`*Q: ${x.q}*`, '', x.a, '']),
  ].join('\n');
}

async function main() {
  const userId = arg('user');
  const jobArg = arg('job');
  const outDir = arg('out');
  if (!userId || !jobArg || !outDir) throw new Error('usage: --user=<uuid> --job=<id or prefix> --out=<dir>');
  const questions = arg('questions', 'Why do you want to work at this company?|Tell us about a project you are proud of and what you did on it.').split('|').filter(Boolean);
  const only = arg('only', '');
  fs.mkdirSync(outDir, { recursive: true });

  const db = getSupabaseAdmin();
  const jobId = await resolveJobId(db, userId, jobArg);
  const { job, resume, httpError } = await loadJobAndResume(db, userId, jobId, 'ats_match, callback_odds, overall_fit, risk_tags, location');
  if (httpError) throw new Error(httpError.error);
  const inputs = await buildGenerationInputs(db, userId, job, resume);
  const allow = humanizer.jdAllowList(inputs.jobContext);
  const ctx = { job, resume, inputs, questions, outDir };

  const runs = [];
  if (only !== 'new') runs.push(await runMode(false, ctx));
  if (only !== 'old') runs.push(await runMode(true, ctx));

  const md = [
    `# Humanizer comparison — ${job.title} @ ${job.company_name}`,
    '',
    `JD-allowed words (the posting itself uses them, so they are not flagged): ${allow.join(', ') || 'none'}`,
    '',
    ...runs.map((r) => section(r.tag === 'OLD' ? 'OLD (current prompts)' : 'NEW (humanizer on)', r, allow)),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'compare.md'), md);
  console.log(`wrote ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

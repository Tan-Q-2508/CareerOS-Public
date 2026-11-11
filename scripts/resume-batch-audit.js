#!/usr/bin/env node
// resume-batch-audit.js — generate résumés for a batch of real scored jobs and
// audit each one the way public résumé checkers do (resumeAudit.js): which
// master roles survived, page fill, opening verbs used more than twice, weak
// openers, AI vocabulary, pronouns, passive voice, quantified share, word
// count. Nothing is written to the database or storage; per-job .docx/.json
// files and a summary.md land in --out. A finished job is reused on a re-run.
//
//   node scripts/resume-batch-audit.js --user=<uuid> --jobs=<id or prefix,...> --out=<dir> [--label=after] [--concurrency=2]
//
// Real AI calls: 2-4 per job (Director, draft, sometimes repair and fill).

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', 'apps', 'server', '.env') });

const { getSupabaseAdmin } = require('@careeros/shared');
const serverSrc = path.join(__dirname, '..', 'apps', 'server', 'src');
const { loadJobAndResume } = require(path.join(serverSrc, 'generation', 'loadJobAndResume'));
const { buildGenerationInputs } = require(path.join(serverSrc, 'generation', 'generationInputs'));
const { generateResume } = require(path.join(serverSrc, 'generation', 'generateResume'));
const { auditResume } = require(path.join(serverSrc, 'generation', 'resumeAudit'));

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function withRetry(label, fn, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const transient = /(503|500|UNAVAILABLE|INTERNAL|high demand|429|RESOURCE_EXHAUSTED|timed out|timeout)/i.test(`${e && e.status} ${e && e.message} ${e}`);
      if (!transient || i >= tries) throw e;
      const waitMs = 45000 * i;
      console.log(`[retry] ${label} failed transiently (attempt ${i}/${tries}): ${String(e && e.message).slice(0, 120)}; waiting ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function resolveJobIds(db, userId, prefixes) {
  const { data } = await db.from('jobs').select('id').eq('user_id', userId).not('jd_profile', 'is', null).limit(5000);
  return prefixes.map((p) => {
    const m = (data || []).filter((j) => j.id.startsWith(p));
    if (m.length !== 1) throw new Error(`job prefix ${p} matched ${m.length} jobs`);
    return m[0].id;
  });
}

async function runOne(db, userId, jobId, outDir, label) {
  const tag = `${jobId.slice(0, 8)}_${label}`;
  const jsonFile = path.join(outDir, `${tag}.json`);
  if (fs.existsSync(jsonFile)) return JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  const { job, resume, httpError } = await loadJobAndResume(db, userId, jobId, 'ats_match, callback_odds, overall_fit, risk_tags, location');
  if (httpError) throw new Error(httpError.error);
  const inputs = await buildGenerationInputs(db, userId, job, resume);
  const { credential, contact, jobContext, confirmedNaked, confirmedContext } = inputs;
  const t0 = Date.now();
  const r = await withRetry(tag, () => generateResume({ profile: resume.parsed_profile, contact, jobContext, confirmedNaked, confirmedContext, credential, onProgress: async (s) => console.log(`[${tag}] ${s}`) }));
  const roleIndices = ((r.asm.detail && r.asm.detail.experience) || []).map((e) => e.roleIndex);
  const audit = auditResume(r.asm.model, resume.parsed_profile, { fillFraction: r.checksPassed.fillFraction, roleIndices });
  const out = {
    job: { id: jobId, title: job.title, company: job.company_name, fit: job.overall_fit },
    seconds: Math.round((Date.now() - t0) / 1000),
    atsScore: r.atsScore,
    onePage: r.checksPassed.onePage,
    fillPassBullets: r.checksPassed.fillPassBullets,
    fillPassBudget: r.checksPassed.fillPassBudget,
    bulletTargets: r.checksPassed.bulletTargets,
    keywordCoverage: r.checksPassed.keywordCoverage,
    openerSwaps: r.checksPassed.openerSwaps || [],
    addedBack: r.checksPassed.addedBack || [],
    audit,
    model: r.asm.model,
    aiCalls: (r.usages || []).length,
    costUsd: (r.usages || []).reduce((a, u) => a + (u.costUsd || 0), 0),
  };
  fs.writeFileSync(path.join(outDir, `${tag}.docx`), r.docxBuffer);
  fs.writeFileSync(jsonFile, JSON.stringify(out, null, 2));
  return out;
}

function summarize(results, label) {
  const n = results.length || 1;
  const avg = (f) => (results.reduce((a, r) => a + (f(r) || 0), 0) / n);
  const lines = [
    `# Résumé batch audit — ${label}`,
    '',
    `Jobs: ${results.length}. Mean fill ${avg((r) => r.audit.fillFraction).toFixed(3)}; mean ATS ${avg((r) => r.atsScore).toFixed(1)}; mean words ${avg((r) => r.audit.words).toFixed(0)}; mean roles shown ${avg((r) => r.audit.rolesShown).toFixed(2)}/${results[0] ? results[0].audit.rolesInMaster : '?'}; résumés dropping a >3-month role: ${results.filter((r) => r.audit.droppedOver3Months.length).length}; résumés with a verb opening >2 bullets: ${results.filter((r) => r.audit.repeatedVerbs.length).length}; mean quantified ${avg((r) => r.audit.quantifiedRatio).toFixed(2)}; AI-word hits total ${results.reduce((a, r) => a + r.audit.aiTells.length, 0)}; total AI cost $${results.reduce((a, r) => a + (r.costUsd || 0), 0).toFixed(2)}`,
    '',
    '| Job | fit | ATS | fill | words | roles | dropped roles (months) | projects | bullets/role | verbs >2 | weak | quant | fill-pass | added back |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const a = r.audit;
      return `| ${r.job.title.slice(0, 40)} @ ${r.job.company} | ${r.job.fit} | ${r.atsScore} | ${(a.fillFraction || 0).toFixed(3)} | ${a.words} | ${a.rolesShown}/${a.rolesInMaster} | ${a.droppedRoles.map((d) => `${d.company} (${d.months})`).join(', ') || '—'} | ${a.projectsShown} | ${a.bulletsPerRole.join('/')} | ${a.repeatedVerbs.map((v) => `${v.verb}×${v.count}`).join(', ') || '—'} | ${a.weakOpeners.length} | ${a.quantifiedRatio} | ${r.fillPassBullets} | ${(r.addedBack || []).map((x) => `${x.entry_type} ${x.entry_index}`).join(', ') || '—'} |`;
    }),
  ];
  return lines.join('\n');
}

async function main() {
  const userId = arg('user');
  const jobsArg = arg('jobs');
  const outDir = arg('out');
  const label = arg('label', 'run');
  const concurrency = Number(arg('concurrency', '2'));
  if (!userId || !jobsArg || !outDir) throw new Error('usage: --user=<uuid> --jobs=<id,...> --out=<dir> [--label=]');
  fs.mkdirSync(outDir, { recursive: true });
  const db = getSupabaseAdmin();
  const ids = await resolveJobIds(db, userId, jobsArg.split(',').filter(Boolean));
  const results = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const k = next++;
      try {
        results[k] = await runOne(db, userId, ids[k], outDir, label);
        console.log(`[done] ${k + 1}/${ids.length} ${ids[k].slice(0, 8)} fill=${results[k].audit.fillFraction.toFixed(3)} roles=${results[k].audit.rolesShown}`);
      } catch (e) {
        console.log(`[fail] ${ids[k].slice(0, 8)}: ${e && e.stack}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const ok = results.filter(Boolean);
  fs.writeFileSync(path.join(outDir, `summary_${label}.md`), summarize(ok, label));
  console.log(summarize(ok, label));
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// onDemandScoring.test.js — on-demand scoring and the Quick read (spec 4.7).
// Plain Node + assert, like the rest of the repo's suites:
//   node apps/server/src/scan/__tests__/onDemandScoring.test.js
// Exits non-zero on any failure. No network, no AI, no real database — the
// `db` used below is an in-memory stub that records every query.

const assert = require('assert');
const shared = require('@careeros/shared');
const { tunables, constants } = shared;

let passed = 0;
let total = 0;
const pending = [];
function section(title) {
  pending.push(async () => console.log(`${title}:`));
}
function check(name, fn) {
  total += 1;
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok - ${name}`);
    } catch (e) {
      console.error(`  FAIL - ${name}`);
      console.error(`    ${e.stack || e.message}`);
      process.exitCode = 1;
    }
  });
}

// ---------------------------------------------------------------------------
// A chainable Supabase stub. Every from(table) call records one query
// ({table, op, payload, filters}); `respond(query)` decides what it resolves
// to. Terminal awaits resolve to { data, error: null }.
// ---------------------------------------------------------------------------
function makeDb(respond = () => null) {
  const queries = [];
  function builder(table) {
    const q = { table, op: 'select', payload: null, filters: [], single: false };
    queries.push(q);
    const self = {
      select() {
        return self;
      },
      insert(p) {
        q.op = 'insert';
        q.payload = p;
        return self;
      },
      update(p) {
        q.op = 'update';
        q.payload = p;
        return self;
      },
      upsert(p) {
        q.op = 'upsert';
        q.payload = p;
        return self;
      },
      delete() {
        q.op = 'delete';
        return self;
      },
      single() {
        q.single = true;
        return self;
      },
      maybeSingle() {
        q.single = true;
        return self;
      },
      then(resolve, reject) {
        return Promise.resolve({ data: respond(q), error: null }).then(resolve, reject);
      },
    };
    for (const m of ['eq', 'neq', 'in', 'lt', 'lte', 'gt', 'gte', 'is', 'not', 'or', 'order', 'limit', 'range', 'ilike']) {
      self[m] = (...args) => {
        q.filters.push([m, ...args]);
        return self;
      };
    }
    return self;
  }
  return {
    queries,
    from: builder,
    rpc: async (name, args) => {
      queries.push({ table: `rpc:${name}`, op: 'rpc', payload: args, filters: [] });
      return { data: { id: 'tx-rpc' }, error: null };
    },
  };
}
const hasFilter = (q, ...f) => q.filters.some((x) => JSON.stringify(x) === JSON.stringify(f));

// ---------------------------------------------------------------------------
const { quickRead, buildTriageProfile } = require('../triage');
const { computeOverallFit, applyScoreCaps } = require('../../scoring/scoreJob');
const { callbackFromRubric, RUBRIC_KEYS } = require('../../scoring/fitCall');

const PROFILE = buildTriageProfile({
  parsedProfile: {
    skills_declared: ['SQL', 'Jira', 'Product Roadmap', 'A/B testing', 'Stakeholder', 'communication', 'teamwork'],
    certifications: ['Lean Six Sigma Black Belt'],
    roles: [{ title: 'Associate Product Manager' }, { title: 'Business Analyst' }],
  },
  domainKeywords: ['user research', 'SQL'],
  years: 2.4,
});

section('Quick read — ceiling');

check('no deterministic cap: the ceiling is the formula maximum', () => {
  const r = quickRead({ job: { title: 'Product Manager', description_text: 'Own the roadmap.' }, profile: PROFILE });
  assert.strictEqual(r.ceiling, computeOverallFit(10, 10, 10));
  assert.deepStrictEqual(r.ceiling_reasons, []);
});

check('years gap under 1 caps at scoreCaps.yearsGapUnder1', () => {
  const r = quickRead({ job: { title: 'Product Manager', description_text: '3+ years of product management experience.' }, profile: PROFILE });
  assert.strictEqual(r.ceiling, tunables.scoreCaps.yearsGapUnder1);
  assert.ok(r.ceiling_reasons[0].includes('3+ years'));
});

check('years gap 1-2 caps at scoreCaps.yearsGap1to2', () => {
  const r = quickRead({ job: { title: 'Product Manager', description_text: '4+ years of experience required.' }, profile: PROFILE });
  assert.strictEqual(r.ceiling, tunables.scoreCaps.yearsGap1to2);
});

check('support role: seniority held to 5, gated callback', () => {
  const r = quickRead({ job: { title: 'Project Assistant', description_text: 'Support the team.' }, profile: PROFILE });
  const cb = callbackFromRubric(Object.fromEntries(RUBRIC_KEYS.map((k) => [k, 10])), null, { postingLevel: 'support' }).callbackOdds;
  assert.strictEqual(r.ceiling, computeOverallFit(10, cb, 10));
  assert.ok(r.ceiling < 8, 'a support role can never reach PURSUE');
});

check('structured program: callback held to the program max', () => {
  const r = quickRead({ job: { title: 'Graduate Rotational Program', description_text: 'Rotate across teams.' }, profile: PROFILE });
  assert.strictEqual(r.ceiling, computeOverallFit(10, tunables.scoring.callbackRubric.postingLevel.program.callbackMax, 10));
});

check('work-authorization restriction caps at scoreCaps.visaHigh', () => {
  const r = quickRead({ job: { title: 'Product Manager', description_text: 'Must be a U.S. citizen.' }, profile: PROFILE });
  assert.strictEqual(r.ceiling, tunables.scoreCaps.visaHigh);
});

check('the ceiling is a true upper bound over random rubrics, gaps and levels', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const bars = [null, 1, 2, 3, 4, 5, 8];
  const titles = ['Product Manager', 'Project Assistant', 'Graduate Rotational Program', 'Senior Product Manager'];
  for (let i = 0; i < 400; i += 1) {
    const bar = bars[Math.floor(rnd() * bars.length)];
    const title = titles[Math.floor(rnd() * titles.length)];
    const restricted = rnd() < 0.2;
    const desc = `${bar ? `${bar}+ years of experience.` : ''} ${restricted ? 'Must be a U.S. citizen.' : ''}`;
    const { ceiling } = quickRead({ job: { title, description_text: desc }, profile: PROFILE });
    // A real score: any rubric, any ATS, any preference fit, same caps.
    const rubric = Object.fromEntries(RUBRIC_KEYS.map((k) => [k, Math.round(rnd() * 100) / 10]));
    const gap = bar == null ? null : Math.round((bar - PROFILE.years) * 10) / 10;
    const level = title === 'Project Assistant' ? 'support' : title.includes('Program') ? 'program' : null;
    const cb = callbackFromRubric(rubric, gap, { postingLevel: level, unmetHardRequirement: rnd() < 0.2 }).callbackOdds;
    const { overall } = applyScoreCaps({
      overall: computeOverallFit(rnd() * 10, cb, rnd() * 10),
      jdYears: bar,
      userYears: PROFILE.years,
      riskTags: restricted ? [{ type: 'visa', severity: 'high' }] : [],
      note: '',
    });
    assert.ok(overall <= ceiling, `real ${overall} > ceiling ${ceiling} (${title}, bar ${bar}, restricted ${restricted})`);
  }
});

section('Quick read — rank, bands, signals');

check('résumé terms: literal hits, plural-tolerant, soft traits never counted', () => {
  assert.ok(!PROFILE.terms.includes('communication') && !PROFILE.terms.includes('teamwork'));
  const r = quickRead({
    job: { title: 'Product Manager', description_text: 'You will write SQL, triage Jira tickets, and talk to stakeholders about the product roadmap.' },
    profile: PROFILE,
  });
  for (const t of ['SQL', 'Jira', 'Stakeholder', 'Product Roadmap']) assert.ok(r.hit_terms.includes(t), `missing ${t}`);
  assert.ok(!r.hit_terms.includes('A/B testing'));
});

check('title fit: function words, not level words', () => {
  const pm = quickRead({ job: { title: 'Product Manager II - Payments', description_text: '' }, profile: PROFILE });
  const prog = quickRead({ job: { title: 'Program Manager', description_text: '' }, profile: PROFILE });
  assert.strictEqual(pm.title_fit, 1);
  assert.strictEqual(prog.title_fit, 0);
});

check('below_threshold whenever the ceiling is under the scan minimum', () => {
  const r = quickRead({ job: { title: 'Product Manager', description_text: '4+ years of experience. SQL, Jira, roadmap.' }, profile: PROFILE, threshold: 7.5 });
  assert.strictEqual(r.band, 'below_threshold');
  const ok = quickRead({ job: { title: 'Product Manager', description_text: '4+ years of experience. SQL, Jira, roadmap.' }, profile: PROFILE, threshold: 6.5 });
  assert.notStrictEqual(ok.band, 'below_threshold');
});

check('a strong overlap outranks a weak one, and bands follow tunables', () => {
  const strong = quickRead({
    job: { title: 'Product Manager', description_text: 'SQL, Jira, product roadmap, A/B testing, stakeholder alignment, user research, Lean Six Sigma Black Belt.' },
    profile: PROFILE,
  });
  const weak = quickRead({ job: { title: 'Nurse Practitioner', description_text: 'Patient care.' }, profile: PROFILE });
  assert.ok(strong.rank > weak.rank);
  assert.strictEqual(strong.band, strong.rank >= tunables.triage.bands.strongMin ? 'strong' : 'possible');
  assert.strictEqual(weak.band, 'long_shot');
});

check('an empty profile degrades to a neutral read, never throws', () => {
  const r = quickRead({ job: { title: 'Product Manager', description_text: 'SQL' }, profile: buildTriageProfile({}) });
  assert.strictEqual(r.term_hits, 0);
  assert.strictEqual(r.title_fit, null);
  assert.ok(Number.isFinite(r.rank));
});

section('score_mode plumbing');

check('normalizeScoreMode: only an explicit on_demand is on demand', () => {
  assert.strictEqual(constants.normalizeScoreMode('on_demand'), 'on_demand');
  for (const v of [undefined, null, '', 'auto', 'ON_DEMAND', 'manual']) assert.strictEqual(constants.normalizeScoreMode(v), 'auto');
});

check('POST /api/scan buildConfig carries score_mode', () => {
  const { buildConfig } = require('../../routes/scan');
  assert.strictEqual(buildConfig({ job_title: 'PM', sources: ['ats_direct'], score_mode: 'on_demand' }).config.score_mode, 'on_demand');
  assert.strictEqual(buildConfig({ job_title: 'PM', sources: ['ats_direct'] }).config.score_mode, 'auto');
});

check('a schedule row carries score_mode into its scan config', () => {
  const { configFromSchedule } = require('../runDueScans');
  const base = { job_title: 'PM', sources: ['ats_direct'], threshold: 7 };
  assert.strictEqual(configFromSchedule({ ...base, score_mode: 'on_demand' }).score_mode, 'on_demand');
  assert.strictEqual(configFromSchedule(base).score_mode, 'auto');
});

section('runScan in on-demand mode');

check('survivors are stored sourced with a Quick read, and no AI is touched', async () => {
  const aiRouter = require('../../lib/aiRouter');
  const origResolve = aiRouter.resolveAiCredential;
  const origSource = shared.jsearchAdapter.sourceJobs;
  const origCs = tunables.coreScraperEnabled;
  // Company detection probes live ATS endpoints — never from a test.
  const registry = require('../../companies/registry');
  const origResolveCompanies = registry.resolveCompaniesFromJobs;
  registry.resolveCompaniesFromJobs = async () => ({ attempted: 0 });
  aiRouter.resolveAiCredential = async () => {
    throw new Error('AI must not be resolved in on-demand mode');
  };
  tunables.coreScraperEnabled = true;
  shared.jsearchAdapter.sourceJobs = async () => ({
    requests: 1,
    jobs: [
      { source: 'cs', dedupKey: 'k1', title: 'Product Manager', companyName: 'Acme', descriptionText: 'SQL and Jira. 2+ years.', link: 'https://acme.example/1' },
      { source: 'cs', dedupKey: 'k2', title: 'Business Analyst', companyName: 'Beta', descriptionText: 'SQL dashboards.', link: 'https://beta.example/2' },
    ],
  });
  try {
    const db = makeDb((q) => {
      if (q.table === 'users') return { years_of_experience: 2.4, domain_keywords: ['SQL'], off_domain_title_keywords: [], years_of_experience_manual: true };
      if (q.table === 'resume_versions') return { id: 'rv1', parsed_profile: { skills_declared: ['SQL', 'Jira'], roles: [{ title: 'Associate Product Manager' }] } };
      if (q.table === 'scan_history' && q.op === 'update' && q.filters.some((f) => f[1] === 'status')) return { id: 's1' };
      return q.single ? null : [];
    });
    const origGetDb = shared.getSupabaseAdmin;
    shared.getSupabaseAdmin = () => db;
    delete require.cache[require.resolve('../runScan')];
    const { runScan } = require('../runScan');
    shared.getSupabaseAdmin = origGetDb;
    await runScan('s1', 'u1', { job_title: 'Product Manager', sources: ['cs'], threshold: 7.5, score_mode: 'on_demand', cs_job_count: 10 });

    const upsert = db.queries.find((q) => q.table === 'jobs' && q.op === 'upsert');
    assert.ok(upsert, 'survivors were upserted');
    assert.strictEqual(upsert.payload.length, 2);
    for (const row of upsert.payload) {
      assert.strictEqual(row.status, 'sourced');
      assert.ok(row.triage && typeof row.triage.rank === 'number' && row.triage.ceiling != null);
    }
    assert.ok(!db.queries.some((q) => q.table === 'ai_usage_log'), 'no AI usage logged');
    assert.ok(db.queries.some((q) => q.table === 'job_dedup_seen' && q.op === 'upsert'), 'dedup memory still written');
    const completed = db.queries.find((q) => q.table === 'scan_history' && q.op === 'update' && q.payload.status === 'completed');
    assert.ok(completed && completed.payload.jobs_scored_count === 0);
    // Only the scan's flat fee — the rpc/insert carries no AI cost.
    const debit = db.queries.find((q) => q.table === 'rpc:debit_cos' || (q.table === 'cos_transactions' && q.op === 'insert'));
    assert.ok(debit, 'flat fee billed');
  } finally {
    aiRouter.resolveAiCredential = origResolve;
    shared.jsearchAdapter.sourceJobs = origSource;
    tunables.coreScraperEnabled = origCs;
    registry.resolveCompaniesFromJobs = origResolveCompanies;
  }
});

check('seen keys load past the 1000-row page (a real account held 6,218)', async () => {
  const { selectAllRows } = require('../runScan');
  const pages = [];
  const db = makeDb((q) => {
    const r = q.filters.find((f) => f[0] === 'range');
    pages.push(r[1]);
    const n = r[1] === 0 ? 1000 : r[1] === 1000 ? 1000 : 218;
    return Array.from({ length: n }, (_, i) => ({ dedup_key: `k${r[1] + i}` }));
  });
  const rows = await selectAllRows(() => db.from('job_dedup_seen').select('dedup_key').eq('user_id', 'u1').order('id'));
  assert.strictEqual(rows.length, 2218);
  assert.deepStrictEqual(pages, [0, 1000, 2000]);
  assert.strictEqual(new Set(rows.map((r) => r.dedup_key)).size, 2218);
});

section('Scoring picked jobs');

check('parseJobIds: dedupes, requires one, caps at maxJobsPerRequest', () => {
  const { parseJobIds } = require('../scoreSelectedJobs');
  assert.ok(parseJobIds([]).error);
  assert.ok(parseJobIds('x').error);
  assert.deepStrictEqual(parseJobIds(['a', ' a ', 'b']).ids, ['a', 'b']);
  const max = tunables.onDemandScoring.maxJobsPerRequest;
  assert.ok(parseJobIds(Array.from({ length: max + 1 }, (_, i) => `j${i}`)).error);
  assert.ok(!parseJobIds(Array.from({ length: max }, (_, i) => `j${i}`)).error);
});

check('claimJobs only moves the caller’s still-sourced jobs, stamping the active résumé', async () => {
  const { claimJobs } = require('../scoreSelectedJobs');
  const db = makeDb(() => [{ id: 'a' }]);
  const rows = await claimJobs(db, 'u1', ['a', 'b'], 'rv9');
  assert.deepStrictEqual(rows, [{ id: 'a' }]);
  const q = db.queries[0];
  assert.strictEqual(q.op, 'update');
  assert.deepStrictEqual(q.payload, { status: 'scoring', resume_version_id: 'rv9' });
  assert.ok(hasFilter(q, 'eq', 'user_id', 'u1'));
  assert.ok(hasFilter(q, 'eq', 'status', 'sourced'));
  assert.ok(hasFilter(q, 'in', 'id', ['a', 'b']));
});

check('scoreSelectedJobs: threshold 0, billed into the scan row, failures released and reported', async () => {
  const jobScorerMod = require('../jobScorer');
  const aiRouter = require('../../lib/aiRouter');
  const origCreate = jobScorerMod.createJobScorer;
  const origResolve = aiRouter.resolveAiCredential;
  const seen = {};
  jobScorerMod.createJobScorer = async (args) => {
    seen.args = args;
    return {
      scoreOne: async (job) => {
        if (job.id === 'bad') throw new Error('model timeout');
      },
      flush: async () => {
        seen.flushed = true;
      },
    };
  };
  aiRouter.resolveAiCredential = async () => ({ mode: 'byok', provider: 'test' });
  try {
    delete require.cache[require.resolve('../scoreSelectedJobs')];
    const { scoreSelectedJobs } = require('../scoreSelectedJobs');
    const db = makeDb((q) => {
      if (q.table === 'users') return { years_of_experience: 3, years_of_experience_manual: true, domain_keywords: [] };
      if (q.table === 'resume_versions') return { id: 'rv1', parsed_profile: { roles: [] } };
      if (q.table === 'scan_history') return { id: 's1', sources: ['ats_direct'], config: { location: 'USA', threshold: 7.5 } };
      if (q.table === 'cos_transactions') return { id: 'tx-scan' };
      if (q.table === 'jobs' && q.op === 'update') return [{ id: 'bad', title: 'Bad Job' }];
      return q.single ? null : [];
    });
    await scoreSelectedJobs('u1', [
      { id: 'good', title: 'Good Job', scan_history_id: 's1' },
      { id: 'bad', title: 'Bad Job', scan_history_id: 's1' },
    ], { db });

    assert.strictEqual(seen.args.config.threshold, 0, 'every picked job is kept');
    assert.strictEqual(seen.args.config.location, 'USA', 'the scan location still drives preference fit');
    assert.strictEqual(seen.args.scanTransactionId, 'tx-scan', 'AI cost folds into the scan row');
    assert.strictEqual(seen.args.actionType, 'ats_direct_scan');
    assert.ok(seen.flushed, 'tracker rows flushed');
    const release = db.queries.find((q) => q.table === 'jobs' && q.op === 'update');
    assert.deepStrictEqual(release.payload, { status: 'sourced' });
    assert.ok(hasFilter(release, 'eq', 'status', 'scoring'), 'only unfinished jobs are released');
    const note = db.queries.find((q) => q.table === 'notifications');
    assert.ok(note && /1 job\(s\) could not be scored/.test(note.payload.message));
    assert.ok(!db.queries.some((q) => q.table === 'rpc:debit_cos'), 'no new flat fee');
  } finally {
    jobScorerMod.createJobScorer = origCreate;
    aiRouter.resolveAiCredential = origResolve;
  }
});

check('reapStaleOnDemandScoring resets only stale scoring rows', async () => {
  const { reapStaleOnDemandScoring } = require('../scheduler');
  const db = makeDb(() => [{ id: 'x' }, { id: 'y' }]);
  const n = await reapStaleOnDemandScoring(db);
  assert.strictEqual(n, 2);
  const q = db.queries[0];
  assert.deepStrictEqual(q.payload, { status: 'sourced' });
  assert.ok(hasFilter(q, 'eq', 'status', 'scoring'));
  assert.ok(q.filters.some((f) => f[0] === 'lt' && f[1] === 'updated_at'));
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed}/${total} passed`);
  if (passed !== total) process.exitCode = 1;
})();

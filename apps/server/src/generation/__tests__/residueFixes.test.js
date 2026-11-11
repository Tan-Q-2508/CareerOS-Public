#!/usr/bin/env node
// residueFixes.test.js — regression coverage for the defects closed by the
// Phase <=5.5 residue sweep (§15 #56), plus the one Phase 3 flagged and never
// exercised.
//
// Each block below pins a bug that was real, shipped, and found by re-walking
// the handoffs rather than by anything failing. A fix with no test is the same
// class of thing as the gap that produced it, so they get tests here.
//
// No test framework in this repo — plain Node + assert:
//   node apps/server/src/generation/__tests__/residueFixes.test.js

const assert = require('assert');
const fs = require('fs');

const { makeValidate } = require('../draftResume');
const { normalizePhone, buildContactLine, PHONE_RE } = require('../extractContact');
const { fitContactLinks } = require('../metrics');
const { bulletIdSet, bulletIdsByEntry } = require('../../scoring/fitCall');
const { extractionSettings, unionSkills } = require('../../scoring/jdAtsCall');
const { selfConsistentAts } = require('../../scoring/scoreJob');
const jdProfileCache = require('../../scoring/jdProfileCache');

let passed = 0;
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Per-entry bullet-id scoping
// ---------------------------------------------------------------------------

console.log('draftResume validator — a real id belonging to the WRONG entry:');

const profile = {
  roles: [
    { title: 'Platform Engineer', bullets: [{ id: 'r0b0', text: 'a' }, { id: 'r0b1', text: 'b' }] },
    { title: 'Data Analyst', bullets: [{ id: 'r1b0', text: 'c' }] },
  ],
  projects: [{ name: 'Thing', bullets: [{ id: 'p0b0', text: 'd' }] }],
};
const selected = { roleIndices: [0, 1], projectIndices: [0] };

function draft() {
  return {
    professional_title: 'Systems Engineer',
    summary: ['a', 'b', 'c'],
    experience: [
      { role_index: 0, bullets: [{ source_bullet_id: 'r0b0' }] },
      { role_index: 1, bullets: [{ source_bullet_id: 'r1b0' }] },
    ],
    projects: [{ project_index: 0, bullets: [{ source_bullet_id: 'p0b0' }] }],
  };
}
const validator = () => makeValidate(profile, selected, 'Target Title', { 0: 1, 1: 1 }, { 0: 1 }, null);

check('a correctly-cited draft is accepted', () => {
  // The validator contract is falsy-means-valid, not strictly-undefined.
  assert.ok(!validator()(draft()), 'a clean draft must not be rejected');
});

check('a bullet citing another ROLE\'s real id is rejected', () => {
  // This is the one that used to pass. r0b1 is a genuine bullet — just not this
  // role's — so the flat bulletIdSet() saw nothing wrong, and the draft shipped
  // one job's achievement attributed to a different job.
  const p = draft();
  p.experience[1].bullets[0].source_bullet_id = 'r0b1';
  const err = validator()(p);
  assert.ok(err, 'a wrong-entry citation must be rejected');
  assert.ok(/DIFFERENT entry/.test(err), `expected a wrong-entry message, got: ${err}`);
});

check('a role bullet citing a PROJECT\'s real id is rejected', () => {
  const p = draft();
  p.experience[0].bullets[0].source_bullet_id = 'p0b0';
  assert.ok(validator()(p), 'cross-type citation must be rejected');
});

check('a project bullet citing a ROLE\'s real id is rejected', () => {
  const p = draft();
  p.projects[0].bullets[0].source_bullet_id = 'r0b0';
  assert.ok(validator()(p), 'cross-type citation must be rejected');
});

check('an invented id still fails with the original message, not the new one', () => {
  const p = draft();
  p.experience[0].bullets[0].source_bullet_id = 'r9b9';
  const err = validator()(p);
  assert.ok(/not a real résumé bullet id/.test(err), `expected the fake-id message, got: ${err}`);
});

check('the wrong-entry check is enforced on the RETRY too, unlike the soft-repairable checks', () => {
  // bullet_target and the title check deliberately stop enforcing on attempt 2
  // because a deterministic repair exists downstream. Nothing can re-home a
  // bullet to the entry it belongs to, so this one must hold on both attempts.
  const v = validator();
  const p = draft();
  p.experience[1].bullets[0].source_bullet_id = 'r0b1';
  assert.ok(v(p), 'attempt 1 must reject');
  assert.ok(v(p), 'attempt 2 must still reject');
});

console.log('\nbulletIdsByEntry — agrees with bulletIdSet on which ids exist:');

check('the union of the per-entry sets is exactly the flat set', () => {
  const flat = bulletIdSet(profile);
  const { roles, projects } = bulletIdsByEntry(profile);
  const union = new Set();
  for (const s of [...roles.values(), ...projects.values()]) for (const id of s) union.add(id);
  assert.deepStrictEqual([...union].sort(), [...flat].sort(), 'the two derivations must never disagree');
});

check('a bullet with no id gets the same positional fallback in both', () => {
  const p = { roles: [{ bullets: [{ text: 'x' }, { text: 'y' }] }], projects: [{ bullets: [{ text: 'z' }] }] };
  assert.deepStrictEqual([...bulletIdSet(p)].sort(), ['p0b0', 'r0b0', 'r0b1']);
  const { roles, projects } = bulletIdsByEntry(p);
  assert.deepStrictEqual([...roles.get(0)].sort(), ['r0b0', 'r0b1']);
  assert.deepStrictEqual([...projects.get(0)], ['p0b0']);
});

// ---------------------------------------------------------------------------
// Phone extraction
// ---------------------------------------------------------------------------

console.log('\nPHONE_RE — the parenthesised area code that was being truncated:');

check('a parenthesised area code keeps its opening paren', () => {
  // The real stored value on a live account was "415) 555-0100": the match used
  // to start at the first DIGIT, dropping the "(". Every resume using the
  // conventional format hit this, not just one row.
  const line = 'Boston, MA | (415) 555-0100 | me@example.com';
  assert.strictEqual(line.match(PHONE_RE)[1], '(415) 555-0100');
});

check('other real formats are unaffected', () => {
  const cases = [
    ['Boston, MA | 415-555-0100 | me@example.com', '415-555-0100'],
    ['Boston, MA | +1 (415) 555-0100 | me@example.com', '+1 (415) 555-0100'],
    ['London | +44 20 7946 0958 | me@example.com', '+44 20 7946 0958'],
    ['Pune | 020 2550 1000 | me@example.com', '020 2550 1000'],
  ];
  for (const [line, expected] of cases) {
    assert.strictEqual(line.match(PHONE_RE)[1], expected, `failed on: ${line}`);
  }
});

console.log('\nnormalizePhone — heals an already-stored bad value without guessing:');

check('an unbalanced paren is dropped, not completed', () => {
  // Deliberately NOT "(415) 555-0100" — putting the paren back would mean
  // inventing a character in a phone number from a guess about where it went.
  assert.strictEqual(normalizePhone('415) 555-0100'), '415 555-0100');
  assert.strictEqual(normalizePhone('(415 555-0100'), '415 555-0100');
});

check('a balanced value is returned untouched', () => {
  assert.strictEqual(normalizePhone('(415) 555-0100'), '(415) 555-0100');
  assert.strictEqual(normalizePhone('+1 (415) 555-0100'), '+1 (415) 555-0100');
});

check('null and empty pass through rather than becoming a string', () => {
  assert.strictEqual(normalizePhone(null), null);
  assert.strictEqual(normalizePhone(undefined), undefined);
  assert.strictEqual(normalizePhone(''), '');
});

// ---------------------------------------------------------------------------
// Contact line: preview must equal export
// ---------------------------------------------------------------------------

console.log('\nfitContactLinks — the Copilot preview and the .docx agree:');

function contactWithLinks(n) {
  const types = ['linkedin', 'github', 'portfolio', 'gitlab', 'twitter', 'medium', 'stackoverflow', 'behance', 'dribbble', 'kaggle', 'orcid', 'youtube'];
  return {
    name: 'A Person',
    cityState: 'Boston, MA',
    phone: '(415) 555-0100',
    email: 'averylongemailaddress@somelongdomainname.example.com',
    links: types.slice(0, n).map((t) => ({ type: t, url: `https://${t}.com/averylongusernamehere` })),
  };
}

check('a link set that fits is unchanged by trimming', () => {
  const c = contactWithLinks(2);
  const fitted = fitContactLinks(c);
  assert.deepStrictEqual(fitted.dropped, []);
  assert.strictEqual(fitted.contactLine, buildContactLine(c));
});

check('an oversized link set is trimmed, and the trimmed line is what both surfaces use', () => {
  const c = contactWithLinks(12);
  // Forced to one line on purpose. At the real 2-line budget even the full
  // 15-platform set fits, which is exactly why no user ever hit this bug — the
  // divergence was latent, not visible. Squeezing the budget makes the trim
  // happen so the relationship under test is actually exercised; the function
  // and the equality it must satisfy are the same at either budget.
  const fitted = fitContactLinks(c, { maxLines: 1 });
  assert.ok(fitted.dropped.length > 0, 'the link set must actually overflow, or this test proves nothing');
  // The bug: the Canvas called buildContactLine on the UNTRIMMED set, so the
  // preview listed links the .docx had already dropped.
  assert.notStrictEqual(fitted.contactLine, buildContactLine(c), 'the untrimmed line must actually differ, or there is nothing to diverge');
  // And the fix: formatting the FITTED set reproduces the same string the
  // export uses. This is the equality the two call sites in copilot.js now rely on.
  assert.strictEqual(fitted.contactLine, buildContactLine({ ...c, links: fitted.links }));
});

check('no contact at all does not throw', () => {
  assert.strictEqual(fitContactLinks({}).contactLine, '');
  assert.strictEqual(fitContactLinks({ links: [] }).contactLine, '');
});

// ---------------------------------------------------------------------------
// The confirm-once gate (flagged by Phase 3's bug-fix handoff, never exercised)
// ---------------------------------------------------------------------------

console.log('\nunvouchedTermsIn — the confirm-once gate all three 422 call sites share:');

const copilot = require('../../routes/copilot');
const { unvouchedTermsIn } = copilot;

const jobContext = {
  jdProfile: { required_skills: ['Kubernetes', 'Terraform'], nice_to_have_skills: ['Go'] },
  tiered: { already_demonstrated: ['Terraform'], transferable: [], hidden_strengths: [] },
};

check('a term the text does not mention is never flagged', () => {
  assert.deepStrictEqual(unvouchedTermsIn('Wrote some documentation.', jobContext, [], []), []);
});

check('a JD term present in the text and vouched by nothing IS flagged', () => {
  assert.deepStrictEqual(unvouchedTermsIn('Ran Kubernetes in production.', jobContext, [], []), ['Kubernetes']);
});

check('a scan-vouched term is not flagged', () => {
  // already_demonstrated came from the scan, so the user has already vouched it.
  assert.deepStrictEqual(unvouchedTermsIn('Managed Terraform modules.', jobContext, [], []), []);
});

check('a confirmed_skills term is not flagged', () => {
  assert.deepStrictEqual(unvouchedTermsIn('Ran Kubernetes in production.', jobContext, ['Kubernetes'], []), []);
});

check('a confirmed-with-context term is not flagged', () => {
  assert.deepStrictEqual(unvouchedTermsIn('Ran Kubernetes in production.', jobContext, [], [{ term: 'Kubernetes', context: 'at work' }]), []);
});

check('several unvouched terms in one bullet are all returned', () => {
  const out = unvouchedTermsIn('Kubernetes and Go, daily.', jobContext, [], []).sort();
  assert.deepStrictEqual(out, ['Go', 'Kubernetes']);
});

check('a short vouched atom cannot spuriously satisfy the gate for a longer term', () => {
  // The B4 bug: bare bidirectional .includes() let a vouched "Go" satisfy a
  // required "Django". skillPresent's word-boundary rule is what stops it.
  const ctx = {
    jdProfile: { required_skills: ['Django'], nice_to_have_skills: [] },
    tiered: { already_demonstrated: [], transferable: [], hidden_strengths: [] },
  };
  assert.deepStrictEqual(unvouchedTermsIn('Built the Django backend.', ctx, ['Go'], []), ['Django']);
});

check('empty or null text flags nothing and does not throw', () => {
  for (const t of ['', null, undefined]) {
    assert.deepStrictEqual(unvouchedTermsIn(t, jobContext, [], []), []);
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Generation concurrency limiter
// ---------------------------------------------------------------------------

// Wrapped in a sequential async main: both checks read the SAME module-level
// counters, so letting them overlap made the drain check observe the other
// check's in-flight jobs. Await in order, then report.
// ---------------------------------------------------------------------------
// JD-extraction settings (2026-09-12). Every production call site is
// `runJdAts({ resumeSkillsBlock, jobTitle, jobText, credential })` with no
// tier/samples, so the override object it builds carries `undefined` for both.
// Spreading that over the configured values reset them — the configured
// samples:2 ran as 1, silently, which is the failure mode a tunable nobody
// reads is worst at.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// selfConsistentAts — the score and the fraction beside it must agree.
//
// Found live: a Box job's card read "KEYWORD MATCH · 7/7" above a 9.5, and six
// others (Google, Amazon) were off the same way. All were BORDERLINE jobs,
// which are the ones re-scored twice for self-consistency. The re-run averaged
// the two ATS scores but stored only the second run's coverage, so the stored
// number was the score of neither stored fraction.
//
// The re-run's premise — "v2's keyword match is deterministic, so averaging it
// is a no-op" — was true of call 1 alone and stopped being true when phase 2
// coverage began folding in call 2's vouched skills, which are a strong-tier
// AI judgment and differ per run.
// ---------------------------------------------------------------------------
check('v2 keeps one run’s ATS score, so it matches the fraction shown with it', () => {
  assert.strictEqual(selfConsistentAts({ useV2: true, firstAts: 10, secondAts: 9 }), 9);
  // The exact live case: 7/7 stored alongside an averaged 9.5.
  assert.notStrictEqual(selfConsistentAts({ useV2: true, firstAts: 10, secondAts: 9 }), 9.5);
});

check('two runs that agree are unaffected either way', () => {
  assert.strictEqual(selfConsistentAts({ useV2: true, firstAts: 8.6, secondAts: 8.6 }), 8.6);
  assert.strictEqual(selfConsistentAts({ useV2: false, firstAts: 8.6, secondAts: 8.6 }), 8.6);
});

check('legacy scoring still averages — it shows no fraction to contradict', () => {
  assert.strictEqual(selfConsistentAts({ useV2: false, firstAts: 10, secondAts: 9 }), 9.5);
});

check('an absent tier/samples argument does not override the configured value', () => {
  const configured = extractionSettings({});
  const withUndefined = extractionSettings({ tier: undefined, samples: undefined });
  assert.deepStrictEqual(withUndefined, configured);
  assert.ok(configured.samples >= 1);
});

check('an explicit argument still wins, and is clamped to a sane range', () => {
  assert.strictEqual(extractionSettings({ samples: 3 }).samples, 3);
  assert.strictEqual(extractionSettings({ samples: 99 }).samples, 4);
  assert.strictEqual(extractionSettings({ samples: 0 }).samples, 1);
  assert.strictEqual(extractionSettings({ tier: 'strong' }).tier, 'strong');
  assert.strictEqual(extractionSettings({ tier: 'nonsense' }).tier, 'cheap');
});

check('unioning samples dedupes case-insensitively and keeps first-seen wording', () => {
  const out = unionSkills([['SQL', 'Python'], ['sql', 'Tableau'], [' ', null, 'Python']]);
  assert.deepStrictEqual(out, ['SQL', 'Python', 'Tableau']);
});

// ---------------------------------------------------------------------------
// The extraction cache key (2026-09-12). Every failure mode of a cache is a
// wrong key: too narrow and a stale answer is served after a real change, too
// wide and nothing ever hits.
// ---------------------------------------------------------------------------
const baseKeyInput = {
  jdText: 'Operations Analyst\nManage FinOps and cloud spend.',
  resumeSkillsBlock: 'Declared skills: SQL, Excel',
  settings: { tier: 'cheap', samples: 2 },
  promptVersion: 'score-v1:abc123',
};
const keyWith = (over) => jdProfileCache.buildCacheKey({ ...baseKeyInput, ...over });

check('identical inputs produce an identical cache key', () => {
  assert.strictEqual(keyWith({}), keyWith({}));
});

check('every input that can change the answer changes the key', () => {
  const base = keyWith({});
  assert.notStrictEqual(base, keyWith({ jdText: baseKeyInput.jdText + ' Extra requirement.' }));
  // A résumé edit must invalidate: call 1 also emits ats_match, a judgement
  // about THIS candidate against that JD.
  assert.notStrictEqual(base, keyWith({ resumeSkillsBlock: 'Declared skills: SQL, Excel, Python' }));
  assert.notStrictEqual(base, keyWith({ settings: { tier: 'strong', samples: 2 } }));
  assert.notStrictEqual(base, keyWith({ settings: { tier: 'cheap', samples: 3 } }));
  // Editing the prompt must not keep serving answers the new prompt would
  // never produce.
  assert.notStrictEqual(base, keyWith({ promptVersion: 'score-v2:abc123' }));
});

check('field boundaries cannot be shifted to forge a collision', () => {
  // Without length-prefixing, "ab"+"c" and "a"+"bc" concatenate identically.
  assert.notStrictEqual(
    jdProfileCache.buildCacheKey({ ...baseKeyInput, jdText: 'ab', resumeSkillsBlock: 'c' }),
    jdProfileCache.buildCacheKey({ ...baseKeyInput, jdText: 'a', resumeSkillsBlock: 'bc' })
  );
});


async function main() {
  // A cache that cannot be reached must cost a re-extraction, never a scored
  // job — so every failure path resolves to a miss instead of throwing.
  await checkAsync('an unreachable cache degrades to a miss, never a throw', async () => {
    assert.strictEqual(await jdProfileCache.get(null, 'user', 'key'), null);
    const exploding = { from: () => { throw new Error('db is down'); } };
    assert.strictEqual(await jdProfileCache.get(exploding, 'user', 'key'), null);
    await jdProfileCache.put(exploding, 'user', { cacheKey: 'k', jdProfile: {} });
  });

  // -------------------------------------------------------------------------
  // Cancellation. Two résumés sat at 'running' for four hours because a deploy
  // killed the process under them and nothing could say so — which is both why
  // cancel exists and why the reaper does.
  //
  // The load-bearing property is that a cancel must actually STOP the work: the
  // signal travels through the progress logger, whose entire contract until now
  // was "never throws, never affects the pipeline". Cancellation is the one
  // exception, and it only applies when asked for.
  // -------------------------------------------------------------------------
  const { makeProgressLogger } = require('../../lib/progress');
  const { isCancellation, CancelledError, CANCELLABLE_STATUSES } = require('../../lib/cancellation');

  function fakeDb(status, { updateFails = false } = {}) {
    return {
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({ data: { progress: [], status }, error: null }) }) }),
        update: () => ({ eq: async () => ({ error: updateFails ? { message: 'write refused' } : null }) }),
      }),
    };
  }

  await checkAsync('a cancelled row stops the pipeline at its next milestone', async () => {
    const log = makeProgressLogger(fakeDb('cancelled'), 'generated_documents', 'doc1', { cancellable: true });
    let thrown = null;
    try {
      await log('draft', 'Drafting');
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'expected the logger to signal cancellation');
    assert.ok(isCancellation(thrown), 'must be recognisable as a cancellation, not a generic failure');
  });

  await checkAsync('a running row is not disturbed', async () => {
    const log = makeProgressLogger(fakeDb('running'), 'generated_documents', 'doc1', { cancellable: true });
    await log('draft', 'Drafting'); // must simply resolve
  });

  await checkAsync('a logger that was NOT asked to watch for cancellation never throws', async () => {
    // This is the one used for terminal writes, which run when the row is
    // ALREADY cancelled — a throw there would escape the catch handling the
    // cancellation and turn a clean stop into an unhandled rejection.
    const log = makeProgressLogger(fakeDb('cancelled'), 'generated_documents', 'doc1');
    await log('cancelled', 'Cancelled');
  });

  await checkAsync('a failed progress WRITE still never breaks the pipeline', async () => {
    // The original contract, which cancellation must not have weakened.
    const log = makeProgressLogger(fakeDb('running', { updateFails: true }), 'generated_documents', 'doc1', {
      cancellable: true,
    });
    await log('draft', 'Drafting');
  });

  await checkAsync('a cancellation is never mistaken for an ordinary failure', async () => {
    assert.ok(isCancellation(new CancelledError()));
    assert.ok(!isCancellation(new Error('AI call failed')));
    assert.ok(!isCancellation(null));
    // Cancelling something already finished must not overwrite its real outcome.
    assert.deepStrictEqual(CANCELLABLE_STATUSES, ['queued', 'running']);
    for (const terminal of ['completed', 'failed', 'cancelled']) {
      assert.ok(!CANCELLABLE_STATUSES.includes(terminal), `${terminal} must not be cancellable`);
    }
  });

  // The scan half: checked BETWEEN jobs, because both scoring loops isolate
  // per-job failures and would swallow a thrown cancellation.
  const { createCancelWatch } = require('../../scan/cancelWatch');

  function scanDb(statuses) {
    let i = 0;
    return {
      reads: 0,
      from() {
        this.reads += 1;
        const status = statuses[Math.min(i++, statuses.length - 1)];
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status }, error: null }) }) }) };
      },
    };
  }

  await checkAsync('a scan notices it was cancelled, and latches', async () => {
    const db = scanDb(['running', 'cancelled', 'running']);
    const isCancelled = createCancelWatch(db, 'scan1', { intervalMs: 0 });
    assert.strictEqual(await isCancelled(), false);
    assert.strictEqual(await isCancelled(), true);
    // Latched: a later poll saying 'running' must not resurrect the scan.
    assert.strictEqual(await isCancelled(), true);
  });

  await checkAsync('the check is throttled, so a 300-job scan is not 300 extra queries', async () => {
    const db = scanDb(['running']);
    const isCancelled = createCancelWatch(db, 'scan1', { intervalMs: 60000 });
    for (let n = 0; n < 50; n += 1) await isCancelled();
    assert.strictEqual(db.reads, 1, `expected one read, got ${db.reads}`);
  });

  await checkAsync('a check that cannot run lets the scan continue, never abandons it', async () => {
    const exploding = { from: () => { throw new Error('db is down'); } };
    const isCancelled = createCancelWatch(exploding, 'scan1', { intervalMs: 0 });
    assert.strictEqual(await isCancelled(), false);
  });

  // -------------------------------------------------------------------------
  // Cover letters carry no emphasis in the body (8.4, changed on sign-off).
  //
  // The bold subject line (8.1) is a SEPARATE mechanism — a literal flag on a
  // deterministic string — and must survive. These assert the mechanism is
  // gone rather than merely unused, because an unused code path is exactly how
  // a locked formatting rule creeps back.
  // -------------------------------------------------------------------------
  await checkAsync('the letter model carries no bold data at all', async () => {
    const render = require('../renderCoverLetter');
    const model = render.buildLetterModel(
      { paragraphs: ['One.', 'Two.', 'Three.', 'Four.'], bold_keywords: ['program management'] },
      { name: 'Alex Chen', email: 'a@example.com' },
      { title: 'Program Manager', company: 'Acme', location: 'Boston, MA' }
    );
    assert.ok(!('boldKeywords' in model), 'boldKeywords must not survive on the model');
    assert.deepStrictEqual(Object.keys(model).filter((k) => /bold/i.test(k)), []);
    // The subject line still exists and is still the thing the renderer bolds.
    assert.strictEqual(model.subject, 'Subject: Application for Program Manager - Alex Chen');
  });

  await checkAsync('the keyword-bolding mechanism is gone, not just unused', async () => {
    const render = require('../renderCoverLetter');
    for (const gone of ['splitBold', 'boldRuns']) {
      assert.strictEqual(render[gone], undefined, `${gone} must no longer exist`);
    }
    const draft = require('../draftCoverLetter');
    assert.strictEqual(draft.groundBoldKeywords, undefined);
    assert.ok(!('bold_keywords' in draft.DRAFT_SCHEMA.properties), 'the model must not be asked for keywords to bold');
    assert.deepStrictEqual(draft.DRAFT_SCHEMA.required, ['paragraphs']);
  });

  await checkAsync('stray markdown emphasis is still stripped before it reaches the .docx', async () => {
    // Now the ONLY defence against a model emitting emphasis markers, since
    // nothing downstream interprets them any more.
    const { stripMarkdown } = require('../renderCoverLetter');
    assert.strictEqual(stripMarkdown('I led **program management** work'), 'I led program management work');
    assert.strictEqual(stripMarkdown('I led __operations__ work'), 'I led operations work');
    assert.strictEqual(stripMarkdown('plain prose stays put'), 'plain prose stays put');
  });

  // -------------------------------------------------------------------------
  // A REFUSED write must not look like a write that never happened.
  //
  // supabase-js returns `{ error }` rather than throwing, so the try/catch that
  // used to be the only handling here caught nothing a PostgREST failure
  // produces. Both states were externally identical — no row, no log — which is
  // precisely why a broken cache survived a full production scan unnoticed.
  // -------------------------------------------------------------------------
  await checkAsync('a write the database REFUSES is reported, not swallowed', async () => {
    const refusing = {
      from: () => ({ upsert: async () => ({ error: { message: 'permission denied' } }) }),
    };
    const said = [];
    const realError = console.error;
    console.error = (...args) => said.push(args.join(' '));
    let wrote;
    try {
      wrote = await jdProfileCache.put(refusing, 'user', { cacheKey: 'k', jdProfile: {} });
    } finally {
      console.error = realError;
    }
    assert.strictEqual(wrote, false, 'a refused write must not report success');
    assert.ok(
      said.some((line) => line.includes('permission denied')),
      `expected the database's own reason to be logged, got: ${JSON.stringify(said)}`
    );
  });

  await checkAsync('a write the database accepts reports success', async () => {
    const accepting = { from: () => ({ upsert: async () => ({ error: null }) }) };
    assert.strictEqual(await jdProfileCache.put(accepting, 'user', { cacheKey: 'k', jdProfile: {} }), true);
  });

  // -------------------------------------------------------------------------
  // Certifications row (§15 #63). The draft AI never sees
  // profile.certifications, so it rebuilt them from the posting's wording:
  // "Lean Six Sigma Black Belt" rendered as "Lean Six Sigma". The row is now
  // the master's own certifications verbatim, plus other held ones.
  // -------------------------------------------------------------------------
  const { certificationRow } = require('../generateResume');
  const certProfile = { certifications: ['Lean Six Sigma Black Belt (Oct 2025)', 'Project Management Certificate — Google (Aug 2023)'] };
  check('the master certifications render verbatim; cut-down copies are dropped', () => {
    assert.deepStrictEqual(
      certificationRow(certProfile, ['Lean Six Sigma', 'Google Project Management Certificate', 'NetSuite certification']),
      ['Lean Six Sigma Black Belt (Oct 2025)', 'Project Management Certificate — Google (Aug 2023)', 'NetSuite certification']
    );
  });
  check('with no drafted certifications, the master ones still render', () => {
    assert.deepStrictEqual(certificationRow(certProfile, undefined), certProfile.certifications);
    assert.deepStrictEqual(certificationRow({}, ['AWS Certified']), ['AWS Certified']);
  });

  // -------------------------------------------------------------------------
  // cacheKeyFor — caching is opt-in on `db && userId`, and the quiet half of
  // that condition is what broke.
  //
  // `jobScorer` passed `user.id` from a `users` row SELECTed without `id`, so
  // userId was undefined, so no key was built, so the cache was never read OR
  // written across a 163-job scan — while looking exactly like a cold cache.
  // No db at all is a legitimate mode (scripts, the offline harness) and stays
  // silent; a db with no user is always a wiring bug and now says so.
  // -------------------------------------------------------------------------
  const { cacheKeyFor } = require('../../scoring/jdAtsCall');
  const keyArgs = { jdText: 'a job', resumeSkillsBlock: 'skills', settings: { tier: 'cheap', samples: 2 } };

  await checkAsync('a db and a real user produce a key', async () => {
    assert.ok(cacheKeyFor({ db: {}, userId: 'u1', ...keyArgs }));
  });

  await checkAsync('no db at all is a supported mode and stays quiet', async () => {
    const said = [];
    const realWarn = console.warn;
    console.warn = (...args) => said.push(args.join(' '));
    try {
      assert.strictEqual(cacheKeyFor({ db: null, userId: null, ...keyArgs }), null);
    } finally {
      console.warn = realWarn;
    }
    assert.deepStrictEqual(said, [], 'a script running without a db must not warn');
  });

  await checkAsync('a db WITHOUT a user is a wiring bug, and warns instead of degrading quietly', async () => {
    for (const missing of [undefined, null, '']) {
      const said = [];
      const realWarn = console.warn;
      console.warn = (...args) => said.push(args.join(' '));
      try {
        assert.strictEqual(cacheKeyFor({ db: {}, userId: missing, ...keyArgs }), null);
      } finally {
        console.warn = realWarn;
      }
      assert.strictEqual(said.length, 1, `expected exactly one warning for userId=${JSON.stringify(missing)}`);
      assert.ok(said[0].includes('userId'), `warning must name the missing input: ${said[0]}`);
    }
  });

console.log('\ngenerationQueue — bounded, and it never leaks a slot:');

const { runGenerationJob, stats } = require('../../lib/generationQueue');

await checkAsync('ten simultaneous jobs never exceed the configured limit', async () => {
  // The whole point: four heavy AI+docx pipelines already return 202 and run
  // in the background with nothing bounding how many run at once on one free
  // dyno. Deferred by Phase 3 to a §25 that was built as something else.
  let inFlight = 0;
  let peak = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const job = async (fail) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(15);
    inFlight -= 1;
    if (fail) throw new Error('boom');
  };

  const limit = stats().limit;
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, n) => runGenerationJob('test', () => job(n === 3 || n === 7)))
  );

  assert.ok(peak <= limit, `peak concurrency ${peak} exceeded the limit of ${limit}`);
  assert.strictEqual(results.filter((r) => r.status === 'rejected').length, 2, 'a throwing job must still reject to its caller');
  assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 8);
});

await checkAsync('the pool fully drains, including after a job throws', async () => {
  // A leaked slot would wedge generation for the whole process until a
  // redeploy — a worse failure than the contention this exists to prevent.
  await Promise.allSettled([
    runGenerationJob('ok', async () => 1),
    runGenerationJob('bad', async () => { throw new Error('boom'); }),
  ]);
  assert.deepStrictEqual({ active: stats().active, queued: stats().queued }, { active: 0, queued: 0 });
});

// The chain itself
// ---------------------------------------------------------------------------

console.log('\nnpm test — every suite on disk is actually in the chain:');

check('no *.test.js file is missing from the test script', () => {
  // Stated as a rule, for the same reason the canary enrolment check is: a
  // hand-maintained list of things to run drifts silently from the things that
  // exist, and nobody notices until a bug ships through the gap.
  const path = require('path');
  const root = path.join(__dirname, '..', '..', '..', '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const chain = pkg.scripts.test || '';

  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.test.js')) found.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'apps'));
  walk(path.join(root, 'packages'));

  // A suite counts as wired up only if some test:* script points at its path
  // AND the chain actually runs that script.
  const missing = found.filter((f) => {
    const entry = Object.entries(pkg.scripts).find(([k, v]) => k.startsWith('test:') && v.includes(f));
    return !entry || !chain.includes(`npm run ${entry[0]}`);
  });
  assert.deepStrictEqual(missing, [], `test files that "npm test" never runs: ${missing.join(", ")}`);
  assert.ok(found.length >= 15, `expected at least 15 suites, found ${found.length}`);
});

  // An overflowing bullet is shortened by whole clauses, never cut mid-thought
  // ("...and set migration." shipped on a real résumé before this).
  const { fitWholeClause, repairVariants } = require('../variantFit');
  const { geometry, DEFAULT_RENDER } = require('../metrics');
  const fitGeom = geometry(DEFAULT_RENDER.marginIn);
  check('variantFit: a trailing participle clause is dropped whole', () => {
    const t = 'Onboarded 5+ vendors in Oracle NetSuite and managed POs to reduce supply chain lead times by 13%, avoiding material shortages during the production ramp.';
    assert.strictEqual(fitWholeClause(t, fitGeom, 0.99), 'Onboarded 5+ vendors in Oracle NetSuite and managed POs to reduce supply chain lead times by 13%.');
  });
  check('variantFit: a list is never left unfinished; the complete shorter variant is used instead', () => {
    const t = 'Mapped system integrations and workflows across business functions to define scope, manage risks, and set migration sequencing for all six platforms.';
    assert.strictEqual(fitWholeClause(t, fitGeom, 0.99), null);
    const { variants } = repairVariants({ short: 'Mapped integrations to define migration scope and risks.', one_line: t, two_line: t });
    assert.strictEqual(variants.one_line, 'Mapped integrations to define migration scope and risks.');
  });
  check('variantFit: no repaired variant ends on a dangling word', () => {
    const t = 'Built a Power BI dashboard for the sales team with data from Salesforce and NetSuite across the four regional business units in North America and Europe for the weekly leadership review.';
    const { variants } = repairVariants({ short: 'Built a Power BI sales dashboard.', one_line: t, two_line: `${t} ${t}` });
    for (const v of Object.values(variants)) assert.ok(!/\b(to|and|for|with|of|the|in|across)\.$/.test(v), v);
  });

  console.log(`\n${passed} checks passed`);
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error('residueFixes.test.js: unexpected error:', e);
  process.exit(1);
});

#!/usr/bin/env node
// classifyPass.test.js — regression suite for the sector-classification pass's
// PROMPT SHAPING and AI WIRING (spec 4.6.9, §15 #54).
//
// sectorLanes.test.js (§15 #53) covers the decision layer — which companies get
// which batch size, which ones a pass touches — plus sectors.js's makeValidator
// and normalizeSectors in isolation. What nothing covered was the layer between
// them: what actually reaches the model, and what happens to what comes back.
//
// That layer holds three properties worth a test:
//
//  - COST. classifyCompanies short-circuits an empty batch WITHOUT calling the
//    router. On a resumable pass (§15 #52) a lane is routinely empty because a
//    previous run already finished it, and a call per empty lane would burn
//    cheap-tier quota — of which there is roughly one registry-pass worth per
//    day — to classify nothing.
//  - BILLING. 4.6.9 makes classification platform overhead: it must always use
//    the house credential at the cheap tier, never a user's BYOK key. That is
//    enforced by the literal arguments passed here and by nothing else.
//  - HONESTY. normalizeSectors has to run over EVERY result, not just the one a
//    spot-check would look at, or a `logistics, other` row reaches the database
//    claiming the company is both known and unknown.
//
// aiRouter is stubbed by mutating the required module object before use —
// sectors.js does `aiRouter.structuredCall(...)` as a property access on that
// same object, so replacing the method is enough. Stubbing the router rather
// than geminiAdapter (aiRouter.test.js's approach) is deliberate: the credential
// and the tier are only visible at this seam, and they are the billing property.
// No network, no API key, no DB.
//
// No test framework in this repo — plain Node + assert:
//   node apps/server/src/companies/__tests__/classifyPass.test.js

const assert = require('assert');
const path = require('path');
const { tunables, constants } = require('@careeros/shared');

const aiRouter = require('../../lib/aiRouter');
const realStructuredCall = aiRouter.structuredCall;

const { companiesBlock, classifyCompanies } = require('../sectors');

// Requiring the bulk script must NOT run the registry-wide pass. Before §15 #54
// this line alone would have started an ETL against the live database — the
// file called main() at module scope, which is exactly why none of it could be
// tested. Reaching the next line is the regression check.
const script = require(path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'classify-sectors.js'));
const { parseArgs, chunk } = script;

const CFG = tunables.sectorClassification;
const { MAX_SECTORS_PER_COMPANY } = constants;

let passed = 0;
let calls = [];

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

/**
 * Stub the router with a model that returns `results`. Records every call's
 * credential, tier and prompt, and runs the validator classifyCompanies passed
 * — so a validator that is built but never wired is a failure here, not a
 * silent no-op in production.
 */
function stubRouter(results) {
  calls = [];
  aiRouter.structuredCall = async (credential, args) => {
    calls.push({ credential, ...args });
    const parsed = { results: typeof results === 'function' ? results(args) : results };
    if (typeof args.validate === 'function') {
      const err = args.validate(parsed);
      if (err) throw new Error(`validator rejected the stub payload: ${err}`);
    }
    return {
      parsed,
      usage: { promptTokenCount: 10, candidatesTokenCount: 5 },
      costUsd: 0.00002,
      model: 'stub-model',
      connectionMode: 'developer',
    };
  };
}

const company = (id, extra = {}) => ({
  id,
  company_name_display: id,
  platform: 'greenhouse',
  slug_or_identifier: id,
  ...extra,
});

// --- companiesBlock --------------------------------------------------------

console.log('companiesBlock — what the model is actually shown:');

check('every company appears exactly once, in input order', () => {
  const companies = [company('a'), company('b'), company('c')];
  const lines = companiesBlock(companies).split('\n');
  assert.strictEqual(lines.length, 4, 'one header + one line per company');
  assert.match(lines[0], /COMPANIES TO CLASSIFY/);
  assert.match(lines[1], /id=a\b/);
  assert.match(lines[2], /id=b\b/);
  assert.match(lines[3], /id=c\b/);
});

check('each line carries all four fields the prompt reasons over', () => {
  const line = companiesBlock([
    company('id-1', { company_name_display: 'Stripe', platform: 'greenhouse', slug_or_identifier: 'stripe' }),
  ]).split('\n')[1];
  assert.strictEqual(line, 'id=id-1 | name=Stripe | platform=greenhouse | slug=stripe');
});

check('a null platform or slug renders (unknown), never a literal null', () => {
  // The system instruction tells the model a slug can carry NO information
  // about the industry. A literal "null" or "undefined" in that position reads
  // as a value — a token to reason from — which is the opposite of the
  // intended signal.
  const line = companiesBlock([
    company('x', { company_name_display: 'Stealth Co', platform: null, slug_or_identifier: null }),
  ]).split('\n')[1];
  assert.strictEqual(line, 'id=x | name=Stealth Co | platform=(unknown) | slug=(unknown)');
  assert.ok(!/null|undefined/.test(line), 'no literal null/undefined reaches the prompt');
});

check('an empty slug string is treated as unknown too, not as an empty value', () => {
  const line = companiesBlock([company('y', { slug_or_identifier: '' })]).split('\n')[1];
  assert.match(line, /slug=\(unknown\)/);
});

check('a large batch is not truncated — every company reaches the model', () => {
  const companies = Array.from({ length: CFG.batchSizes.standard }, (_, i) => company(`c${i}`));
  const block = companiesBlock(companies);
  assert.strictEqual(block.split('\n').length, CFG.batchSizes.standard + 1);
  for (const c of companies) assert.ok(block.includes(`id=${c.id} |`), `${c.id} missing from the prompt`);
});

// --- classifyCompanies -----------------------------------------------------

(async () => {
  console.log('\nclassifyCompanies — the empty-batch short circuit (a quota guard, not an optimization):');

  await checkAsync('an empty batch returns an empty Map and makes NO router call', async () => {
    stubRouter([]);
    const r = await classifyCompanies([]);
    assert.strictEqual(calls.length, 0, 'an empty lane must not spend a call');
    assert.strictEqual(r.byCompanyId.size, 0);
    assert.strictEqual(r.costUsd, 0);
    assert.strictEqual(r.usage, null);
  });

  await checkAsync('null/undefined are handled the same way, not thrown on', async () => {
    stubRouter([]);
    assert.strictEqual((await classifyCompanies(null)).byCompanyId.size, 0);
    assert.strictEqual((await classifyCompanies(undefined)).byCompanyId.size, 0);
    assert.strictEqual(calls.length, 0);
  });

  console.log('\nclassifyCompanies — 4.6.9 platform overhead: the house credential, the cheap tier:');

  await checkAsync('always the house CAI credential — never a user BYOK key', async () => {
    stubRouter([{ company_id: 'a', sectors: ['fintech'] }]);
    await classifyCompanies([company('a')]);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].credential, { mode: 'cai' });
  });

  await checkAsync('always the cheap tier — classification never reaches for the strong model', async () => {
    stubRouter([{ company_id: 'a', sectors: ['fintech'] }]);
    await classifyCompanies([company('a')]);
    assert.strictEqual(calls[0].tier, 'cheap');
  });

  await checkAsync('the prompt IS companiesBlock output, and a schema is always sent', async () => {
    const companies = [company('a'), company('b')];
    stubRouter(companies.map((c) => ({ company_id: c.id, sectors: ['other'] })));
    await classifyCompanies(companies);
    assert.strictEqual(calls[0].prompt, companiesBlock(companies));
    assert.ok(calls[0].responseSchema, 'a response schema is always sent');
    assert.ok(calls[0].systemInstruction.length > 0);
  });

  console.log('\nclassifyCompanies — the validator is WIRED, not merely built:');

  await checkAsync('a hallucinated company_id is rejected rather than written', async () => {
    // The stub runs whatever validator it was given. If classifyCompanies ever
    // stopped passing one, this payload would sail through and a sector would
    // be attributed to a company that was never in the batch.
    stubRouter([{ company_id: 'not-in-the-batch', sectors: ['fintech'] }]);
    await assert.rejects(() => classifyCompanies([company('a')]), /is not one of the input companies/);
  });

  await checkAsync('an invented sector outside the fixed vocabulary is rejected', async () => {
    stubRouter([{ company_id: 'a', sectors: ['crypto_casino'] }]);
    await assert.rejects(() => classifyCompanies([company('a')]), /unknown sector/);
  });

  await checkAsync('more than MAX_SECTORS_PER_COMPANY is rejected', async () => {
    const tooMany = constants.COMPANY_SECTORS.slice(0, MAX_SECTORS_PER_COMPANY + 1);
    assert.strictEqual(tooMany.length, MAX_SECTORS_PER_COMPANY + 1, 'the vocabulary must exceed the cap for this to test anything');
    stubRouter([{ company_id: 'a', sectors: tooMany }]);
    await assert.rejects(() => classifyCompanies([company('a')]), /more than/);
  });

  console.log('\nclassifyCompanies — normalization runs over EVERY result, not just the first:');

  await checkAsync('`other` is stripped alongside a real sector on every company in the batch', async () => {
    // The bug this guards is a for-loop that normalizes results[0] and copies
    // the rest through. A 50-company batch would then land 49 unnormalized
    // rows, each claiming to be both determined and undetermined.
    const companies = [company('a'), company('b'), company('c')];
    stubRouter([
      { company_id: 'a', sectors: ['logistics', 'other'] },
      { company_id: 'b', sectors: ['fintech', 'other'] },
      { company_id: 'c', sectors: ['other'] },
    ]);
    const { byCompanyId } = await classifyCompanies(companies);
    assert.deepStrictEqual(byCompanyId.get('a'), ['logistics']);
    assert.deepStrictEqual(byCompanyId.get('b'), ['fintech']);
    assert.deepStrictEqual(byCompanyId.get('c'), ['other'], 'a lone `other` is the honest answer and survives');
  });

  await checkAsync('duplicates in one result are collapsed', async () => {
    stubRouter([{ company_id: 'a', sectors: ['fintech', 'fintech'] }]);
    const { byCompanyId } = await classifyCompanies([company('a')]);
    assert.deepStrictEqual(byCompanyId.get('a'), ['fintech']);
  });

  await checkAsync('usage, cost, model and connection mode all travel back for ai_usage_log', async () => {
    // logSectorUsage writes these to ai_usage_log with user_id: null. If any
    // were dropped here the classification pass would be genuinely unbilled AND
    // genuinely unlogged, which 4.6.9 does not allow — overhead is absorbed,
    // not hidden.
    stubRouter([{ company_id: 'a', sectors: ['fintech'] }]);
    const r = await classifyCompanies([company('a')]);
    assert.strictEqual(r.model, 'stub-model');
    assert.strictEqual(r.connectionMode, 'developer');
    assert.strictEqual(r.costUsd, 0.00002);
    assert.ok(r.usage && r.usage.promptTokenCount === 10);
  });

  await checkAsync('a company the model silently omitted is simply absent, never guessed at', async () => {
    // selectStale re-selects anything not stamped with the current version, so
    // an omission costs one retry on the next run. Inventing a sector to fill
    // the gap would cost a wrong fact forever.
    stubRouter([{ company_id: 'a', sectors: ['fintech'] }]);
    const { byCompanyId } = await classifyCompanies([company('a'), company('b')]);
    assert.strictEqual(byCompanyId.size, 1);
    assert.strictEqual(byCompanyId.has('b'), false);
  });

  // --- the script's argv layer --------------------------------------------

  console.log('\nparseArgs / chunk — reachable at all only because the script is now requirable:');

  check('requiring the bulk script does not run it, and exports the pure layer', () => {
    assert.strictEqual(typeof script.parseArgs, 'function');
    assert.strictEqual(typeof script.chunk, 'function');
    assert.strictEqual(typeof script.main, 'function');
  });

  check('neither mode is assumed — a bare invocation sets no run flag', () => {
    const a = parseArgs([]);
    assert.strictEqual(a.dryRun, false);
    assert.strictEqual(a.apply, false);
  });

  check('defaults come from tunables, not from a hardcoded number', () => {
    assert.strictEqual(parseArgs([]).concurrency, CFG.concurrency);
    assert.deepStrictEqual(parseArgs([]).lanes, ['solo', 'complex', 'standard']);
    assert.strictEqual(parseArgs([]).limit, null);
  });

  check('--limit and --concurrency parse to numbers, not strings', () => {
    const a = parseArgs(['--apply', '--limit=250', '--concurrency=8']);
    assert.strictEqual(a.apply, true);
    assert.strictEqual(a.limit, 250);
    assert.strictEqual(a.concurrency, 8);
  });

  check('--lanes selects a subset, in the order given', () => {
    assert.deepStrictEqual(parseArgs(['--lanes=solo,standard']).lanes, ['solo', 'standard']);
    assert.deepStrictEqual(parseArgs(['--lanes= solo , complex ']).lanes, ['solo', 'complex']);
  });

  check('an unknown lane name is DROPPED, not run and not crashed on', () => {
    // The consequence is worth stating: a typo runs fewer lanes and reports
    // fewer companies, silently. It does not classify the wrong ones, and it
    // does not die partway through a paid pass.
    assert.deepStrictEqual(parseArgs(['--lanes=solo,slow']).lanes, ['solo']);
    assert.deepStrictEqual(parseArgs(['--lanes=nonsense']).lanes, []);
  });

  check('an unrecognised flag is ignored rather than aborting a long pass', () => {
    const a = parseArgs(['--dry-run', '--wat']);
    assert.strictEqual(a.dryRun, true);
  });

  check('--out captures a path containing = signs', () => {
    assert.strictEqual(parseArgs(['--out=/tmp/a=b.json']).out, '/tmp/a=b.json');
  });

  check('chunk splits evenly, keeps the remainder, and never drops an element', () => {
    assert.deepStrictEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
    assert.deepStrictEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
    assert.deepStrictEqual(chunk([1, 2], 50), [[1, 2]], 'a batch smaller than its size is one chunk');
    assert.deepStrictEqual(chunk([], 50), [], 'an empty lane produces no chunks — and so no calls');
  });

  check('chunk over a full standard lane preserves every company', () => {
    const items = Array.from({ length: 137 }, (_, i) => i);
    const chunks = chunk(items, CFG.batchSizes.standard);
    assert.strictEqual(chunks.flat().length, items.length);
    assert.deepStrictEqual(chunks.flat(), items);
  });

  aiRouter.structuredCall = realStructuredCall;
  console.log(`\n${passed} checks passed.`);
})();

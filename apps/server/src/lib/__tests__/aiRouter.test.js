#!/usr/bin/env node
// aiRouter.test.js — regression suite for the CAI candidate-list fallback
// loop added with the vertex->developer connection-mode migration (16.7).
// Each tier is an ORDERED LIST of models rather than one model, because
// AI Studio's free tier grants quota per model ID; structuredCall must try
// them in order and return the first success, so a single model's quota
// exhaustion or a transient 503 doesn't fail the whole call.
//
// No test framework in this repo (no jest/mocha) — plain Node + assert,
// runnable directly:
//   node apps/server/src/lib/__tests__/aiRouter.test.js
// Exits non-zero on any failure.
//
// geminiAdapter is stubbed by mutating the shared module's exported object
// BEFORE aiRouter is required: aiRouter destructures that same object
// reference at load, so replacing the method on it is enough — no network,
// no API key, no DB.

const assert = require('assert');
const shared = require('@careeros/shared');

const realStructuredCall = shared.geminiAdapter.structuredCall;
let calls = [];

// Installs a stub that fails for every model in `failModels` and succeeds
// for anything else, recording the exact order models were tried in.
function stubGemini({ failModels = [], failAll = false } = {}) {
  calls = [];
  shared.geminiAdapter.structuredCall = async ({ model }) => {
    calls.push(model);
    if (failAll || failModels.includes(model)) {
      throw new Error(`stub failure for ${model}`);
    }
    return { data: { ok: true }, model, connectionMode: 'developer', costUsd: 0.0001 };
  };
}

const aiRouter = require('../aiRouter');
const { tunables } = shared;

const cheap = Array.isArray(tunables.aiModelTier.cheap) ? tunables.aiModelTier.cheap : [tunables.aiModelTier.cheap];
const strong = Array.isArray(tunables.aiModelTier.strong) ? tunables.aiModelTier.strong : [tunables.aiModelTier.strong];
const parse = Array.isArray(tunables.parseModel) ? tunables.parseModel : [tunables.parseModel];

const CAI = { mode: 'cai' };
const args = { systemInstruction: 'sys', prompt: 'p', responseSchema: {}, validate: undefined };

let passed = 0;
async function check(name, fn) {
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

async function main() {
  console.log('tunables shape — each tier must be a non-empty ordered list:');

  await check('cheap tier is a non-empty array of model names', () => {
    assert.ok(Array.isArray(tunables.aiModelTier.cheap), 'aiModelTier.cheap must be an array');
    assert.ok(cheap.length >= 1);
    for (const m of cheap) assert.strictEqual(typeof m, 'string');
  });

  await check('strong tier is a non-empty array of model names', () => {
    assert.ok(Array.isArray(tunables.aiModelTier.strong), 'aiModelTier.strong must be an array');
    assert.ok(strong.length >= 1);
    for (const m of strong) assert.strictEqual(typeof m, 'string');
  });

  await check('parse tier is a non-empty array of model names', () => {
    assert.ok(Array.isArray(tunables.parseModel), 'parseModel must be an array');
    assert.ok(parse.length >= 1);
  });

  await check('cheap and strong pools are disjoint (16.7: cheap volume must not starve strong quota)', () => {
    const overlap = cheap.filter((m) => strong.includes(m));
    assert.deepStrictEqual(overlap, [], `cheap/strong share model(s): ${overlap.join(', ')}`);
  });

  await check('every candidate model has a geminiRates entry (otherwise costUsd silently goes null)', () => {
    for (const m of [...cheap, ...strong, ...parse]) {
      assert.ok(tunables.geminiRates[m], `no geminiRates entry for "${m}"`);
    }
  });

  console.log('\nCAI fallback loop:');

  await check('first candidate succeeds -> only one call, no fallback', async () => {
    stubGemini();
    const res = await aiRouter.structuredCall(CAI, { tier: 'cheap', ...args });
    assert.strictEqual(res.model, cheap[0]);
    assert.deepStrictEqual(calls, [cheap[0]]);
  });

  await check('first candidate fails -> falls through to the second, in order', async () => {
    if (cheap.length < 2) return; // nothing to fall through to
    stubGemini({ failModels: [cheap[0]] });
    const res = await aiRouter.structuredCall(CAI, { tier: 'cheap', ...args });
    assert.strictEqual(res.model, cheap[1]);
    assert.deepStrictEqual(calls, [cheap[0], cheap[1]]);
  });

  await check('all but the last candidate fail -> the last one still succeeds', async () => {
    stubGemini({ failModels: strong.slice(0, -1) });
    const res = await aiRouter.structuredCall(CAI, { tier: 'strong', ...args });
    assert.strictEqual(res.model, strong[strong.length - 1]);
    assert.deepStrictEqual(calls, strong);
  });

  await check('every candidate fails -> throws, after trying all of them', async () => {
    stubGemini({ failAll: true });
    await assert.rejects(
      () => aiRouter.structuredCall(CAI, { tier: 'strong', ...args }),
      /stub failure/
    );
    assert.deepStrictEqual(calls, strong, 'must attempt every candidate before giving up');
  });

  await check("tier 'parse' uses tunables.parseModel, not aiModelTier", async () => {
    stubGemini();
    const res = await aiRouter.structuredCall(CAI, { tier: 'parse', ...args });
    assert.strictEqual(res.model, parse[0]);
    assert.deepStrictEqual(calls, [parse[0]]);
  });

  await check('cheap and strong tiers each stay inside their own pool', async () => {
    stubGemini({ failAll: true });
    await assert.rejects(() => aiRouter.structuredCall(CAI, { tier: 'cheap', ...args }));
    assert.deepStrictEqual(calls, cheap);
  });

  console.log('\nBYOK branch is unaffected by the CAI candidate lists:');

  await check('BYOK gemini calls exactly the configured model, once, no fallback', async () => {
    stubGemini();
    const res = await aiRouter.structuredCall(
      { mode: 'byok', provider: 'gemini', apiKey: 'k', baseUrl: null, model: 'some-user-model' },
      { tier: 'strong', ...args }
    );
    assert.deepStrictEqual(calls, ['some-user-model']);
    assert.strictEqual(res.connectionMode, 'byok');
    assert.strictEqual(res.costUsd, null);
  });

  await check('unknown BYOK provider throws rather than silently falling back to CAI', async () => {
    stubGemini();
    await assert.rejects(
      () => aiRouter.structuredCall({ mode: 'byok', provider: 'not_a_provider' }, { tier: 'cheap', ...args }),
      /unknown BYOK provider/
    );
    assert.deepStrictEqual(calls, []);
  });

  // ---- per-model cooldown after a timeout (Vertex gemini-3.8-flash hangs) ----
  await check('a timed-out model is skipped on the next call, not retried for its full timeout again', async () => {
    aiRouter.resetModelCooldowns();
    calls = [];
    shared.geminiAdapter.structuredCall = async ({ model }) => {
      calls.push(model);
      if (model === strong[0]) throw new Error('This operation was aborted');
      return { data: { ok: true }, model, connectionMode: 'vertex', costUsd: 0 };
    };
    await aiRouter.structuredCall(CAI, { tier: 'strong', ...args });
    assert.deepStrictEqual(calls, [strong[0], strong[1]]);
    calls = [];
    await aiRouter.structuredCall(CAI, { tier: 'strong', ...args });
    assert.deepStrictEqual(calls, [strong[1]], 'the cooling model must be skipped');
  });

  await check('an ordinary (non-timeout) failure does not start a cooldown', async () => {
    aiRouter.resetModelCooldowns();
    stubGemini({ failModels: [strong[0]] });
    await aiRouter.structuredCall(CAI, { tier: 'strong', ...args });
    calls = [];
    await aiRouter.structuredCall(CAI, { tier: 'strong', ...args });
    assert.strictEqual(calls[0], strong[0]);
  });

  await check('the last candidate is never skipped, even while cooling', async () => {
    aiRouter.resetModelCooldowns();
    calls = [];
    shared.geminiAdapter.structuredCall = async ({ model }) => {
      calls.push(model);
      throw new Error('This operation was aborted');
    };
    await assert.rejects(() => aiRouter.structuredCall(CAI, { tier: 'strong', ...args }));
    calls = [];
    await assert.rejects(() => aiRouter.structuredCall(CAI, { tier: 'strong', ...args }));
    assert.deepStrictEqual(calls, [strong[strong.length - 1]]);
    aiRouter.resetModelCooldowns();
  });

  shared.geminiAdapter.structuredCall = realStructuredCall;

  console.log(`\n${passed} check(s) passed.`);
  if (process.exitCode) {
    console.error('\nSome checks FAILED.');
  } else {
    console.log('All checks passed.');
  }
}

main().catch((e) => {
  console.error('aiRouter.test.js: unexpected error:', e);
  process.exitCode = 1;
});

#!/usr/bin/env node
// connectionMode.test.js — coverage for geminiAdapter's two connection modes
// (spec 16.7), which had none in either direction.
//
// Both the original vertex->developer migration handoff and the
// developer->vertex switch handoff recorded the same gap in the same words:
// "No dedicated regression test was added ... aiRouter.test.js stubs
// geminiAdapter.structuredCall entirely, so it doesn't exercise connection-mode
// selection either way." That stub sits one layer too high — it replaces the
// function whose job IS to pick a mode. This suite stubs `@google/genai`
// instead, so the real selection code runs and what it asks for is observable.
//
// Why this matters more than it used to: the account is now on a billed GCP
// project, so a mode misread is real money going to the wrong place (or a
// silent fallback to a dormant path). isConfigured() also only checks that
// credentials are PRESENT, never that they work — so the shape of what it
// checks is the only thing a test can pin down, and it is worth pinning.
//
// No test framework in this repo — plain Node + assert:
//   node packages/shared/src/ai/__tests__/connectionMode.test.js

const assert = require('assert');
const path = require('path');
const Module = require('module');

let passed = 0;
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

// --- Stub @google/genai before geminiAdapter is ever required -------------
// The adapter caches its client by mode, so each load below is a fresh
// module instance with a fresh cache. `constructed` records the exact options
// object passed to the SDK constructor, which is the thing under test.
const constructed = [];
const genaiPath = require.resolve('@google/genai', { paths: [path.join(__dirname, '..', '..', '..')] });
require.cache[genaiPath] = {
  id: genaiPath,
  filename: genaiPath,
  loaded: true,
  exports: {
    GoogleGenAI: class {
      constructor(opts) {
        constructed.push(opts);
        this.models = { generateContent: async () => ({ text: '{}', usageMetadata: {} }) };
      }
    },
  },
};

const ADAPTER = require.resolve('../geminiAdapter');

// Load a fresh adapter under a given env, then restore.
function withEnv(env, fn) {
  const saved = {};
  const keys = ['GEMINI_CONNECTION_MODE', 'GEMINI_API_KEY', 'GCP_PROJECT_ID', 'GCP_VERTEX_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS_JSON'];
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  delete require.cache[ADAPTER];
  try {
    return fn(require(ADAPTER));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[ADAPTER];
  }
}

console.log('getConnectionMode — precedence and default:');

check('the env var wins over the tunable', () => {
  withEnv({ GEMINI_CONNECTION_MODE: 'developer' }, (a) => {
    assert.strictEqual(a.getConnectionMode(), 'developer');
  });
  withEnv({ GEMINI_CONNECTION_MODE: 'vertex' }, (a) => {
    assert.strictEqual(a.getConnectionMode(), 'vertex');
  });
});

check('with no env var it falls back to tunables.aiConnectionMode', () => {
  const tunables = require('../../tunables.json');
  withEnv({}, (a) => {
    assert.strictEqual(a.getConnectionMode(), tunables.aiConnectionMode || 'vertex');
  });
});

check('the shipped default is vertex — a billed path, so this is asserted, not assumed', () => {
  const tunables = require('../../tunables.json');
  assert.strictEqual(
    tunables.aiConnectionMode,
    'vertex',
    'tunables.aiConnectionMode changed. That is a real decision with a real cost attached — update this assertion deliberately, and check render.yaml and the live Render env agree (they do NOT auto-sync).'
  );
});

console.log('\nisConfigured — each mode checks its OWN credentials, not the other mode\'s:');

check('developer mode needs GEMINI_API_KEY and nothing else', () => {
  withEnv({ GEMINI_CONNECTION_MODE: 'developer', GEMINI_API_KEY: 'k' }, (a) => {
    assert.strictEqual(a.isConfigured(), true);
  });
  // A fully-configured vertex environment must NOT read as configured while
  // developer mode is selected — that is the cross-wiring this asserts against.
  withEnv({ GEMINI_CONNECTION_MODE: 'developer', GCP_PROJECT_ID: 'p', GOOGLE_APPLICATION_CREDENTIALS_JSON: '{}' }, (a) => {
    assert.strictEqual(a.isConfigured(), false);
  });
});

check('vertex mode needs a project AND some form of credential', () => {
  withEnv({ GEMINI_CONNECTION_MODE: 'vertex', GCP_PROJECT_ID: 'p', GOOGLE_APPLICATION_CREDENTIALS_JSON: '{}' }, (a) => {
    assert.strictEqual(a.isConfigured(), true);
  });
  withEnv({ GEMINI_CONNECTION_MODE: 'vertex', GCP_PROJECT_ID: 'p', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json' }, (a) => {
    assert.strictEqual(a.isConfigured(), true);
  });
  // Project with no credential, and credential with no project, are both
  // incomplete — neither half alone is enough.
  withEnv({ GEMINI_CONNECTION_MODE: 'vertex', GCP_PROJECT_ID: 'p' }, (a) => {
    assert.strictEqual(a.isConfigured(), false);
  });
  withEnv({ GEMINI_CONNECTION_MODE: 'vertex', GOOGLE_APPLICATION_CREDENTIALS_JSON: '{}' }, (a) => {
    assert.strictEqual(a.isConfigured(), false);
  });
  // An API key does not configure vertex mode.
  withEnv({ GEMINI_CONNECTION_MODE: 'vertex', GEMINI_API_KEY: 'k' }, (a) => {
    assert.strictEqual(a.isConfigured(), false);
  });
});

check('isConfigured reports presence only — it cannot tell a wrong key from a right one', () => {
  // Documented in the vertex-switch handoff as the reason a misconfigured
  // credential still reports "configured" until the first real call. Asserted
  // here so the limitation is visible in the test suite rather than only in a
  // handoff nobody re-reads.
  withEnv({ GEMINI_CONNECTION_MODE: 'vertex', GCP_PROJECT_ID: 'nonexistent-project', GOOGLE_APPLICATION_CREDENTIALS_JSON: 'not even json' }, (a) => {
    assert.strictEqual(a.isConfigured(), true, 'presence-only by design');
  });
});

console.log('\ngetClient — the SDK is constructed differently per mode:');

check('developer mode constructs with an apiKey and no vertex flag', async () => {
  constructed.length = 0;
  withEnv({ GEMINI_CONNECTION_MODE: 'developer', GEMINI_API_KEY: 'test-key' }, (a) => {
    a.structuredCall({ model: 'm', systemInstruction: 's', prompt: 'p', responseSchema: {} }).catch(() => {});
  });
  assert.strictEqual(constructed.length, 1, 'the SDK was not constructed');
  assert.strictEqual(constructed[0].apiKey, 'test-key');
  assert.ok(!constructed[0].vertexai, 'developer mode must not set vertexai');
});

check('vertex mode constructs with vertexai + project + location, never an apiKey', async () => {
  constructed.length = 0;
  withEnv({ GEMINI_CONNECTION_MODE: 'vertex', GCP_PROJECT_ID: 'careeros-test', GCP_VERTEX_LOCATION: 'global', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json' }, (a) => {
    a.structuredCall({ model: 'm', systemInstruction: 's', prompt: 'p', responseSchema: {} }).catch(() => {});
  });
  assert.strictEqual(constructed.length, 1, 'the SDK was not constructed');
  assert.strictEqual(constructed[0].vertexai, true);
  assert.strictEqual(constructed[0].project, 'careeros-test');
  assert.strictEqual(constructed[0].location, 'global');
  assert.strictEqual(constructed[0].apiKey, undefined, 'a vertex client must never carry an API key');
});

check('vertex mode defaults location to us-central1 when unset', () => {
  constructed.length = 0;
  withEnv({ GEMINI_CONNECTION_MODE: 'vertex', GCP_PROJECT_ID: 'p', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json' }, (a) => {
    a.structuredCall({ model: 'm', systemInstruction: 's', prompt: 'p', responseSchema: {} }).catch(() => {});
  });
  assert.strictEqual(constructed[0].location, 'us-central1');
});

check('a per-user BYOK key forces developer mode regardless of the server setting', () => {
  // aiRouter passes apiKey for BYOK (13.3). It must never reach the house
  // vertex project — that would bill the house for a user's own key.
  constructed.length = 0;
  withEnv({ GEMINI_CONNECTION_MODE: 'vertex', GCP_PROJECT_ID: 'p', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json' }, (a) => {
    a.structuredCall({ model: 'm', systemInstruction: 's', prompt: 'p', responseSchema: {}, apiKey: 'user-key' }).catch(() => {});
  });
  assert.strictEqual(constructed.length, 1);
  assert.strictEqual(constructed[0].apiKey, 'user-key');
  assert.ok(!constructed[0].vertexai, 'a BYOK call must not go through the house vertex project');
});

check('a missing credential throws a mode-specific error rather than falling back', () => {
  withEnv({ GEMINI_CONNECTION_MODE: 'developer' }, async (a) => {
    await assert.rejects(
      () => a.structuredCall({ model: 'm', systemInstruction: 's', prompt: 'p', responseSchema: {} }),
      /GEMINI_API_KEY is required for developer mode/
    );
  });
  withEnv({ GEMINI_CONNECTION_MODE: 'vertex' }, async (a) => {
    await assert.rejects(
      () => a.structuredCall({ model: 'm', systemInstruction: 's', prompt: 'p', responseSchema: {} }),
      /GCP_PROJECT_ID is required for vertex mode/
    );
  });
});

console.log('\nconnectionMode is reported on every result, since ai_usage_log records it:');

check('every candidate model in both tiers has a geminiRates entry', () => {
  // A model with no rate entry logs costUsd: null, which silently under-counts
  // the ledger. Under the free tier that cost nothing; on a billed project it
  // means real spend going unrecorded.
  const tunables = require('../../tunables.json');
  const models = new Set([
    ...(tunables.aiModelTier.cheap || []),
    ...(tunables.aiModelTier.strong || []),
    ...(Array.isArray(tunables.parseModel) ? tunables.parseModel : [tunables.parseModel].filter(Boolean)),
  ]);
  const missing = [...models].filter((m) => !tunables.geminiRates || !tunables.geminiRates[m]);
  assert.deepStrictEqual(missing, [], `models with no geminiRates entry (cost logs as null): ${missing.join(', ')}`);
});

check('thinking tokens are billed at the output rate, not dropped', () => {
  // Gemini reports thoughtsTokenCount apart from candidatesTokenCount, and
  // Google prices it as output. Costing only candidates left a thinking
  // model's reasoning unpriced — the reason logged cost ran well under the GCP
  // invoice. A call that thought for 1M tokens must cost the output rate for it.
  const { computeCostUsd } = require('../geminiAdapter');
  const tunables = require('../../tunables.json');
  const model = Object.keys(tunables.geminiRates)[0];
  const rate = tunables.geminiRates[model];
  const base = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
  assert.strictEqual(computeCostUsd(model, { ...base, thoughts_tokens: 1_000_000 }), rate.output);
  assert.strictEqual(
    computeCostUsd(model, { ...base, output_tokens: 1_000_000, thoughts_tokens: 1_000_000 }),
    rate.output * 2
  );
  // A usage object from before the field existed still prices.
  assert.strictEqual(computeCostUsd(model, { ...base, output_tokens: 1_000_000 }), rate.output);
});

console.log(`\n${passed} checks passed`);
process.exit(process.exitCode || 0);

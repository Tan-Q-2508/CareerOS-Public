#!/usr/bin/env node
// contractCheck.test.js — regression suite for the Custom Adapter Tier's
// contract-drift canary (spec 18.3, §15 #44). Covers assertShape (pure, no
// network) against a good payload, a payload missing one required field, a
// renamed container key, and an empty/null payload — the "canary catches a
// deliberately-broken response shape" deliverable §15 #44 asks for — plus
// runContractChecks' per-platform isolation and DB-write shape.
//
// Also covers the empty-STRING trap the four scrape/detail adapters
// normalize around (assertShape counts '' as present, so a silently-emptied
// description would otherwise go green), and asserts EVERY registered ATS
// Direct adapter is enrolled in the canary — stated as a rule over the registry
// rather than a hand-kept list, which is how five adapters stayed unenrolled.
//
// No test framework in this repo — plain Node + assert:
//   node packages/shared/src/sourcing/ats/__tests__/contractCheck.test.js

const assert = require('assert');
const { assertShape, runContractChecks, collectContractChecks, getPath } = require('../contractCheck');

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

console.log('getPath — dotted-path lookup:');

check('reads a nested value', () => {
  assert.deepStrictEqual(getPath({ data: { jobs: [1, 2] } }, 'data.jobs'), [1, 2]);
});

check('returns undefined on a missing segment, never throws', () => {
  assert.strictEqual(getPath({ data: {} }, 'data.jobs.length'), undefined);
  assert.strictEqual(getPath(null, 'data.jobs'), undefined);
  assert.strictEqual(getPath(undefined, 'a.b.c'), undefined);
});

console.log('\nassertShape — a good payload with every required field present:');

check('Amazon-shaped payload with jobs[].id/title/description present', () => {
  const payload = { hits: 100, jobs: [{ id_icims: '1', title: 'SWE', description: 'text' }] };
  const { ok, missingFields } = assertShape(payload, ['jobs', 'hits']);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(missingFields, []);
});

console.log('\nassertShape — a deliberately-broken response shape:');

check('one required field goes missing (e.g. a renamed field)', () => {
  // Simulates the adapter's own required-field list surviving a redesign
  // that dropped one field the adapter reads.
  const payload = { data: { positions: [] } }; // "count" renamed/removed
  const { ok, missingFields } = assertShape(payload, ['data.positions', 'data.count']);
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(missingFields, ['data.count']);
});

check('the container key itself is renamed (e.g. "positions" -> "jobs")', () => {
  const payload = { data: { jobs: [{ id: 1 }] } }; // adapter still expects "positions"
  const { ok, missingFields } = assertShape(payload, ['data.positions']);
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(missingFields, ['data.positions']);
});

check('an empty array is present but valid (not itself a missing field)', () => {
  // A required field pointing at an array is "present" even when the array
  // is empty — genuinely zero results is a scan-time fact (4.6.2's header),
  // not a contract break. Only undefined/null counts as missing.
  const payload = { jobs: [] };
  const { ok, missingFields } = assertShape(payload, ['jobs']);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(missingFields, []);
});

check('a null payload (e.g. the endpoint now 204s with no body)', () => {
  const { ok, missingFields } = assertShape(null, ['jobs', 'hits']);
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(missingFields, ['jobs', 'hits']);
});

check('an empty-object payload (e.g. a redesigned wrapper with nothing inside)', () => {
  const { ok, missingFields } = assertShape({}, ['data.jobs', 'data.total']);
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(missingFields, ['data.jobs', 'data.total']);
});

console.log('\nassertShape — the empty-string trap the scrape adapters normalize around:');

check('an empty STRING passes, which is why a scraped description must be nulled by run()', () => {
  // The counterpart to the empty-array case above, and the reason avature's,
  // oracle's, eightfold's and phenom's checks return `firstDescription: x || null`
  // instead of the raw value. An HTML-scrape adapter whose selector stops
  // matching returns '' — present, so the canary would go green on a genuinely
  // broken adapter. This asserts the trap is real, so the normalization is
  // never "simplified" away.
  const raw = assertShape({ items: [{}], firstDescription: '' }, ['items', 'firstDescription']);
  assert.strictEqual(raw.ok, true, 'an empty string is present as far as assertShape is concerned');
});

check('a nulled-out empty description IS caught as a missing field', () => {
  const payload = { items: [{}], firstTitle: 'SWE', firstLink: 'https://x/1', firstDescription: null };
  const { ok, missingFields } = assertShape(payload, ['items', 'firstTitle', 'firstLink', 'firstDescription']);
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(missingFields, ['firstDescription']);
});

check('a fully-populated scrape-adapter shape passes', () => {
  const payload = { items: [{}], firstTitle: 'SWE', firstLink: 'https://x/1', firstDescription: 'real description text' };
  const { ok, missingFields } = assertShape(payload, ['items', 'firstTitle', 'firstLink', 'firstDescription']);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(missingFields, []);
});

console.log('\ncollectContractChecks — every ATS Direct adapter is enrolled:');

check('EVERY registered adapter exports a well-formed contractCheck', () => {
  // Asserted as a rule over the whole adapter registry, not as an enumerated
  // list. The list version passed for a year while five adapters — Tier 1's
  // three and Tier 2's two, the ones sourcing the most jobs — were absent from
  // it and therefore from the canary, because nothing compared the list to
  // reality. Stated this way, a new adapter cannot be added without either
  // carrying a canary or deliberately failing this test.
  const { adapters } = require('../index');
  const registered = Object.values(adapters).map((a) => a.platform).sort();
  const enrolled = collectContractChecks(Object.values(adapters)).map((c) => c.name).sort();
  const missing = registered.filter((p) => !enrolled.includes(p));
  assert.deepStrictEqual(missing, [], `adapters registered but not enrolled in the contract canary: ${missing.join(", ")}`);
  assert.ok(registered.length >= 13, `expected at least 13 adapters, found ${registered.length}`);
});

check('every canary names a real platform and a non-empty required-field list', () => {
  const { adapters } = require('../index');
  for (const a of Object.values(adapters)) {
    const c = a.contractCheck;
    if (!c) continue;
    assert.strictEqual(c.name, a.platform, `contractCheck.name "${c.name}" does not match platform "${a.platform}"`);
    assert.ok(c.requiredFields.length > 0, `${a.platform}: a canary asserting nothing always passes`);
  }
});

console.log('\nrunContractChecks — per-platform isolation and DB write shape:');

function fakeDb(rows, { insertError = null } = {}) {
  return {
    from(table) {
      assert.strictEqual(table, 'ats_contract_checks');
      return {
        insert: async (row) => {
          rows.push(row);
          return { error: insertError };
        },
      };
    },
  };
}

// Throws what a real adapter throws: every ATS adapter sets `err.status` from
// resp.status, and phenom also carries the Retry-After header.
function httpError(status, { retryAfter = null } = {}) {
  const err = new Error(`HTTP ${status} from https://example.test/api`);
  err.status = status;
  if (retryAfter !== null) err.retryAfter = retryAfter;
  return err;
}

(async () => {
  await checkAsync('a passing check and a throwing check are both recorded, one bad platform does not abort the run', async () => {
    const rows = [];
    const db = fakeDb(rows);
    const adapters = [
      {
        contractCheck: {
          name: 'good_platform',
          requiredFields: ['jobs'],
          run: async () => ({ jobs: [{ id: 1 }] }),
        },
      },
      {
        contractCheck: {
          name: 'broken_platform',
          requiredFields: ['jobs'],
          run: async () => {
            throw new Error('simulated network failure');
          },
        },
      },
      {
        // No contractCheck at all — non-Custom-Adapter-Tier adapters (e.g.
        // greenhouse.js) must be silently skipped, not crash the collector.
        platform: 'greenhouse',
      },
    ];

    const summary = await runContractChecks(db, { adapters });
    assert.strictEqual(summary.checked, 2, 'only the two adapters with a real contractCheck are counted');
    assert.strictEqual(summary.ok, 1);
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(rows.length, 2);

    const good = rows.find((r) => r.platform === 'good_platform');
    assert.strictEqual(good.ok, true);
    assert.deepStrictEqual(good.missing_fields, []);
    assert.strictEqual(good.error_message, null);

    const bad = rows.find((r) => r.platform === 'broken_platform');
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.error_message.includes('simulated network failure'));
  });

  await checkAsync('a check whose payload is missing a required field is recorded as ok:false with that field listed', async () => {
    const rows = [];
    const db = fakeDb(rows);
    const adapters = [
      {
        contractCheck: {
          name: 'drifted_platform',
          requiredFields: ['data.jobs', 'data.total'],
          run: async () => ({ data: { jobs: [] } }), // "total" silently dropped
        },
      },
    ];
    await runContractChecks(db, { adapters });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].ok, false);
    assert.deepStrictEqual(rows[0].missing_fields, ['data.total']);
    assert.strictEqual(rows[0].error_message, null);
  });

  console.log('\nthrottling is not drift (18.3, §15 #53):');

  await checkAsync('a thrown HTTP error records its status_code instead of discarding it', async () => {
    const rows = [];
    const adapters = [
      { contractCheck: { name: 'errored_platform', requiredFields: ['jobs'], run: async () => { throw httpError(500); } } },
    ];
    await runContractChecks(fakeDb(rows), { adapters });
    assert.strictEqual(rows[0].ok, false);
    assert.strictEqual(rows[0].status_code, 500, 'err.status must survive into the row');
  });

  await checkAsync('a 429 that clears on retry is recorded as a PASS, never written as a failure', async () => {
    // The phenom case from §15 #52's handoff: 429 back-to-back, then clean.
    // Ordinary throttling should resolve itself before it is ever recorded —
    // that is what stops the daily run crying wolf.
    const rows = [];
    let calls = 0;
    const adapters = [
      {
        contractCheck: {
          name: 'throttled_then_ok',
          requiredFields: ['jobs'],
          run: async () => {
            calls += 1;
            if (calls === 1) throw httpError(429, { retryAfter: '0' });
            return { jobs: [{ id: 1 }] };
          },
        },
      },
    ];
    const summary = await runContractChecks(fakeDb(rows), { adapters });
    assert.strictEqual(calls, 2, 'a retryable status must be retried exactly once');
    assert.strictEqual(summary.ok, 1);
    assert.strictEqual(rows.length, 1, 'only the final outcome is recorded, not the retried attempt');
    assert.strictEqual(rows[0].ok, true);
    assert.strictEqual(rows[0].status_code, null);
  });

  await checkAsync('a persistent 429 is recorded as ok:false WITH status 429 and no missing fields', async () => {
    // This is the row shape a maintainer must be able to read as "throttled,
    // not broken": status_code 429 + empty missing_fields.
    const rows = [];
    let calls = 0;
    const adapters = [
      {
        contractCheck: {
          name: 'always_throttled',
          requiredFields: ['jobs'],
          run: async () => { calls += 1; throw httpError(429, { retryAfter: '0' }); },
        },
      },
    ];
    await runContractChecks(fakeDb(rows), { adapters });
    assert.strictEqual(calls, 2, 'retried once, then given up on — never hammered');
    assert.strictEqual(rows[0].ok, false);
    assert.strictEqual(rows[0].status_code, 429);
    assert.deepStrictEqual(rows[0].missing_fields, [], 'empty missing_fields is what marks this as not-drift');
  });

  await checkAsync('a non-retryable status is NOT retried', async () => {
    const rows = [];
    let calls = 0;
    const adapters = [
      { contractCheck: { name: 'gone', requiredFields: ['jobs'], run: async () => { calls += 1; throw httpError(404); } } },
    ];
    await runContractChecks(fakeDb(rows), { adapters });
    assert.strictEqual(calls, 1, 'a 404 is an answer, not a request to wait');
    assert.strictEqual(rows[0].status_code, 404);
  });

  await checkAsync('a transport failure carrying no status records a null status_code', async () => {
    const rows = [];
    const adapters = [
      { contractCheck: { name: 'dns_fail', requiredFields: ['jobs'], run: async () => { throw new Error('getaddrinfo ENOTFOUND'); } } },
    ];
    await runContractChecks(fakeDb(rows), { adapters });
    assert.strictEqual(rows[0].status_code, null);
    assert.ok(rows[0].error_message.includes('ENOTFOUND'));
  });

  await checkAsync('real DRIFT is still distinguishable: missing_fields set, status_code null', async () => {
    // The whole point of the column — this row and the persistent-429 row above
    // must not look alike.
    const rows = [];
    const adapters = [
      { contractCheck: { name: 'drifted', requiredFields: ['data.jobs', 'data.total'], run: async () => ({ data: { jobs: [] } }) } },
    ];
    await runContractChecks(fakeDb(rows), { adapters });
    assert.strictEqual(rows[0].ok, false);
    assert.deepStrictEqual(rows[0].missing_fields, ['data.total']);
    assert.strictEqual(rows[0].status_code, null);
    assert.strictEqual(rows[0].error_message, null);
  });

  await checkAsync('a failed DB insert is logged and does not abort the remaining platforms', async () => {
    // supabase-js RESOLVES with { error } rather than throwing, so the old
    // try/catch here was dead code and a failed write vanished silently.
    const rows = [];
    const db = fakeDb(rows, { insertError: { message: 'permission denied for table' } });
    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      const summary = await runContractChecks(db, {
        adapters: [
          { contractCheck: { name: 'p1', requiredFields: ['jobs'], run: async () => ({ jobs: [] }) } },
          { contractCheck: { name: 'p2', requiredFields: ['jobs'], run: async () => ({ jobs: [] }) } },
        ],
      });
      assert.strictEqual(summary.checked, 2, 'a write failure must not stop the second platform');
    } finally {
      console.error = realError;
    }
    assert.strictEqual(errors.length, 2, 'each failed write is reported, not swallowed');
    assert.ok(errors[0].includes('permission denied'), `got: ${errors[0]}`);
  });

  console.log(`\n${passed} checks passed`);
  process.exit(process.exitCode || 0);
})();

#!/usr/bin/env node
// sponsorLookup.test.js — regression suite for sponsorship resolution and
// company-wide aggregation (spec 19.2/19.3/19.4/19.5, §15 #53).
//
// §15 #49 shipped this path with no unit test ("coverage today is the live
// verification"), and §15 #53 then changed its core: the three resolution tiers
// now UNION into one company total instead of short-circuiting to whichever
// tier hit first. That total is the number on the badge and in the scoring
// prompt, and 19.3 sets a higher bar for it than for anything else in this
// product, because someone may be making an immigration-relevant decision from
// it. So it is tested, not spot-checked.
//
// Covered hardest:
//  - aggregateSponsorRows' weighting. An unweighted blend would let a
//    3-filing entity swing a 13,000-filing one.
//  - De-duplication across tiers. The same entity reached twice would inflate
//    the exact figure this module exists to get right.
//  - The mixed-vintage refusal, which is the guard that made summing safe.
//  - sponsorFacts(null), which carries 19.4's non-negotiable "absence of a
//    filing is not evidence of refusal" instruction.
//  - The exclusion list, which is the only thing standing between a NAME
//    COLLISION and a badge crediting one company with another company's
//    filings. Two unrelated real businesses can normalize to the same
//    string, and equality matching cannot tell them apart on its own.
//
// No test framework in this repo — plain Node + assert:
//   node apps/server/src/visa/__tests__/sponsorLookup.test.js

const assert = require('assert');
const { aggregateSponsorRows } = require('../aggregate');
const {
  createSponsorResolver,
  attachSponsors,
  sponsorVintage,
  wageLevelSummary,
  biggestFiling,
  applyExclusions,
  _resetAliasCache,
} = require('../sponsorLookup');
const { sponsorFacts } = require('../../scoring/fitCall');

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

// --- fixtures -------------------------------------------------------------

// A visa_sponsors row. Vintage defaults are shared so rows aggregate unless a
// test deliberately makes them disagree.
function sponsorRow(normalized, filings, extra = {}) {
  return {
    employer_name_normalized: normalized,
    employer_name_display: extra.display || normalized,
    company_ats_registry_id: extra.registryId ?? null,
    filing_count_last_fy: filings,
    avg_wage: extra.avgWage ?? null,
    wage_level_distribution: extra.dist || {},
    top_job_titles: extra.titles || [],
    source_fiscal_year: extra.fy ?? 2026,
    source_quarter: extra.q ?? 3,
    retrieved_at: extra.retrievedAt || '2026-08-27T00:00:00.000Z',
  };
}

// --- a chainable Supabase stub -------------------------------------------
//
// supabase-js builders are thenable and accumulate filters, so the stub has to
// be too: the code under test awaits some builders directly and calls
// .maybeSingle() on others.
function fakeDb(tables, { onQuery } = {}) {
  return {
    from(table) {
      const rows = tables[table] || [];
      const filters = [];
      let order = null;

      const run = () => {
        if (onQuery) onQuery(table);
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (order) {
          out = [...out].sort((a, b) =>
            order.asc ? Number(a[order.col]) - Number(b[order.col]) : Number(b[order.col]) - Number(a[order.col])
          );
        }
        return { data: out, error: null };
      };

      const builder = {
        select() {
          return builder;
        },
        eq(col, val) {
          filters.push((r) => r[col] === val);
          return builder;
        },
        in(col, vals) {
          const set = new Set(vals);
          filters.push((r) => set.has(r[col]));
          return builder;
        },
        not(col, _op, _val) {
          filters.push((r) => r[col] !== null && r[col] !== undefined);
          return builder;
        },
        gte(col, val) {
          filters.push((r) => Number(r[col]) >= Number(val));
          return builder;
        },
        order(col, opts) {
          order = { col, asc: !!(opts && opts.ascending) };
          return builder;
        },
        limit(n) {
          const inner = run;
          builder.then = (res, rej) => Promise.resolve({ data: inner().data.slice(0, n), error: null }).then(res, rej);
          return builder;
        },
        range() {
          return builder;
        },
        async maybeSingle() {
          const { data } = run();
          return { data: data[0] || null, error: null };
        },
        then(res, rej) {
          return Promise.resolve(run()).then(res, rej);
        },
      };
      return builder;
    },
  };
}

console.log('aggregateSponsorRows — one company, many filing entities (19.2):');

check('empty input returns null, not an empty shell', () => {
  assert.strictEqual(aggregateSponsorRows([]), null);
  assert.strictEqual(aggregateSponsorRows(null), null);
  assert.strictEqual(aggregateSponsorRows([null, undefined]), null);
});

check('a single row is returned unchanged, with entity_count 1', () => {
  // The control: a single-entity filer like Lyft must not be altered by
  // aggregation existing.
  const row = sponsorRow('lyft', 412, { dist: { I: 0.5, II: 0.5 }, avgWage: 150000 });
  const out = aggregateSponsorRows([row]);
  assert.strictEqual(out.filing_count_last_fy, 412);
  assert.deepStrictEqual(out.wage_level_distribution, { I: 0.5, II: 0.5 });
  assert.strictEqual(out.avg_wage, 150000);
  assert.strictEqual(out.entity_count, 1);
});

check('filing counts are SUMMED across entities', () => {
  // The Deloitte case: 6 through one subsidiary, 2,613 through the real hiring
  // entity. The badge used to show 6 or 2,613; the company filed 2,619.
  const out = aggregateSponsorRows([
    sponsorRow('deloitte', 6, { display: 'Deloitte LLP' }),
    sponsorRow('deloitte consulting', 2613, { display: 'Deloitte Consulting LLP' }),
  ]);
  assert.strictEqual(out.filing_count_last_fy, 2619);
  assert.strictEqual(out.entity_count, 2);
});

check('the LARGEST entity supplies the display name and leads entity_names', () => {
  const out = aggregateSponsorRows([
    sponsorRow('deloitte', 6, { display: 'Deloitte LLP' }),
    sponsorRow('deloitte consulting', 2613, { display: 'Deloitte Consulting LLP' }),
  ]);
  assert.strictEqual(out.employer_name_display, 'Deloitte Consulting LLP');
  assert.deepStrictEqual(out.entity_names, ['Deloitte Consulting LLP', 'Deloitte LLP']);
});

check('the wage-level blend is WEIGHTED by filing count, not a flat average', () => {
  // The whole point. A 3-filing entity that is 100% Level I must not drag a
  // 997-filing entity that is 100% Level IV toward "entry-level friendly".
  // Flat average would be 50/50; weighted is 0.3% / 99.7%.
  const out = aggregateSponsorRows([
    sponsorRow('big', 997, { dist: { IV: 1 } }),
    sponsorRow('small', 3, { dist: { I: 1 } }),
  ]);
  assert.strictEqual(out.wage_level_distribution.IV, 0.997);
  assert.strictEqual(out.wage_level_distribution.I, 0.003);
});

check('a blended distribution still sums to ~1', () => {
  const out = aggregateSponsorRows([
    sponsorRow('a', 100, { dist: { I: 0.4, II: 0.4, 'N/A': 0.2 } }),
    sponsorRow('b', 300, { dist: { III: 0.5, IV: 0.5 } }),
  ]);
  const sum = Object.values(out.wage_level_distribution).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, `expected ~1, got ${sum}`);
});

check('avg_wage is weighted, and entities reporting no wage are excluded rather than counted as zero', () => {
  const out = aggregateSponsorRows([
    sponsorRow('a', 900, { avgWage: 100000 }),
    sponsorRow('b', 100, { avgWage: 200000 }),
    sponsorRow('c', 1000, { avgWage: null }),
  ]);
  // (100000*900 + 200000*100) / 1000 = 110000. The null-wage entity must not
  // drag this toward zero.
  assert.strictEqual(out.avg_wage, 110000);
});

check('avg_wage is null when no entity reported one', () => {
  assert.strictEqual(aggregateSponsorRows([sponsorRow('a', 5), sponsorRow('b', 5)]).avg_wage, null);
});

check('MIXED VINTAGES refuse to blend and fall back to the largest single entity', () => {
  // The guard that made summing safe at all. A figure spanning two quarters
  // describes no real reporting period, so it is better to understate.
  const out = aggregateSponsorRows([
    sponsorRow('a', 100, { fy: 2026, q: 3, display: 'Entity A' }),
    sponsorRow('b', 900, { fy: 2026, q: 2, display: 'Entity B' }),
  ]);
  assert.strictEqual(out.filing_count_last_fy, 900, 'must NOT sum to 1000 across quarters');
  assert.strictEqual(out.entity_count, 1);
  assert.strictEqual(out.employer_name_display, 'Entity B');
});

check('duplicate entities are counted ONCE — the tiers overlap by design', () => {
  // A row reachable by both the registry-id tier and the alias tier arrives
  // twice. Counting it twice would inflate the exact number this exists to fix.
  const row = sponsorRow('amazon com services', 13707);
  const out = aggregateSponsorRows([row, { ...row }, row]);
  assert.strictEqual(out.filing_count_last_fy, 13707);
  assert.strictEqual(out.entity_count, 1);
});

check('a registry id is preserved from whichever entity carries one', () => {
  const out = aggregateSponsorRows([
    sponsorRow('a', 500, { registryId: null }),
    sponsorRow('b', 100, { registryId: 'reg-1' }),
  ]);
  assert.strictEqual(out.company_ats_registry_id, 'reg-1');
});

check('all-zero-filing entities do not divide by zero', () => {
  const out = aggregateSponsorRows([sponsorRow('a', 0, { dist: { I: 1 } }), sponsorRow('b', 0, { dist: { IV: 1 } })]);
  assert.strictEqual(out.filing_count_last_fy, 0);
  for (const v of Object.values(out.wage_level_distribution)) assert.ok(Number.isFinite(v), 'no NaN shares');
});

check('top job titles are merged, de-duplicated and capped', () => {
  const out = aggregateSponsorRows([
    sponsorRow('a', 100, { titles: ['SWE', 'Data Scientist'] }),
    sponsorRow('b', 50, { titles: ['SWE', 'Product Manager'] }),
  ]);
  assert.deepStrictEqual(out.top_job_titles, ['SWE', 'Data Scientist', 'Product Manager']);
});

check('the input rows are never mutated', () => {
  const rows = [sponsorRow('a', 100, { dist: { I: 1 } }), sponsorRow('b', 100, { dist: { IV: 1 } })];
  const before = JSON.stringify(rows);
  aggregateSponsorRows(rows);
  assert.strictEqual(JSON.stringify(rows), before);
});

console.log('\nbiggestFiling — still the rule for picking ONE representative row:');

check('the larger filing count wins; nulls lose; two nulls give null', () => {
  const a = sponsorRow('a', 6);
  const b = sponsorRow('b', 2613);
  assert.strictEqual(biggestFiling(a, b), b);
  assert.strictEqual(biggestFiling(b, a), b);
  assert.strictEqual(biggestFiling(null, a), a);
  assert.strictEqual(biggestFiling(a, null), a);
  assert.strictEqual(biggestFiling(null, null), null);
});

check('a tie keeps the first argument', () => {
  const a = sponsorRow('a', 10);
  const b = sponsorRow('b', 10);
  assert.strictEqual(biggestFiling(a, b), a);
});

console.log('\nsponsorVintage / wageLevelSummary — 19.3 requires the vintage to travel with the number:');

check('the vintage is built from the row, never hardcoded', () => {
  assert.strictEqual(sponsorVintage(sponsorRow('a', 1)), 'FY2026 Q3, retrieved 2026-08-27');
});

check('a missing retrieved_at degrades rather than rendering "undefined"', () => {
  assert.ok(sponsorVintage({ ...sponsorRow('a', 1), retrieved_at: null }).includes('unknown date'));
});

check('sponsorVintage(null) is null, so a caller cannot print a vintage for nothing', () => {
  assert.strictEqual(sponsorVintage(null), null);
});

check('the wage-level summary is biggest-share-first and drops zero shares', () => {
  const row = sponsorRow('a', 1, { dist: { I: 0.1, II: 0.6, III: 0.3, IV: 0 } });
  assert.strictEqual(wageLevelSummary(row), 'II 60%, III 30%, I 10%');
});

check('an absent distribution yields null, not an empty string', () => {
  assert.strictEqual(wageLevelSummary(sponsorRow('a', 1)), null);
  assert.strictEqual(wageLevelSummary(null), null);
});

console.log('\nsponsorFacts — 19.4\'s never-fabricate instruction (a guardrail, not prose):');

check('the NULL branch says plainly that absence of a filing is NOT evidence of refusal', () => {
  // If this line is ever trimmed for brevity, the model is free to read a miss
  // as "this employer does not sponsor" and mark down callback_odds for a
  // company that sponsors heavily under a name we failed to match.
  const text = sponsorFacts(null).join(' ');
  assert.ok(text.includes('NOT evidence'), 'the negation must be explicit');
  assert.ok(/does not sponsor/i.test(text), 'the misreading must be named so it can be forbidden');
  assert.ok(/unknown/i.test(text), 'the model must be told to treat sponsorship as unknown');
});

check('a multi-entity company is labelled as a company-wide TOTAL in the prompt', () => {
  // Otherwise the model sees a number far larger than any single employer name
  // it recognises and may discount it as wrong.
  const company = aggregateSponsorRows([
    sponsorRow('amazon com services', 13707, { display: 'Amazon.com Services LLC' }),
    sponsorRow('amazon web services', 6724, { display: 'Amazon Web Services, Inc.' }),
  ]);
  const text = sponsorFacts(company).join('\n');
  assert.ok(text.includes('20431'), `the summed total must appear, got: ${text}`);
  assert.ok(/company-wide total across 2 filing entities/.test(text));
  assert.ok(text.includes('Amazon Web Services, Inc.'), 'the entities are named so the figure is checkable');
});

check('a single-entity company keeps the simple wording', () => {
  const text = sponsorFacts(aggregateSponsorRows([sponsorRow('lyft', 412, { display: 'Lyft, Inc.' })])).join('\n');
  assert.ok(!/company-wide total/.test(text));
  assert.ok(text.includes('Lyft, Inc.'));
});

console.log('\ncreateSponsorResolver — three tiers UNIONED, not short-circuited:');

const ALIASES = [
  { registry_normalized_name: 'amazon', filing_employer_name: 'amazon com services' },
  { registry_normalized_name: 'amazon', filing_employer_name: 'amazon web services' },
  { registry_normalized_name: 'deloitte', filing_employer_name: 'deloitte consulting' },
];

(async () => {
  await checkAsync('the registry-id tier no longer shadows the alias tier — both count', async () => {
    // The regression this rewrite exists to prevent. Previously an id hit
    // returned immediately and the company's alias-only entities were lost.
    _resetAliasCache();
    const db = fakeDb({
      visa_sponsors: [
        sponsorRow('amazon', 500, { registryId: 'reg-amz', display: 'Amazon Inc' }),
        sponsorRow('amazon com services', 13707, { display: 'Amazon.com Services LLC' }),
        sponsorRow('amazon web services', 6724, { display: 'Amazon Web Services, Inc.' }),
      ],
      visa_sponsor_aliases: ALIASES,
    });
    const out = await createSponsorResolver(db).resolve('Amazon', 'reg-amz');
    assert.strictEqual(out.filing_count_last_fy, 500 + 13707 + 6724);
    assert.strictEqual(out.entity_count, 3);
  });

  await checkAsync('an entity reachable by BOTH the registry id and an alias is counted once', async () => {
    _resetAliasCache();
    const db = fakeDb({
      visa_sponsors: [sponsorRow('amazon com services', 13707, { registryId: 'reg-amz' })],
      visa_sponsor_aliases: ALIASES,
    });
    const out = await createSponsorResolver(db).resolve('Amazon', 'reg-amz');
    assert.strictEqual(out.filing_count_last_fy, 13707, 'must not double to 27414');
    assert.strictEqual(out.entity_count, 1);
  });

  await checkAsync('the Deloitte case: a tiny exact-name match no longer hides the real hiring entity', async () => {
    _resetAliasCache();
    const db = fakeDb({
      visa_sponsors: [
        sponsorRow('deloitte', 6, { display: 'Deloitte LLP' }),
        sponsorRow('deloitte consulting', 2613, { display: 'Deloitte Consulting LLP' }),
      ],
      visa_sponsor_aliases: ALIASES,
    });
    const out = await createSponsorResolver(db).resolve('Deloitte', null);
    assert.strictEqual(out.filing_count_last_fy, 2619);
  });

  await checkAsync('a company with no match resolves to null — never to a zero-filing shell', async () => {
    _resetAliasCache();
    const db = fakeDb({ visa_sponsors: [sponsorRow('other co', 5)], visa_sponsor_aliases: [] });
    assert.strictEqual(await createSponsorResolver(db).resolve('Unknown Startup', null), null);
  });

  await checkAsync('an unnormalizable company name short-circuits without querying at all', async () => {
    _resetAliasCache();
    let queries = 0;
    const db = fakeDb({ visa_sponsors: [], visa_sponsor_aliases: [] }, { onQuery: () => (queries += 1) });
    assert.strictEqual(await createSponsorResolver(db).resolve('   ', null), null);
    assert.strictEqual(queries, 0);
  });

  await checkAsync('two concurrent callers for the same employer share ONE in-flight query (§26 rule 2)', async () => {
    // The promise cache. Two pipeline workers reaching the same employer before
    // either query returns must not issue two queries.
    _resetAliasCache();
    let sponsorQueries = 0;
    const db = fakeDb(
      { visa_sponsors: [sponsorRow('stripe', 300)], visa_sponsor_aliases: [] },
      { onQuery: (t) => { if (t === 'visa_sponsors') sponsorQueries += 1; } }
    );
    const resolver = createSponsorResolver(db);
    const [a, b] = await Promise.all([resolver.resolve('Stripe', null), resolver.resolve('Stripe', null)]);
    assert.strictEqual(a.filing_count_last_fy, 300);
    assert.strictEqual(b, a, 'both callers get the same resolved object');
    assert.strictEqual(resolver.stats.cached, 1, 'the second call is served from cache');
    assert.strictEqual(resolver.stats.lookups, 1);
  });

  await checkAsync('a lookup failure resolves null and never rejects — scoring must not fail on enrichment', async () => {
    _resetAliasCache();
    const db = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          order() { return this; },
          then(res, rej) { return Promise.resolve({ data: null, error: { message: 'connection reset' } }).then(res, rej); },
          async maybeSingle() { return { data: null, error: { message: 'connection reset' } }; },
        };
      },
    };
    const realError = console.error;
    console.error = () => {};
    try {
      assert.strictEqual(await createSponsorResolver(db).resolve('Anything', 'reg-1'), null);
    } finally {
      console.error = realError;
    }
  });

  console.log('\nattachSponsors — the bulk badge path agrees with the resolver:');

  await checkAsync('a job gets the same company-wide total the resolver would produce', async () => {
    _resetAliasCache();
    const db = fakeDb({
      visa_sponsors: [
        sponsorRow('amazon com services', 13707, { display: 'Amazon.com Services LLC' }),
        sponsorRow('amazon web services', 6724, { display: 'Amazon Web Services, Inc.' }),
      ],
      visa_sponsor_aliases: ALIASES,
    });
    const [job] = await attachSponsors(db, [{ id: 'j1', company_name: 'Amazon', company_ats_registry_id: null }]);
    assert.strictEqual(job.visa_sponsor.filing_count_last_fy, 20431);
    assert.strictEqual(job.visa_sponsor.entity_count, 2);
  });

  await checkAsync('an unmatched job gets a null sponsor, not a fabricated zero', async () => {
    _resetAliasCache();
    const db = fakeDb({ visa_sponsors: [], visa_sponsor_aliases: [] });
    const [job] = await attachSponsors(db, [{ id: 'j1', company_name: 'Nobody Co', company_ats_registry_id: null }]);
    assert.strictEqual(job.visa_sponsor, null);
  });

  await checkAsync('attachSponsors NEVER throws — a failure degrades the whole page to null sponsors', async () => {
    // 19.5: a sponsorship lookup failure must not take down the dashboard, and
    // null renders as "No sponsorship data", which already means "we don't know".
    _resetAliasCache();
    const db = {
      from() {
        return {
          select() { return this; },
          in() { return this; },
          order() { return this; },
          then(res, rej) { return Promise.resolve({ data: null, error: { message: 'boom' } }).then(res, rej); },
        };
      },
    };
    const realError = console.error;
    console.error = () => {};
    try {
      const jobs = await attachSponsors(db, [{ id: 'j1', company_name: 'Amazon', company_ats_registry_id: 'r1' }]);
      assert.strictEqual(jobs.length, 1);
      assert.strictEqual(jobs[0].visa_sponsor, null);
      assert.strictEqual(jobs[0].id, 'j1', 'the job itself survives intact');
    } finally {
      console.error = realError;
    }
  });

  await checkAsync('an empty job list is returned as-is without querying', async () => {
    _resetAliasCache();
    let queries = 0;
    const db = fakeDb({ visa_sponsors: [] }, { onQuery: () => (queries += 1) });
    assert.deepStrictEqual(await attachSponsors(db, []), []);
    assert.strictEqual(queries, 0);
  });

  await checkAsync('the input jobs are not mutated', async () => {
    _resetAliasCache();
    const db = fakeDb({ visa_sponsors: [sponsorRow('lyft', 412)], visa_sponsor_aliases: [] });
    const jobs = [{ id: 'j1', company_name: 'Lyft', company_ats_registry_id: null }];
    const out = await attachSponsors(db, jobs);
    assert.strictEqual(jobs[0].visa_sponsor, undefined, 'the original object must be untouched');
    assert.strictEqual(out[0].visa_sponsor.filing_count_last_fy, 412);
  });

  // --- the exclusion list (19.2) -----------------------------------------

  console.log('\napplyExclusions — the inverse of the alias map, and a pure function:');

  const VERTEX_ROWS = [
    sponsorRow('vertex pharmaceuticals', 137, { display: 'Vertex Pharmaceuticals Incorporated' }),
    sponsorRow('vertex', 17, { display: 'Vertex, Inc.' }),
  ];
  const VERTEX_EXCL = new Map([['vertex', new Set(['vertex'])]]);

  check('an excluded filing entity is dropped from the row set', () => {
    const out = applyExclusions(VERTEX_ROWS, VERTEX_EXCL, 'vertex');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].employer_name_normalized, 'vertex pharmaceuticals');
  });

  check('the excluded name and the company name are allowed to be EQUAL', () => {
    // This is the normal shape of a collision, not an edge case: `Vertex, Inc.`
    // normalizes to exactly the registry name it is being kept out of. An
    // implementation keyed on "a different name" would exclude nothing at all.
    assert.strictEqual(applyExclusions(VERTEX_ROWS, VERTEX_EXCL, 'vertex').length, 1);
  });

  check('a company with no exclusions is returned untouched', () => {
    const rows = [sponsorRow('lyft', 73)];
    assert.deepStrictEqual(applyExclusions(rows, VERTEX_EXCL, 'lyft'), rows);
    assert.deepStrictEqual(applyExclusions(rows, new Map(), 'vertex'), rows);
  });

  check('an exclusion applies ONLY to the company it was recorded for', () => {
    // The pairing is the unit. `vertex` excluded from the pharma company says
    // nothing about any other company that might legitimately file as `vertex`.
    assert.strictEqual(applyExclusions(VERTEX_ROWS, VERTEX_EXCL, 'some other company').length, 2);
  });

  check('a null or empty company name excludes nothing rather than everything', () => {
    assert.strictEqual(applyExclusions(VERTEX_ROWS, VERTEX_EXCL, null).length, 2);
    assert.strictEqual(applyExclusions(VERTEX_ROWS, VERTEX_EXCL, '').length, 2);
  });

  console.log('\ncreateSponsorResolver — the exclusion beats every tier that can reach the row:');

  const EXCLUSIONS = [{ registry_normalized_name: 'vertex', filing_employer_name: 'vertex' }];
  const VERTEX_ALIAS = [{ registry_normalized_name: 'vertex', filing_employer_name: 'vertex pharmaceuticals' }];

  await checkAsync('the EXACT-NAME tier cannot smuggle a colliding entity back in', async () => {
    // Why this filter cannot live at ETL time alone: this tier queries
    // employer_name_normalized directly and never looks at the FK, so nulling
    // the link does not stop it finding the colliding entity.
    _resetAliasCache();
    const db = fakeDb({
      visa_sponsors: VERTEX_ROWS,
      visa_sponsor_aliases: VERTEX_ALIAS,
      visa_sponsor_exclusions: EXCLUSIONS,
    });
    const out = await createSponsorResolver(db).resolve('Vertex', null);
    assert.strictEqual(out.filing_count_last_fy, 137, 'the pharma company alone');
    assert.strictEqual(out.entity_count, 1);
  });

  await checkAsync('the REGISTRY-ID tier cannot either, for a row linked before the exclusion existed', async () => {
    _resetAliasCache();
    const db = fakeDb({
      visa_sponsors: [
        sponsorRow('vertex pharmaceuticals', 137, { display: 'Vertex Pharmaceuticals Incorporated' }),
        sponsorRow('vertex', 17, { display: 'Vertex, Inc.', registryId: 'reg-vertex' }),
      ],
      visa_sponsor_aliases: VERTEX_ALIAS,
      visa_sponsor_exclusions: EXCLUSIONS,
    });
    const out = await createSponsorResolver(db).resolve('Vertex', 'reg-vertex');
    assert.strictEqual(out.filing_count_last_fy, 137);
    assert.strictEqual(out.entity_count, 1);
  });

  await checkAsync('with no exclusion recorded the same data blends — the bug this prevents', async () => {
    // Pinned deliberately: it proves the two checks above exercise the
    // exclusion rather than passing for some unrelated reason.
    _resetAliasCache();
    const db = fakeDb({
      visa_sponsors: VERTEX_ROWS,
      visa_sponsor_aliases: VERTEX_ALIAS,
      visa_sponsor_exclusions: [],
    });
    const out = await createSponsorResolver(db).resolve('Vertex', null);
    assert.strictEqual(out.filing_count_last_fy, 154);
    assert.strictEqual(out.entity_count, 2);
  });

  await checkAsync('a legitimate multi-entity company is untouched by an unrelated exclusion', async () => {
    // 7 of the 9 companies with this shape are genuinely one company. A
    // mechanism that caught them too would delete more real filings than false
    // ones, which is why this list is hand-maintained and never generated.
    _resetAliasCache();
    const db = fakeDb({
      visa_sponsors: [
        sponsorRow('deloitte', 6, { display: 'Deloitte LLP' }),
        sponsorRow('deloitte consulting', 2613, { display: 'Deloitte Consulting LLP' }),
      ],
      visa_sponsor_aliases: [{ registry_normalized_name: 'deloitte', filing_employer_name: 'deloitte consulting' }],
      visa_sponsor_exclusions: EXCLUSIONS,
    });
    const out = await createSponsorResolver(db).resolve('Deloitte', null);
    assert.strictEqual(out.filing_count_last_fy, 2619);
    assert.strictEqual(out.entity_count, 2);
  });

  await checkAsync('attachSponsors applies the exclusion on the badge path too', async () => {
    _resetAliasCache();
    const db = fakeDb({
      visa_sponsors: VERTEX_ROWS,
      visa_sponsor_aliases: VERTEX_ALIAS,
      visa_sponsor_exclusions: EXCLUSIONS,
    });
    const out = await attachSponsors(db, [{ id: 'j1', company_name: 'Vertex', company_ats_registry_id: null }]);
    assert.strictEqual(out[0].visa_sponsor.filing_count_last_fy, 137);
    assert.strictEqual(out[0].visa_sponsor.entity_count, 1);
  });

  console.log(`\n${passed} checks passed`);
  process.exit(process.exitCode || 0);
})();

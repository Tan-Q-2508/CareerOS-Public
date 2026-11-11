#!/usr/bin/env node
// startups.test.js — the decision layer behind the built-in Startups tracklist
// (spec 4.6.9a, §15 #65): which companies qualify, how a startup's board is
// found from its own website, when an existing registry row may be treated as
// the same company, and who ends up on the list. Pure — no network, no
// database; the live crawl is what scripts/import-startups.js --dry-run is for.
//
//   node apps/server/src/companies/__tests__/startups.test.js

const assert = require('assert');
const { extractBoardCandidates, careersLinks, discoverBoard, normalizeWebsite } = require('../startupDiscovery');
const { desiredMembers } = require('../startupTracklist');
const { isCandidate, batchShort, boardMatchesDomain, domainLabel } = require('../../../../../scripts/import-startups');

let passed = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('async check used with sync runner');
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

(async () => {
  console.log('extractBoardCandidates — a startup site\'s own links:');

  check('an embedded Greenhouse board and an Ashby link are both read, most-linked first', () => {
    const html = `
      <a href="https://jobs.ashbyhq.com/acme">Open roles</a>
      <a href="https://jobs.ashbyhq.com/acme/6f78b170-9600">Engineer</a>
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeold"></script>`;
    assert.deepStrictEqual(extractBoardCandidates(html, 'https://acme.com/careers'), [
      { platform: 'ashby', slug: 'acme', count: 2 },
      { platform: 'greenhouse', slug: 'acmeold', count: 1 },
    ]);
  });

  check('vendor marketing links ("Powered by Workable") are never read as a board', () => {
    const html = `<a href="https://www.workable.com/careers">Powered by Workable</a>
      <a href="https://www.greenhouse.io/careers">Greenhouse</a>
      <a href="https://www.lever.co/pricing">Lever</a>
      <a href="https://www.bamboohr.com/careers/">BambooHR</a>`;
    assert.deepStrictEqual(extractBoardCandidates(html, 'https://acme.com'), []);
  });

  check('a YC profile link ("Backed by Y Combinator") is not the company\'s board', () => {
    const html = '<a href="https://www.ycombinator.com/companies/acme">Backed by YC</a>';
    assert.deepStrictEqual(extractBoardCandidates(html, 'https://acme.com'), []);
  });

  check('URLs inside inline scripts count, including JSON-escaped ones', () => {
    const html = '<script>window.cfg={"jobs":"https:\\/\\/jobs.lever.co\\/acme"}</script>';
    assert.deepStrictEqual(extractBoardCandidates(html, 'https://acme.com'), [{ platform: 'lever', slug: 'acme', count: 1 }]);
  });

  check('careers-page links stay on the site and are capped', () => {
    const html = `<a href="/careers">Careers</a><a href="https://acme.com/jobs/">Jobs</a>
      <a href="https://other.com/careers">x</a><a href="/about">About</a>`;
    assert.deepStrictEqual(careersLinks(html, 'https://acme.com'), ['https://acme.com/careers', 'https://acme.com/jobs/']);
  });

  check('websites without a scheme normalize to an origin', () => {
    assert.strictEqual(normalizeWebsite('acme.com'), 'https://acme.com');
    assert.strictEqual(normalizeWebsite('http://www.checkr.com'), 'http://www.checkr.com');
    assert.strictEqual(normalizeWebsite(''), null);
  });

  await checkAsync('discoverBoard follows the homepage to a careers page when the homepage links no board', async () => {
    const pages = {
      'https://acme.com': '<a href="/join-us">Join us</a>',
      'https://acme.com/join-us': '<iframe src="https://jobs.ashbyhq.com/acme/embed"></iframe>',
    };
    const fetched = [];
    const { candidates } = await discoverBoard('acme.com', {
      fetchText: async (u) => {
        fetched.push(u);
        if (!(u in pages)) throw Object.assign(new Error('404'), { status: 404 });
        return pages[u];
      },
    });
    assert.deepStrictEqual(candidates, [{ platform: 'ashby', slug: 'acme', count: 1 }]);
    assert.deepStrictEqual(fetched, ['https://acme.com', 'https://acme.com/join-us']);
  });

  console.log('\nboardMatchesDomain — when an existing row may be treated as this company:');

  check('a board slug that matches the company\'s web domain', () => {
    assert.strictEqual(boardMatchesDomain('webflow', 'https://webflow.com'), true);
    assert.strictEqual(boardMatchesDomain('apolloio', 'https://www.apollo.io/'), true);
    assert.strictEqual(boardMatchesDomain('shipbobinc', 'http://shipbob.com'), true);
    assert.strictEqual(boardMatchesDomain('acme:wd5:External', 'https://acme.com'), true, 'a Workday composite is read by its tenant');
  });

  check('same name, different company: no match', () => {
    // getmagic.com (YC W15) is not Magic.dev, the registry's "Magic".
    assert.strictEqual(boardMatchesDomain('magic.dev', 'https://getmagic.com/'), false);
    assert.strictEqual(boardMatchesDomain('radar', 'https://goradar.com'), false);
  });

  check('tokens shorter than four characters never match', () => {
    assert.strictEqual(boardMatchesDomain('ai', 'https://ai.com'), false);
    assert.strictEqual(domainLabel('https://www.go.dev'), 'go');
  });

  console.log('\nisCandidate / batchShort — which directory rows qualify:');

  const base = { slug: 'acme', status: 'Active', nonprofit: false, isHiring: true, regions: ['United States of America', 'Remote'], team_size: 40 };
  check('an active, hiring, US startup under the size cap qualifies', () => {
    assert.strictEqual(isCandidate(base, 1000), true);
  });
  check('inactive, acquired, nonprofit, not hiring, non-US, or late-stage companies do not', () => {
    assert.strictEqual(isCandidate({ ...base, status: 'Acquired' }, 1000), false);
    assert.strictEqual(isCandidate({ ...base, nonprofit: true }, 1000), false);
    assert.strictEqual(isCandidate({ ...base, isHiring: false }, 1000), false);
    assert.strictEqual(isCandidate({ ...base, regions: ['United Kingdom', 'Remote'] }, 1000), false);
    assert.strictEqual(isCandidate({ ...base, team_size: 7000 }, 1000), false, 'Stripe-sized is not a startup');
  });
  check('an unknown team size is not treated as too large', () => {
    assert.strictEqual(isCandidate({ ...base, team_size: null }, 1000), true);
  });
  check('batch labels shorten the way YC writes them', () => {
    assert.strictEqual(batchShort('Winter 2015'), 'W15');
    assert.strictEqual(batchShort('Summer 2024'), 'S24');
    assert.strictEqual(batchShort('Spring 2025'), 'X25');
    assert.strictEqual(batchShort('IK12'), null);
  });

  console.log('\ndesiredMembers — who is on the Startups list:');

  check('only hiring startups with an ACTIVE board are members', () => {
    const profiles = [
      { company_ats_registry_id: 'a', is_hiring: true },
      { company_ats_registry_id: 'b', is_hiring: false },
      { company_ats_registry_id: 'c', is_hiring: true },
      { company_ats_registry_id: 'd', is_hiring: null },
    ];
    const active = new Set(['a', 'b', 'd']); // c's board is gone
    assert.deepStrictEqual([...desiredMembers(profiles, active)].sort(), ['a', 'd']);
  });

  console.log(`\n${passed} checks passed`);
  process.exit(process.exitCode || 0);
})();

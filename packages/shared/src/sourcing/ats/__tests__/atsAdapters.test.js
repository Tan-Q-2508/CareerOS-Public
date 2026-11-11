#!/usr/bin/env node
// atsAdapters.test.js — the first fixture-based coverage any ATS Direct adapter
// has ever had.
//
// Until now every one of the 13 adapters was covered only by a live
// verification run at build time plus the §18.3 canary. That posture was set in
// §15 #45 and re-flagged as open by Closeout 3 without being revisited: "No
// fixture-based per-adapter unit tests exist. Only contractCheck.test.js, which
// drives fake adapters." A live run costs money, needs network, and proves
// nothing about the code once the run is over.
//
// Two things are tested here, chosen because they are pure, free, and cover the
// failure modes that have actually happened in this codebase:
//
//   1. extractSlugFromUrl. Pure string logic, and the source of a real shipped
//      bug — §15 #46 found the URL-match loop breaking on the FIRST adapter
//      whose extractor returned a hit, which surfaced because Eightfold's
//      shape-matching extractor claimed Phenom URLs. Cross-platform NEGATIVE
//      cases are therefore as important as the positive ones and get equal
//      weight below.
//
//   2. normalizeItem's schema contract (§4.2). Every adapter must emit the same
//      internal shape; a field quietly becoming undefined instead of null, or a
//      date staying a raw string, is exactly what a fixture catches and a live
//      "did it return jobs?" check does not.
//
// The raw fixtures below were CAPTURED from the real live endpoints rather than
// hand-invented, then trimmed to the fields each adapter actually reads. URLs
// and ids are real. Where a real board's value is genuinely null (Greenhouse
// exposes no employment type, Workday no salary) the fixture keeps the null
// rather than inventing a value.
//
// No test framework in this repo — plain Node + assert:
//   node packages/shared/src/sourcing/ats/__tests__/atsAdapters.test.js

const assert = require('assert');

const greenhouse = require('../greenhouse');
const lever = require('../lever');
const ashby = require('../ashby');
const workday = require('../workday');
const workable = require('../workable');
const oracle = require('../oracle');
const eightfold = require('../eightfold');
const avature = require('../avature');
const phenom = require('../phenom');
const { adapters } = require('../index');

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

// ---------------------------------------------------------------------------
// 1. extractSlugFromUrl
// ---------------------------------------------------------------------------

console.log('extractSlugFromUrl — real URL forms resolve to the right slug:');

check('greenhouse: both board hosts and the API host', () => {
  assert.deepStrictEqual(greenhouse.extractSlugFromUrl('https://job-boards.greenhouse.io/anthropic/jobs/4461450008'), {
    platform: 'greenhouse',
    slug: 'anthropic',
  });
  assert.deepStrictEqual(greenhouse.extractSlugFromUrl('https://boards.greenhouse.io/anthropic'), {
    platform: 'greenhouse',
    slug: 'anthropic',
  });
  assert.deepStrictEqual(greenhouse.extractSlugFromUrl('https://boards-api.greenhouse.io/v1/boards/anthropic/jobs'), {
    platform: 'greenhouse',
    slug: 'anthropic',
  });
});

check('greenhouse: the embedded ?gh_jid= form proves the platform but carries no slug', () => {
  // Deliberately {slug: null}, not null — detect.js relies on the difference to
  // fall through to name-guess for the slug rather than giving up on the company.
  assert.deepStrictEqual(greenhouse.extractSlugFromUrl('https://stripe.com/jobs/search?gh_jid=8023928'), {
    platform: 'greenhouse',
    slug: null,
  });
});

check('lever: posting permalink and the postings API', () => {
  assert.deepStrictEqual(lever.extractSlugFromUrl('https://jobs.lever.co/spotify/2193db3f-77c5-43b8-b030-8f92c9'), {
    platform: 'lever',
    slug: 'spotify',
  });
  assert.deepStrictEqual(lever.extractSlugFromUrl('https://api.lever.co/v0/postings/spotify'), {
    platform: 'lever',
    slug: 'spotify',
  });
});

check('ashby: posting permalink and the posting API', () => {
  assert.deepStrictEqual(ashby.extractSlugFromUrl('https://jobs.ashbyhq.com/1password/6f78b170-9600-4b2d-9682-f'), {
    platform: 'ashby',
    slug: '1password',
  });
  assert.deepStrictEqual(ashby.extractSlugFromUrl('https://api.ashbyhq.com/posting-api/job-board/1password'), {
    platform: 'ashby',
    slug: '1password',
  });
});

check('workday: the three-part composite is rebuilt from host + path', () => {
  assert.deepStrictEqual(
    workday.extractSlugFromUrl('https://23andme.wd5.myworkdayjobs.com/23/job/Palo-Alto-HQ/Security-Operations-Engineer_2026046'),
    { platform: 'workday', slug: '23andme:wd5:23' }
  );
  // API form: /wday/cxs/{tenant}/{site}/...
  assert.deepStrictEqual(workday.extractSlugFromUrl('https://23andme.wd5.myworkdayjobs.com/wday/cxs/23andme/23/jobs'), {
    platform: 'workday',
    slug: '23andme:wd5:23',
  });
});

check('workable: board URL carries a slug, /j/ permalink does not', () => {
  assert.deepStrictEqual(workable.extractSlugFromUrl('https://apply.workable.com/1000heads/'), {
    platform: 'workable',
    slug: '1000heads',
  });
  // The real link normalizeItem produces is the permalink form — same
  // "platform known, slug isn't" shape as Greenhouse's embedded case.
  assert.deepStrictEqual(workable.extractSlugFromUrl('https://apply.workable.com/j/E4335D00D8'), {
    platform: 'workable',
    slug: null,
  });
});

console.log('\nextractSlugFromUrl — cross-platform negatives (the §15 #46 bug class):');

check('no adapter claims another adapter\'s real URL', () => {
  // The URL-match loop used to break on the first extractor that returned a
  // hit, so one adapter over-claiming silently sent a company to the wrong
  // platform. Each real URL below must be claimed by exactly one adapter.
  const realUrls = {
    greenhouse: 'https://job-boards.greenhouse.io/anthropic/jobs/4461450008',
    lever: 'https://jobs.lever.co/spotify/2193db3f-77c5-43b8-b030-8f92c9',
    ashby: 'https://jobs.ashbyhq.com/1password/6f78b170-9600-4b2d-9682-f',
    workday: 'https://23andme.wd5.myworkdayjobs.com/23/job/Palo-Alto-HQ/SecOps_2026046',
  };
  const all = Object.values(adapters);
  for (const [owner, url] of Object.entries(realUrls)) {
    const claimers = all.filter((a) => typeof a.extractSlugFromUrl === 'function' && a.extractSlugFromUrl(url)).map((a) => a.platform);
    assert.deepStrictEqual(
      claimers.sort(),
      [owner],
      `${url}\n      expected only "${owner}" to claim it, got: ${claimers.join(', ') || '(none)'}`
    );
  }
});

check('a garbage or unrelated URL is claimed by nobody', () => {
  for (const url of ['https://example.com/careers', 'not a url at all', '', null, undefined]) {
    for (const a of Object.values(adapters)) {
      if (typeof a.extractSlugFromUrl !== 'function') continue;
      assert.strictEqual(
        a.extractSlugFromUrl(url),
        null,
        `${a.platform} claimed ${JSON.stringify(url)} — an extractor must return null, never throw or guess`
      );
    }
  }
});

check('every adapter exposes the same detection surface', () => {
  for (const a of Object.values(adapters)) {
    assert.strictEqual(typeof a.platform, 'string', 'adapter has no platform name');
    for (const fn of ['extractSlugFromUrl', 'probe', 'fetchJobs', 'normalizeItem']) {
      assert.strictEqual(typeof a[fn], 'function', `${a.platform} is missing ${fn}()`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. normalizeItem — the §4.2 internal schema
// ---------------------------------------------------------------------------

// Every key §4.2 requires, and whether it must be non-null for a healthy
// posting. `descriptionText` is deliberately nullable: Greenhouse and Workable
// fill it in fetchJobs AFTER the keep filter passes (4.6.13), so normalizeItem
// alone legitimately returns null there.
const SCHEMA = [
  'source', 'atsPlatform', 'atsSlug', 'title', 'companyName', 'location',
  'postedAt', 'link', 'descriptionText', 'seniorityLevel', 'employmentType',
  'salaryMin', 'salaryMax', 'dedupKey',
];

function assertSchema(job, platform) {
  for (const key of SCHEMA) {
    assert.ok(key in job, `${platform}: normalized job is missing "${key}"`);
    assert.notStrictEqual(job[key], undefined, `${platform}: "${key}" is undefined — every absent field must be an explicit null`);
  }
  assert.strictEqual(job.source, 'ats_direct', `${platform}: source must be 'ats_direct'`);
  assert.strictEqual(job.atsPlatform, platform, `${platform}: atsPlatform mismatch`);
  assert.ok(job.dedupKey, `${platform}: dedupKey must never be empty`);
  if (job.postedAt !== null) {
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T/.test(job.postedAt),
      `${platform}: postedAt must be an ISO string, got ${JSON.stringify(job.postedAt)}`
    );
  }
}

console.log('\nnormalizeItem — captured real payloads produce the §4.2 schema:');

check('greenhouse: nested location, company name read from the payload', () => {
  const raw = {
    id: 4461450008,
    title: 'Account Executive, AI Native',
    absolute_url: 'https://job-boards.greenhouse.io/anthropic/jobs/4461450008',
    location: { name: 'New York City, NY; San Francisco, CA' },
    company_name: 'Anthropic',
    first_published: '2024-12-20T18:53:38-05:00',
  };
  const job = greenhouse.normalizeItem(raw, { slug: 'anthropic', companyName: 'Fallback Inc' });
  assertSchema(job, 'greenhouse');
  assert.strictEqual(job.title, 'Account Executive, AI Native');
  // Greenhouse is the one Tier 1 platform carrying the company name — the
  // payload must win over the caller's fallback.
  assert.strictEqual(job.companyName, 'Anthropic');
  assert.strictEqual(job.location, 'New York City, NY; San Francisco, CA');
  assert.strictEqual(job.postedAt, '2024-12-20T23:53:38.000Z');
  // Deferred until after the keep filter (4.6.13), not missing.
  assert.strictEqual(job.descriptionText, null);
  assert.strictEqual(job.dedupKey, 'ats:greenhouse:anthropic:4461450008');
});

check('lever: epoch MILLIseconds, and the description stitches lists in', () => {
  const raw = {
    id: '2193db3f-77c5-43b8-b030-8f92c9',
    text: 'Android Engineer - Experience',
    hostedUrl: 'https://jobs.lever.co/spotify/2193db3f-77c5-43b8-b030-8f92c9',
    categories: { location: 'London', commitment: 'Permanent' },
    createdAt: 1782214185805,
    descriptionPlain: 'We are looking for an Android engineer.',
    lists: [{ text: 'What you will do', content: '<ul><li>Ship features</li></ul>' }],
    additionalPlain: 'Spotify is an equal opportunity employer.',
  };
  const job = lever.normalizeItem(raw, { slug: 'spotify', companyName: 'Spotify' });
  assertSchema(job, 'lever');
  assert.strictEqual(job.postedAt, '2026-06-23T11:29:45.805Z', 'createdAt is ms, not seconds');
  assert.strictEqual(job.employmentType, 'Permanent');
  // The requirements live in `lists`; taking descriptionPlain alone would hand
  // the model a JD with its qualifications section missing.
  assert.ok(job.descriptionText.includes('What you will do'), 'list heading dropped');
  assert.ok(job.descriptionText.includes('Ship features'), 'list body dropped');
  assert.ok(job.descriptionText.includes('equal opportunity'), 'additionalPlain dropped');
});

check('lever: no company name anywhere in the payload, so the caller supplies it', () => {
  const job = lever.normalizeItem({ text: 'X', hostedUrl: 'https://jobs.lever.co/spotify/1' }, { slug: 'spotify', companyName: 'Spotify' });
  assert.strictEqual(job.companyName, 'Spotify');
  assert.strictEqual(job.postedAt, null, 'a missing createdAt must be null, not Invalid Date');
});

check('ashby: secondary locations join, and only SALARY comp is read as salary', () => {
  const raw = {
    id: '6f78b170-9600-4b2d-9682-f',
    title: 'Senior GTM Engineering Analyst',
    jobUrl: 'https://jobs.ashbyhq.com/1password/6f78b170-9600-4b2d-9682-f',
    location: 'Remote (United States',
    secondaryLocations: [{ location: 'Canada)' }],
    publishedAt: '2026-09-11T17:18:27.824Z',
    employmentType: 'FullTime',
    descriptionPlain: 'Own the GTM data pipeline.',
    compensation: {
      compensationTiers: [
        { components: [{ compensationType: 'Equity', minValue: 1, maxValue: 2 }, { compensationType: 'Salary', minValue: 150000, maxValue: 190000 }] },
      ],
    },
  };
  const job = ashby.normalizeItem(raw, { slug: '1password', companyName: '1Password' });
  assertSchema(job, 'ashby');
  assert.strictEqual(job.location, 'Remote (United States, Canada)');
  // Equity is not a salary and must never be reported as one.
  assert.strictEqual(job.salaryMin, 150000);
  assert.strictEqual(job.salaryMax, 190000);
});

check('ashby: a comp block with no salary component yields nulls, not the equity numbers', () => {
  const raw = {
    id: '1', title: 'X', jobUrl: 'https://jobs.ashbyhq.com/1password/1',
    compensation: { compensationTiers: [{ components: [{ compensationType: 'Equity', minValue: 1, maxValue: 2 }] }] },
  };
  const job = ashby.normalizeItem(raw, { slug: '1password', companyName: '1Password' });
  assert.strictEqual(job.salaryMin, null);
  assert.strictEqual(job.salaryMax, null);
});

check('workday: the real date comes off the DETAIL payload, never the relative list string', () => {
  // `postedOn` is "Posted 6 Days Ago" — worthless as a date. startDate is the
  // real one, and it only exists on the per-posting detail call.
  const detail = {
    jobPostingInfo: {
      id: '2026046',
      title: 'Security Operations Engineer',
      location: 'Palo Alto (HQ)',
      startDate: '2026-09-01',
      postedOn: 'Posted 6 Days Ago',
      jobDescription: '<p>Defend the fleet.</p>',
      externalUrl: 'https://23andme.wd5.myworkdayjobs.com/23/job/Palo-Alto-HQ/SecOps_2026046',
    },
  };
  const job = workday.normalizeItem(detail, { id: '23andme:wd5:23', slug: '23andme:wd5:23', companyName: '23andMe' });
  assertSchema(job, 'workday');
  assert.strictEqual(job.postedAt, '2026-09-01T00:00:00.000Z');
  assert.ok(job.descriptionText && job.descriptionText.includes('Defend the fleet'), 'detail description dropped');
});

check('workable: published_on is a real date, and experience is a platform seniority signal', () => {
  const raw = {
    shortcode: 'E4335D00D8',
    title: 'Account Director',
    url: 'https://apply.workable.com/j/E4335D00D8',
    city: 'New York', state: 'New York', country: 'United States',
    published_on: '2026-07-28',
    employment_type: 'Full-time',
    experience: 'Director',
  };
  const job = workable.normalizeItem(raw, { slug: '1000heads', companyName: '1000heads' });
  assertSchema(job, 'workable');
  assert.strictEqual(job.location, 'New York, New York, United States');
  assert.strictEqual(job.postedAt, '2026-07-28T00:00:00.000Z');
  // Workable's own field, not inferred from the title — passed through as-is.
  assert.strictEqual(job.seniorityLevel, 'Director');
  assert.strictEqual(job.descriptionText, null, 'deferred past the keep filter, same as greenhouse');
});

console.log('\nnormalizeItem — a sparse payload never produces undefined or a bad date:');

check('every adapter taking a single raw item survives an almost-empty payload', () => {
  const cases = [
    [greenhouse, {}, { slug: 's', companyName: 'C' }],
    [lever, {}, { slug: 's', companyName: 'C' }],
    [ashby, {}, { slug: 's', companyName: 'C' }],
    [workable, {}, { slug: 's', companyName: 'C' }],
    [workday, { jobPostingInfo: {} }, { id: 't:wd5:s', slug: 't:wd5:s', companyName: 'C' }],
    [oracle, { jobPostingInfo: {} }, { id: 't:us2:CX', slug: 't:us2:CX', companyName: 'C' }],
    [eightfold, {}, { id: '1', slug: 'x.eightfold.ai', companyName: 'C' }],
    [phenom, {}, { id: '1', slug: 'h:d', companyName: 'C' }],
  ];
  for (const [adapter, raw, ctx] of cases) {
    const job = adapter.normalizeItem(raw, ctx);
    for (const key of SCHEMA) {
      assert.ok(key in job, `${adapter.platform}: missing "${key}" on a sparse payload`);
      assert.notStrictEqual(job[key], undefined, `${adapter.platform}: "${key}" came back undefined on a sparse payload`);
    }
    assert.notStrictEqual(job.postedAt, 'Invalid Date', `${adapter.platform}: a missing date must be null`);
    if (job.postedAt !== null) assert.ok(/^\d{4}-/.test(job.postedAt), `${adapter.platform}: non-ISO postedAt`);
  }
});

check('avature takes a feed item plus detail HTML, and tolerates both being empty', () => {
  const job = avature.normalizeItem({}, '', { slug: 'careers:main', companyName: 'C' });
  for (const key of SCHEMA) {
    assert.notStrictEqual(job[key], undefined, `avature: "${key}" came back undefined`);
  }
});

console.log(`\n${passed} checks passed`);
process.exit(process.exitCode || 0);

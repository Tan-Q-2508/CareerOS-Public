#!/usr/bin/env node
// expandedCoverage.test.js — fixture coverage for the eleven ATS Direct
// adapters added in §15 #65 (SmartRecruiters, Recruitee, BambooHR, Breezy HR,
// Rippling, SAP SuccessFactors, Oracle Taleo, iCIMS classic, iCIMS career sites
// (Jibe), Radancy, YC Work at a Startup), the Oracle custom-host identifier,
// and the Workable squatter rule in detect.js.
//
// Same posture as atsAdapters.test.js: pure, free, no network. Fixtures are
// trimmed from payloads captured live on 2026-09-26 — URLs and ids are real.
//
//   node packages/shared/src/sourcing/ats/__tests__/expandedCoverage.test.js

const assert = require('assert');

const { adapters } = require('../index');
const { acceptsGuess, URL_MATCH_ADAPTERS, NAME_GUESS_EXCLUDED, VERIFIES_BOARD_NAME, ADAPTERS } = require('../detect');
const smartrecruiters = require('../smartrecruiters');
const recruitee = require('../recruitee');
const bamboohr = require('../bamboohr');
const breezy = require('../breezy');
const rippling = require('../rippling');
const successfactors = require('../successfactors');
const taleo = require('../taleo');
const icims = require('../icims');
const jibe = require('../jibe');
const radancy = require('../radancy');
const ycombinator = require('../ycombinator');
const oracle = require('../oracle');
const { extractJobPostings, jobPostingLocation, innerHtmlByAttr, titleMatchesAny } = require('../webFetch');

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

const SCHEMA = [
  'source', 'atsPlatform', 'atsSlug', 'title', 'companyName', 'location',
  'postedAt', 'link', 'descriptionText', 'seniorityLevel', 'employmentType',
  'salaryMin', 'salaryMax', 'dedupKey',
];
function assertSchema(job, platform) {
  for (const key of SCHEMA) {
    assert.ok(key in job, `${platform}: missing "${key}"`);
    assert.notStrictEqual(job[key], undefined, `${platform}: "${key}" is undefined`);
  }
  assert.strictEqual(job.source, 'ats_direct');
  assert.strictEqual(job.atsPlatform, platform);
  if (job.postedAt !== null) assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(job.postedAt), `${platform}: non-ISO postedAt ${job.postedAt}`);
}

// ---------------------------------------------------------------------------
// 1. URL matching
// ---------------------------------------------------------------------------
console.log('extractSlugFromUrl — each new platform claims its own real URLs:');

const REAL = {
  smartrecruiters: ['https://jobs.smartrecruiters.com/ServiceNow/744000151981339-sr-staff-product-designer', 'ServiceNow'],
  recruitee: ['https://bunq.recruitee.com/o/senior-legal-counsel-3', 'bunq'],
  bamboohr: ['https://kiln.bamboohr.com/careers/341', 'kiln'],
  breezy: ['https://beli.breezy.hr/p/893b5379a9f6-senior-backend-infrastructure-engineer', 'beli'],
  rippling: ['https://ats.rippling.com/rippling/jobs/75ad50c6-778f-42ee-9c63-70d1cd687202', 'rippling'],
  successfactors: ['https://jobs.exxonmobil.com/job/Bangalore-Market-Back-Supply-Scheduler-KA-560066/1424289700/', 'jobs.exxonmobil.com'],
  taleo: ['https://drhorton.taleo.net/careersection/2/jobdetail.ftl?job=2604887&lang=en', 'drhorton:2'],
  icims: ['https://career-schwab.icims.com/jobs/127197/it-service-support-analyst/job?in_iframe=1', 'career-schwab.icims.com'],
  jibe: ['https://jobs.statefarm.com/main/jobs/46200?lang=en-us', 'jobs.statefarm.com/main'],
  radancy: ['https://careers.unitedhealthgroup.com/job/eden-prairie/software-engineer/34088/101148841072', 'careers.unitedhealthgroup.com'],
  ycombinator: ['https://www.ycombinator.com/companies/circuithub/jobs/js2U2cL-computer-vision-engineer', 'circuithub'],
};

for (const [platform, [url, slug]] of Object.entries(REAL)) {
  check(`${platform}: ${slug}`, () => {
    assert.deepStrictEqual(adapters[platform].extractSlugFromUrl(url), { platform, slug });
  });
}

check('the newer SuccessFactors template and a locale-prefixed Radancy site', () => {
  assert.deepStrictEqual(successfactors.extractSlugFromUrl('https://jobs.aa.com/job/Aviation-Maintenance-Technician/88096-en_US/'), { platform: 'successfactors', slug: 'jobs.aa.com' });
  assert.deepStrictEqual(radancy.extractSlugFromUrl('https://jobs.walgreens.com/en/job/deerfield/software-engineer/1242/101095159648'), { platform: 'radancy', slug: 'jobs.walgreens.com/en' });
});

check('API-host forms resolve to the same slug as the board URLs', () => {
  assert.strictEqual(smartrecruiters.extractSlugFromUrl('https://api.smartrecruiters.com/v1/companies/AbbVie/postings?limit=1').slug, 'AbbVie');
  assert.strictEqual(rippling.extractSlugFromUrl('https://api.rippling.com/platform/api/ats/v1/board/rippling/jobs').slug, 'rippling');
  assert.strictEqual(jibe.extractSlugFromUrl('https://careers.amd.com/api/jobs?page=1').slug, 'careers.amd.com');
});

check('greenhouse: an embedded board reads its token from ?for= (it used to resolve to "embed")', () => {
  const greenhouse = require('../greenhouse');
  assert.deepStrictEqual(greenhouse.extractSlugFromUrl('https://boards.greenhouse.io/embed/job_board?for=stripe'), { platform: 'greenhouse', slug: 'stripe' });
  assert.deepStrictEqual(greenhouse.extractSlugFromUrl('https://boards.greenhouse.io/embed/job_board/js?for=figma'), { platform: 'greenhouse', slug: 'figma' });
  assert.deepStrictEqual(greenhouse.extractSlugFromUrl('https://job-boards.greenhouse.io/embed/job_app?token=1'), { platform: 'greenhouse', slug: null });
});

check('vendor, employee-only and classic-portal hosts are not claimed as boards', () => {
  assert.strictEqual(icims.extractSlugFromUrl('https://www.icims.com/legal/privacy-notice-website/'), null);
  assert.strictEqual(icims.extractSlugFromUrl('https://internal-amd.icims.com/jobs/search'), null);
  assert.strictEqual(bamboohr.extractSlugFromUrl('https://www.bamboohr.com/careers/'), null);
  assert.strictEqual(successfactors.extractSlugFromUrl('https://career4.successfactors.com/career?company=exxonmobilP'), null);
  assert.strictEqual(breezy.extractSlugFromUrl('https://assets-cdn.breezy.hr/x.png'), null);
});

console.log('\nextractSlugFromUrl — cross-platform negatives across ALL 24 adapters:');

check('every real URL (old and new platforms) is claimed by exactly one adapter', () => {
  const urls = {
    greenhouse: 'https://job-boards.greenhouse.io/anthropic/jobs/4461450008',
    lever: 'https://jobs.lever.co/spotify/2193db3f-77c5-43b8-b030-8f92c9',
    ashby: 'https://jobs.ashbyhq.com/1password/6f78b170-9600-4b2d-9682-f',
    workday: 'https://23andme.wd5.myworkdayjobs.com/23/job/Palo-Alto-HQ/SecOps_2026046',
    ...Object.fromEntries(Object.entries(REAL).map(([p, [u]]) => [p, u])),
  };
  const all = Object.values(adapters);
  for (const [owner, url] of Object.entries(urls)) {
    const claimers = all.filter((a) => a.extractSlugFromUrl(url)).map((a) => a.platform);
    assert.deepStrictEqual(claimers, [owner], `${url} -> ${claimers.join(', ') || '(none)'}`);
  }
});

check('a Jibe-shaped path without ?lang= is not a Jibe candidate (Greenhouse boards share /jobs/{id})', () => {
  assert.strictEqual(jibe.extractSlugFromUrl('https://boards.greenhouse.io/anthropic/jobs/4461450008'), null);
  assert.strictEqual(jibe.extractSlugFromUrl('https://example.com/careers/jobs/12345'), null);
});

check('shape-only adapters sit after every host-signature adapter in URL-match order', () => {
  const order = URL_MATCH_ADAPTERS.map((a) => a.platform);
  const firstShape = Math.min(...['phenom', 'successfactors', 'jibe', 'radancy'].map((p) => order.indexOf(p)));
  for (const host of ['greenhouse', 'lever', 'ashby', 'workday', 'workable', 'smartrecruiters', 'recruitee', 'bamboohr', 'breezy', 'rippling', 'taleo', 'icims', 'ycombinator']) {
    assert.ok(order.indexOf(host) < firstShape, `${host} must be tried before any shape-only adapter`);
  }
  assert.strictEqual(order.length, Object.keys(adapters).length, 'every adapter must be URL-matchable');
});

check('name-guess membership: verifiable platforms in, company-domain and YC platforms out', () => {
  const sweep = ADAPTERS.map((a) => a.platform);
  for (const p of ['smartrecruiters', 'recruitee', 'breezy', 'rippling']) {
    assert.ok(sweep.includes(p), `${p} should be in the sweep`);
    assert.ok(VERIFIES_BOARD_NAME.has(p), `${p} joins the sweep only because it name-verifies`);
  }
  for (const p of ['bamboohr', 'successfactors', 'taleo', 'icims', 'jibe', 'radancy', 'ycombinator']) {
    assert.ok(NAME_GUESS_EXCLUDED.has(p), `${p} must be excluded from name-guessing`);
    assert.ok(!sweep.includes(p), `${p} must not be swept`);
  }
});

// ---------------------------------------------------------------------------
// 2. Detection acceptance rule
// ---------------------------------------------------------------------------
console.log('\nacceptsGuess — the verification a guessed slug must pass:');

const wk = { platform: 'workable' };
const sr = { platform: 'smartrecruiters' };
const lv = { platform: 'lever' };

check('an empty Workable account named after the company is rejected (the squatter case)', () => {
  // Real shape found live: apply.workable.com/api/v1/widget/accounts/walmart
  // answers 200 with name "walmart" and zero jobs.
  assert.strictEqual(acceptsGuess({ ok: true, adapter: wk, boardName: 'walmart', jobCount: 0 }, 'Walmart'), false);
  assert.strictEqual(acceptsGuess({ ok: true, adapter: wk, boardName: 'Tesla', jobCount: null }, 'Tesla'), false);
});

check('a Workable board that names the company AND lists jobs is accepted', () => {
  assert.strictEqual(acceptsGuess({ ok: true, adapter: wk, boardName: '1000heads', jobCount: 12 }, '1000heads'), true);
});

check('a name-verifying platform rejects a board named for someone else', () => {
  assert.strictEqual(acceptsGuess({ ok: true, adapter: sr, boardName: 'Bosch Group' }, 'Visa'), false);
  assert.strictEqual(acceptsGuess({ ok: true, adapter: sr, boardName: null }, 'AbbVie'), false);
  assert.strictEqual(acceptsGuess({ ok: true, adapter: sr, boardName: 'AbbVie' }, 'AbbVie Inc.'), true);
});

check('a non-verifying platform (Lever) keeps its existing unverified acceptance', () => {
  assert.strictEqual(acceptsGuess({ ok: true, adapter: lv, boardName: null }, 'Spotify'), true);
  assert.strictEqual(acceptsGuess({ ok: false, adapter: lv }, 'Spotify'), false);
});

// ---------------------------------------------------------------------------
// 3. Oracle custom hosts
// ---------------------------------------------------------------------------
console.log('\noracle — the two-part {host}:{site} identifier:');

check('a dc-less oraclecloud host and a custom domain both parse and round-trip', () => {
  assert.deepStrictEqual(oracle.parseIdentifier('jpmc.fa.oraclecloud.com:CX_1001'), { host: 'jpmc.fa.oraclecloud.com', site: 'CX_1001' });
  assert.deepStrictEqual(oracle.parseIdentifier('enterpriseplatform.dell.com:CX_1001'), { host: 'enterpriseplatform.dell.com', site: 'CX_1001' });
  assert.strictEqual(oracle.buildIdentifier({ host: 'jpmc.fa.oraclecloud.com', site: 'CX_1001' }), 'jpmc.fa.oraclecloud.com:CX_1001');
  assert.deepStrictEqual(oracle.parseIdentifier('efds:em5:CX_1'), { tenant: 'efds', dc: 'em5', site: 'CX_1' });
  assert.strictEqual(oracle.parseIdentifier('nodot:CX_1'), null, 'a two-part id must carry a real host');
});

check('URL matching reads both forms off the candidate-experience URL', () => {
  assert.strictEqual(oracle.extractSlugFromUrl('https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210768195').slug, 'jpmc.fa.oraclecloud.com:CX_1001');
  assert.strictEqual(oracle.extractSlugFromUrl('https://enterpriseplatform.dell.com/hcmUI/CandidateExperience/en/sites/CX_1001/jobs').slug, 'enterpriseplatform.dell.com:CX_1001');
  assert.strictEqual(oracle.extractSlugFromUrl('https://efds.fa.em5.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1').slug, 'efds:em5:CX_1');
  assert.strictEqual(oracle.extractSlugFromUrl('https://example.com/careers/jobs'), null);
});

// ---------------------------------------------------------------------------
// 4. normalizeItem schema, from captured payloads
// ---------------------------------------------------------------------------
console.log('\nnormalizeItem — captured payloads produce the §4.2 schema:');

check('smartrecruiters: sections joined, platform seniority/employment passed through', () => {
  const item = {
    id: '744000151981339', name: 'Sr. Staff Product Designer ', releasedDate: '2026-09-26T03:12:04.607Z',
    location: { city: 'Santa Clara', region: 'CALIFORNIA', country: 'us', fullLocation: 'Santa Clara, CALIFORNIA, United States', remote: false },
    company: { identifier: 'ServiceNow', name: 'ServiceNow' },
    typeOfEmployment: { label: 'Full-time' }, experienceLevel: { label: 'Mid-Senior Level' },
  };
  const detail = {
    postingUrl: 'https://jobs.smartrecruiters.com/ServiceNow/744000151981339-sr-staff-product-designer',
    jobAd: { sections: { jobDescription: { title: 'Job Description', text: '<p>Design systems.</p>' }, qualifications: { title: 'Qualifications', text: '<ul><li>10 years</li></ul>' } } },
  };
  const job = smartrecruiters.normalizeItem(item, { slug: 'ServiceNow', companyName: 'ServiceNow', detail });
  assertSchema(job, 'smartrecruiters');
  assert.strictEqual(job.title, 'Sr. Staff Product Designer');
  assert.strictEqual(job.location, 'Santa Clara, CALIFORNIA, United States');
  assert.ok(job.descriptionText.includes('Design systems') && job.descriptionText.includes('10 years'));
  assert.strictEqual(job.seniorityLevel, 'Mid-Senior Level');
  assert.strictEqual(job.dedupKey, 'ats:smartrecruiters:ServiceNow:744000151981339');
});

check('recruitee: only a YEARLY salary reaches the numeric columns', () => {
  const offer = { id: 2760348, slug: 'senior-legal-counsel-3', title: '(Senior) Legal Counsel', location: 'Amsterdam, Noord-Holland, Netherlands', published_at: '2026-09-25 15:46:07 UTC', careers_url: 'https://careers.bunq.com/o/senior-legal-counsel-3', company_name: 'bunq', employment_type_code: 'fulltime_permanent', salary: { min: 5000, max: 7000, period: 'month', currency: 'EUR' } };
  const job = recruitee.normalizeItem(offer, { slug: 'bunq', companyName: 'bunq' });
  assertSchema(job, 'recruitee');
  assert.strictEqual(job.salaryMin, null, 'a monthly figure must not read as annual');
  assert.strictEqual(job.postedAt, '2026-09-25T15:46:07.000Z');
  const yearly = recruitee.normalizeItem({ ...offer, salary: { min: 90000, max: 120000, period: 'year' } }, { slug: 'bunq', companyName: 'bunq' });
  assert.strictEqual(yearly.salaryMax, 120000);
});

check('bamboohr: the date and description come from the detail, location from both', () => {
  const item = { id: '341', jobOpeningName: 'Community Manager', employmentStatusLabel: 'Full-Time', location: { city: 'Manhattan Beach', state: 'California' }, isRemote: null };
  const detail = { result: { jobOpening: { jobOpeningShareUrl: 'https://kiln.bamboohr.com/careers/341', description: '<p>About Kiln</p>', datePosted: '2026-07-13', location: { city: 'Manhattan Beach', state: 'California', addressCountry: 'United States' }, minimumExperience: 'Experienced' } } };
  const job = bamboohr.normalizeItem(item, { slug: 'kiln', companyName: 'Kiln', detail });
  assertSchema(job, 'bamboohr');
  assert.strictEqual(job.postedAt, '2026-07-13T00:00:00.000Z');
  assert.strictEqual(job.location, 'Manhattan Beach, California, United States');
  const listOnly = bamboohr.normalizeItem(item, { slug: 'kiln', companyName: 'Kiln' });
  assert.strictEqual(listOnly.postedAt, null, 'the list has no date');
  assert.strictEqual(listOnly.link, 'https://kiln.bamboohr.com/careers/341');
});

check('breezy: remote positions are labelled and the salary string is not parsed into numbers', () => {
  const p = { id: '026d43128c81', friendly_id: '026d43128c81-junior-software-engineer', name: 'Junior Software Engineer', url: 'https://tristero.breezy.hr/p/026d43128c81-junior-software-engineer', published_date: '2023-12-08T16:23:34.743Z', type: { name: 'Full-Time' }, location: { is_remote: true, name: 'NYC, NY' }, salary: '$80,000 – $130,000 / year', company: { name: 'Tristero' } };
  const job = breezy.normalizeItem(p, { slug: 'tristero', companyName: 'Tristero' });
  assertSchema(job, 'breezy');
  assert.strictEqual(job.location, 'NYC, NY (Remote)');
  assert.strictEqual(job.salaryMin, null);
});

check('rippling: multi-location jobs collapse to one posting with every location', () => {
  const list = [
    { uuid: 'a', name: 'AE', url: 'https://ats.rippling.com/rippling/jobs/a', workLocation: { label: 'Austin, TX' } },
    { uuid: 'a', name: 'AE', url: 'https://ats.rippling.com/rippling/jobs/a', workLocation: { label: 'San Antonio, TX' } },
  ];
  const detail = { name: 'AE', createdOn: '2026-08-13T08:54:48.317000-07:00', workLocations: ['Austin, TX', 'San Antonio, TX'], description: { role: '<p>Sell.</p>', company: '<p>About Rippling</p>' }, employmentType: { id: 'Salaried, full-time' }, companyName: 'Rippling', payRangeDetails: [] };
  const job = rippling.normalizeItem({ ...list[0], locations: ['Austin, TX', 'San Antonio, TX'] }, { slug: 'rippling', companyName: 'Rippling', detail });
  assertSchema(job, 'rippling');
  assert.strictEqual(job.location, 'Austin, TX | San Antonio, TX');
  assert.strictEqual(job.postedAt, '2026-08-13T15:54:48.317Z');
  assert.ok(job.descriptionText.startsWith('Sell.'), 'the role text leads, company boilerplate follows');
});

// ---------------------------------------------------------------------------
// 5. HTML/JSON parsers of the scraped platforms
// ---------------------------------------------------------------------------
console.log('\nparsers — the career-site HTML shapes each adapter reads:');

check('successfactors: classic result rows and a multi-block detail page', () => {
  const html = `<tr class="data-row">
    <td class="colTitle"><span class="jobTitle hidden-phone"><a href="/job/Kuala-Lumpur-Petroleum-Engineer-Fede-50088/1381269100/" class="jobTitle-link">Petroleum Engineer</a></span></td>
    <td class="colLocation hidden-phone"><span class="jobLocation">
      Kuala Lumpur, Federal Territory of Kuala Lumpur, MY, 50088 </span></td>
    <td class="colDate hidden-phone"><span class="jobDate">Sep 26, 2026
    </span></td></tr>
  Results <b>1 – 25</b> of <b>582</b>`;
  const rows = successfactors.parseClassicRows(html, 'https://jobs.exxonmobil.com');
  assert.deepStrictEqual(rows, [{
    id: '1381269100', title: 'Petroleum Engineer',
    link: 'https://jobs.exxonmobil.com/job/Kuala-Lumpur-Petroleum-Engineer-Fede-50088/1381269100/',
    location: 'Kuala Lumpur, Federal Territory of Kuala Lumpur, MY, 50088', date: 'Sep 26, 2026',
  }]);
  const detail = successfactors.parseDetail(`<meta itemprop="datePosted" content="Sat Sep 26 07:00:00 UTC 2026"><meta itemprop="hiringOrganization" content="ExxonMobil">
    <span itemprop="description"><p>Location : DFW</p></span>
    <div><span itemprop="description" class="x"><span><b>Intro</b></span><p>Fly with us.</p></span></div>`);
  assert.ok(detail.description.includes('Location : DFW') && detail.description.includes('Fly with us.'), 'both description blocks are read');
  assert.strictEqual(detail.hiringOrganization, 'ExxonMobil');
  const job = successfactors.normalizeItem(rows[0], { slug: 'jobs.exxonmobil.com', companyName: 'ExxonMobil', detail });
  assertSchema(job, 'successfactors');
  assert.strictEqual(job.postedAt, '2026-09-26T07:00:00.000Z');
});

check('taleo: columns are read by the section\'s own layout, and "!*!" fields are the description', () => {
  const row = taleo.readRow({ jobId: '269275', contestNo: '2604887', column: ['Application Developer I', '["TX-Arlington"]', 'Sep 25, 2026'], linkedColumn: 0, locationsColumns: [1] });
  assert.deepStrictEqual(row, { id: '2604887', title: 'Application Developer I', location: 'TX-Arlington', date: 'Sep 25, 2026' });
  const value = ['ftlx0', 'Application Developer I', encodeURIComponent('!*!<p>Build apps\\: fast.</p>'), encodeURIComponent('!*!<p>Build apps\\: fast.</p>'), 'TX-Arlington'].join('!|!');
  const d = taleo.parseDetail(`<input type="hidden" name="initialHistory" id="initialHistory" value="${value}" />`);
  assert.strictEqual(d.description, 'Build apps: fast.', 'duplicates dropped, \\: unescaped');
  const job = taleo.normalizeItem(row, { slug: 'drhorton:2', companyName: 'D.R. Horton', parsed: taleo.parseIdentifier('drhorton:2'), detail: d });
  assertSchema(job, 'taleo');
  assert.strictEqual(job.link, 'https://drhorton.taleo.net/careersection/2/jobdetail.ftl?job=2604887&lang=en');
  assert.strictEqual(taleo.parseIdentifier('drhorton'), null);
});

check('icims: job cards yield title, link and the location field that precedes the title', () => {
  const html = `<ul class="container-fluid iCIMS_JobsTable"><li class="iCIMS_JobCardItem"><div class="row">
    <div class="col-xs-6 header left"><span class="sr-only field-label">Job Locations</span><span > US-TX-Austin | US-NE-Omaha</span></div>
    <div class="col-xs-12 title"><a href="https://career-schwab.icims.com/jobs/127197/it-service-support-analyst/job?in_iframe=1" class="iCIMS_Anchor" title="127197 - IT Service Support Analyst"><span class="sr-only field-label">Job Posting Title</span><h3 > IT Service Support Analyst</h3></a></div></div></li></ul>`;
  const cards = icims.parseCards(html, 'career-schwab.icims.com');
  assert.deepStrictEqual(cards, [{ id: '127197', title: 'IT Service Support Analyst', link: 'https://career-schwab.icims.com/jobs/127197/it-service-support-analyst/job?in_iframe=1', location: 'US-TX-Austin | US-NE-Omaha' }]);
});

check('radancy: rows read across tenant variants (h2 + job-location + optional date)', () => {
  const html = `<section data-total-results="108"><ul>
    <li><a href="/job/charlotte/principal-devops-engineer-i/4673/98067014240" data-job-id="98067014240"><h2>Principal DevOps Engineer I</h2><span class="job-location">Charlotte, NC</span><span class="job-date-posted">09/24/2026</span></a></li>
    <li class="branded-list__list-item"><a href="/en/job/deerfield/software-engineer/1242/101095159648" data-job-id="101095159648"><h2 class="headline headline--xs">Software Engineer</h2><span class="job-location">Deerfield, Illinois</span></a></li>
  </ul></section>`;
  const rows = radancy.parseResults(html, 'https://jobs.spectrum.com');
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], { id: '98067014240', title: 'Principal DevOps Engineer I', link: 'https://jobs.spectrum.com/job/charlotte/principal-devops-engineer-i/4673/98067014240', location: 'Charlotte, NC', date: '09/24/2026' });
  assert.strictEqual(rows[1].date, null);
  assert.strictEqual(rows[1].link, 'https://jobs.spectrum.com/en/job/deerfield/software-engineer/1242/101095159648');
});

check('radancy/icims/ycombinator: a JobPosting in ld+json drives description, date and location', () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Software Engineer","datePosted":"2026-9-25","description":"<p>Build.</p>","hiringOrganization":{"@type":"Organization","name":"UnitedHealth Group"},"jobLocation":[{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Eden Prairie","addressRegion":"Minnesota","addressCountry":"United States"}}]}</script>`;
  const [jp] = extractJobPostings(html);
  assert.strictEqual(jobPostingLocation(jp), 'Eden Prairie, Minnesota, United States');
  const job = radancy.normalizeItem({ id: '101148841072', title: 'Software Engineer', link: 'https://careers.unitedhealthgroup.com/job/x/y/34088/101148841072', location: null, date: null }, { slug: 'careers.unitedhealthgroup.com', companyName: 'UnitedHealth Group', jp });
  assertSchema(job, 'radancy');
  assert.strictEqual(job.descriptionText, 'Build.');
  assert.ok(job.postedAt && job.postedAt.startsWith('2026-09-2'), 'a non-padded ISO-ish date still parses');
  assert.deepStrictEqual(extractJobPostings('<script type="application/ld+json">{broken</script>'), [], 'a malformed block is skipped');
});

check('ycombinator: the data-page attribute decodes to the company and its postings', () => {
  const json = JSON.stringify({ props: { company: { name: 'CircuitHub', slug: 'circuithub' }, jobPostings: [{ id: 81917, title: 'Computer Vision Engineer', url: '/companies/circuithub/jobs/js2U2cL-computer-vision-engineer', location: 'UK / Remote (US)', type: 'Full-time', salaryRange: '£80K - £150K GBP', visa: 'US citizen/visa only', minExperience: 'Any (new grads ok)', companyName: 'CircuitHub' }] } });
  const html = `<div id="app" data-page="${json.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div>`;
  const data = ycombinator.pageData(html);
  assert.strictEqual(data.props.company.name, 'CircuitHub');
  const job = ycombinator.normalizeItem(data.props.jobPostings[0], { slug: 'circuithub', companyName: 'CircuitHub', jp: { description: '<p>See the Grid.</p>', datePosted: '2025-09-18T10:38:16Z' } });
  assertSchema(job, 'ycombinator');
  assert.strictEqual(job.salaryMin, null, 'the ld+json salary currency is unreliable and is never written');
  assert.ok(job.descriptionText.includes('Salary: £80K - £150K GBP') && job.descriptionText.includes('Visa: US citizen/visa only'));
  assert.strictEqual(job.link, 'https://www.ycombinator.com/companies/circuithub/jobs/js2U2cL-computer-vision-engineer');
});

check('jibe: the job link is built from the site base path and the posting language', () => {
  const d = { slug: '46200', req_id: '46200', title: 'Summer 2027 Intern', full_location: 'Bloomington, Illinois', posted_date: '2026-09-25T20:45:00+0000', language: 'en-us', hiring_organization: 'State Farm', employment_type: 'INTERN' };
  const job = jibe.normalizeItem(d, { slug: 'jobs.statefarm.com/main', companyName: 'State Farm', host: 'jobs.statefarm.com', basePath: '/main' });
  assertSchema(job, 'jibe');
  assert.strictEqual(job.link, 'https://jobs.statefarm.com/main/jobs/46200?lang=en-us');
  assert.strictEqual(job.postedAt, '2026-09-25T20:45:00.000Z');
});

check('webFetch: a class must match as a whole token (the Breezy header case)', () => {
  const html = '<div id="description" class="container position-description"><ul><li>%BUTTON%</li></ul></div><div class="description"><h1>T</h1><p>Body</p></div>';
  assert.strictEqual(innerHtmlByAttr(html, 'class', 'description'), '<h1>T</h1><p>Body</p>');
  assert.strictEqual(titleMatchesAny('Senior Software Engineer', ['software engineer']), true);
  assert.strictEqual(titleMatchesAny('Recruiter', ['engineer', 'analyst']), false);
  assert.strictEqual(titleMatchesAny('Anything', []), true);
});

check('every new adapter survives an almost-empty payload without undefined fields', () => {
  const cases = [
    [smartrecruiters, {}, { slug: 's', companyName: 'C' }],
    [recruitee, {}, { slug: 's', companyName: 'C' }],
    [bamboohr, {}, { slug: 's', companyName: 'C' }],
    [breezy, {}, { slug: 's', companyName: 'C' }],
    [rippling, {}, { slug: 's', companyName: 'C' }],
    [successfactors, {}, { slug: 'x.example.com', companyName: 'C' }],
    [taleo, { id: '1' }, { slug: 't:1', companyName: 'C', parsed: { tenant: 't', section: '1' } }],
    [icims, { id: '1', link: 'https://x.icims.com/jobs/1/x/job' }, { slug: 'x.icims.com', companyName: 'C' }],
    [jibe, {}, { slug: 'x.example.com', companyName: 'C', host: 'x.example.com', basePath: '' }],
    [radancy, { id: '1', link: 'https://x.example.com/job/a/b/1/123456' }, { slug: 'x.example.com', companyName: 'C' }],
    [ycombinator, {}, { slug: 's', companyName: 'C' }],
  ];
  for (const [adapter, raw, ctx] of cases) {
    const job = adapter.normalizeItem(raw, ctx);
    for (const key of SCHEMA) assert.notStrictEqual(job[key], undefined, `${adapter.platform}: "${key}" undefined on a sparse payload`);
  }
});

check('every adapter registers a contract-drift canary (18.3)', () => {
  for (const a of Object.values(adapters)) {
    assert.ok(a.contractCheck && typeof a.contractCheck.run === 'function' && Array.isArray(a.contractCheck.requiredFields), `${a.platform} has no contractCheck`);
    assert.strictEqual(a.contractCheck.name, a.platform, `${a.platform}'s canary is registered under another name`);
  }
});

// The slug-directory importer's pure layer (scripts/import-ats-slugs.js).
const { identifierFor, isTransient } = require('../../../../../../scripts/import-ats-slugs');

check('importer: SuccessFactors career-site roots are the identifier; the classic portal is not', () => {
  assert.strictEqual(identifierFor('successfactors', 'https://jobs.dana.com/'), 'jobs.dana.com');
  assert.strictEqual(identifierFor('successfactors', 'https://career15.sapsf.cn/career'), 'career15.sapsf.cn/career');
  assert.strictEqual(identifierFor('successfactors', 'https://career4.successfactors.com/career?company=X'), null);
  // Every other platform still goes through its adapter's own parser only.
  assert.strictEqual(identifierFor('recruitee', 'https://example.com/not-a-board'), null);
  assert.strictEqual(identifierFor('workday', 'https://23andme.wd5.myworkdayjobs.com/23'), '23andme:wd5:23');
});

check('importer: only momentary failures are retried, a definite answer rejects', () => {
  for (const status of [429, 403, 500, 503]) assert.ok(isTransient({ status }), `${status} should retry`);
  assert.ok(isTransient({ status: 0, error: 'fetch failed' }));
  assert.ok(!isTransient({ status: 404 }));
  assert.ok(!isTransient({ status: 200, error: 'no postings' }));
  assert.ok(!isTransient({ status: 0, error: 'malformed identifier' }));
});

check('importer: a row is named by its board, then its cleaned page title, never worse than the directory', () => {
  const { nameFromTitle, chooseName } = require('../../../../../../scripts/import-ats-slugs');
  // Page titles the directory stored as SuccessFactors company names.
  assert.strictEqual(nameFromTitle('Careers at EY: search jobs', 'careers.ey.com'), 'EY');
  assert.strictEqual(nameFromTitle('Seagatecareers', 'seagatecareers.com'), 'Seagate');
  assert.strictEqual(nameFromTitle('Your Career - DÖHLER', 'jobs.doehler.com'), 'DÖHLER');
  assert.strictEqual(nameFromTitle('Careers at Lovelace Biomedical Research Institute', 'careers-lrri.icims.com'), 'Lovelace Biomedical Research Institute');
  // Pure boilerplate on the company's own domain names it by that domain...
  assert.strictEqual(nameFromTitle('Empleo', 'empleo.abanca.com'), 'Abanca');
  // ...but a shared vendor host names nobody, and an unsure strip gives up.
  assert.strictEqual(nameFromTitle('Careers', 'careers-x.icims.com'), null);
  assert.strictEqual(nameFromTitle('Work for the City of Vancouver — Do your best work here', 'jobs.vancouver.ca'), null);
  // The board's own name beats the directory's slug-name; a junk one does not.
  assert.strictEqual(chooseName({ display: 'Generalcatalyst', slug: 'generalcatalyst', selfName: 'General Catalyst' }), 'General Catalyst');
  assert.strictEqual(chooseName({ display: 'Acme Robotics', slug: 'acme', selfName: 'Careers' }), 'Acme Robotics');
});

check('importer: the main iCIMS portal outranks regional and role-specific ones', () => {
  const { icimsPortalScore } = require('../../../../../../scripts/import-ats-slugs');
  const best = (hosts) => [...hosts].sort((a, b) => icimsPortalScore(b) - icimsPortalScore(a))[0];
  assert.strictEqual(best(['germancareers-bruker.icims.com', 'uscareers-bruker.icims.com', 'spanishcareers-bruker.icims.com']), 'uscareers-bruker.icims.com');
  assert.strictEqual(best(['emea-blackhawknetwork.icims.com', 'careers-blackhawknetwork.icims.com']), 'careers-blackhawknetwork.icims.com');
  assert.strictEqual(best(['drivers-natdcp.icims.com', 'careers-natdcp.icims.com']), 'careers-natdcp.icims.com');
});

(async () => {
  // Recruitee throttles across tenants, so its floor must hold between two
  // DIFFERENT hosts, outside a scan (probes) — the case per-host pacing misses.
  const { pacePlatform, paceHost } = require('../scanContext');
  const gap = require('../../../tunables.json').atsDirect.minPlatformIntervalMs.recruitee;
  try {
    let t0 = Date.now();
    await paceHost('https://a.recruitee.com/api/offers/', 'recruitee');
    await paceHost('https://b.recruitee.com/api/offers/', 'recruitee');
    await paceHost('https://c.recruitee.com/api/offers/', 'recruitee');
    const spent = Date.now() - t0;
    assert.ok(spent >= 2 * gap - 15, `three Recruitee requests on three hosts took ${spent}ms, want >= ${2 * gap}`);
    t0 = Date.now();
    await pacePlatform('greenhouse');
    await pacePlatform('greenhouse');
    assert.ok(Date.now() - t0 < 50, 'a platform with no floor must not wait');
    passed += 1;
    console.log('  ok - platform-wide floor spaces Recruitee across tenants, probes included');
  } catch (e) {
    console.error('  FAIL - platform-wide floor spaces Recruitee across tenants, probes included');
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
  console.log(`\n${passed} checks passed`);
  process.exit(process.exitCode || 0);
})();

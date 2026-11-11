// Y Combinator "Work at a Startup" adapter — the startup job board behind the
// system Startups tracklist (§15 #65).
//
// Most YC companies post roles on YC's own job board rather than (or as well
// as) an ATS; each company's listing is a public page. Verified live
// 2026-09-26:
//   list:   GET https://www.ycombinator.com/companies/{slug}/jobs
//           The page is server-rendered with its data in a `data-page`
//           attribute (HTML-escaped JSON): props.company { name, slug, website,
//           batch_name, team_size, location } and props.jobPostings [{ id,
//           title, url, location, type, salaryRange, equityRange,
//           minExperience, visa, companyName, createdAt ("about 1 year") }].
//   detail: GET https://www.ycombinator.com{url}
//           -> a schema.org JobPosting in ld+json: description (HTML),
//              datePosted (a real timestamp, unlike the list's relative
//              createdAt), jobLocation, employmentType.
// An unknown slug is a clean 404. robots.txt allows /companies/{slug}/jobs
// (only the /companies?* search listing is disallowed), and this adapter
// only ever requests those two page shapes.
//
// Salary: the ld+json baseSalary was seen claiming USD for a posting the list
// shows in GBP, so neither is written to the numeric salary columns; the
// displayed range goes into the description text as the company wrote it.
//
// `props.company.name` is returned as the board name. Still URL-match only
// (detect.js NAME_GUESS_EXCLUDED): guessing every unknown company against
// ycombinator.com would put a request on YC for every name any scan ever
// sees, for a board that only YC companies have. YC companies enter the
// registry through scripts/import-startups.js instead.

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText, decodeEntities } = require('./htmlToText');
const { fetchText, pooled, cleanTitles, titleMatchesAny, toIso, extractJobPostings, jobPostingLocation } = require('./webFetch');

const platform = 'ycombinator';
const BASE = 'https://www.ycombinator.com';

function cfg() {
  return tunables.atsDirect.platforms.ycombinator;
}

// www.ycombinator.com/companies/{slug}[/jobs[/{job}]] and
// www.workatastartup.com/companies/{slug}. A bare workatastartup.com/jobs/{id}
// permalink names no company, so it identifies the platform only.
function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (host === 'www.ycombinator.com' || host === 'ycombinator.com' || host === 'www.workatastartup.com' || host === 'workatastartup.com') {
    if (parts[0] === 'companies' && parts[1] && /^[a-z0-9-]+$/i.test(parts[1]) && parts[1] !== 'industry' && parts[1] !== 'location' && parts[1] !== 'batch') {
      return { platform, slug: parts[1].toLowerCase() };
    }
    if (host.includes('workatastartup') && parts[0] === 'jobs') return { platform, slug: null };
  }
  return null;
}

function pageData(html) {
  const m = /data-page="([^"]+)"/.exec(String(html || ''));
  if (!m) return null;
  try {
    return JSON.parse(decodeEntities(m[1]));
  } catch {
    return null;
  }
}

async function companyPage(slug) {
  const html = await fetchText(`${BASE}/companies/${encodeURIComponent(slug)}/jobs`, { platform });
  const data = pageData(html);
  const props = data && data.props;
  if (!props || !Array.isArray(props.jobPostings)) {
    const err = new Error(`YC company page for "${slug}" carried no jobPostings`);
    err.status = 200;
    throw err;
  }
  return props;
}

async function probe(slug) {
  if (!slug) return { ok: false, status: 0, boardName: null, error: 'missing identifier' };
  try {
    const props = await companyPage(slug);
    // jobCount lets scripts/import-startups.js fall back to this board only
    // when the company actually lists roles on it.
    return { ok: true, status: 200, boardName: (props.company && props.company.name) || null, jobCount: props.jobPostings.length, error: null };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

function normalizeItem(p, { slug, companyName, jp }) {
  const posting = jp || {};
  const id = p.id != null ? String(p.id) : null;
  const link = p.url ? `${BASE}${p.url}` : null;
  const facts = [
    p.salaryRange && `Salary: ${p.salaryRange}`,
    p.equityRange && `Equity: ${p.equityRange}`,
    p.minExperience && `Experience: ${p.minExperience}`,
    p.visa && `Visa: ${p.visa}`,
  ].filter(Boolean);
  const body = posting.description ? htmlToText(posting.description) : null;
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: p.title || posting.title || null,
    companyName: companyName || p.companyName || null,
    location: p.location || jobPostingLocation(posting),
    postedAt: toIso(posting.datePosted),
    link,
    descriptionText: body ? [body, facts.join('\n')].filter(Boolean).join('\n\n') : null,
    seniorityLevel: p.minExperience || null,
    employmentType: p.type || posting.employmentType || null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id, link, title: p.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

async function fetchJobs(slug, { companyName, titles, limit, keep } = {}) {
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const t = cleanTitles(titles);
  const props = await companyPage(slug);
  const survivors = props.jobPostings
    .filter((p) => p && p.url && titleMatchesAny(p.title, t))
    .filter((p) => !keep || keep(normalizeItem(p, { slug, companyName })))
    .slice(0, cap);
  const jobs = await pooled(survivors, cfg().detailConcurrency, async (p) => {
    try {
      const html = await fetchText(`${BASE}${p.url}`, { platform });
      return normalizeItem(p, { slug, companyName, jp: extractJobPostings(html)[0] });
    } catch (e) {
      console.error(`ycombinator fetchJobs: detail failed for "${p.url}":`, e.message || e);
      return null;
    }
  });
  return jobs.filter((j) => j && j.title && j.link);
}

const CONTRACT_CHECK_SLUG = 'circuithub';
const contractCheck = {
  name: platform,
  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt', 'boardName'],
  run: async () => {
    const p = await probe(CONTRACT_CHECK_SLUG);
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: 'CircuitHub', limit: 1 });
    const first = jobs[0] || {};
    return {
      jobs: jobs.length ? jobs : null,
      firstTitle: first.title || null,
      firstLink: first.link || null,
      firstDescription: first.descriptionText || null,
      firstPostedAt: first.postedAt || null,
      boardName: p.boardName || null,
    };
  },
};

module.exports = { platform, extractSlugFromUrl, probe, fetchJobs, normalizeItem, pageData, contractCheck };

// Radancy (TalentBrew) career-site adapter — ATS Direct enterprise platform
// set (§15 #65).
//
// Radancy is not an ATS: it is the career-site layer many large employers put
// in front of one (UnitedHealth over Taleo, Walgreens over BrassRing, Charter
// over iCIMS, L3Harris, ...). Where the ATS underneath is reachable directly
// (Boeing, Chevron, Disney... all Workday) the registry points at the ATS; this
// adapter exists for the companies whose ATS is not, and it reads the site the
// candidate actually sees. Verified live 2026-09-26 on UnitedHealth Group,
// Walgreens, Charter (jobs.spectrum.com), L3Harris and Boeing — one request
// shape across all five:
//
//   list:   GET https://{site}/search-jobs/results?ActiveFacetID=0&CurrentPage={n}
//               &RecordsPerPage={n}&Keywords={text}&SearchType=5&...
//           (X-Requested-With: XMLHttpRequest)
//           -> { results: "<section ... data-total-results=\"525\"> <li> <a
//                href=\"/job/{city}/{title}/{orgId}/{jobId}\" data-job-id=...>
//                <h2>Title</h2> <span class=\"job-location\">…</span>
//                [<span class=\"job-date-posted\">09/24/2026</span>] </a></li>…",
//                hasJobs }
//   detail: GET https://{site}/job/{city}/{title}/{orgId}/{jobId}
//           -> a schema.org JobPosting in ld+json (description, datePosted,
//              jobLocation, hiringOrganization, identifier)
//
// Row markup differs a little per tenant (h2 vs span title, where the
// location span sits), so a row is read from its <li> block by class-name
// fragments rather than one exact template. `Keywords` narrows server-side.
//
// Identifier is the site base: host plus any locale prefix the site mounts
// under ("jobs.walgreens.com/en", "careers.unitedhealthgroup.com"). Never in
// name-guess — the host is the company's own domain.

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText, decodeEntities } = require('./htmlToText');
const { fetchJson, fetchText, pooled, cleanTitles, titleMatchesAny, toIso, extractJobPostings, jobPostingLocation } = require('./webFetch');

const platform = 'radancy';

function cfg() {
  return tunables.atsDirect.platforms.radancy;
}

function parseIdentifier(id) {
  if (!id) return null;
  const s = String(id).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const [host, ...rest] = s.split('/');
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null;
  return { host: host.toLowerCase(), prefix: rest.length ? `/${rest.join('/')}` : '' };
}

function siteBase(id) {
  const p = parseIdentifier(id);
  return p ? `https://${p.host}${p.prefix}` : null;
}

// {site}/job/{city}/{title}/{orgId}/{jobId} — four segments after "job", the
// last two numeric. Specific enough that it collides with no other adapter's
// shape, but still only a candidate until detect.js's probe confirms it.
function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('job');
  if (i < 0 || parts.length !== i + 5 || !/^\d+$/.test(parts[i + 3]) || !/^\d{6,}$/.test(parts[i + 4])) return null;
  const prefix = parts.slice(0, i).join('/');
  const host = parsed.hostname.toLowerCase();
  return { platform, slug: prefix ? `${host}/${prefix}` : host };
}

function resultsUrl(base, { page, perPage, keywords }) {
  const p = new URLSearchParams({
    ActiveFacetID: '0',
    CurrentPage: String(page),
    RecordsPerPage: String(perPage),
    Distance: '50',
    RadiusUnitType: '0',
    Keywords: keywords || '',
    Location: '',
    ShowRadius: 'False',
    IsPagination: page > 1 ? 'True' : 'False',
    FacetType: '0',
    SearchResultsModuleName: 'Search Results',
    SearchFiltersModuleName: 'Search Filters',
    SortCriteria: '0',
    SortDirection: '0',
    SearchType: '5',
  });
  return `${base}/search-jobs/results?${p.toString()}`;
}

function textOf(fragment) {
  return fragment ? decodeEntities(fragment.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || null : null;
}

// One results fragment -> [{ id, title, link, location, date }].
function parseResults(html, base) {
  const s = String(html || '');
  const out = [];
  const seen = new Set();
  for (const m of s.matchAll(/<a\b[^>]*href="([^"]*\/job\/[^"]+)"[^>]*>/gi)) {
    const idm = /data-job-id="(\d+)"/.exec(m[0]) || /\/(\d{6,})\/?(?:[?#]|$)/.exec(m[1]);
    if (!idm || seen.has(idm[1])) continue;
    seen.add(idm[1]);
    const liStart = s.lastIndexOf('<li', m.index);
    const liEnd = s.indexOf('</li>', m.index);
    const block = s.slice(liStart >= 0 ? liStart : m.index, liEnd >= 0 ? liEnd : m.index + 2000);
    const title = (/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i.exec(block) || /class="[^"]*job-title[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block) || [])[1];
    const loc = (/class="[^"]*job-location[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block) || [])[1];
    const date = (/class="[^"]*(?:job-date|date-posted|job-info date)[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block) || [])[1];
    let link;
    try {
      link = new URL(decodeEntities(m[1]), `${new URL(base).origin}/`).href;
    } catch {
      continue;
    }
    out.push({ id: idm[1], title: textOf(title), link, location: textOf(loc), date: textOf(date) });
  }
  return out;
}

function totalOf(html) {
  const m = /data-total-results="(\d+)"/.exec(String(html || ''));
  return m ? Number(m[1]) : null;
}

async function listRows(base, { keywords, cap }) {
  const c = cfg();
  const out = [];
  for (let page = 1; page <= c.maxListPages; page++) {
    const body = await fetchJson(resultsUrl(base, { page, perPage: c.pageSize, keywords }), {
      platform,
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (typeof body?.results !== 'string') {
      const err = new Error(`Radancy ${base}: no results fragment`);
      err.status = 200;
      throw err;
    }
    const rows = parseResults(body.results, base);
    out.push(...rows);
    const total = totalOf(body.results);
    if (!rows.length || total == null || out.length >= total || out.length >= cap) break;
  }
  return out;
}

async function probe(id) {
  const base = siteBase(id);
  if (!base) return { ok: false, status: 0, boardName: null, error: 'malformed identifier' };
  try {
    const rows = await listRows(base, { keywords: '', cap: 1 });
    return { ok: rows.length > 0, status: 200, boardName: null, error: rows.length ? null : 'no jobs' };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

function normalizeItem(row, { slug, companyName, jp }) {
  const posting = jp || {};
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: row.title || posting.title || null,
    companyName: companyName || (posting.hiringOrganization && posting.hiringOrganization.name) || null,
    location: jobPostingLocation(posting) || row.location || null,
    postedAt: toIso(posting.datePosted) || toIso(row.date),
    link: row.link,
    descriptionText: posting.description ? htmlToText(posting.description) : null,
    seniorityLevel: null,
    employmentType: Array.isArray(posting.employmentType) ? posting.employmentType.join(', ') : posting.employmentType || null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id: row.id, link: row.link, title: row.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

async function fetchJobs(slug, { companyName, titles, limit, keep } = {}) {
  const base = siteBase(slug);
  if (!base) throw new Error(`Radancy: malformed identifier "${slug}"`);
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const t = cleanTitles(titles);
  const byId = new Map();
  for (const kw of t.length ? t : ['']) {
    for (const row of await listRows(base, { keywords: kw, cap: cap * 4 })) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }
  const survivors = [...byId.values()]
    .filter((row) => row.title && titleMatchesAny(row.title, t))
    .filter((row) => !keep || keep(normalizeItem(row, { slug, companyName })))
    .slice(0, cap);
  const jobs = await pooled(survivors, cfg().detailConcurrency, async (row) => {
    try {
      const html = await fetchText(row.link, { platform });
      return normalizeItem(row, { slug, companyName, jp: extractJobPostings(html)[0] });
    } catch (e) {
      console.error(`radancy fetchJobs: detail failed for "${row.link}":`, e.message || e);
      return null;
    }
  });
  return jobs.filter(Boolean);
}

const CONTRACT_CHECK_SLUG = 'careers.unitedhealthgroup.com';
const contractCheck = {
  name: platform,
  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt', 'firstLocation'],
  run: async () => {
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: 'UnitedHealth Group', titles: ['engineer'], limit: 1 });
    const first = jobs[0] || {};
    return {
      jobs: jobs.length ? jobs : null,
      firstTitle: first.title || null,
      firstLink: first.link || null,
      firstDescription: first.descriptionText || null,
      firstPostedAt: first.postedAt || null,
      firstLocation: first.location || null,
    };
  },
};

module.exports = { platform, parseIdentifier, extractSlugFromUrl, probe, fetchJobs, normalizeItem, parseResults, contractCheck };

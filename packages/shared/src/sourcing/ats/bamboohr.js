// BambooHR adapter — ATS Direct, SMB/startup platform set (§15 #65).
//
// The public careers site behind every BambooHR customer, verified live
// 2026-09-26 (kiln.bamboohr.com):
//   list:   GET https://{slug}.bamboohr.com/careers/list          (Accept: application/json)
//           -> { meta: { totalCount }, result: [{ id, jobOpeningName,
//                departmentLabel, employmentStatusLabel, location: { city, state },
//                atsLocation, isRemote, locationType }] }
//   detail: GET https://{slug}.bamboohr.com/careers/{id}/detail
//           -> { result: { jobOpening: { jobOpeningName, description (HTML),
//                datePosted "YYYY-MM-DD", location: { city, state, addressCountry },
//                employmentStatusLabel, minimumExperience, compensation,
//                jobOpeningShareUrl } } }
// The list carries no description or date, so this is list-then-detail, like
// Workday. An unknown slug is a 302 to www.bamboohr.com's marketing page, not a
// 404 — the fetch follows it and gets HTML, which fetchJson reports as a
// non-JSON response and probe() reads as a miss.
//
// No company name appears in either payload, so a guessed slug cannot be
// verified — this platform is URL-match only (detect.js NAME_GUESS_EXCLUDED),
// the Lever/Ashby risk 4.6.2 already accepts without the verification those
// two at least had history behind.

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { fetchJson, pooled, cleanTitles, titleMatchesAny, toIso } = require('./webFetch');

const platform = 'bamboohr';

function cfg() {
  return tunables.atsDirect.platforms.bamboohr;
}

function base(slug) {
  return `https://${encodeURIComponent(slug)}.bamboohr.com/careers`;
}

// {slug}.bamboohr.com/careers[/{id}] and the older /jobs/view.php?id= shape.
function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const m = /^([a-z0-9-]+)\.bamboohr\.com$/.exec(parsed.hostname.toLowerCase());
  if (!m || ['www', 'api', 'app', 'help', 'documentation', 'marketplace', 'partners'].includes(m[1])) return null;
  const path = parsed.pathname.toLowerCase();
  if (!path.startsWith('/careers') && !path.startsWith('/jobs')) return null;
  return { platform, slug: m[1] };
}

async function probe(slug) {
  if (!slug) return { ok: false, status: 0, boardName: null, error: 'missing identifier' };
  try {
    const body = await fetchJson(`${base(slug)}/list`, { platform });
    const ok = Array.isArray(body?.result);
    return { ok, status: 200, boardName: null, error: ok ? null : 'no result array' };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

function listLocation(item) {
  const l = item.location || {};
  const a = item.atsLocation || {};
  const s = [l.city || a.city, l.state || a.state || a.province, a.country].filter(Boolean).join(', ');
  return item.isRemote ? (s ? `${s} (Remote)` : 'Remote') : s || null;
}

function normalizeItem(item, { slug, companyName, detail }) {
  const jo = (detail && detail.result && detail.result.jobOpening) || null;
  const id = item.id != null ? String(item.id) : null;
  const link = (jo && jo.jobOpeningShareUrl) || (id ? `${base(slug)}/${id}` : null);
  let location = listLocation(item);
  if (jo && jo.location) {
    const l = jo.location;
    location = [l.city, l.state, l.addressCountry].filter(Boolean).join(', ') || location;
    if (item.isRemote && location && !/remote/i.test(location)) location = `${location} (Remote)`;
  }
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: item.jobOpeningName || (jo && jo.jobOpeningName) || null,
    companyName: companyName || null,
    location,
    postedAt: toIso(jo && jo.datePosted),
    link,
    descriptionText: jo ? htmlToText(jo.description) : null,
    seniorityLevel: (jo && jo.minimumExperience) || null,
    employmentType: item.employmentStatusLabel || (jo && jo.employmentStatusLabel) || null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id, link, title: item.jobOpeningName, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

// `keep` runs against the LIST-level job (title + location, no date) before
// any detail request, so an off-location posting never costs one. The date
// only exists on the detail, and the caller's own filter still runs on the
// returned jobs, so a posted-within filter is still applied — just after the
// fan-out, as it is for Workday.
async function fetchJobs(slug, { companyName, titles, limit, keep } = {}) {
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const t = cleanTitles(titles);
  const body = await fetchJson(`${base(slug)}/list`, { platform });
  const survivors = (Array.isArray(body?.result) ? body.result : [])
    .filter((item) => item.id != null && titleMatchesAny(item.jobOpeningName, t))
    .filter((item) => !keep || keep(normalizeItem(item, { slug, companyName })))
    .slice(0, cap);
  const jobs = await pooled(survivors, cfg().detailConcurrency, async (item) => {
    try {
      const detail = await fetchJson(`${base(slug)}/${encodeURIComponent(item.id)}/detail`, { platform });
      return normalizeItem(item, { slug, companyName, detail });
    } catch (e) {
      console.error(`bamboohr fetchJobs: detail failed for "${slug}/${item.id}":`, e.message || e);
      return null;
    }
  });
  return jobs.filter((j) => j && j.title && j.link);
}

const CONTRACT_CHECK_SLUG = 'kiln';
const contractCheck = {
  name: platform,
  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt'],
  run: async () => {
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: 'Kiln', limit: 1 });
    const first = jobs[0] || {};
    return {
      jobs: jobs.length ? jobs : null,
      firstTitle: first.title || null,
      firstLink: first.link || null,
      firstDescription: first.descriptionText || null,
      firstPostedAt: first.postedAt || null,
    };
  },
};

module.exports = { platform, extractSlugFromUrl, probe, fetchJobs, normalizeItem, contractCheck };

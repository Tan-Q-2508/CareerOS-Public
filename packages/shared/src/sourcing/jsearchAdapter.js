const tunables = require('../tunables.json');
const { dedupKey } = require('./dedup');

// Core Scraper (CS) sourcing via JSearch on RapidAPI (spec 4.2 / 13.2). This is
// the always-on, house-run source every user gets from day one — no BYOK, no
// per-actor mapping (JSearch has a fixed, known output shape). Mirrors the
// apifyAdapter contract so runScan / the Session 12 worker treat it uniformly:
//   sourceJobs({ title, location, keywords, count, postedWithinDays })
//     -> { jobs: NormalizedJob[], requests }   (requests = pages, for the CS sourcing cost)
//
// The house RapidAPI key lives in process.env.RAPIDAPI_KEY; without it, CS is
// unavailable (isConfigured() false → the scan route 503s), BYO still works.

function cfg() {
  return tunables.sourcing.jsearch;
}

function isConfigured() {
  return Boolean(process.env.RAPIDAPI_KEY);
}

// JSearch's date_posted enum from our posted-within window (days).
function datePosted(days) {
  const d = days || tunables.postedWithinDays;
  if (d <= 1) return 'today';
  if (d <= 3) return '3days';
  if (d <= 7) return 'week';
  return 'month';
}

function toIso(v) {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v * 1000).toISOString(); // JSearch timestamps are epoch seconds
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toNumber(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function joinLocation(item) {
  const parts = [item.job_city, item.job_state, item.job_country].filter(Boolean);
  if (parts.length) return parts.join(', ');
  return item.job_location || null;
}

// Map one JSearch `data[]` result into the internal schema (4.2). JSearch's shape
// is fixed, so this is a fixed per-adapter mapping (no user field-mapping).
function normalizeItem(item) {
  const title = item.job_title || null;
  const link = item.job_apply_link || item.job_google_link || null;
  return {
    source: 'cs',
    title,
    companyName: item.employer_name || null,
    location: joinLocation(item),
    postedAt: toIso(item.job_posted_at_datetime_utc || item.job_posted_at_timestamp),
    link,
    descriptionText: item.job_description || null,
    seniorityLevel: null, // JSearch doesn't provide a normalized seniority level
    employmentType: item.job_employment_type || null,
    salaryMin: toNumber(item.job_min_salary),
    salaryMax: toNumber(item.job_max_salary),
    dedupKey: dedupKey({ id: item.job_id, link, title, companyName: item.employer_name, location: joinLocation(item) }),
  };
}

/**
 * Source jobs from JSearch (Core Scraper).
 * @returns {{ jobs: object[], requests: number }} requests = pages requested (bills per page, 13.4).
 */
async function sourceJobs({ title, location, keywords, count, postedWithinDays }) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) throw new Error('Core Scraper not configured: RAPIDAPI_KEY is required');
  const c = cfg();
  const want = count || tunables.csJobCount.default;
  const numPages = Math.max(1, Math.min(c.maxPages, Math.ceil(want / c.resultsPerPage)));

  const query = [title, keywords].filter(Boolean).join(' ').trim() + (location ? ` in ${location}` : '');
  const params = new URLSearchParams({
    query,
    page: '1',
    num_pages: String(numPages),
    date_posted: datePosted(postedWithinDays),
    country: c.country,
  });

  const resp = await fetch(`https://${c.host}${c.searchPath}?${params.toString()}`, {
    headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': c.host },
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (json && (json.message || json.error)) || `JSearch HTTP ${resp.status}`;
    throw new Error(typeof msg === 'string' ? msg : `JSearch HTTP ${resp.status}`);
  }

  // v5 /search-v2 nests the array under data.jobs; older /search returned data[].
  const rawJobs = (json.data && json.data.jobs) || json.data || [];
  const jobs = rawJobs
    .map(normalizeItem)
    .filter((j) => j.title && j.link)
    .slice(0, want);
  return { jobs, requests: numPages };
}

module.exports = { sourceJobs, isConfigured, normalizeItem, datePosted };

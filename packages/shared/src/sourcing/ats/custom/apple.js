// Apple Custom Adapter Tier adapter (spec 18.2, Phase 5.5 §15 #45).
//
// jobs.apple.com is server-rendered — there is no JSON API/XHR at all (live
// discovery, 2026-08-27: watching the Network tab while paging/searching
// shows zero fetch/XHR requests; every interaction is a full page navigation).
// The search results ARE present as clean JSON, but double-encoded: the page
// carries
//   <script>window.__staticRouterHydrationData = JSON.parse("...");</script>
// where the "..." is a JSON STRING LITERAL (its own quotes/backslashes
// escaped) whose decoded content is itself a second JSON document. Decoding
// needs two steps — unescape the outer JS string literal, then JSON.parse the
// result — never a single JSON.parse of the raw HTML slice.
//   list:   GET https://jobs.apple.com/en-us/search?search={query}&sort=relevance&page={n}
//           -> loaderData.search.{searchResults[], totalRecords}
//   detail: GET https://jobs.apple.com/en-us/details/{reqId}/{transformedPostingTitle}
//           -> loaderData.jobDetails.jobsData.{description, minimumQualifications,
//              preferredQualifications, ...} — searchResults' own `jobSummary` is
//              a short teaser only, not the real posting text.
// Both confirmed live and reachable from a plain Node fetch (Apple's endpoint
// negotiates gzip, which this runtime's fetch decompresses transparently —
// unlike Amazon's zstd default, see custom/index.js's header).
//
// No board/company display name anywhere in either payload — same posture as
// every other adapter here. `reqId` (e.g. "200609884-0836") already encodes
// the posting-identifier suffix Apple's own detail URL needs; it is NOT the
// same as `positionId` alone.

const tunables = require('../../../tunables.json');
const { dedupKey } = require('../../dedup');
const { getHtmlCustom, parseFixedIdentifier, fixedIdentifier } = require('./index');

const platform = 'apple';

function cfg() {
  return tunables.atsDirect.platforms.apple;
}

// Unescapes a JS double-quoted string literal starting right after the
// opening quote that follows `marker` in `html`, honoring backslash escapes
// (so an escaped quote inside the literal doesn't end the scan early), and
// JSON.parse-decodes the result — the standard way to pull a string literal's
// real value out of `JSON.parse("...")`-wrapped inline hydration data.
function extractQuotedJsString(html, marker) {
  const mi = html.indexOf(marker);
  if (mi === -1) return null;
  let i = mi + marker.length;
  if (html[i] !== '"') return null;
  i++;
  let out = '';
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === '\\') {
      out += ch + html[i + 1];
      i++;
      continue;
    }
    if (ch === '"') break;
    out += ch;
  }
  try {
    return JSON.parse(`"${out}"`);
  } catch {
    return null;
  }
}

const HYDRATION_MARKER = 'window.__staticRouterHydrationData = JSON.parse(';

// Pulls loaderData.<key> out of a fetched Apple page's double-encoded
// hydration blob. Returns null on any decode failure (a redesign dropping
// this mechanism entirely) rather than throwing — the caller decides how to
// treat "found nothing", same posture as every JSON adapter's empty-list case.
function extractLoaderData(html, key) {
  const jsonStr = extractQuotedJsString(html, HYDRATION_MARKER);
  if (!jsonStr) return null;
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  return (data && data.loaderData && data.loaderData[key]) || null;
}

function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  if (!/(^|\.)jobs\.apple\.com$/.test(parsed.hostname.toLowerCase())) return null;
  // Custom Adapter Tier identity is the plain platform key (custom/index.js) —
  // there's nothing to extract from the path, just recognizing the host.
  return { platform, slug: fixedIdentifier(platform) };
}

function searchUrl(query, page) {
  const q = new URLSearchParams({ search: query || '', sort: 'relevance', page: String(page) });
  return `https://jobs.apple.com/en-us/search?${q.toString()}`;
}

function detailUrl(reqId, transformedPostingTitle) {
  return `https://jobs.apple.com/en-us/details/${encodeURIComponent(reqId)}/${encodeURIComponent(transformedPostingTitle || '')}`;
}

// Cheap existence probe: one search page for a broad, near-universal term
// ("engineer") — Apple has no unfiltered "browse everything" page, so an
// empty-string search is the closest to a existence check; `ok` iff
// `searchResults` is a non-empty array. A malformed identifier short-circuits
// before any request.
async function probe(id) {
  const parsed = parseFixedIdentifier(platform, id);
  if (!parsed) return { ok: false, status: 0, boardName: null, error: 'malformed identifier' };
  try {
    const html = await getHtmlCustom(searchUrl('', 1));
    const search = extractLoaderData(html, 'search');
    const results = Array.isArray(search?.searchResults) ? search.searchResults : null;
    if (!results) return { ok: false, status: 200, boardName: null, error: 'hydration data not found (page shape changed?)' };
    return { ok: results.length > 0, status: 200, boardName: null, error: null };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length)))
    .fill(0)
    .map(async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return out;
}

function listItemMatchesTitle(item, title) {
  if (!title) return true;
  return !!(item.postingTitle && item.postingTitle.toLowerCase().includes(title.toLowerCase().trim()));
}

function listItemMatchesAnyTitle(item, titles) {
  if (!titles || !titles.length) return true;
  return titles.some((t) => listItemMatchesTitle(item, t));
}

function formatLocation(locations) {
  if (!Array.isArray(locations) || !locations.length) return null;
  return locations.map((l) => l.name || l.city).filter(Boolean).join(', ') || null;
}

function normalizeItem(jobsData, { slug, companyName }) {
  const info = jobsData || {};
  const link = detailUrl(info.jobNumber || info.reqId, info.transformedPostingTitle);
  // Full text = the role summary + the real description + both qualification
  // blocks — `description`/`minimumQualifications`/`preferredQualifications`
  // are already plain text (Apple's own field, not HTML), so no htmlToText
  // pass is needed here (contrast Amazon/Workday, whose fields carry HTML).
  const descriptionText = [info.jobSummary, info.description, info.minimumQualifications, info.preferredQualifications]
    .filter(Boolean)
    .join('\n\n');
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: (info.postingTitle || '').trim() || null,
    companyName: companyName || null,
    location: formatLocation(info.locations),
    postedAt: toIso(info.postDateInGMT),
    link,
    descriptionText,
    seniorityLevel: info.highJobTitle || null,
    employmentType: info.employmentType || info.jobType || null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id: info.jobNumber || info.reqId, link, title: info.postingTitle, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pull open postings from jobs.apple.com, title-narrowed and detail-enriched,
 * normalized into the 4.2 internal schema.
 *
 * @param {string} slug the fixed identifier "apple" (custom/index.js)
 * @param {{companyName?: string, titles?: string[], limit?: number, dispatcher?: *}} opts
 *   `titles`, when supplied, is passed ONE AT A TIME as Apple's own
 *   server-side `search` query (same per-title-searchText posture as
 *   workday.js/oracle.js) AND still applied as a local substring match
 *   against each item's `postingTitle` — the caller's filter is never
 *   replaced, only pre-narrowed, since `search` also matches body text.
 *   No titles at all runs one pass with an empty query (Apple's whole current
 *   posting list, paginated up to `limit`).
 */
async function fetchJobs(slug, { companyName, titles, limit } = {}) {
  const c = cfg();
  const parsed = parseFixedIdentifier(platform, slug);
  if (!parsed) throw new Error(`Apple: malformed identifier "${slug}"`);

  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const realTitles = Array.isArray(titles) ? titles.filter(Boolean) : titles ? [titles] : [];
  const passes = realTitles.length ? realTitles : [''];

  const listedById = new Map();
  for (const searchTitle of passes) {
    if (listedById.size >= cap * 4) break;
    for (let page = 1; page <= c.maxListPages; page++) {
      const html = await getHtmlCustom(searchUrl(searchTitle, page));
      const search = extractLoaderData(html, 'search');
      const results = Array.isArray(search?.searchResults) ? search.searchResults : [];
      for (const item of results) {
        if (item.positionId && !listedById.has(item.positionId)) listedById.set(item.positionId, item);
      }
      const total = typeof search?.totalRecords === 'number' ? search.totalRecords : null;
      if (!results.length) break;
      if (total != null && page * c.pageSize >= total) break;
      if (listedById.size >= cap * 4) break;
    }
  }

  const survivors = [...listedById.values()]
    .filter((item) => listItemMatchesAnyTitle(item, realTitles) && item.positionId)
    .slice(0, cap);

  const details = await pooled(survivors, c.detailConcurrency, async (item) => {
    try {
      const html = await getHtmlCustom(detailUrl(item.jobNumber || item.reqId, item.transformedPostingTitle));
      const jobDetails = extractLoaderData(html, 'jobDetails');
      const jobsData = jobDetails && jobDetails.jobsData;
      if (!jobsData) throw new Error('detail hydration data not found (page shape changed?)');
      return normalizeItem(jobsData, { slug, companyName });
    } catch (e) {
      // Per-company failure isolation (12.4) is the CALLER's job for a whole
      // board going down; one bad posting detail inside an otherwise-healthy
      // board must not take the rest of the board down with it.
      console.error(`apple fetchJobs: detail fetch failed for "${item.reqId}":`, e.message || e);
      return null;
    }
  });

  return details.filter((j) => j && j.title && j.link);
}

// Contract-drift canary (18.3, §15 #44) — a known-good query, and the fields
// this adapter actually reads. `run()` returns the RAW extracted `search`
// object (not the normalized job list) so the canary is checking the same
// shape `fetchJobs`/`probe` themselves depend on.
const contractCheck = {
  name: platform,
  requiredFields: ['searchResults', 'totalRecords'],
  run: async () => {
    const html = await getHtmlCustom(searchUrl('engineer', 1));
    return extractLoaderData(html, 'search');
  },
};

module.exports = {
  platform,
  extractSlugFromUrl,
  probe,
  fetchJobs,
  normalizeItem,
  contractCheck,
  // Exposed for tests / the contract-check module's own verification.
  extractQuotedJsString,
  extractLoaderData,
};

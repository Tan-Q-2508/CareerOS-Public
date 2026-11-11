// Google Custom Adapter Tier adapter (spec 18.2, Phase 5.5 §15 #46).
//
// careers.google.com (served from google.com/about/careers/applications) is
// server-rendered — no XHR/JSON API (live discovery: paging/searching fires
// zero fetch requests, every interaction is a full page navigation, same
// posture as Apple). Its data arrives embedded as a Google Closure
// `AF_initDataCallback({key: 'ds:1', hash: '...', data: [...] , ...});` block
// in the page HTML — a POSITIONAL array with no field names at all, the most
// fragile shape of any adapter in this codebase: a field's identity is its
// array index, not a name, so a page redesign that reorders fields breaks
// this silently in a way none of the other JSON-shaped adapters can. This is
// exactly why the field map below lives in ONE place, fully documented, and
// why this adapter's contractCheck exists (18.3).
//
//   list:   GET https://www.google.com/about/careers/applications/jobs/results?q={query}&page={n}
//           -> the `ds:1` block's `data` is `[jobs[], null, total, pageSize]`
//   detail: none needed — full posting text (responsibilities, qualifications,
//           "about the job") is present in the LIST payload already, same
//           list-only posture as amazon.js.
//
// GOOGLE_JOB_FIELDS documents every index this adapter reads, confirmed live
// against a real result set (2026-08-27) — anything not listed here was
// either unclear or unused and deliberately left alone rather than guessed:
//   0  job id (string)
//   1  posting title
//   2  application/signin URL — the real, working "link" for this posting
//   3  [null, responsibilitiesHtml]
//   4  [null, qualificationsHtml] — MINIMUM + PREFERRED qualifications
//      combined; a near-duplicate, minimum-only subset also appears at index
//      19 and is deliberately NOT read (index 4 already carries everything
//      index 19 does, plus more)
//   5  tenant/company path (stable across postings — a platform identifier,
//      not a per-job field; not read, kept here only as a documented finding)
//   7  company display name (e.g. "Google") — not read; this platform is
//      never in detect.js's VERIFIES_BOARD_NAME (fixed-key identity, 18.2)
//   9  locations: [[displayName, [displayName], city, ?, region, countryCode], ...]
//   10 [null, aboutTheJobHtml] — the role's intro/summary text
//   12 [createdSeconds, createdNanos] — used as postedAt
//
// No board/company display name is READ (index 7 exists but this platform
// never verifies against it, same posture as Apple/Amazon).

const tunables = require('../../../tunables.json');
const { dedupKey } = require('../../dedup');
const { htmlToText } = require('../htmlToText');
const { getHtmlCustom, parseFixedIdentifier, fixedIdentifier } = require('./index');

const platform = 'google';

function cfg() {
  return tunables.atsDirect.platforms.google;
}

// Extracts the raw `data` array out of an AF_initDataCallback block matching
// `key: '{dsKey}'`, via a bracket-depth scan (never `eval`/`Function` — this
// is untrusted third-party page content, and the array's own contents are
// valid JSON once isolated, so a plain JSON.parse of just that slice is both
// safer and sufficient). Returns null on any decode failure (redesign) rather
// than throwing, same posture as apple.js's extractLoaderData.
function extractDsArray(html, dsKey) {
  const marker = `key: '${dsKey}'`;
  const mi = html.indexOf(marker);
  if (mi === -1) return null;
  const dataIdx = html.indexOf('data:[', mi);
  if (dataIdx === -1) return null;
  const start = dataIdx + 'data:'.length; // position of the '['
  let depth = 0;
  let i = start;
  let inStr = false;
  let strCh = null;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  try {
    return JSON.parse(html.slice(start, i));
  } catch {
    return null;
  }
}

// Wraps extractDsArray's raw `[jobs[], ..., total, pageSize]` shape into a
// named object — every caller below reads this, never the positional array
// directly, so the "which index means what" question has exactly one answer
// site (the field map in this module's header).
function extractSearchResults(html) {
  const data = extractDsArray(html, 'ds:1');
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  return {
    jobs: data[0],
    total: typeof data[2] === 'number' ? data[2] : null,
    pageSize: typeof data[3] === 'number' ? data[3] : null,
  };
}

function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const isCareersHost = /(^|\.)google\.com$/.test(host) && parsed.pathname.startsWith('/about/careers/applications');
  if (!isCareersHost) return null;
  return { platform, slug: fixedIdentifier(platform) };
}

function searchUrl(query, page) {
  const q = new URLSearchParams({ q: query || '', page: String(page) });
  return `https://www.google.com/about/careers/applications/jobs/results?${q.toString()}`;
}

// Cheap existence probe: one search page. `ok` iff `jobs` is a non-empty
// array. A malformed identifier short-circuits before any request.
async function probe(id) {
  const parsed = parseFixedIdentifier(platform, id);
  if (!parsed) return { ok: false, status: 0, boardName: null, error: 'malformed identifier' };
  try {
    const html = await getHtmlCustom(searchUrl('', 1));
    const results = extractSearchResults(html);
    if (!results) return { ok: false, status: 200, boardName: null, error: 'hydration data not found (page shape changed?)' };
    return { ok: results.jobs.length > 0, status: 200, boardName: null, error: null };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

function listItemMatchesTitle(item, title) {
  if (!title) return true;
  const t = item[1];
  return !!(t && t.toLowerCase().includes(title.toLowerCase().trim()));
}

function listItemMatchesAnyTitle(item, titles) {
  if (!titles || !titles.length) return true;
  return titles.some((t) => listItemMatchesTitle(item, t));
}

function formatLocation(locationsField) {
  if (!Array.isArray(locationsField) || !locationsField.length) return null;
  return locationsField.map((loc) => loc && loc[0]).filter(Boolean).join('; ') || null;
}

function toIso(pair) {
  if (!Array.isArray(pair) || typeof pair[0] !== 'number') return null;
  const d = new Date(pair[0] * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// See this module's header for the field-index map this reads.
function normalizeItem(item, { slug, companyName }) {
  const info = item || [];
  const id = info[0];
  const title = info[1] || null;
  const link = info[2] || null;
  const descriptionText = [info[10], info[3], info[4]]
    .map((pair) => (Array.isArray(pair) ? htmlToText(pair[1]) : null))
    .filter(Boolean)
    .join('\n\n');
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title,
    companyName: companyName || null,
    location: formatLocation(info[9]),
    postedAt: toIso(info[12]),
    link,
    descriptionText,
    seniorityLevel: null,
    employmentType: null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id, link, title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

/**
 * Pull open postings from careers.google.com, title-narrowed, normalized
 * into the 4.2 internal schema. List-only — see this module's header.
 *
 * @param {string} slug the fixed identifier "google" (custom/index.js)
 * @param {{companyName?: string, titles?: string[], limit?: number}} opts
 *   `titles`, when supplied, is passed ONE AT A TIME as Google's own
 *   server-side `q` query (same per-title-searchText posture as
 *   workday.js/apple.js/amazon.js) AND still applied as a local substring
 *   match against each posting's own title. No titles at all runs one
 *   unfiltered pass.
 */
async function fetchJobs(slug, { companyName, titles, limit } = {}) {
  const c = cfg();
  const parsed = parseFixedIdentifier(platform, slug);
  if (!parsed) throw new Error(`Google: malformed identifier "${slug}"`);

  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const realTitles = Array.isArray(titles) ? titles.filter(Boolean) : titles ? [titles] : [];
  const passes = realTitles.length ? realTitles : [''];

  const listedById = new Map();
  for (const searchTitle of passes) {
    if (listedById.size >= cap * 4) break;
    for (let page = 1; page <= c.maxListPages; page++) {
      const html = await getHtmlCustom(searchUrl(searchTitle, page));
      const results = extractSearchResults(html);
      const jobs = results ? results.jobs : [];
      for (const item of jobs) {
        const id = item[0];
        if (id && !listedById.has(id)) listedById.set(id, item);
      }
      const total = results ? results.total : null;
      const pageSize = (results && results.pageSize) || c.pageSize;
      if (!jobs.length) break;
      if (total != null && page * pageSize >= total) break;
      if (listedById.size >= cap * 4) break;
    }
  }

  const survivors = [...listedById.values()]
    .filter((item) => listItemMatchesAnyTitle(item, realTitles) && item[0])
    .slice(0, cap)
    .map((item) => normalizeItem(item, { slug, companyName }));

  return survivors.filter((j) => j && j.title && j.link);
}

// Contract-drift canary (18.3, §15 #44) — a known-good query, and the fields
// this adapter actually reads. `run()` returns the same named-object shape
// `extractSearchResults` produces (not the raw positional array) so a
// required-field name here means something legible, not a bare array index.
const contractCheck = {
  name: platform,
  requiredFields: ['jobs', 'total'],
  run: async () => {
    const html = await getHtmlCustom(searchUrl('engineer', 1));
    return extractSearchResults(html);
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
  extractDsArray,
  extractSearchResults,
};

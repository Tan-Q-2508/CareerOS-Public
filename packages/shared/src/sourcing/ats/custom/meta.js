// Meta Custom Adapter Tier adapter (spec 18.2, Phase 5.5 §15 #47). Sequenced
// last per §15's own reasoning — GraphQL-backed, and the persisted-query
// `doc_id` is the piece most likely to need near-term re-discovery after a
// frontend redesign.
//
// metacareers.com is a Relay/GraphQL app, not REST. Two real, separate
// mechanisms, discovered live (2026-08-27):
//   list:   POST https://www.metacareers.com/graphql
//           body: fb_api_req_friendly_name=CareersJobSearchResultsV2DataQuery,
//                 doc_id=DOC_ID_LIST (see below), lsd={token}, variables=JSON
//           -> { data: { job_search_with_featured_jobs_v2: { all_jobs: [...] } } }
//   detail: GET https://www.metacareers.com/jobs/{id}/
//           -> a schema.org JobPosting embedded as <script type="application/
//              ld+json"> in the page HTML — description, responsibilities,
//              qualifications, employmentType, datePosted, jobLocation[], all
//              plain server-rendered structured data, no GraphQL/doc_id
//              needed for this half at all.
//
// **DOC_ID rotation risk — read before assuming a stale value is a code bug.**
// `DOC_ID_LIST` is a Relay persisted-query id extracted from Meta's own
// compiled JS bundle (grep for the string
// "CareersJobSearchResultsV2DataQuery_candidate_portalRelayOperation" in the
// bundle referenced from the /jobsearch/ page's <script src> tags — it
// resolves to a bare numeric string via `a.exports="..."`). Persisted-query
// ids rotate on a frontend redesign far more readily than a REST path would
// — if `probe()`/`fetchJobs()` start failing with a GraphQL error (not a
// clean miss), re-run that same bundle-grep first before assuming anything
// else broke.
//
// **Three non-obvious requirements found live, not documented anywhere
// public, all necessary for the POST to succeed (a plain doc_id+variables
// POST 400s without them):**
//   1. `X-ASBD-ID: 129477` header — an undocumented Meta-internal anti-abuse
//      header. Omitting it alone is enough to 400 with a generic HTML error
//      page (not a GraphQL error), which reads exactly like a WAF rejection,
//      not a malformed-request response — confirmed by testing the correct
//      variables shape both with and without this header.
//   2. An `lsd` CSRF token, scraped from a normal GET of a search-results
//      page (`"LSD",[],{"token":"..."}` embedded in the HTML), sent BOTH as
//      a `lsd` form field and an `X-FB-LSD` header.
//   3. `Sec-Fetch-Site: same-origin` / `Sec-Fetch-Mode: cors` /
//      `Sec-Fetch-Dest: empty` plus a matching `Referer`/`Origin` — a normal
//      browser sends these automatically; a bare server-side POST does not.
// None of this is a bypass of any bot/CAPTCHA CHALLENGE (14) — it's simply
// replicating the ordinary headers a real page's own fetch call already
// sends, the same posture as every other adapter in this codebase.
//
// **The `/jobsearch/` page ALSO serves `content-encoding: zstd`** — same
// class of bug as Amazon's (custom/index.js's header) — this module fetches
// with `Accept-Encoding: identity` throughout for the same reason, since it
// cannot route through custom/index.js's shared helpers (they're GET-only;
// this adapter needs POST + cookies + custom headers).
//
// `results_per_page` in the list query's variables MUST be `null` — passing
// an integer 400s with a GraphQL `noncoercible_variable_value` error
// (confirmed live). Left `null`, the endpoint returns the WHOLE matching
// result set in one response (874 postings for an empty query against
// Meta's real board) — a single-request-whole-board shape like Lever/Ashby,
// not a paginated one; this adapter caps locally after receiving the full
// list, same as those two.
//
// List results carry NO description (`id`, `title`, `locations[]`, `teams[]`,
// `sub_teams[]` only) — full text needs the per-posting detail fetch, same
// list-then-detail shape as Workday/Oracle/Eightfold/Phenom.

const tunables = require('../../../tunables.json');
const { requestTimeoutMs } = require('../scanContext');
const { dedupKey } = require('../../dedup');
const { htmlToText } = require('../htmlToText');
const { UA, readBodyJson, readBodyText } = require('../httpClient');
const { agent: defaultDispatcher } = require('../dispatcher');
const { parseFixedIdentifier, fixedIdentifier } = require('./index');

const platform = 'meta';

// Persisted-query ids — see this module's header for how to re-derive these
// after a frontend redesign invalidates them.
const DOC_ID_JOB_COUNT = '26210170368675892'; // CareersJobSearchHideFiltersBarV2Query — probe() only
const DOC_ID_LIST = '27129360303422352'; // CareersJobSearchResultsV2DataQuery

function cfg() {
  return tunables.atsDirect.platforms.meta;
}

function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  if (!/(^|\.)metacareers\.com$/.test(parsed.hostname.toLowerCase())) return null;
  return { platform, slug: fixedIdentifier(platform) };
}

// Scrapes a fresh `lsd` CSRF token plus the session cookies Meta's own
// frontend would be carrying, from a normal GET of a search page. One of
// these is fetched per outer probe()/fetchJobs() call and reused for every
// GraphQL POST that call makes — no cross-call session state is kept,
// consistent with every other adapter here being stateless between calls.
async function fetchSession({ dispatcher = defaultDispatcher } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs());
  try {
    const resp = await fetch('https://www.metacareers.com/jobsearch/?q=', {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: controller.signal,
      dispatcher,
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${resp.status} from metacareers.com session fetch`);
      err.status = resp.status;
      throw err;
    }
    const html = await readBodyText(resp);
    const lsd = (html.match(/"LSD",\[\],\{"token":"([^"]+)"/) || [])[1] || null;
    const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    if (!lsd) throw new Error('metacareers.com session fetch: lsd token not found (page shape changed?)');
    return { lsd, cookie };
  } finally {
    clearTimeout(timer);
  }
}

// POSTs one GraphQL persisted-query request with every header found live to
// be required (see this module's header). Throws on a non-2xx OR a GraphQL
// `errors` envelope, so the caller's per-company failure isolation (12.4)
// sees a real failure either way.
async function graphqlPost({ friendlyName, docId, variables, session, dispatcher = defaultDispatcher }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs());
  try {
    const body = new URLSearchParams({
      fb_api_req_friendly_name: friendlyName,
      variables: JSON.stringify(variables),
      doc_id: docId,
      lsd: session.lsd,
    });
    const resp = await fetch('https://www.metacareers.com/graphql', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        'X-FB-Friendly-Name': friendlyName,
        'X-FB-LSD': session.lsd,
        'X-ASBD-ID': '129477',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        Referer: 'https://www.metacareers.com/jobsearch/?q=',
        Origin: 'https://www.metacareers.com',
        Cookie: session.cookie,
      },
      body: body.toString(),
      signal: controller.signal,
      dispatcher,
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${resp.status} from metacareers.com/graphql (${friendlyName})`);
      err.status = resp.status;
      throw err;
    }
    const json = await readBodyJson(resp);
    if (json.errors) {
      throw new Error(`metacareers.com/graphql (${friendlyName}) returned errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
    }
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

function searchInput(query) {
  return {
    q: query || '',
    divisions: [],
    offices: [],
    roles: [],
    leadership_levels: [],
    saved_jobs: [],
    saved_searches: [],
    sub_teams: [],
    teams: [],
    is_leadership: false,
    is_remote_only: false,
    page: 1,
    results_per_page: null, // MUST stay null — see this module's header
    sort_by_new: false,
  };
}

// Cheap existence probe: the job_count-only query, not the full results
// list. `ok` iff job_count > 0. A malformed identifier short-circuits before
// any request.
async function probe(id, { dispatcher } = {}) {
  const parsed = parseFixedIdentifier(platform, id);
  if (!parsed) return { ok: false, status: 0, boardName: null, error: 'malformed identifier' };
  try {
    const session = await fetchSession({ dispatcher });
    const data = await graphqlPost({
      friendlyName: 'CareersJobSearchHideFiltersBarV2Query',
      docId: DOC_ID_JOB_COUNT,
      variables: { search_input: searchInput('') },
      session,
      dispatcher,
    });
    const count = data?.job_search_with_featured_jobs_v2?.job_count;
    return { ok: typeof count === 'number' && count > 0, status: 200, boardName: null, error: null };
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
  return !!(item.title && item.title.toLowerCase().includes(title.toLowerCase().trim()));
}

function listItemMatchesAnyTitle(item, titles) {
  if (!titles || !titles.length) return true;
  return titles.some((t) => listItemMatchesTitle(item, t));
}

function jobUrl(id) {
  return `https://www.metacareers.com/jobs/${encodeURIComponent(id)}/`;
}

// Fetches one posting's detail page and pulls the embedded schema.org
// JobPosting JSON-LD block out of the HTML — no GraphQL call needed for this
// half (see this module's header).
async function fetchDetail(id, { dispatcher = defaultDispatcher } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs());
  try {
    const resp = await fetch(jobUrl(id), {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: controller.signal,
      dispatcher,
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${resp.status} from ${jobUrl(id)}`);
      err.status = resp.status;
      throw err;
    }
    const html = await readBodyText(resp);
    const marker = 'application/ld+json';
    const mi = html.indexOf(marker);
    if (mi === -1) return null;
    const gt = html.indexOf('>', mi) + 1;
    const end = html.indexOf('</script>', gt);
    if (gt <= 0 || end === -1) return null;
    try {
      return JSON.parse(html.slice(gt, end));
    } catch {
      return null;
    }
  } finally {
    clearTimeout(timer);
  }
}

function normalizeItem(detail, listItem, { slug, companyName }) {
  const d = detail || {};
  const link = jobUrl(listItem.id);
  const descriptionText = [d.description, d.responsibilities, d.qualifications]
    .map((t) => htmlToText(t))
    .filter(Boolean)
    .join('\n\n');
  const locations = Array.isArray(d.jobLocation) ? d.jobLocation.map((l) => l.name).filter(Boolean) : listItem.locations;
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: listItem.title || d.title || null,
    // Neither payload carries a useful company display name (the detail
    // page's hiringOrganization is always literally "Meta") — from the
    // caller, same posture as every other adapter here.
    companyName: companyName || null,
    location: Array.isArray(locations) && locations.length ? locations.join('; ') : null,
    postedAt: d.datePosted || null,
    link,
    descriptionText,
    seniorityLevel: null,
    employmentType: d.employmentType || null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id: listItem.id, link, title: listItem.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

/**
 * Pull open postings from metacareers.com, title-narrowed and detail-
 * enriched, normalized into the 4.2 internal schema.
 *
 * @param {string} slug the fixed identifier "meta" (custom/index.js)
 * @param {{companyName?: string, titles?: string[], limit?: number, dispatcher?: *}} opts
 *   `titles`, when supplied, is passed ONE AT A TIME as Meta's own
 *   server-side `q` (same per-title-searchText posture as workday.js/
 *   apple.js/amazon.js/google.js) AND still applied as a local substring
 *   match against each item's own title. No titles at all runs one
 *   unfiltered pass — the WHOLE current board (874 postings live), so a
 *   caller always supplying titles (the normal scan path) is materially
 *   cheaper than the no-titles case here more than on any other adapter.
 */
async function fetchJobs(slug, { companyName, titles, limit, dispatcher } = {}) {
  const c = cfg();
  const parsed = parseFixedIdentifier(platform, slug);
  if (!parsed) throw new Error(`Meta: malformed identifier "${slug}"`);

  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const realTitles = Array.isArray(titles) ? titles.filter(Boolean) : titles ? [titles] : [];
  const passes = realTitles.length ? realTitles : [''];

  const session = await fetchSession({ dispatcher });
  const listedById = new Map();
  for (const searchTitle of passes) {
    if (listedById.size >= cap * 4) break;
    const data = await graphqlPost({
      friendlyName: 'CareersJobSearchResultsV2DataQuery',
      docId: DOC_ID_LIST,
      variables: { search_input: searchInput(searchTitle), isLoggedIn: false },
      session,
      dispatcher,
    });
    const jobs = Array.isArray(data?.job_search_with_featured_jobs_v2?.all_jobs) ? data.job_search_with_featured_jobs_v2.all_jobs : [];
    for (const item of jobs) {
      if (item.id && !listedById.has(item.id)) listedById.set(item.id, item);
    }
  }

  const survivors = [...listedById.values()]
    .filter((item) => listItemMatchesAnyTitle(item, realTitles) && item.id)
    .slice(0, cap);

  const details = await pooled(survivors, c.detailConcurrency, async (item) => {
    try {
      const detail = await fetchDetail(item.id, { dispatcher });
      return normalizeItem(detail, item, { slug, companyName });
    } catch (e) {
      // Per-company failure isolation (12.4) is the CALLER's job for a whole
      // board going down; one bad posting detail inside an otherwise-healthy
      // board must not take the rest of the board down with it.
      console.error(`meta fetchJobs: detail fetch failed for id "${item.id}":`, e.message || e);
      return null;
    }
  });

  return details.filter((j) => j && j.title && j.link);
}

// Contract-drift canary (18.3, §15 #44) — a known-good query, and the fields
// this adapter actually reads. Checks the LIST query's shape (the piece most
// likely to break first per this module's header on doc_id rotation risk),
// not the detail page's JSON-LD.
const contractCheck = {
  name: platform,
  requiredFields: ['all_jobs'],
  run: async () => {
    const session = await fetchSession();
    const data = await graphqlPost({
      friendlyName: 'CareersJobSearchResultsV2DataQuery',
      docId: DOC_ID_LIST,
      variables: { search_input: searchInput('engineer'), isLoggedIn: false },
      session,
    });
    return data?.job_search_with_featured_jobs_v2;
  },
};

module.exports = { platform, extractSlugFromUrl, probe, fetchJobs, normalizeItem, contractCheck };

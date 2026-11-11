// Workday adapter — ATS Direct Tier 2 (spec 4.6.1). Phase 4, §15 #27.
//
// Its own dedicated POST/pagination parser — deliberately NOT sharing Tier 1's
// GET-based httpClient shape (4.6.1 is explicit that this is the wrong move).
//
// Endpoints verified live 2026-08-10 against a real tenant (23andme/wd5/23):
//   list:   POST https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
//           body {appliedFacets:{}, limit, offset, searchText} -> { total, jobPostings:[...] }
//   detail: GET  https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath}
//           -> { jobPostingInfo: {...} }
// Three things that matter and are easy to get wrong:
//   * `limit` caps at 20 server-side — limit:50 returns HTTP 400. Pagination is
//     by `offset`, not a cursor.
//   * The list response carries NO description and its only date field
//     (`postedOn`) is a relative string ("Posted 6 Days Ago") — worthless as a
//     real date. The real date (`startDate`, a real ISO-ish date string) and
//     the description (`jobDescription`, HTML) only exist on the per-posting
//     detail call, keyed by `externalPath` from the list item.
//   * `searchText` genuinely filters server-side, but broader than a title
//     match (it also matches description body text) — it narrows the detail-
//     fetch fan-out, it does not replace the caller's own title filter.
// A bogus site 404s; a bogus tenant 422s — both read as "not found" here.

const tunables = require('../../tunables.json');
const { requestTimeoutMs, inScan, paceHost } = require('./scanContext');
const { withRetry } = require('./retry');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { UA, readBodyJson } = require('./httpClient');
const { agent: defaultDispatcher } = require('./dispatcher');

const platform = 'workday';

function cfg() {
  return tunables.atsDirect.platforms.workday;
}

// slug_or_identifier is a composite "{tenant}:{wd}:{site}" — colon-delimited,
// since none of the three real-world components can contain a colon, and it
// keeps the registry's single-text-column schema (4.6.5) intact rather than
// needing a schema change just for this one platform.
function buildIdentifier({ tenant, wd, site }) {
  return `${tenant}:${wd}:${site}`;
}

function parseIdentifier(id) {
  if (!id) return null;
  const parts = String(id).split(':');
  if (parts.length !== 3) return null;
  const [tenant, wd, site] = parts;
  if (!tenant || !wd || !site) return null;
  return { tenant, wd, site };
}

function tenantBase({ tenant, wd, site }) {
  return `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
}

// Recognizes both the canonical browser URL (tenant.wd5.myworkdayjobs.com/site)
// and the API form (.../wday/cxs/{tenant}/{site}/...). Either way the `wd`
// component only ever appears in the hostname, never the path, so it's read
// from there regardless of which form matched.
function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const hostMatch = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (!hostMatch) return null;
  const [, tenant, wd] = hostMatch;

  const parts = parsed.pathname.split('/').filter(Boolean);
  const cxsIdx = parts.indexOf('cxs');
  // API form: /wday/cxs/{tenant}/{site}/... — site is the segment right after
  // the tenant that repeats the hostname's tenant.
  const site = cxsIdx >= 0 && parts[cxsIdx + 1] === tenant ? parts[cxsIdx + 2] : parts[0];
  return site ? { platform, slug: buildIdentifier({ tenant, wd, site }) } : { platform, slug: null };
}

// Inside a scan every Workday request is paced per tenant host and retried
// on its own — a scan is up to 25 list pages per title, and ONE failed page
// used to fail the whole company. Probes stay one-shot.
function scanRetry(url, fn) {
  if (!inScan()) return fn();
  return withRetry(async () => {
    await paceHost(url, platform);
    return fn();
  }, { attempts: tunables.atsDirect.scan.pageAttempts });
}

function postJson(url, body, opts = {}) {
  return scanRetry(url, () => postJsonOnce(url, body, opts));
}

function getJsonWd(url, opts = {}) {
  return scanRetry(url, () => getJsonWdOnce(url, opts));
}

// Node's fetch sends `Accept-Language: *` unless told otherwise, and Workday
// tenants with localized career sites answer that with a 500 — GEICO, Nordstrom,
// Wawa, Truist, Regions and ~40 others probed 500 on every request with it and
// 200 with a real language tag. Other tenants (23andMe) accept either, which is
// why this stayed invisible: the failure looked like a dead site, not a header.
const HEADERS = { Accept: 'application/json', 'Accept-Language': 'en-US', 'User-Agent': UA };

async function postJsonOnce(url, body, { ms, dispatcher = defaultDispatcher } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || requestTimeoutMs());
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify(body),
      signal: controller.signal,
      dispatcher,
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${resp.status} from ${url}`);
      err.status = resp.status;
      err.retryAfter = resp.headers.get('retry-after');
      throw err;
    }
    return await readBodyJson(resp);
  } finally {
    clearTimeout(timer);
  }
}

async function getJsonWdOnce(url, { ms, dispatcher = defaultDispatcher } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || requestTimeoutMs());
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: controller.signal, dispatcher });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${resp.status} from ${url}`);
      err.status = resp.status;
      err.retryAfter = resp.headers.get('retry-after');
      throw err;
    }
    return await readBodyJson(resp);
  } finally {
    clearTimeout(timer);
  }
}

// Cheap existence probe: one list call, limit:1. Workday exposes no board
// display name at any endpoint, so boardName is always null (unlike
// Greenhouse) — a Workday guess can never be verified this way, which is
// exactly why detect.js never runs Workday through name-guess mode at all.
async function probe(id, { dispatcher } = {}) {
  const parsed = parseIdentifier(id);
  if (!parsed) return { ok: false, status: 0, boardName: null, error: 'malformed identifier' };
  try {
    const body = await postJson(`${tenantBase(parsed)}/jobs`, { appliedFacets: {}, limit: 1, offset: 0, searchText: '' }, { dispatcher });
    return { ok: !!(body && Array.isArray(body.jobPostings)), status: 200, boardName: null, error: null };
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

// Multi-title scans (4.6.15) — true if the item matches ANY of the given
// titles, or if the list is empty (no title filter at all, same posture as
// listItemMatchesTitle's own no-title case).
function listItemMatchesAnyTitle(item, titles) {
  if (!titles || !titles.length) return true;
  return titles.some((t) => listItemMatchesTitle(item, t));
}

function normalizeItem(detail, { id, slug, companyName }) {
  const info = (detail && detail.jobPostingInfo) || {};
  const link = info.externalUrl || null;
  const jobReqId = info.jobReqId != null ? String(info.jobReqId) : null;
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: info.title || null,
    // Workday's payload carries no company name anywhere — from the caller,
    // same posture as Lever/Ashby.
    companyName: companyName || null,
    location: (info.jobRequisitionLocation && info.jobRequisitionLocation.descriptor) || info.location || null,
    // startDate is a real date; postedOn ("Posted 6 Days Ago") is a relative
    // string and must never be parsed as one.
    postedAt: toIso(info.startDate),
    link,
    descriptionText: htmlToText(info.jobDescription),
    seniorityLevel: null,
    employmentType: info.timeType || null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id: jobReqId || id, link, title: info.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pull every open posting for a Workday site, title-narrowed and detail-
 * enriched, normalized into the 4.2 internal schema.
 *
 * @param {string} slug composite "{tenant}:{wd}:{site}" identifier
 * @param {{companyName?: string, titles?: string[], limit?: number, keep?: (job: object) => boolean, dispatcher?: *}} opts
 *   `titles`, when supplied, is passed ONE AT A TIME as Workday's own
 *   server-side `searchText` (4.6.15: a real narrowing pre-pass per title,
 *   cutting the detail-fetch fan-out, cheaper than dropping searchText to ''
 *   and paginating the tenant's whole board) AND still applied as a local
 *   substring any-match against each item's own title — the caller's title
 *   filter is never replaced, only pre-narrowed, since searchText also
 *   matches description body text. `keep`, unlike the Tier 1/Workable
 *   adapters, is NOT applied here — location/postedAt only exist after the
 *   per-posting detail fetch below, and atsDirectAdapter.js's own outer
 *   filter already covers this platform (see its sourceCompanyJobs
 *   docstring, 4.6.13).
 */
async function fetchJobs(slug, { companyName, titles, limit, dispatcher } = {}) {
  const c = cfg();
  const parsed = parseIdentifier(slug);
  if (!parsed) throw new Error(`Workday: malformed identifier "${slug}"`);
  const base = tenantBase(parsed);

  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const pageSize = c.pageSize;
  const realTitles = Array.isArray(titles) ? titles.filter(Boolean) : titles ? [titles] : [];
  // Multi-title (4.6.15): searchText takes one string at a time, so run the
  // list-pagination pass once per title and dedupe the accumulated results
  // by externalPath. No titles at all -> one unfiltered pass, same as before
  // this change.
  const passes = realTitles.length ? realTitles : [''];
  const listedByPath = new Map();
  for (const searchTitle of passes) {
    if (listedByPath.size >= cap) break;
    let offset = 0;
    for (let page = 0; page < c.maxListPages; page++) {
      const body = await postJson(`${base}/jobs`, {
        appliedFacets: {},
        limit: pageSize,
        offset,
        searchText: searchTitle,
      }, { dispatcher });
      const postings = (body && body.jobPostings) || [];
      for (const p of postings) {
        if (p.externalPath && !listedByPath.has(p.externalPath)) listedByPath.set(p.externalPath, p);
      }
      const total = typeof body?.total === 'number' ? body.total : null;
      offset += pageSize;
      if (!postings.length) break;
      if (total != null && offset >= total) break;
      if (listedByPath.size >= cap) break;
    }
  }

  const survivors = [...listedByPath.values()]
    .filter((item) => listItemMatchesAnyTitle(item, realTitles) && item.externalPath)
    .slice(0, cap);

  const details = await pooled(survivors, c.detailConcurrency, async (item) => {
    try {
      const detail = await getJsonWd(`${base}${item.externalPath}`, { dispatcher });
      return normalizeItem(detail, { id: item.externalPath, slug, companyName });
    } catch (e) {
      // Per-company failure isolation (12.4) is the CALLER's job for a whole
      // board going down; one bad posting detail inside an otherwise-healthy
      // board must not take the rest of the board down with it.
      console.error(`workday fetchJobs: detail fetch failed for "${item.externalPath}":`, e.message || e);
      return null;
    }
  });

  return details.filter((j) => j && j.title && j.link);
}

// --- Contract-drift canary (18.3) -----------------------------------------
//
// Enrolled late: §15 #44 built the canary for the Custom Adapter Tier and
// §15 #52 widened it to Tier 2.5, leaving Tier 1 and Tier 2 — the platforms
// that source the most jobs — with no drift detection at all.
//
// Unlike the Tier 2.5 checks, which assert on the RAW payload, this one runs
// the adapter's own fetchJobs and asserts on the NORMALIZED job. These
// endpoints are documented and stable; the likelier failure is a field
// quietly changing meaning underneath normalizeItem, which a raw-shape check
// would not see. Only fields that must never be null are required —
// seniorityLevel/salary are legitimately absent here and are not asserted.
//
// FALSE-POSITIVE NOTE: a real board with zero open roles reports as drift
// (every field missing at once, with the probe still ok). That shape means
// "pick a new canary board", not "the adapter broke" — the same exposure
// every other adapter's canary carries.
const CONTRACT_CHECK_SLUG = "23andme:wd5:23"; // the tenant this adapter was built against

const contractCheck = {
  name: platform,  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt'],
  run: async () => {
    // Workday is the one platform where description and real date exist ONLY
    // on the per-posting detail call — asserting them here is what proves the
    // two-step list-then-detail contract still holds, not just the list.
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: '23andMe', limit: 1 });
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

module.exports = { platform, buildIdentifier, parseIdentifier, extractSlugFromUrl, probe, fetchJobs, normalizeItem, contractCheck };

// Phenom People adapter — ATS Direct Tier 2.5 (spec 18.1/18.2). Phase 5.5,
// §15 #46.
//
// A real, multi-tenant vendor platform, not a Custom Adapter Tier one-off —
// same shape as Eightfold/Oracle/Avature, so it lives here (`ats/phenom.js`),
// not under `ats/custom/`. Discovered live building Session 44's Custom
// Adapter Tier scaffolding: Microsoft's career site
// (`jobs.careers.microsoft.com`, §18.2's original URL) now REDIRECTS to
// `apply.careers.microsoft.com`, which turns out to run Phenom People — an
// undocumented but clean, unauthenticated JSON API:
//   list:   GET https://{host}/api/pcsx/search?domain={domain}&query={q}&location=&start={n}&num={n}
//           -> { data: { positions: [...], count } }
//   detail: GET https://{host}/api/pcsx/position_details?position_id={id}&domain={domain}&hl=en
//           -> { data: { jobDescription (HTML), publicUrl, efcustomTextEmploymentType, ... } }
// Both confirmed live and reachable from a plain Node fetch. `domain` is
// REQUIRED here (unlike Eightfold, where it turned out to be optional) —
// confirmed live: omitting it 400s.
//
// Identifier is "{host}:{domain}" — same composite shape and parse/build
// functions as eightfold.js, since this platform has the same two-part
// identity (a per-tenant API host plus a domain qualifier). No board/company
// display name anywhere in either payload, so this platform is never in
// detect.js's VERIFIES_BOARD_NAME, and — like every composite-identifier
// platform (Workday/Oracle/Eightfold/Avature) — never joins the name-guess
// sweep (NAME_GUESS_EXCLUDED): a Phenom identifier isn't derivable from a
// company's display name.

const tunables = require('../../tunables.json');
const { requestTimeoutMs, inScan, paceHost } = require('./scanContext');
const { withRetry } = require('./retry');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { UA, readBodyJson } = require('./httpClient');
const { agent: defaultDispatcher } = require('./dispatcher');

const platform = 'phenom';

function cfg() {
  return tunables.atsDirect.platforms.phenom;
}

// slug_or_identifier is "{host}:{domain}" — both parts required (see this
// module's header: unlike Eightfold, `domain` is not optional here).
function parseIdentifier(id) {
  if (!id) return null;
  const s = String(id);
  const idx = s.indexOf(':');
  if (idx === -1) return null;
  const host = s.slice(0, idx);
  const domain = s.slice(idx + 1);
  return host && domain ? { host, domain } : null;
}

function buildIdentifier({ host, domain }) {
  return `${host}:${domain}`;
}

// Matches any host whose path/query shape looks like Phenom's own
// (`/careers/job/{id}` job pages, or the `/api/pcsx/...` API itself) AND
// carries a `domain` query param — this platform has no shared hostname
// convention the way Eightfold's `.eightfold.ai` suffix does, so there is
// nothing to match on except the URL shape plus the required domain, and
// this is only ever a CANDIDATE: detect.js always follows a URL match with a
// real probe() before accepting it (same discipline as every other adapter).
function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const domain = parsed.searchParams.get('domain');
  if (!domain) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const isJobPageShape = parts[0] === 'careers' && parts[1] === 'job' && /^\d+$/.test(parts[2] || '');
  const isApiShape = parts[0] === 'api' && parts[1] === 'pcsx';
  if (!isJobPageShape && !isApiShape) return null;
  return { platform, slug: buildIdentifier({ host, domain }) };
}

// Inside a scan: spaced per host and retried per page (with the server's own
// Retry-After) — Microsoft's tenant 429'd a scan at page 8 of an unspaced
// pagination run, which used to fail the whole company. Probes stay one-shot.
async function getJsonPhenom(url, opts = {}) {
  if (!inScan()) return getJsonPhenomOnce(url, opts);
  return withRetry(async () => {
    await paceHost(url, platform);
    return getJsonPhenomOnce(url, opts);
  }, { attempts: tunables.atsDirect.scan.pageAttempts });
}

async function getJsonPhenomOnce(url, { dispatcher = defaultDispatcher } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs());
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: controller.signal, dispatcher });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${resp.status} from ${url}`);
      err.status = resp.status;
      // This tenant (apply.careers.microsoft.com) really does throttle — an
      // isolated 429 here is rate limiting, not contract drift (18.3). Carrying
      // the header lets the canary's retry honour the server's own wait
      // instead of guessing at a backoff.
      err.retryAfter = resp.headers.get('retry-after');
      throw err;
    }
    return await readBodyJson(resp);
  } finally {
    clearTimeout(timer);
  }
}

function listUrl({ host, domain }, { query, start, num }) {
  const q = new URLSearchParams({ domain, query: query || '', location: '', start: String(start), num: String(num) });
  return `https://${host}/api/pcsx/search?${q.toString()}`;
}

function detailUrl({ host, domain }, id) {
  const q = new URLSearchParams({ position_id: String(id), domain, hl: 'en' });
  return `https://${host}/api/pcsx/position_details?${q.toString()}`;
}

// Cheap existence probe: one list call, num:1. `ok` iff `positions` is a
// non-empty array; a bogus host fails at DNS resolution before any status is
// seen; a missing/wrong `domain` 400s cleanly.
async function probe(id, { dispatcher } = {}) {
  const parsed = parseIdentifier(id);
  if (!parsed) return { ok: false, status: 0, boardName: null, error: 'malformed identifier' };
  try {
    const body = await getJsonPhenom(listUrl(parsed, { start: 0, num: 1 }), { dispatcher });
    const positions = Array.isArray(body?.data?.positions) ? body.data.positions : [];
    return { ok: positions.length > 0, status: 200, boardName: null, error: null };
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
  return !!(item.name && item.name.toLowerCase().includes(title.toLowerCase().trim()));
}

function listItemMatchesAnyTitle(item, titles) {
  if (!titles || !titles.length) return true;
  return titles.some((t) => listItemMatchesTitle(item, t));
}

function toIsoFromUnixSeconds(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeItem(detail, { id, slug, companyName }) {
  const info = detail || {};
  const employmentType = Array.isArray(info.efcustomTextEmploymentType)
    ? info.efcustomTextEmploymentType.join(', ')
    : info.efcustomTextEmploymentType || null;
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: info.name || null,
    // No company display name anywhere in the payload — from the caller,
    // same posture as every other adapter here.
    companyName: companyName || null,
    location: info.location || (Array.isArray(info.locations) ? info.locations.join(', ') : null) || null,
    postedAt: toIsoFromUnixSeconds(info.postedTs || info.creationTs),
    link: info.publicUrl || null,
    descriptionText: htmlToText(info.jobDescription),
    seniorityLevel: null,
    employmentType,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id, link: info.publicUrl || null, title: info.name, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

/**
 * Pull every open posting for a Phenom People career site, title-narrowed
 * and detail-enriched, normalized into the 4.2 internal schema.
 *
 * @param {string} slug composite "{host}:{domain}" identifier
 * @param {{companyName?: string, titles?: string[], limit?: number, dispatcher?: *}} opts
 *   `titles`, when supplied, is passed ONE AT A TIME as Phenom's own
 *   server-side `query` (confirmed live to genuinely narrow results — same
 *   per-title-searchText posture as workday.js/eightfold.js's sibling
 *   platforms) AND still applied as a local substring match against each
 *   item's own `name`. `keep` is NOT applied here — full description only
 *   exists after the per-posting detail fetch below, same reasoning as
 *   eightfold.js.
 */
async function fetchJobs(slug, { companyName, titles, limit, dispatcher } = {}) {
  const c = cfg();
  const parsed = parseIdentifier(slug);
  if (!parsed) throw new Error(`Phenom: malformed identifier "${slug}"`);

  // Every list page and every detail is a request to ONE host, and the only
  // live tenant (Microsoft) sustains ~1 request/second before 429ing — so the
  // fan-out is capped by what the scan can use: paging stops once `cap`
  // title-matched postings are listed, and at most maxDetails get a detail
  // fetch. The old stop (4× cap listed, up to 200 details) meant ~225
  // requests for one company and a 429 every scan.
  const cap = Math.min(limit || tunables.atsDirect.fetchLimitDefault, c.maxDetails || Infinity);
  const pageSize = c.pageSize;
  const realTitles = Array.isArray(titles) ? titles.filter(Boolean) : titles ? [titles] : [];
  const passes = realTitles.length ? realTitles : [''];

  const listedById = new Map();
  let matchedCount = 0;
  for (const searchTitle of passes) {
    if (matchedCount >= cap) break;
    let start = 0;
    for (let page = 0; page < c.maxListPages; page++) {
      const body = await getJsonPhenom(listUrl(parsed, { query: searchTitle, start, num: pageSize }), { dispatcher });
      const positions = Array.isArray(body?.data?.positions) ? body.data.positions : [];
      for (const p of positions) {
        if (p.id != null && !listedById.has(p.id)) {
          listedById.set(p.id, p);
          if (listItemMatchesAnyTitle(p, realTitles)) matchedCount += 1;
        }
      }
      const total = typeof body?.data?.count === 'number' ? body.data.count : null;
      start += pageSize;
      if (!positions.length) break;
      if (total != null && start >= total) break;
      if (matchedCount >= cap) break;
    }
  }

  const survivors = [...listedById.values()]
    .filter((item) => listItemMatchesAnyTitle(item, realTitles) && item.id != null)
    .slice(0, cap);

  const details = await pooled(survivors, c.detailConcurrency, async (item) => {
    try {
      const body = await getJsonPhenom(detailUrl(parsed, item.id), { dispatcher });
      return normalizeItem(body?.data, { id: item.id, slug, companyName });
    } catch (e) {
      // Per-company failure isolation (12.4) is the CALLER's job for a whole
      // board going down; one bad posting detail inside an otherwise-healthy
      // board must not take the rest of the board down with it.
      console.error(`phenom fetchJobs: detail fetch failed for id "${item.id}":`, e.message || e);
      return null;
    }
  });

  return details.filter((j) => j && j.title && j.link);
}

// Contract-drift canary (18.3, §15 #44). See oracle.js's check for why this
// covers the detail call as well as the list call, and why `firstDescription`
// is normalized to null when empty rather than passed through as ''.
const CONTRACT_CHECK_SLUG = 'apply.careers.microsoft.com:microsoft.com'; // the registry's real Phenom tenant
const contractCheck = {
  name: platform,
  requiredFields: ['positions', 'count', 'firstId', 'firstName', 'firstDescription', 'firstPublicUrl'],
  run: async () => {
    const parsed = parseIdentifier(CONTRACT_CHECK_SLUG);
    const body = await getJsonPhenom(listUrl(parsed, { start: 0, num: 1 }));
    const positions = Array.isArray(body?.data?.positions) ? body.data.positions : null;
    const first = positions?.[0] || {};
    const detailBody = first.id != null ? await getJsonPhenom(detailUrl(parsed, first.id)) : {};
    const info = detailBody?.data || {};
    return {
      positions,
      count: typeof body?.data?.count === 'number' ? body.data.count : null,
      firstId: first.id != null ? first.id : null,
      firstName: info.name || null,
      firstDescription: info.jobDescription || null,
      firstPublicUrl: info.publicUrl || null,
    };
  },
};

module.exports = { platform, buildIdentifier, parseIdentifier, extractSlugFromUrl, probe, fetchJobs, normalizeItem, contractCheck };

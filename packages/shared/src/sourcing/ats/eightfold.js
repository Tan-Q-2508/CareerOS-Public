// Eightfold AI adapter — ATS Direct Tier 2.5 (spec 18.1). Phase 5.5, §15 #43.
//
// §18.1 gated this platform on a build-time feasibility spike; the spike
// passed. Live-confirmed 2026-08-26 against a real tenant (Netflix,
// `explore.jobs.netflix.net`):
//   list:   GET https://{host}/api/apply/v2/jobs?start={n}&num={n}
//           -> { positions: [...], count }
//   detail: GET https://{host}/api/apply/v2/jobs/{id}
//           -> { id, name, location, job_description (HTML), t_create, ... }
// Both unauthenticated, no `domain` query param required — see below.
//
// Two things that matter and are easy to get wrong:
//   * A `domain` query param (e.g. `?domain=netflix.com`) appears on Eightfold's
//     OWN frontend requests, and the spec's original framing treated the API
//     host + domain as a composite the way Workday/Oracle's tenant+datacenter
//     are. Live testing found this is NOT required: omitting `domain`
//     entirely returns HTTP 200 with the identical result set (`count: 506`
//     either way) — the API host alone resolves a default domain server-side.
//     Supplying the WRONG domain explicitly does 404, so a domain, if ever
//     stored, must be correct — but since none is needed for a correct
//     result, the identifier here is just the bare API HOST, a single token
//     like Greenhouse/Lever/Ashby's slug, not a colon-delimited composite
//     like Workday/Oracle's. Only one live tenant was available to confirm
//     this against — whether a multi-brand Eightfold tenant (several domains
//     under one host) would ever need an explicit `domain` to disambiguate is
//     unconfirmed; `domain` is threaded through as an optional override for
//     exactly that case, but is never required in the confirmed shape.
//   * **Revised 2026-08-27, against a real ~80-company list**: Eightfold
//     actually offers TWO hosting modes, not one. The common case (~95% of a
//     real sample) is a SHARED default subdomain, `{company}.eightfold.ai`
//     — a genuine, host-suffix-matchable convention, much like Workday's
//     `.myworkdayjobs.com`. The minority case is a fully white-labeled
//     CUSTOM domain (Netflix's `explore.jobs.netflix.net`, John Deere,
//     Houston ISD, ...) with no shared signature at all. `extractSlugFromUrl`
//     (below) handles both: a `*.eightfold.ai` host matches on ANY path
//     (the host alone is the identifiable unit there); anything else falls
//     back to matching Eightfold's confirmed URL SHAPES (`/api/apply/v2/
//     jobs...` or the canonical single-job page `/careers/job/{numericId}`)
//     — narrower than a suffix match, and still only a CANDIDATE either way:
//     detect.js always follows a URL match with a real `probe()` call before
//     accepting it, so an unrelated site coincidentally sharing one of these
//     shapes (implausible, but not impossible) is still caught before
//     entering the registry. This platform still never joins the
//     NAME-GUESS SWEEP (detect.js) even for the guessable shared-subdomain
//     case — recognizing a URL that's already been supplied is a different
//     question from guessing a company belongs on Eightfold at all with no
//     board name available to verify against, same false-positive
//     discipline as everywhere else.
// The list payload carries no full description (`job_description` is empty
// in list results) — full text needs the per-posting detail call, same
// list-then-detail shape as Workday/Oracle. No board/company display name in
// either payload.

const tunables = require('../../tunables.json');
const { requestTimeoutMs } = require('./scanContext');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { UA, readBodyJson } = require('./httpClient');
const { agent: defaultDispatcher } = require('./dispatcher');

const platform = 'eightfold';

function cfg() {
  return tunables.atsDirect.platforms.eightfold;
}

// slug_or_identifier is the bare API host (e.g. "explore.jobs.netflix.net") —
// no composite needed, see this module's header. `parseIdentifier` accepts
// either a bare host or an optional "{host}:{domain}" form (never produced by
// extractSlugFromUrl today, but supported for a future manual override).
function parseIdentifier(id) {
  if (!id) return null;
  const s = String(id);
  const idx = s.indexOf(':');
  if (idx === -1) return { host: s, domain: null };
  const host = s.slice(0, idx);
  const domain = s.slice(idx + 1) || null;
  return host ? { host, domain } : null;
}

function buildIdentifier({ host, domain }) {
  return domain ? `${host}:${domain}` : host;
}

// Recognizes TWO distinct real hosting modes, confirmed live against a bulk
// company list (2026-08-27), not assumed from the Netflix case alone:
//   1. The SHARED default subdomain, "{company}.eightfold.ai" — the more
//      common real-world case (roughly 95% of a real ~80-company sample).
//      The host suffix alone identifies the tenant here, the same way
//      Workday's ".myworkdayjobs.com" does, so ANY path on this host is a
//      match — a bare "/careers" listing-page URL (which is what companies
//      actually link from their own site, no job id in it) resolves the
//      identifier just as well as a full job-detail URL.
//   2. A fully CUSTOM white-labeled domain (Netflix, John Deere, Houston
//      ISD, ...) carrying no shared naming signature at all — here there is
//      genuinely nothing to match on except Eightfold's own confirmed URL
//      SHAPES (the API path or the canonical "/careers/job/{numericId}"
//      page), narrower than a suffix match and still only a candidate (see
//      this module's header) until `probe()` confirms it.
// Mode 1 does NOT get folded into NAME_GUESS_EXCLUDED's reasoning reversed —
// a guessed "{company}.eightfold.ai" slug is still never trusted without a
// live probe confirming real postings back (detect.js's standing discipline
// for every URL match), and this platform still never joins the name-guess
// SWEEP itself (detect.js) — that's a distinct question (guessing a company
// belongs on Eightfold AT ALL) from this one (recognizing a URL that's
// already been supplied).
const EIGHTFOLD_HOST_SUFFIX = /(^|\.)eightfold\.ai$/;

function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const domain = parsed.searchParams.get('domain') || null;
  if (EIGHTFOLD_HOST_SUFFIX.test(host)) {
    return { platform, slug: buildIdentifier({ host, domain }) };
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  const isApiShape = parts[0] === 'api' && parts[1] === 'apply' && parts[2] === 'v2' && parts[3] === 'jobs';
  const isJobPageShape = parts[0] === 'careers' && parts[1] === 'job' && /^\d+$/.test(parts[2] || '');
  if (!isApiShape && !isJobPageShape) return null;
  return { platform, slug: buildIdentifier({ host, domain }) };
}

async function getJsonEightfold(url, { ms, dispatcher = defaultDispatcher } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || requestTimeoutMs());
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: controller.signal, dispatcher });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${resp.status} from ${url}`);
      err.status = resp.status;
      throw err;
    }
    return await readBodyJson(resp);
  } finally {
    clearTimeout(timer);
  }
}

function listUrl({ host, domain }, { start, num }) {
  const q = new URLSearchParams({ start: String(start), num: String(num) });
  if (domain) q.set('domain', domain);
  return `https://${host}/api/apply/v2/jobs?${q.toString()}`;
}

function detailUrl({ host, domain }, id) {
  const q = domain ? `?${new URLSearchParams({ domain }).toString()}` : '';
  return `https://${host}/api/apply/v2/jobs/${encodeURIComponent(id)}${q}`;
}

// Cheap existence probe: one list call, num:1. `ok` iff `positions` is a
// non-empty array; a bogus host fails at DNS resolution before any status is
// even seen (surfaces as a fetch/abort rejection, same as every other
// composite-identifier platform's dead-tenant case); a bogus/unrecognized
// domain override (if ever supplied) 404s cleanly. No board display name
// anywhere in the payload, so boardName is always null.
async function probe(id, { dispatcher } = {}) {
  const parsed = parseIdentifier(id);
  if (!parsed) return { ok: false, status: 0, boardName: null, error: 'malformed identifier' };
  try {
    const body = await getJsonEightfold(listUrl(parsed, { start: 0, num: 1 }), { dispatcher });
    const positions = Array.isArray(body?.positions) ? body.positions : [];
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

// Multi-title scans (4.6.15) — true if the item matches ANY of the given
// titles, or if the list is empty (no title filter at all).
function listItemMatchesAnyTitle(item, titles) {
  if (!titles || !titles.length) return true;
  return titles.some((t) => listItemMatchesTitle(item, t));
}

function normalizeItem(detail, { id, slug, companyName }) {
  const info = detail || {};
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: info.name || null,
    // Eightfold's payload carries no company name anywhere — from the
    // caller, same posture as every other adapter here.
    companyName: companyName || null,
    location: info.location || (Array.isArray(info.locations) ? info.locations.join(', ') : null) || null,
    // t_create is unix SECONDS (unlike Workday's relative-string postedOn).
    postedAt: toIsoFromUnixSeconds(info.t_create),
    link: info.canonicalPositionUrl || null,
    descriptionText: htmlToText(info.job_description),
    seniorityLevel: null,
    employmentType: info.work_location_option || null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id, link: info.canonicalPositionUrl || null, title: info.name, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

function toIsoFromUnixSeconds(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pull every open posting for an Eightfold AI career site, title-narrowed and
 * detail-enriched, normalized into the 4.2 internal schema.
 *
 * @param {string} slug bare API host, or "{host}:{domain}" (see parseIdentifier)
 * @param {{companyName?: string, titles?: string[], limit?: number, dispatcher?: *}} opts
 *   `titles`, when supplied, is applied as a local substring any-match
 *   against each item's own name after listing (same posture as Workday's/
 *   Oracle's local filter). `keep` is NOT applied here — same reasoning as
 *   those two adapters: location/postedAt exist at list time, but the full
 *   description (which a caller's keep predicate may need) only exists after
 *   the per-posting detail fetch below.
 */
async function fetchJobs(slug, { companyName, titles, limit, dispatcher } = {}) {
  const c = cfg();
  const parsed = parseIdentifier(slug);
  if (!parsed) throw new Error(`Eightfold: malformed identifier "${slug}"`);

  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const pageSize = c.pageSize;
  const realTitles = Array.isArray(titles) ? titles.filter(Boolean) : titles ? [titles] : [];

  const listedById = new Map();
  let start = 0;
  for (let page = 0; page < c.maxListPages; page++) {
    const body = await getJsonEightfold(listUrl(parsed, { start, num: pageSize }), { dispatcher });
    const positions = Array.isArray(body?.positions) ? body.positions : [];
    for (const p of positions) {
      if (p.id != null && !listedById.has(p.id)) listedById.set(p.id, p);
    }
    const total = typeof body?.count === 'number' ? body.count : null;
    start += pageSize;
    if (!positions.length) break;
    if (total != null && start >= total) break;
    if (listedById.size >= cap * 4) break; // enough raw candidates to survive title filtering
  }

  const survivors = [...listedById.values()]
    .filter((item) => listItemMatchesAnyTitle(item, realTitles) && item.id != null)
    .slice(0, cap);

  const details = await pooled(survivors, c.detailConcurrency, async (item) => {
    try {
      const detail = await getJsonEightfold(detailUrl(parsed, item.id), { dispatcher });
      return normalizeItem(detail, { id: item.id, slug, companyName });
    } catch (e) {
      // Per-company failure isolation (12.4) is the CALLER's job for a whole
      // board going down; one bad posting detail inside an otherwise-healthy
      // board must not take the rest of the board down with it.
      console.error(`eightfold fetchJobs: detail fetch failed for id "${item.id}":`, e.message || e);
      return null;
    }
  });

  return details.filter((j) => j && j.title && j.link);
}

// Contract-drift canary (18.3, §15 #44). See oracle.js's check for why this
// covers the detail call as well as the list call, and why `firstDescription`
// is normalized to null when empty rather than passed through as ''.
const CONTRACT_CHECK_SLUG = 'bayer.eightfold.ai'; // a real, stable registry tenant
const contractCheck = {
  name: platform,
  requiredFields: ['positions', 'count', 'firstId', 'firstName', 'firstDescription', 'firstUrl'],
  run: async () => {
    const parsed = parseIdentifier(CONTRACT_CHECK_SLUG);
    const body = await getJsonEightfold(listUrl(parsed, { start: 0, num: 1 }));
    const positions = Array.isArray(body?.positions) ? body.positions : null;
    const first = positions?.[0] || {};
    const detail = first.id != null ? await getJsonEightfold(detailUrl(parsed, first.id)) : {};
    return {
      positions,
      count: typeof body?.count === 'number' ? body.count : null,
      firstId: first.id != null ? first.id : null,
      firstName: detail.name || null,
      firstDescription: detail.job_description || null,
      firstUrl: detail.canonicalPositionUrl || null,
    };
  },
};

module.exports = { platform, buildIdentifier, parseIdentifier, extractSlugFromUrl, probe, fetchJobs, normalizeItem, contractCheck };

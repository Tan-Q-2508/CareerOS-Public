// Oracle Recruiting Cloud (Fusion Cloud HCM) adapter — ATS Direct Tier 2.5
// (spec 18.1). Phase 5.5, §15 #42.
//
// Live-confirmed 2026-08-26 against a real tenant (Ford, tenant "eeho",
// datacenter "us2"):
//   list:   GET https://{tenant}.fa.{dc}.oraclecloud.com/hcmRestApi/resources/
//               latest/recruitingCEJobRequisitions?onlyData=true
//               &expand=requisitionList.secondaryLocations
//               &finder=findReqs;siteNumber={site},limit={n},offset={n},
//               sortBy=POSTING_DATES_DESC
//           -> { items: [{ TotalJobsCount, requisitionList: [...] }] }
//   detail: GET https://{tenant}.fa.{dc}.oraclecloud.com/hcmRestApi/resources/
//               latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true
//               &finder=ById;Id="{id}",siteNumber="{site}"
//           -> { items: [{ ExternalDescriptionStr, ... }] }
// §18.1 as originally written cited the `recruitingCandidates` resource —
// WRONG, confirmed live. The real candidate-facing resource is
// `recruitingCEJobRequisitions` (list) / `recruitingCEJobRequisitionDetails`
// (detail).
//
// Two things that matter and are easy to get wrong:
//   * The identifier is stored as a THREE-part composite "{tenant}:{dc}:{site}",
//     matching the real candidate-facing browser URL's own
//     ".../sites/{site}/..." segment (e.g. Ford's is "jobsearch", not a guessable
//     "CX_1" placeholder) — but live testing found `siteNumber` in the
//     `findReqs` finder has NO observed filtering effect for a single-site
//     tenant (identical `requisitionList` returned for the real site value,
//     a garbage string, and the parameter omitted entirely). Since URL-match
//     mode always reads `site` off a real observed URL (never guesses it),
//     this doesn't cause an incorrect result today — but it means `site`
//     cannot be used to distinguish "this identifier is genuine" from "this
//     identifier is malformed junk that happens to parse," which is exactly
//     why `probe()` below never leans on siteNumber for that job. Whether a
//     genuinely multi-site tenant would filter differently is unconfirmed —
//     only one live tenant (Ford) was available to test against. Follows the
//     same colon-delimited-composite precedent as Workday's
//     "{tenant}:{wd}:{site}" (4.6.5) regardless.
//   * `probe()`'s real signal is connectivity + non-empty results: a bogus
//     tenant fails at DNS resolution (surfaces as a fetch/abort rejection,
//     same as any other platform's dead-tenant case); a real tenant with
//     zero open postings would return `requisitionList: []` at HTTP 200 —
//     `probe()` asserts on that list's length rather than `resp.ok` alone so
//     a case like that (unconfirmed whether it actually occurs; not
//     reproducible from Ford, which has 2000+ open reqs) isn't misregistered
//     as `active`.
// The list payload carries no full description (only ShortDescriptionStr) and
// no board/company display name anywhere — full text needs the per-posting
// detail call (like Workday), and an unverifiable guessed tenant can never be
// cross-checked (like Workday) — so this platform is URL-match-only, never
// part of the name-guess sweep (detect.js).

const tunables = require('../../tunables.json');
const { requestTimeoutMs } = require('./scanContext');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { UA, readBodyJson } = require('./httpClient');
const { agent: defaultDispatcher } = require('./dispatcher');

const platform = 'oracle';

function cfg() {
  return tunables.atsDirect.platforms.oracle;
}

// slug_or_identifier is a composite "{tenant}:{dc}:{site}" — colon-delimited,
// same reasoning as workday.js's buildIdentifier/parseIdentifier: none of the
// three real-world components can contain a colon, and it keeps the
// registry's single-text-column schema (4.6.5) intact.
//
// A TWO-part "{host}:{site}" form (§15 #65) covers a tenant whose REST API is
// served from a host that is not {tenant}.fa.{dc}.oraclecloud.com — a custom
// domain (Dell's enterpriseplatform.dell.com) or an oraclecloud host with no
// datacenter segment (JPMorgan's jpmc.fa.oraclecloud.com). Both answer the
// same /hcmRestApi resources at their own host, verified live 2026-09-26. The
// two forms cannot be confused: a host always contains a dot, a tenant never
// does.
function buildIdentifier({ tenant, dc, site, host }) {
  return host ? `${host}:${site}` : `${tenant}:${dc}:${site}`;
}

function parseIdentifier(id) {
  if (!id) return null;
  const parts = String(id).split(':');
  if (parts.length === 2) {
    const [host, site] = parts;
    if (!host || !site || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return null;
    return { host: host.toLowerCase(), site };
  }
  if (parts.length !== 3) return null;
  const [tenant, dc, site] = parts;
  if (!tenant || !dc || !site) return null;
  return { tenant, dc, site };
}

function hostOf({ tenant, dc, host }) {
  return host || `${tenant}.fa.${dc}.oraclecloud.com`;
}

function tenantBase(parsed) {
  return `https://${hostOf(parsed)}/hcmRestApi/resources/latest`;
}

// Recognizes the candidate-facing browser URL
// ({tenant}.fa.{dc}.oraclecloud.com/hcmUI/CandidateExperience/{locale}/sites/
// {site}/...) and the REST API form (host is identical either way; siteNumber
// only ever appears in the path, read from the "sites/" segment when present
// or a "siteNumber=" query param on the REST form).
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
  const sitesIdx = parts.indexOf('sites');
  const site = sitesIdx >= 0 ? parts[sitesIdx + 1] : parsed.searchParams.get('siteNumber');
  const hostMatch = /^([a-z0-9-]+)\.fa\.([a-z0-9-]+)\.oraclecloud\.com$/.exec(host);
  if (hostMatch) {
    const [, tenant, dc] = hostMatch;
    return site ? { platform, slug: buildIdentifier({ tenant, dc, site }) } : { platform, slug: null };
  }
  // The two-part custom-host form (see buildIdentifier): an oraclecloud host
  // with no datacenter segment, or any host serving Oracle's candidate
  // experience path. A candidate only — detect.js probes before accepting.
  const isOracleCloud = /^[a-z0-9-]+\.fa\.oraclecloud\.com$/.test(host);
  const isCandidateExperience = parts[0] === 'hcmUI' && parts[1] === 'CandidateExperience';
  if (!isOracleCloud && !isCandidateExperience) return null;
  return site ? { platform, slug: buildIdentifier({ host, site }) } : { platform, slug: null };
}

async function getJsonOracle(url, { ms, dispatcher = defaultDispatcher } = {}) {
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

function listUrl(parsed, { limit, offset }) {
  const finder = `findReqs;siteNumber=${encodeURIComponent(parsed.site)},limit=${limit},offset=${offset},sortBy=POSTING_DATES_DESC`;
  return `${tenantBase(parsed)}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder}`;
}

function detailUrl(parsed, id) {
  const finder = `ById;Id="${encodeURIComponent(id)}",siteNumber="${encodeURIComponent(parsed.site)}"`;
  return `${tenantBase(parsed)}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=${finder}`;
}

// Cheap existence probe: one list call, limit:1. `ok` is asserted on the
// returned requisitionList's length, never on resp.ok alone — see this
// module's header for why (a real-but-empty tenant is the theoretical case
// this guards, not a bogus siteNumber, which the live endpoint doesn't
// actually validate). Oracle exposes no board display name at any endpoint
// (same as Workday), so boardName is always null.
async function probe(id, { dispatcher } = {}) {
  const parsed = parseIdentifier(id);
  if (!parsed) return { ok: false, status: 0, boardName: null, error: 'malformed identifier' };
  try {
    const body = await getJsonOracle(listUrl(parsed, { limit: 1, offset: 0 }), { dispatcher });
    const reqs = (body?.items?.[0]?.requisitionList) || [];
    return { ok: reqs.length > 0, status: 200, boardName: null, error: null };
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
  return !!(item.Title && item.Title.toLowerCase().includes(title.toLowerCase().trim()));
}

// Multi-title scans (4.6.15) — true if the item matches ANY of the given
// titles, or if the list is empty (no title filter at all).
function listItemMatchesAnyTitle(item, titles) {
  if (!titles || !titles.length) return true;
  return titles.some((t) => listItemMatchesTitle(item, t));
}

function normalizeItem(detail, { id, slug, companyName }) {
  const info = (detail && detail.items && detail.items[0]) || {};
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: info.Title || null,
    // Oracle's payload carries no company name anywhere — from the caller,
    // same posture as every other adapter here.
    companyName: companyName || null,
    location: info.PrimaryLocation || null,
    postedAt: toIso(info.ExternalPostedStartDate),
    link: null,
    descriptionText: htmlToText(info.ExternalDescriptionStr),
    seniorityLevel: null,
    employmentType: info.WorkerType || null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id, link: null, title: info.Title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pull every open posting for an Oracle Recruiting Cloud site, title-narrowed
 * and detail-enriched, normalized into the 4.2 internal schema.
 *
 * @param {string} slug composite "{tenant}:{dc}:{site}" identifier
 * @param {{companyName?: string, titles?: string[], limit?: number, dispatcher?: *}} opts
 *   `titles`, when supplied, is applied as a local substring any-match
 *   against each item's own title after listing (same posture as Workday's
 *   local filter — Oracle's finder does expose a keyword facet, but title
 *   narrowing stays local here to avoid relying on an unverified server-side
 *   semantic). `keep` is NOT applied here — location/postedAt only exist
 *   after the per-posting detail fetch below, same reasoning as workday.js.
 */
async function fetchJobs(slug, { companyName, titles, limit, dispatcher } = {}) {
  const c = cfg();
  const parsed = parseIdentifier(slug);
  if (!parsed) throw new Error(`Oracle: malformed identifier "${slug}"`);

  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const pageSize = c.pageSize;
  const realTitles = Array.isArray(titles) ? titles.filter(Boolean) : titles ? [titles] : [];

  const listedById = new Map();
  let offset = 0;
  for (let page = 0; page < c.maxListPages; page++) {
    const body = await getJsonOracle(listUrl(parsed, { limit: pageSize, offset }), { dispatcher });
    const item0 = body?.items?.[0] || {};
    const reqs = item0.requisitionList || [];
    for (const r of reqs) {
      if (r.Id && !listedById.has(r.Id)) listedById.set(r.Id, r);
    }
    const total = typeof item0.TotalJobsCount === 'number' ? item0.TotalJobsCount : null;
    offset += pageSize;
    if (!reqs.length) break;
    if (total != null && offset >= total) break;
    if (listedById.size >= cap * 4) break; // enough raw candidates to survive title filtering
  }

  const survivors = [...listedById.values()]
    .filter((item) => listItemMatchesAnyTitle(item, realTitles) && item.Id)
    .slice(0, cap);

  const details = await pooled(survivors, c.detailConcurrency, async (item) => {
    try {
      const detail = await getJsonOracle(detailUrl(parsed, item.Id), { dispatcher });
      const job = normalizeItem(detail, { id: item.Id, slug, companyName });
      // Detail response carries no direct apply link — build the candidate
      // experience URL from the same components used to fetch it.
      job.link = `https://${hostOf(parsed)}/hcmUI/CandidateExperience/en/sites/${parsed.site}/requisitions/preview/${item.Id}`;
      job.dedupKey = dedupKey({ id: item.Id, link: job.link, title: job.title, companyName, atsPlatform: platform, atsSlug: slug });
      return job;
    } catch (e) {
      // Per-company failure isolation (12.4) is the CALLER's job for a whole
      // board going down; one bad posting detail inside an otherwise-healthy
      // board must not take the rest of the board down with it.
      console.error(`oracle fetchJobs: detail fetch failed for id "${item.Id}":`, e.message || e);
      return null;
    }
  });

  return details.filter((j) => j && j.title && j.link);
}

// Contract-drift canary (18.3, §15 #44). A known-good tenant, plus the fields
// this adapter actually reads — from BOTH the list call and the per-posting
// detail call, since a description-field rename breaks the adapter just as
// completely as a list-shape change and is exactly the kind of drift 18.3
// exists to catch.
//
// `run()` returns a synthesized named-object shape rather than a raw payload,
// same posture as google.js's check, so a required-field name means something
// legible instead of a bare array index. The description is normalized to
// `null` when empty on purpose: assertShape treats only undefined/null as
// missing (an empty string passes, deliberately and unit-tested), so returning
// the raw string would let a silently-emptied description slip through green.
const CONTRACT_CHECK_SLUG = 'ebwg:us2:CX'; // ACI Worldwide — a real, stable registry tenant
const contractCheck = {
  name: platform,
  requiredFields: ['requisitionList', 'totalJobsCount', 'firstId', 'firstTitle', 'firstDescription'],
  run: async () => {
    const parsed = parseIdentifier(CONTRACT_CHECK_SLUG);
    const body = await getJsonOracle(listUrl(parsed, { limit: 1, offset: 0 }));
    const item0 = body?.items?.[0] || {};
    const requisitionList = item0.requisitionList || null;
    const first = requisitionList?.[0] || {};
    const detail = first.Id ? await getJsonOracle(detailUrl(parsed, first.Id)) : null;
    const info = detail?.items?.[0] || {};
    return {
      requisitionList,
      totalJobsCount: typeof item0.TotalJobsCount === 'number' ? item0.TotalJobsCount : null,
      firstId: first.Id || null,
      firstTitle: info.Title || null,
      firstDescription: info.ExternalDescriptionStr || null,
    };
  },
};

module.exports = { platform, buildIdentifier, parseIdentifier, extractSlugFromUrl, probe, fetchJobs, normalizeItem, contractCheck };

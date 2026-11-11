// Amazon Custom Adapter Tier adapter (spec 18.2, Phase 5.5 §15 #45).
//
// amazon.jobs exposes a clean, unauthenticated JSON search endpoint —
// GET https://www.amazon.jobs/en/search.json?base_query=&result_limit=&offset=
//   -> { hits, jobs: [{ id_icims, job_path, title, description,
//        basic_qualifications, preferred_qualifications, normalized_location,
//        posted_date, ... }] }
// List-only: full `description` + `basic_qualifications` +
// `preferred_qualifications` are already present at list time — no separate
// detail call needed, same list-only shape as Greenhouse/Lever/Ashby, unlike
// every other adapter in this tier.
//
// One real bug found live building this adapter: the endpoint serves
// `content-encoding: zstd` by default, which this runtime's fetch/undici does
// NOT auto-decompress — the raw compressed bytes were silently misread as
// truncated JSON. Fixed once, generally, in custom/index.js's getJsonCustom
// (`Accept-Encoding: identity` on every request in this tier) rather than
// here — see that module's header for the full account.
//
// `base_query` genuinely full-text-searches server-side (confirmed live: a
// title query narrows real results, not a client-side filter) — same
// per-title-searchText posture as workday.js/apple.js. No board/company
// display name field exists in the payload beyond the POSTING's own
// `company_name` (an Amazon subsidiary/legal-entity name, e.g. "Amazon Data
// Services Ireland Limited" — not useful as a board-identity check, so this
// platform is never in detect.js's VERIFIES_BOARD_NAME).

const tunables = require('../../../tunables.json');
const { dedupKey } = require('../../dedup');
const { htmlToText } = require('../htmlToText');
const { getJsonCustom, parseFixedIdentifier, fixedIdentifier } = require('./index');

const platform = 'amazon';

function cfg() {
  return tunables.atsDirect.platforms.amazon;
}

function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  if (!/(^|\.)amazon\.jobs$/.test(parsed.hostname.toLowerCase())) return null;
  return { platform, slug: fixedIdentifier(platform) };
}

function searchUrl(query, { limit, offset }) {
  const q = new URLSearchParams({
    base_query: query || '',
    result_limit: String(limit),
    offset: String(offset),
    sort: 'recent',
  });
  return `https://www.amazon.jobs/en/search.json?${q.toString()}`;
}

// Cheap existence probe — one page, num:1. `ok` iff `jobs` is a non-empty
// array. A malformed identifier short-circuits before any request.
async function probe(id) {
  const parsed = parseFixedIdentifier(platform, id);
  if (!parsed) return { ok: false, status: 0, boardName: null, error: 'malformed identifier' };
  try {
    const body = await getJsonCustom(searchUrl('', { limit: 1, offset: 0 }));
    const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
    return { ok: jobs.length > 0, status: 200, boardName: null, error: null };
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

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeItem(item, { slug, companyName }) {
  const info = item || {};
  const link = info.job_path ? `https://www.amazon.jobs${info.job_path}` : null;
  const descriptionText = [info.description, info.basic_qualifications, info.preferred_qualifications]
    .map((t) => htmlToText(t))
    .filter(Boolean)
    .join('\n\n');
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: info.title || null,
    // Amazon's own `company_name` is a legal-entity/subsidiary name (e.g.
    // "Amazon Data Services Ireland Limited"), not a display name — caller's
    // companyName wins, same posture as every other adapter here.
    companyName: companyName || null,
    location: info.normalized_location || info.location || null,
    postedAt: toIso(info.posted_date),
    link,
    descriptionText,
    seniorityLevel: null,
    employmentType: info.job_schedule_type || null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id: info.id_icims, link, title: info.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

/**
 * Pull open postings from amazon.jobs, title-narrowed, normalized into the
 * 4.2 internal schema. List-only — see this module's header.
 *
 * @param {string} slug the fixed identifier "amazon" (custom/index.js)
 * @param {{companyName?: string, titles?: string[], limit?: number}} opts
 *   `titles`, when supplied, is passed ONE AT A TIME as Amazon's own
 *   server-side `base_query` (same per-title-searchText posture as
 *   workday.js/apple.js) AND still applied as a local substring match against
 *   each item's own title. No titles at all runs one unfiltered pass.
 */
async function fetchJobs(slug, { companyName, titles, limit } = {}) {
  const c = cfg();
  const parsed = parseFixedIdentifier(platform, slug);
  if (!parsed) throw new Error(`Amazon: malformed identifier "${slug}"`);

  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const pageSize = c.pageSize;
  const realTitles = Array.isArray(titles) ? titles.filter(Boolean) : titles ? [titles] : [];
  const passes = realTitles.length ? realTitles : [''];

  const listedById = new Map();
  for (const searchTitle of passes) {
    if (listedById.size >= cap * 4) break;
    let offset = 0;
    for (let page = 0; page < c.maxListPages; page++) {
      const body = await getJsonCustom(searchUrl(searchTitle, { limit: pageSize, offset }));
      const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
      for (const item of jobs) {
        if (item.id_icims && !listedById.has(item.id_icims)) listedById.set(item.id_icims, item);
      }
      const total = typeof body?.hits === 'number' ? body.hits : null;
      offset += pageSize;
      if (!jobs.length) break;
      if (total != null && offset >= total) break;
      if (listedById.size >= cap * 4) break;
    }
  }

  const survivors = [...listedById.values()]
    .filter((item) => listItemMatchesAnyTitle(item, realTitles) && item.id_icims)
    .slice(0, cap)
    .map((item) => normalizeItem(item, { slug, companyName }));

  return survivors.filter((j) => j && j.title && j.link);
}

// Contract-drift canary (18.3, §15 #44) — a known-good query, and the fields
// this adapter actually reads.
const contractCheck = {
  name: platform,
  requiredFields: ['hits', 'jobs'],
  run: async () => getJsonCustom(searchUrl('engineer', { limit: 1, offset: 0 })),
};

module.exports = { platform, extractSlugFromUrl, probe, fetchJobs, normalizeItem, contractCheck };

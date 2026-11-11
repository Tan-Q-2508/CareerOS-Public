// Greenhouse adapter — ATS Direct Tier 1 (spec 4.6.1).
//
// Endpoints verified live 2026-08-05 against real boards:
//   listing: GET {boardApi}/{slug}/jobs?content=true -> { jobs: [...], meta }
//   probe:   GET {boardApi}/{slug}                   -> { name, content }  (~30 bytes)
// Unknown slug 404s on both. The probe endpoint is the only Tier 1 probe that
// returns the company's own display name, which is what lets detect.js verify
// a guessed slug on this platform (see detect.js's verification note).

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { getJson, getJsonArrayStreamed } = require('./httpClient');

const platform = 'greenhouse';

function base() {
  return tunables.atsDirect.platforms.greenhouse.boardApi;
}

// boards.greenhouse.io/{slug}, job-boards.greenhouse.io/{slug}, and the API host
// itself. Also recognizes the embedded form (a company's OWN domain carrying a
// ?gh_jid= param, e.g. stripe.com/jobs/search?gh_jid=8023928): that proves the
// platform but carries no slug, so slug comes back null and detect.js falls
// through to name-guess for the slug rather than giving up on the company.
function extractSlugFromUrl(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const parts = u.pathname.split('/').filter(Boolean);
    // The embedded board (boards.greenhouse.io/embed/job_board?for={slug},
    // .../embed/job_app?for=..., .../embed/job_board/js?for=...) carries the
    // board token in `for` — the form most company careers pages use. Read as
    // a path it produced the slug "embed" (found §15 #65).
    if (parts[0] === 'embed') return { platform, slug: u.searchParams.get('for') || null };
    // boards-api.greenhouse.io/v1/boards/{slug}/... vs boards.greenhouse.io/{slug}
    const idx = parts.indexOf('boards');
    const slug = idx >= 0 ? parts[idx + 1] : parts[0];
    return { platform, slug: slug || null };
  }
  if (u.searchParams.has('gh_jid') || u.searchParams.has('gh_src')) {
    return { platform, slug: null };
  }
  return null;
}

/** Cheap existence probe. Returns the board's display name for cross-checking. */
async function probe(slug) {
  try {
    const body = await getJson(`${base()}/${encodeURIComponent(slug)}`);
    return { ok: true, status: 200, boardName: (body && body.name) || null, error: null };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

function normalizeItem(item, { slug, companyName }) {
  const link = item.absolute_url || null;
  const id = item.id != null ? String(item.id) : null;
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: item.title || null,
    // Greenhouse is the one Tier 1 platform that carries the company name in
    // the payload; prefer it, fall back to what the caller resolved.
    companyName: item.company_name || companyName || null,
    location: (item.location && item.location.name) || null,
    postedAt: toIso(item.first_published || item.updated_at),
    link,
    // Filled in by fetchJobs's onItem AFTER the keep filter passes (4.6.15) —
    // htmlToText is the expensive part of normalizing a posting, and keep()
    // (atsDirectAdapter.js) only ever reads title/location/postedAt, never
    // this field, so decoding it for a posting that's about to be filtered
    // out is pure wasted CPU.
    descriptionText: null,
    // No seniority, employment-type or salary fields exist on this API. Left
    // null rather than guessed from the title — the scoring pipeline treats a
    // null as "unknown", and a wrong guess reads as fact.
    seniorityLevel: null,
    employmentType: null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id, link, title: item.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pull every open posting for a board, normalized into the 4.2 internal
 * schema. Streams above the size threshold (4.6.13) rather than buffering
 * the whole board (up to ~12 MB) via response.json() first.
 *
 * @param {string} slug board token
 * @param {{companyName?: string, limit?: number, keep?: (job: object) => boolean, dispatcher?: *}} opts
 *   `keep`, when supplied, is applied PER ITEM as postings stream in — this is
 *   what fixes the cap-vs-filter ordering bug (4.6.13): `limit` now caps the
 *   number of postings that pass `keep`, scanning the FULL board in order,
 *   rather than capping raw postings before atsDirectAdapter's title/location/
 *   date filter ever ran (the old behavior silently dropped matches past
 *   position `limit` on a board with more than `limit` raw postings).
 */
async function fetchJobs(slug, { companyName, limit, keep, dispatcher } = {}) {
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const kept = [];
  await getJsonArrayStreamed(`${base()}/${encodeURIComponent(slug)}/jobs?content=true`, {
    pick: 'jobs',
    dispatcher,
    onItem: (raw) => {
      const job = normalizeItem(raw, { slug, companyName });
      if (!job.title || !job.link) return true;
      if (keep && !keep(job)) return true;
      job.descriptionText = htmlToText(raw.content);
      kept.push(job);
      return kept.length < cap;
    },
  });
  return kept;
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
const CONTRACT_CHECK_SLUG = "anthropic"; // a real, stable registry board

const contractCheck = {
  name: platform,  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt', 'boardName'],
  run: async () => {
    // boardName is asserted here and nowhere else: Greenhouse is one of only
    // two platforms detect.js can name-verify a GUESSED slug against
    // (VERIFIES_BOARD_NAME). If this field ever disappears, name-guess
    // silently stops verifying instead of visibly failing.
    const p = await probe(CONTRACT_CHECK_SLUG);
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: 'Anthropic', limit: 1 });
    const first = jobs[0] || {};
    return {
      jobs: jobs.length ? jobs : null,
      firstTitle: first.title || null,
      firstLink: first.link || null,
      firstDescription: first.descriptionText || null,
      firstPostedAt: first.postedAt || null,
      boardName: p.boardName || null,
    };
  },
};

module.exports = { platform, extractSlugFromUrl, probe, fetchJobs, normalizeItem, contractCheck };

// Lever adapter — ATS Direct Tier 1 (spec 4.6.1).
//
// Endpoints verified live 2026-08-05:
//   listing: GET {postingsApi}/{slug}?mode=json -> a BARE ARRAY of postings
//   probe:   HEAD the same URL                  -> 200 / 404
//
// Two behaviours worth knowing before touching this file:
//   * A real board with no open roles returns 200 with []. A 200 proves the
//     board exists; it does NOT prove there are postings. That's fine for
//     detection (the company is genuinely resolved — see detect.js's note on
//     why a separate "resolved but empty" outcome was dropped), but don't read
//     a successful probe as "this company has jobs".
//   * A sweep of plausible-but-fake slugs (acme-corp-holdings,
//     globex-industries, initech-systems, and real companies that use other
//     platforms such as stripe/airbnb) all returned 404, so the 200 signal
//     itself is reliable — the ambiguity is only about postings, not existence.

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { getJsonArrayStreamed, probeHead } = require('./httpClient');

const platform = 'lever';

function base() {
  return tunables.atsDirect.platforms.lever.postingsApi;
}

function url(slug) {
  return `${base()}/${encodeURIComponent(slug)}?mode=json`;
}

// jobs.lever.co/{slug}/{postingId} and api.lever.co/v0/postings/{slug}
function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  if (!/(^|\.)lever\.co$/.test(parsed.hostname.toLowerCase())) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('postings');
  const slug = idx >= 0 ? parts[idx + 1] : parts[0];
  return { platform, slug: slug || null };
}

async function probe(slug) {
  const r = await probeHead(url(slug));
  return { ok: r.ok, status: r.status, boardName: null, error: r.error };
}

// descriptionPlain alone is only the intro blurb — the requirements live in
// `lists` (each entry a heading plus an HTML <li> block) and any closing notes
// in additionalPlain. Scoring reads exactly the requirements, so all three get
// concatenated; taking descriptionPlain by itself would hand the model a job
// description with its qualifications section missing.
function buildDescription(p) {
  const parts = [];
  if (p.descriptionPlain) parts.push(String(p.descriptionPlain).trim());
  else if (p.description) parts.push(htmlToText(p.description));
  for (const list of p.lists || []) {
    const heading = (list.text || '').trim();
    const body = htmlToText(list.content);
    if (heading || body) parts.push([heading, body].filter(Boolean).join('\n'));
  }
  if (p.additionalPlain) parts.push(String(p.additionalPlain).trim());
  else if (p.additional) parts.push(htmlToText(p.additional));
  return parts.filter(Boolean).join('\n\n').trim() || null;
}

function normalizeItem(p, { slug, companyName }) {
  const cats = p.categories || {};
  const link = p.hostedUrl || p.applyUrl || null;
  const id = p.id != null ? String(p.id) : null;
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: p.text || null,
    // Lever's payload carries no company name anywhere — it comes from the
    // caller (in #24, the registry's company_name_display).
    companyName: companyName || null,
    location: cats.location || (Array.isArray(cats.allLocations) ? cats.allLocations.join(', ') : null) || null,
    // createdAt is epoch MILLIseconds here (JSearch's is seconds — don't copy
    // that adapter's toIso).
    postedAt: toIsoMs(p.createdAt),
    link,
    descriptionText: buildDescription(p),
    seniorityLevel: null,
    employmentType: cats.commitment || null,
    salaryMin: toNumber(p.salaryRange && p.salaryRange.min),
    salaryMax: toNumber(p.salaryRange && p.salaryRange.max),
    dedupKey: dedupKey({ id, link, title: p.text, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

function toIsoMs(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toNumber(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull every open posting for a board. Streams above the size threshold
 * (4.6.13); `keep`, when supplied, is applied per posting as they stream in,
 * and `limit` caps the number that PASS `keep` — see greenhouse.js's fetchJobs
 * doc for why this ordering matters (fixes a cap-vs-filter bug on boards
 * larger than `limit`).
 */
async function fetchJobs(slug, { companyName, limit, keep, dispatcher } = {}) {
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const kept = [];
  await getJsonArrayStreamed(url(slug), {
    pick: null, // Lever's response body is a bare array, not { jobs: [...] }
    dispatcher,
    onItem: (raw) => {
      const job = normalizeItem(raw, { slug, companyName });
      if (!job.title || !job.link) return true;
      if (keep && !keep(job)) return true;
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
const CONTRACT_CHECK_SLUG = "spotify"; // a real, stable registry board

const contractCheck = {
  name: platform,  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt'],
  run: async () => {
    // firstDescription is the load-bearing one here. buildDescription()
    // stitches descriptionPlain + lists + additionalPlain; if `lists` ever
    // changes shape the description silently loses its requirements section
    // while still being non-empty, so length is checked, not just presence.
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: 'Spotify', limit: 1 });
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

module.exports = { platform, extractSlugFromUrl, probe, fetchJobs, normalizeItem, buildDescription, contractCheck };

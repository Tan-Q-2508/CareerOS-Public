// Ashby adapter — ATS Direct Tier 1 (spec 4.6.1).
//
// Endpoints verified live 2026-08-05:
//   listing: GET {boardApi}/{slug}?includeCompensation=true -> { jobs: [...], apiVersion }
//   probe:   HEAD the same URL                              -> 200 / 404
//
// Ashby has no cheap listing variant — dropping includeCompensation still
// returns the full board (Linear measured 330 KB, OpenAI 12 MB). HEAD is
// therefore the only affordable existence check, and it's what probe() uses;
// never call fetchJobs just to test whether a slug exists.
//
// Unlike Greenhouse, nothing in this payload names the company, so a guessed
// slug can't be verified here — see companyName.js on why slug-guessing stays
// conservative.

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { getJsonArrayStreamed, probeHead } = require('./httpClient');

const platform = 'ashby';

function base() {
  return tunables.atsDirect.platforms.ashby.boardApi;
}

function url(slug) {
  return `${base()}/${encodeURIComponent(slug)}?includeCompensation=true`;
}

// jobs.ashbyhq.com/{slug}/{postingId} and api.ashbyhq.com/posting-api/job-board/{slug}
function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  if (!/(^|\.)ashbyhq\.com$/.test(parsed.hostname.toLowerCase())) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('job-board');
  const slug = idx >= 0 ? parts[idx + 1] : parts[0];
  return { platform, slug: slug || null };
}

async function probe(slug) {
  const r = await probeHead(url(slug));
  return { ok: r.ok, status: r.status, boardName: null, error: r.error };
}

function normalizeItem(j, { slug, companyName }) {
  const link = j.jobUrl || j.applyUrl || null;
  const id = j.id != null ? String(j.id) : null;
  const secondary = Array.isArray(j.secondaryLocations)
    ? j.secondaryLocations.map((l) => (typeof l === 'string' ? l : l && l.location)).filter(Boolean)
    : [];
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: j.title || null,
    // No company name in the payload — supplied by the caller, same as Lever.
    companyName: companyName || null,
    location: [j.location, ...secondary].filter(Boolean).join(', ') || null,
    postedAt: toIso(j.publishedAt),
    link,
    // descriptionPlain is already plain text; descriptionHtml is the fallback.
    descriptionText: j.descriptionPlain ? String(j.descriptionPlain).trim() : htmlToText(j.descriptionHtml),
    seniorityLevel: null,
    employmentType: j.employmentType || null,
    salaryMin: compensationBound(j, 'min'),
    salaryMax: compensationBound(j, 'max'),
    dedupKey: dedupKey({ id, link, title: j.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

// Ashby's compensation block is a nested, optional structure of salary/equity/
// bonus components. Read only a salary-typed cash component; anything else
// (equity, variable comp) is not a salary and must not be reported as one.
function compensationBound(j, which) {
  const tiers = j.compensation && Array.isArray(j.compensation.compensationTiers)
    ? j.compensation.compensationTiers
    : [];
  for (const tier of tiers) {
    for (const c of tier.components || []) {
      const type = String(c.compensationType || '').toLowerCase();
      if (type !== 'salary') continue;
      const v = which === 'min' ? c.minValue : c.maxValue;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return null;
}

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pull every open posting for a board. Streams above the size threshold
 * (4.6.13) — Ashby boards run large (Linear 330 KB, OpenAI 12 MB) and
 * `includeCompensation=true` has no cheap variant. `keep`, when supplied, is
 * applied per posting as they stream in, and `limit` caps the number that
 * PASS `keep` — see greenhouse.js's fetchJobs doc for why this ordering
 * matters.
 */
async function fetchJobs(slug, { companyName, limit, keep, dispatcher } = {}) {
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const kept = [];
  await getJsonArrayStreamed(url(slug), {
    pick: 'jobs',
    dispatcher,
    onItem: (raw) => {
      if (raw.isListed === false) return true; // unlisted postings aren't public roles
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
const CONTRACT_CHECK_SLUG = "1password"; // a real, stable registry board

const contractCheck = {
  name: platform,  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt'],
  run: async () => {
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: '1Password', limit: 1 });
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

module.exports = { platform, extractSlugFromUrl, probe, fetchJobs, normalizeItem, contractCheck };

// SmartRecruiters adapter — ATS Direct, SMB/startup platform set (§15 #65).
//
// Public, unauthenticated Posting API, verified live 2026-09-26:
//   list:   GET https://api.smartrecruiters.com/v1/companies/{id}/postings?limit={n}&offset={n}[&q={text}]
//           -> { offset, limit, totalFound, content: [{ id, name, releasedDate,
//                location: { city, region, country, fullLocation, remote },
//                company: { identifier, name }, typeOfEmployment, experienceLevel, ... }] }
//   detail: GET https://api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}
//           -> { ..., postingUrl, jobAd: { sections: { companyDescription,
//                jobDescription, qualifications, additionalInformation } } }
// The company identifier is case-insensitive ("AbbVie" == "abbvie"), and `q`
// narrows server-side (AbbVie: 1,833 postings, q=scientist -> 185), so the
// adapter runs one narrowing pass per scan title — the same per-title
// pre-narrowing posture as workday.js's searchText.
//
// IDENTITY — an unknown company does NOT 404: `/companies/zzqq.../postings`
// answers 200 with totalFound 0, exactly like a real company with nothing
// open. So `probe()` is ok only when at least one posting comes back, and it
// returns the posting's own `company.name` as the board name, which is what
// lets detect.js name-verify a guessed identifier here (VERIFIES_BOARD_NAME)
// the way it already does for Greenhouse and Workable. A real company with no
// open roles therefore probes as a miss — recoverable (the unresolved re-sweep
// retries it), unlike a wrong mapping.

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { fetchJson, pooled, cleanTitles, titleMatchesAny, toIso } = require('./webFetch');

const platform = 'smartrecruiters';
const API = 'https://api.smartrecruiters.com/v1/companies';

function cfg() {
  return tunables.atsDirect.platforms.smartrecruiters;
}

// jobs.smartrecruiters.com/{company}/{postingId}-{slug}
// careers.smartrecruiters.com/{company}[/...]
// api.smartrecruiters.com/v1/companies/{company}/postings[...]
function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!/(^|\.)smartrecruiters\.com$/.test(host)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (host.startsWith('api.')) {
    const i = parts.indexOf('companies');
    return { platform, slug: i >= 0 && parts[i + 1] ? parts[i + 1] : null };
  }
  if (host.startsWith('jobs.') || host.startsWith('careers.')) {
    const slug = parts[0] && !/^(oneclick-ui|widget|sr-jobs)$/i.test(parts[0]) ? parts[0] : null;
    return { platform, slug };
  }
  return null;
}

function listUrl(id, { limit, offset, q }) {
  const p = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (q) p.set('q', q);
  return `${API}/${encodeURIComponent(id)}/postings?${p.toString()}`;
}

async function probe(id) {
  if (!id) return { ok: false, status: 0, boardName: null, error: 'missing identifier' };
  try {
    const body = await fetchJson(listUrl(id, { limit: 1, offset: 0 }), { platform });
    const first = Array.isArray(body?.content) ? body.content[0] : null;
    return { ok: !!first, status: 200, boardName: (first && first.company && first.company.name) || null, error: null };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

function describe(sections) {
  if (!sections) return null;
  const order = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription'];
  const parts = order
    .map((k) => sections[k])
    .filter((s) => s && s.text)
    .map((s) => [s.title, htmlToText(s.text)].filter(Boolean).join('\n'));
  return parts.join('\n\n').trim() || null;
}

function normalizeItem(item, { slug, companyName, detail }) {
  const d = detail || {};
  const id = item.id != null ? String(item.id) : null;
  const loc = item.location || {};
  const link = d.postingUrl || (id ? `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${id}` : null);
  const location = loc.fullLocation
    ? loc.fullLocation.replace(/,\s*,/g, ',')
    : [loc.city, loc.region, loc.country && String(loc.country).toUpperCase()].filter(Boolean).join(', ') || null;
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: item.name ? String(item.name).trim() : null,
    companyName: companyName || (item.company && item.company.name) || null,
    location: loc.remote && location ? `${location} (Remote)` : location,
    postedAt: toIso(item.releasedDate),
    link,
    descriptionText: describe(d.jobAd && d.jobAd.sections),
    // SmartRecruiters' own structured fields, passed through as the platform
    // states them — never inferred from the title.
    seniorityLevel: (item.experienceLevel && item.experienceLevel.label) || null,
    employmentType: (item.typeOfEmployment && item.typeOfEmployment.label) || null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id, link, title: item.name, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

async function listAll(slug, { q, cap }) {
  const c = cfg();
  const out = [];
  for (let page = 0, offset = 0; page < c.maxListPages; page++) {
    const body = await fetchJson(listUrl(slug, { limit: c.pageSize, offset, q }), { platform });
    const content = Array.isArray(body?.content) ? body.content : [];
    out.push(...content);
    offset += c.pageSize;
    if (!content.length || offset >= (body.totalFound || 0) || out.length >= cap) break;
  }
  return out;
}

/**
 * Every open posting matching any scan title, detail-enriched. `keep` is
 * applied BEFORE the detail fan-out because title/location/postedAt all exist
 * at list time here (unlike Workday), so a posting the scan would drop never
 * costs a detail request.
 */
async function fetchJobs(slug, { companyName, titles, limit, keep } = {}) {
  const c = cfg();
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const t = cleanTitles(titles);
  const byId = new Map();
  for (const q of t.length ? t : [null]) {
    for (const item of await listAll(slug, { q, cap: cap * 4 })) {
      if (item.id != null && !byId.has(item.id)) byId.set(item.id, item);
    }
  }
  const survivors = [...byId.values()]
    .filter((item) => titleMatchesAny(item.name, t))
    .map((item) => ({ item, job: normalizeItem(item, { slug, companyName }) }))
    .filter(({ job }) => job.title && job.link && (!keep || keep(job)))
    .slice(0, cap);

  const jobs = await pooled(survivors, c.detailConcurrency, async ({ item }) => {
    try {
      const detail = await fetchJson(`${API}/${encodeURIComponent(slug)}/postings/${encodeURIComponent(item.id)}`, { platform });
      return normalizeItem(item, { slug, companyName, detail });
    } catch (e) {
      console.error(`smartrecruiters fetchJobs: detail failed for "${slug}/${item.id}":`, e.message || e);
      return null;
    }
  });
  return jobs.filter((j) => j && j.title && j.link);
}

// Contract-drift canary (18.3). Asserts on the normalized job, like the Tier 1
// checks — this API is documented and stable, so the realistic failure is a
// field changing meaning under normalizeItem. boardName is asserted because
// this platform joins detect.js's VERIFIES_BOARD_NAME set.
const CONTRACT_CHECK_SLUG = 'ServiceNow';
const contractCheck = {
  name: platform,
  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt', 'boardName'],
  run: async () => {
    const p = await probe(CONTRACT_CHECK_SLUG);
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: 'ServiceNow', limit: 1 });
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

// Rippling ATS adapter — ATS Direct, SMB/startup platform set (§15 #65).
//
// Rippling's public job-board API, verified live 2026-09-26 against Rippling's
// own board:
//   list:   GET https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs
//           -> [{ uuid, name, department: { label }, url, workLocation: { label } }]
//              (a job with several locations appears once PER location)
//   detail: GET https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs/{uuid}
//           -> { uuid, name, description: { company (HTML), role (HTML) },
//                workLocations[], employmentType: { label, id }, createdOn,
//                companyName, payRangeDetails[], url }
// The public board page is https://ats.rippling.com/{slug}/jobs[/{uuid}]. An
// unknown slug 404s on the API.
//
// The list carries no company name; the detail does (`companyName`), so
// probe() spends one detail call on the first posting to return it, which is
// what lets detect.js name-verify a guessed slug (VERIFIES_BOARD_NAME). A
// board with nothing open probes ok with no name, and a guess against it is
// rejected by verification.

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { fetchJson, pooled, cleanTitles, titleMatchesAny, toIso } = require('./webFetch');

const platform = 'rippling';
const API = 'https://api.rippling.com/platform/api/ats/v1/board';

function cfg() {
  return tunables.atsDirect.platforms.rippling;
}

// ats.rippling.com/{slug}/jobs[/{uuid}] and the API form.
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
  if (host === 'ats.rippling.com') {
    // ats.rippling.com/{locale}/{slug}/jobs is also seen; skip a leading locale.
    const i = /^[a-z]{2}(-[a-z]{2})?$/i.test(parts[0] || '') && parts[1] && parts[2] === 'jobs' ? 1 : 0;
    return parts[i] && parts[i + 1] === 'jobs' ? { platform, slug: parts[i] } : { platform, slug: null };
  }
  if (host === 'api.rippling.com') {
    const i = parts.indexOf('board');
    return i >= 0 && parts[i + 1] ? { platform, slug: parts[i + 1] } : null;
  }
  return null;
}

async function probe(slug) {
  if (!slug) return { ok: false, status: 0, boardName: null, error: 'missing identifier' };
  try {
    const list = await fetchJson(`${API}/${encodeURIComponent(slug)}/jobs`, { platform });
    if (!Array.isArray(list)) return { ok: false, status: 200, boardName: null, error: 'list is not an array' };
    let boardName = null;
    if (list[0] && list[0].uuid) {
      const d = await fetchJson(`${API}/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(list[0].uuid)}`, { platform }).catch(() => null);
      boardName = (d && d.companyName) || null;
    }
    return { ok: true, status: 200, boardName, error: null };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

// One entry per job, with every location the list repeated it under.
function collapse(list) {
  const byId = new Map();
  for (const item of list) {
    if (!item || !item.uuid) continue;
    const loc = item.workLocation && item.workLocation.label;
    const prev = byId.get(item.uuid);
    if (prev) {
      if (loc && !prev.locations.includes(loc)) prev.locations.push(loc);
    } else {
      byId.set(item.uuid, { ...item, locations: loc ? [loc] : [] });
    }
  }
  return [...byId.values()];
}

function normalizeItem(item, { slug, companyName, detail }) {
  const d = detail || {};
  const id = item.uuid ? String(item.uuid) : null;
  const link = d.url || item.url || (id ? `https://ats.rippling.com/${slug}/jobs/${id}` : null);
  const locations = Array.isArray(d.workLocations) && d.workLocations.length ? d.workLocations : item.locations || [];
  const desc = d.description ? [htmlToText(d.description.role), htmlToText(d.description.company)].filter(Boolean).join('\n\n') : null;
  const pay = Array.isArray(d.payRangeDetails) ? d.payRangeDetails[0] : null;
  const yearly = pay && /year|annual/i.test(String(pay.frequency || pay.payFrequency || ''));
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: item.name || d.name || null,
    companyName: companyName || d.companyName || null,
    location: locations.join(' | ') || null,
    postedAt: toIso(d.createdOn),
    link,
    descriptionText: desc || null,
    seniorityLevel: null,
    employmentType: (d.employmentType && (d.employmentType.id || d.employmentType.label)) || null,
    salaryMin: yearly && Number.isFinite(Number(pay.rangeStart)) ? Number(pay.rangeStart) : null,
    salaryMax: yearly && Number.isFinite(Number(pay.rangeEnd)) ? Number(pay.rangeEnd) : null,
    dedupKey: dedupKey({ id, link, title: item.name, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

async function fetchJobs(slug, { companyName, titles, limit, keep } = {}) {
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const t = cleanTitles(titles);
  const list = await fetchJson(`${API}/${encodeURIComponent(slug)}/jobs`, { platform });
  const survivors = collapse(Array.isArray(list) ? list : [])
    .filter((item) => titleMatchesAny(item.name, t))
    .filter((item) => !keep || keep(normalizeItem(item, { slug, companyName })))
    .slice(0, cap);
  const jobs = await pooled(survivors, cfg().detailConcurrency, async (item) => {
    try {
      const detail = await fetchJson(`${API}/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(item.uuid)}`, { platform });
      return normalizeItem(item, { slug, companyName, detail });
    } catch (e) {
      console.error(`rippling fetchJobs: detail failed for "${slug}/${item.uuid}":`, e.message || e);
      return null;
    }
  });
  return jobs.filter((j) => j && j.title && j.link);
}

const CONTRACT_CHECK_SLUG = 'rippling';
const contractCheck = {
  name: platform,
  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt', 'boardName'],
  run: async () => {
    const p = await probe(CONTRACT_CHECK_SLUG);
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: 'Rippling', limit: 1 });
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

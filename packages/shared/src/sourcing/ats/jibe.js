// iCIMS career-site adapter ("Jibe") — ATS Direct enterprise platform set
// (§15 #65). Jibe is the career-site product iCIMS acquired; the companies on
// it front an iCIMS ATS with a site on their own domain. Verified live
// 2026-09-26 on State Farm, PepsiCo, Constellation, AMD, Exelon and Principal:
//
//   list: GET https://{host}/api/jobs?page={n}&limit={n}[&keywords={text}]
//         -> { totalCount, count, jobs: [{ data: { slug, req_id, title,
//              description (HTML), qualifications, responsibilities, city,
//              state, country, full_location, location_name, posted_date,
//              employment_type, hiring_organization, apply_url, language } }] }
//   job:  https://{host}{basePath}/jobs/{slug}?lang={language}
//         where basePath is the section the site root redirects to
//         ("/main" at State Farm and PepsiCo, "/careers-home" at AMD/Exelon).
//
// The API carries full description text at list time — no detail fan-out —
// and `keywords` narrows server-side, so the adapter runs one pass per scan
// title. `hiring_organization` is the company's own name and is returned as
// the board name.
//
// Identifier is "{host}" or "{host}{basePath}" (e.g. "jobs.statefarm.com/main");
// the API always lives at the host root, the base path only shapes job links.
// A bare-host identifier resolves its base path from the root redirect once
// per fetch.
//
// Never in name-guess: the host is the company's own domain.

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { fetchJson, request, cleanTitles, titleMatchesAny, toIso } = require('./webFetch');

const platform = 'jibe';

function cfg() {
  return tunables.atsDirect.platforms.jibe;
}

function parseIdentifier(id) {
  if (!id) return null;
  const s = String(id).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const [host, ...rest] = s.split('/');
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null;
  return { host: host.toLowerCase(), basePath: rest.length ? `/${rest.join('/')}` : null };
}

// {host}/{base}/jobs/{id}[?lang=..] (a job page) or {host}/api/jobs (the API).
// The job-page shape is not a unique signature, so it is only a candidate that
// detect.js probes; this adapter sits after every host-signature adapter.
function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (/(^|\.)icims\.com$/.test(host)) return null; // classic portal — icims.js
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts[0] === 'api' && parts[1] === 'jobs') return { platform, slug: host };
  const i = parts.indexOf('jobs');
  if (i < 0 || parts.length !== i + 2 || !/^[A-Za-z0-9-]*\d[A-Za-z0-9-]*$/.test(parts[i + 1])) return null;
  // Every Jibe job link carries ?lang=; without it "/jobs/{id}" is far too
  // common a shape (a Greenhouse board URL has it) to even be a candidate.
  if (!parsed.searchParams.has('lang')) return null;
  const base = parts.slice(0, i).join('/');
  return { platform, slug: base ? `${host}/${base}` : host };
}

function apiUrl(host, { page, limit, keywords }) {
  const p = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (keywords) p.set('keywords', keywords);
  return `https://${host}/api/jobs?${p.toString()}`;
}

async function resolveBasePath(parsed) {
  if (parsed.basePath != null) return parsed.basePath;
  try {
    const { finalUrl } = await request(`https://${parsed.host}/`, { platform, accept: 'text/html', browser: true });
    const path = new URL(finalUrl).pathname.replace(/\/+$/, '');
    return path.replace(/\/jobs$/, '');
  } catch {
    return '';
  }
}

async function probe(id) {
  const parsed = parseIdentifier(id);
  if (!parsed) return { ok: false, status: 0, boardName: null, error: 'malformed identifier' };
  try {
    const body = await fetchJson(apiUrl(parsed.host, { page: 1, limit: 1 }), { platform });
    const first = Array.isArray(body?.jobs) ? body.jobs[0] : null;
    return { ok: !!first, status: 200, boardName: (first && first.data && first.data.hiring_organization) || null, error: first ? null : 'no jobs' };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

function locationOf(d) {
  if (d.full_location) return d.full_location;
  return [d.city, d.state, d.country].filter(Boolean).join(', ') || d.location_name || null;
}

function normalizeItem(d, { slug, companyName, host, basePath }) {
  const id = d.req_id || d.slug || null;
  const lang = d.language || 'en-us';
  const link = d.slug ? `https://${host}${basePath || ''}/jobs/${encodeURIComponent(d.slug)}?lang=${encodeURIComponent(lang)}` : null;
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: d.title || null,
    companyName: companyName || d.hiring_organization || null,
    location: d.multipleLocations && locationOf(d) ? `${locationOf(d)} (+ more)` : locationOf(d),
    postedAt: toIso(d.posted_date || d.create_date),
    link,
    descriptionText: null,
    seniorityLevel: null,
    employmentType: d.employment_type || null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id, link, title: d.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

function describe(d) {
  return [d.description, d.responsibilities, d.qualifications].map(htmlToText).filter(Boolean).join('\n\n') || null;
}

async function fetchJobs(slug, { companyName, titles, limit, keep } = {}) {
  const parsed = parseIdentifier(slug);
  if (!parsed) throw new Error(`Jibe: malformed identifier "${slug}"`);
  const c = cfg();
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const t = cleanTitles(titles);
  const basePath = await resolveBasePath(parsed);
  const byId = new Map();
  const kept = [];
  for (const kw of t.length ? t : ['']) {
    for (let page = 1; page <= c.maxListPages && kept.length < cap; page++) {
      const body = await fetchJson(apiUrl(parsed.host, { page, limit: c.pageSize, keywords: kw }), { platform });
      const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
      for (const { data } of jobs) {
        if (!data || byId.has(data.slug)) continue;
        byId.set(data.slug, true);
        // `external` reads false on every live posting (AMD, State Farm), so it
        // is not a visibility flag; `internal: true` is the internal-only one.
        if (data.searchable === false || data.internal === true) continue;
        if (!titleMatchesAny(data.title, t)) continue;
        const job = normalizeItem(data, { slug, companyName, host: parsed.host, basePath });
        if (!job.title || !job.link || (keep && !keep(job))) continue;
        job.descriptionText = describe(data);
        kept.push(job);
        if (kept.length >= cap) break;
      }
      if (!jobs.length || page * c.pageSize >= (body.totalCount || 0)) break;
    }
  }
  return kept;
}

const CONTRACT_CHECK_SLUG = 'careers.amd.com/careers-home';
const contractCheck = {
  name: platform,
  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt', 'boardName'],
  run: async () => {
    const p = await probe(CONTRACT_CHECK_SLUG);
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: 'AMD', limit: 1 });
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

module.exports = { platform, parseIdentifier, extractSlugFromUrl, probe, fetchJobs, normalizeItem, contractCheck };

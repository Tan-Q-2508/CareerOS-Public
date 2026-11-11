// Breezy HR adapter — ATS Direct, SMB/startup platform set (§15 #65).
//
// Verified live 2026-09-26 (beli, tristero, subscribe):
//   list:   GET https://{slug}.breezy.hr/json
//           -> [{ id, friendly_id, name, url, published_date, type: { name },
//                location: { name, city, state: { name }, country: { name }, is_remote },
//                department, salary (display string), company: { name, friendly_id } }]
//   detail: GET https://{slug}.breezy.hr/p/{friendly_id}   (server-rendered HTML)
//           -> the posting body sits in <div class="description">
// The JSON feed carries no description, so this is list-then-detail. An
// unknown slug is a clean 404 ("Career portal not found").
//
// Every list item repeats `company.name`, which lets detect.js name-verify a
// guessed slug (VERIFIES_BOARD_NAME). A real board with no open positions
// returns [] and therefore no name — a guess against it is rejected, the
// conservative outcome.

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { fetchJson, fetchText, pooled, cleanTitles, titleMatchesAny, toIso, innerHtmlByAttr } = require('./webFetch');

const platform = 'breezy';

function cfg() {
  return tunables.atsDirect.platforms.breezy;
}

function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const m = /^([a-z0-9-]+)\.breezy\.hr$/.exec(parsed.hostname.toLowerCase());
  if (!m || ['www', 'app', 'api', 'jobs', 'assets-cdn', 'gallery-cdn'].includes(m[1])) return null;
  return { platform, slug: m[1] };
}

function feedUrl(slug) {
  return `https://${encodeURIComponent(slug)}.breezy.hr/json`;
}

async function probe(slug) {
  if (!slug) return { ok: false, status: 0, boardName: null, error: 'missing identifier' };
  try {
    const body = await fetchJson(feedUrl(slug), { platform });
    if (!Array.isArray(body)) return { ok: false, status: 200, boardName: null, error: 'feed is not an array' };
    return { ok: true, status: 200, boardName: (body[0] && body[0].company && body[0].company.name) || null, error: null };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

function locationOf(p) {
  const l = p.location || {};
  const s = l.name || [l.city, l.state && l.state.name, l.country && l.country.name].filter(Boolean).join(', ') || null;
  return l.is_remote ? (s ? `${s} (Remote)` : 'Remote') : s;
}

function normalizeItem(p, { slug, companyName }) {
  const id = p.id != null ? String(p.id) : null;
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: p.name || null,
    companyName: companyName || (p.company && p.company.name) || null,
    location: locationOf(p),
    postedAt: toIso(p.published_date),
    link: p.url || (p.friendly_id ? `https://${slug}.breezy.hr/p/${p.friendly_id}` : null),
    descriptionText: null,
    seniorityLevel: null,
    employmentType: (p.type && p.type.name) || null,
    // `salary` is a free-text display string ("$90,000 – $120,000 / year");
    // parsing it into numbers would be a guess, so the columns stay null and
    // the string is appended to the description instead.
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id, link: p.url, title: p.name, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

async function fetchJobs(slug, { companyName, titles, limit, keep } = {}) {
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const t = cleanTitles(titles);
  const feed = await fetchJson(feedUrl(slug), { platform });
  const survivors = (Array.isArray(feed) ? feed : [])
    .filter((p) => titleMatchesAny(p.name, t))
    .map((p) => ({ p, job: normalizeItem(p, { slug, companyName }) }))
    .filter(({ job }) => job.title && job.link && (!keep || keep(job)))
    .slice(0, cap);
  const jobs = await pooled(survivors, cfg().detailConcurrency, async ({ p, job }) => {
    try {
      const html = await fetchText(job.link, { platform });
      const body = innerHtmlByAttr(html, 'class', 'description');
      const text = htmlToText(body);
      job.descriptionText = [text, p.salary ? `Salary: ${p.salary}` : null].filter(Boolean).join('\n\n') || null;
      return job;
    } catch (e) {
      console.error(`breezy fetchJobs: detail failed for "${job.link}":`, e.message || e);
      return null;
    }
  });
  return jobs.filter(Boolean);
}

const CONTRACT_CHECK_SLUG = 'beli';
const contractCheck = {
  name: platform,
  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt', 'boardName'],
  run: async () => {
    const p = await probe(CONTRACT_CHECK_SLUG);
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: 'Beli', limit: 1 });
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

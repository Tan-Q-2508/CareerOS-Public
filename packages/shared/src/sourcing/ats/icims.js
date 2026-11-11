// iCIMS classic portal adapter — ATS Direct enterprise platform set (§15 #65).
//
// The server-rendered iCIMS job portal ({portal}.icims.com), verified live
// 2026-09-26 on Charles Schwab (career-schwab), StoneX (careers-stonex) and
// General Dynamics Electric Boat (careers-gdeb):
//   list:   GET https://{portal}.icims.com/jobs/search?pr={page}&in_iframe=1[&searchKeyword={text}]
//           -> <li class="iCIMS_JobCardItem"> cards, each with an
//              a.iCIMS_Anchor href=".../jobs/{id}/{slug}/job?in_iframe=1"
//              title="{id} - {Title}", a "Job Locations" field, and
//              "Page X of Y" paging (pr is 0-based)
//   detail: GET the card's href -> a schema.org JobPosting in ld+json with
//           description, datePosted, jobLocation, employmentType and
//           hiringOrganization.
//
// Many iCIMS customers put a career SITE in front of the portal instead; the
// portal then only answers with a `window.top.location` redirect to that site
// (Costco -> careers.costco.com, Charter -> jobs.spectrum.com). Those sites are
// read by jibe.js or radancy.js; this adapter reports the redirect stub as a
// clean miss rather than following it into a different platform's shape.
//
// Identifier is the portal host. Never in name-guess (portal names like
// "career-schwab" and "careers-gdeb" are not derivable from a company name).

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText, decodeEntities } = require('./htmlToText');
const { fetchText, pooled, cleanTitles, titleMatchesAny, toIso, extractJobPostings, jobPostingLocation } = require('./webFetch');

const platform = 'icims';
const VENDOR_HOSTS = new Set(['www.icims.com', 'icims.com', 'careers.icims.com', 'developer.icims.com', 'community.icims.com']);

function cfg() {
  return tunables.atsDirect.platforms.icims;
}

function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!/^[a-z0-9-]+\.icims\.com$/.test(host) || VENDOR_HOSTS.has(host)) return null;
  if (/^(internal|events|images|cdn)-/.test(host)) return null; // employee-only / asset hosts
  return { platform, slug: host };
}

function searchUrl(host, { page, keyword }) {
  const p = new URLSearchParams({ pr: String(page), in_iframe: '1' });
  if (keyword) {
    p.set('searchKeyword', keyword);
    p.set('searchRelation', 'keyword_all');
  }
  return `https://${host}/jobs/search?${p.toString()}`;
}

// Cards of one results page -> [{ id, title, link, location }].
function parseCards(html, host) {
  const s = String(html);
  const esc = host.replace(/\./g, '\\.');
  const re = new RegExp(`<a[^>]+href="(https://${esc}/jobs/(\\d+)/[^"]*)"[^>]*>`, 'gi');
  const anchors = [...s.matchAll(re)];
  const out = [];
  const seen = new Set();
  for (let k = 0; k < anchors.length; k++) {
    const [tag, rawHref, id] = anchors[k];
    if (seen.has(id)) continue;
    seen.add(id);
    // The card spans from the <li> that opened before this anchor to the next
    // anchor — the location field sits BEFORE the title in the card markup.
    const cardStart = Math.max(s.lastIndexOf('<li', anchors[k].index), k ? anchors[k - 1].index + 1 : 0);
    const cardEnd = k + 1 < anchors.length ? anchors[k + 1].index : s.length;
    const card = s.slice(cardStart, cardEnd);
    const titleAttr = /title="([^"]*)"/.exec(tag);
    const h = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(card.slice(card.indexOf(tag)));
    let title = h ? h[1] : titleAttr ? titleAttr[1].replace(/^\s*\d+\s*-\s*/, '') : '';
    title = decodeEntities(title.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const loc = /Job Locations?<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i.exec(card);
    out.push({
      id,
      title: title || null,
      link: decodeEntities(rawHref),
      location: loc ? decodeEntities(loc[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || null : null,
    });
  }
  return out;
}

function pageCount(html) {
  const m = /Page\s+\d+\s+of\s+(\d+)/i.exec(String(html));
  return m ? Number(m[1]) : 1;
}

async function listRows(host, { keyword, cap }) {
  const out = [];
  let pages = 1;
  for (let page = 0; page < Math.min(pages, cfg().maxListPages); page++) {
    const html = await fetchText(searchUrl(host, { page, keyword }), { platform });
    if (page === 0 && /window\.top\.location/.test(html) && !/iCIMS_/.test(html)) {
      const err = new Error(`iCIMS portal ${host} redirects to a separate career site`);
      err.status = 404;
      throw err;
    }
    out.push(...parseCards(html, host));
    pages = pageCount(html);
    if (out.length >= cap) break;
  }
  return out;
}

async function probe(host) {
  if (!host) return { ok: false, status: 0, boardName: null, error: 'missing identifier' };
  try {
    const rows = await listRows(String(host).toLowerCase(), { keyword: '', cap: 1 });
    return { ok: rows.length > 0, status: 200, boardName: null, error: rows.length ? null : 'no postings' };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

function normalizeItem(row, { slug, companyName, jp }) {
  const posting = jp || {};
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: row.title || posting.title || null,
    companyName: companyName || (posting.hiringOrganization && posting.hiringOrganization.name) || null,
    location: row.location || jobPostingLocation(posting),
    postedAt: toIso(posting.datePosted),
    link: row.link,
    descriptionText: posting.description ? htmlToText(posting.description) : null,
    seniorityLevel: null,
    employmentType: Array.isArray(posting.employmentType) ? posting.employmentType.join(', ') : posting.employmentType || null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id: row.id, link: row.link, title: row.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

async function fetchJobs(slug, { companyName, titles, limit, keep } = {}) {
  const host = String(slug || '').toLowerCase();
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const t = cleanTitles(titles);
  const byId = new Map();
  for (const kw of t.length ? t : ['']) {
    for (const row of await listRows(host, { keyword: kw, cap: cap * 4 })) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }
  const survivors = [...byId.values()]
    .filter((row) => row.title && titleMatchesAny(row.title, t))
    .filter((row) => !keep || keep(normalizeItem(row, { slug, companyName })))
    .slice(0, cap);
  const jobs = await pooled(survivors, cfg().detailConcurrency, async (row) => {
    try {
      const html = await fetchText(row.link, { platform });
      return normalizeItem(row, { slug, companyName, jp: extractJobPostings(html)[0] });
    } catch (e) {
      console.error(`icims fetchJobs: detail failed for "${row.link}":`, e.message || e);
      return null;
    }
  });
  return jobs.filter(Boolean);
}

const CONTRACT_CHECK_SLUG = 'career-schwab.icims.com';
const contractCheck = {
  name: platform,
  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt', 'firstLocation'],
  run: async () => {
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: 'Charles Schwab', limit: 1 });
    const first = jobs[0] || {};
    return {
      jobs: jobs.length ? jobs : null,
      firstTitle: first.title || null,
      firstLink: first.link || null,
      firstDescription: first.descriptionText || null,
      firstPostedAt: first.postedAt || null,
      firstLocation: first.location || null,
    };
  },
};

module.exports = { platform, extractSlugFromUrl, probe, fetchJobs, normalizeItem, parseCards, contractCheck };

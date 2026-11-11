// SAP SuccessFactors adapter (Career Site Builder) — ATS Direct enterprise
// platform set (§15 #65). The ATS behind a dozen Fortune-200 career sites
// (ExxonMobil, Phillips 66, American Airlines, NextEra, Colgate, Deere, ...).
//
// A Career Site Builder (CSB) site lives on the company's own domain
// (jobs.exxonmobil.com), so the identifier is that HOST, optionally with a
// path prefix when the site is mounted under one — never a guessed value.
// Two CSB template generations exist in the wild, verified live 2026-09-26,
// and a tenant answers exactly one of them:
//
//   1. The newer ("Unify") template exposes a JSON search API:
//        POST https://{site}/services/recruiting/v1/jobs
//             { locale, pageNumber, keywords, ... }   (10 per page)
//        -> { totalJobs, jobSearchResult: [{ response: { id,
//             unifiedStandardTitle, jobLocationShort[], unifiedStandardStart,
//             urlTitle, supportedLocales[] } }] }
//      Job page: https://{site}/job/{urlTitle}/{id}-{locale}/
//      (jobs.aa.com, jobs.colgate.com). The classic tenants answer this POST
//      with 401.
//   2. The classic template renders results server-side:
//        GET https://{site}/search/?q={kw}&sortColumn=referencedate&sortDirection=desc&startrow={n}
//        -> <tr class="data-row"> rows with a.jobTitle-link, span.jobLocation,
//           span.jobDate, and "Results <b>1 – 25</b> of <b>582</b>"
//      (jobs.exxonmobil.com, careers.phillips66.com, ...).
//
// Both templates serve the same job page: schema.org microdata with the
// posting body in `itemprop="description"`, plus (classic) `datePosted` and
// `hiringOrganization` metas. `q`/`keywords` narrow server-side (they match
// body text too), so the adapter runs one pass per scan title and still
// applies the local title match before the detail fan-out.
//
// SuccessFactors' OTHER public surface, the classic career portal
// (career4.successfactors.com/career?company=...), is a session-driven JSF app
// with no stable listing endpoint — deliberately not matched here (PACCAR is
// the known case, left unresolved in data/ats-research/fortune200_us.csv).
//
// Never in name-guess: a company's own domain is not derivable from its name.

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText, decodeEntities } = require('./htmlToText');
const { fetchJson, fetchText, pooled, cleanTitles, titleMatchesAny, toIso, innerHtmlAt } = require('./webFetch');

const platform = 'successfactors';

function cfg() {
  return tunables.atsDirect.platforms.successfactors;
}

// "{host}" or "{host}/{prefix}" — no scheme, no trailing slash.
function parseIdentifier(id) {
  if (!id) return null;
  const s = String(id).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const [host, ...rest] = s.split('/');
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null;
  return { host: host.toLowerCase(), prefix: rest.length ? `/${rest.join('/')}` : '' };
}

function siteBase(id) {
  const p = parseIdentifier(id);
  return p ? `https://${p.host}${p.prefix}` : null;
}

// Job-page shapes of both templates:
//   classic  /job/{Slug}/{digits}/
//   newer    /job/{Title}/{digits}-{xx_XX}/
// A candidate only — detect.js always probes before accepting a URL match, and
// this adapter sits after every host-signature adapter in URL_MATCH_ADAPTERS.
function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (/(^|\.)successfactors\.(com|eu)$/.test(host)) return null; // classic portal, see header
  const parts = parsed.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('job');
  if (i < 0 || parts.length !== i + 3) return null;
  const last = parts[i + 2];
  if (!/^\d{5,}$/.test(last) && !/^\d{3,}-[a-z]{2}_[A-Z]{2}$/.test(last)) return null;
  const prefix = parts.slice(0, i).join('/');
  return { platform, slug: prefix ? `${host}/${prefix}` : host };
}

function unifyBody({ page, keywords, locale }) {
  return JSON.stringify({
    locale: locale || 'en_US',
    pageNumber: page,
    sortBy: '',
    keywords: keywords || '',
    location: '',
    facetFilters: {},
    brand: '',
    skills: [],
    categoryId: 0,
    alertId: '',
    rcmCandidateId: '',
  });
}

async function unifyPage(base, { page, keywords }) {
  return fetchJson(`${base}/services/recruiting/v1/jobs`, {
    platform,
    method: 'POST',
    body: unifyBody({ page, keywords }),
    headers: { 'Content-Type': 'application/json' },
    browser: true,
  });
}

function classicUrl(base, { keywords, startrow }) {
  const p = new URLSearchParams({ q: keywords || '', sortColumn: 'referencedate', sortDirection: 'desc', startrow: String(startrow) });
  return `${base}/search/?${p.toString()}`;
}

function spanText(block, cls) {
  const m = new RegExp(`class="${cls}[^"]*"[^>]*>([\\s\\S]*?)<\\/span>`, 'i').exec(block);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || null : null;
}

// Rows of one classic results page -> [{ id, title, link, location, date }].
function parseClassicRows(html, base) {
  const rows = [];
  for (const part of String(html).split(/<tr class="data-row/).slice(1)) {
    const block = part.split('</tr>')[0];
    const a = /<a[^>]*href="([^"]*\/job\/[^"]+)"[^>]*class="jobTitle-link"[^>]*>([\s\S]*?)<\/a>|<a[^>]*class="jobTitle-link"[^>]*href="([^"]*\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const href = a[1] || a[3];
    const title = decodeEntities((a[2] || a[4] || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const idm = /\/(\d{5,})\/?$/.exec(href.split('?')[0]);
    rows.push({
      id: idm ? idm[1] : href,
      title,
      link: new URL(href, `${base}/`).href,
      location: spanText(block, 'jobLocation'),
      date: spanText(block, 'jobDate'),
    });
  }
  return rows;
}

function classicTotal(html) {
  const m = /of <b>([\d,]+)<\/b>/.exec(String(html));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

// Which template this tenant runs, decided once per fetch: the JSON API
// answers 401 on a classic tenant, and a classic tenant's search page is the
// fallback. Returns rows in one shape either way.
async function listRows(base, { keywords, cap }) {
  const c = cfg();
  let unifyAnswered = false;
  try {
    const out = [];
    for (let page = 0; page < c.maxListPages; page++) {
      const body = await unifyPage(base, { page, keywords });
      unifyAnswered = true;
      const results = Array.isArray(body?.jobSearchResult) ? body.jobSearchResult : null;
      if (!results) throw Object.assign(new Error('no jobSearchResult'), { status: 200 });
      for (const r of results) {
        const x = r && r.response;
        if (!x || !x.id) continue;
        const locale = (x.supportedLocales && x.supportedLocales[0]) || 'en_US';
        // urlTitle arrives already URL-encoded ("AnalystSr-Analyst%2C-...");
        // encoding it again produced %252C links that 404.
        const slug = x.urlTitle || x.unifiedUrlTitle || 'job';
        out.push({
          id: String(x.id),
          title: x.unifiedStandardTitle || null,
          link: `${base}/job/${slug}/${encodeURIComponent(x.id)}-${locale}/`,
          location: Array.isArray(x.jobLocationShort) ? x.jobLocationShort.map((s) => String(s).trim()).join(' | ') : null,
          date: x.unifiedStandardStart || null,
        });
      }
      if (!results.length || out.length >= (body.totalJobs || 0) || out.length >= cap) break;
    }
    return out;
  } catch (e) {
    // Only a refusal of the FIRST JSON call means "classic tenant". A JSON
    // tenant failing on a later page is a real failure, not a template switch
    // — falling back there would mix two listings.
    if (unifyAnswered || ![200, 400, 401, 403, 404, 405].includes(e.status)) throw e;
  }
  const out = [];
  for (let page = 0, startrow = 0; page < c.maxListPages; page++) {
    const html = await fetchText(classicUrl(base, { keywords, startrow }), { platform, browser: true });
    const rows = parseClassicRows(html, base);
    out.push(...rows);
    const total = classicTotal(html);
    startrow += rows.length;
    if (!rows.length || total == null || startrow >= total || out.length >= cap) break;
  }
  return out;
}

async function probe(id) {
  const base = siteBase(id);
  if (!base) return { ok: false, status: 0, boardName: null, error: 'malformed identifier' };
  try {
    const rows = await listRows(base, { keywords: '', cap: 1 });
    return { ok: rows.length > 0, status: 200, boardName: null, error: rows.length ? null : 'no postings found' };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

function meta(html, prop) {
  const m = new RegExp(`itemprop="${prop}"[^>]*content="([^"]*)"`, 'i').exec(html) || new RegExp(`content="([^"]*)"[^>]*itemprop="${prop}"`, 'i').exec(html);
  return m ? decodeEntities(m[1]).trim() : null;
}

// Several templates split the posting across more than one
// `itemprop="description"` element (American Airlines renders a short
// location/requisition header in the first and the body in a later one), so
// every one is read and the distinct texts joined in page order.
function parseDetail(html) {
  const s = String(html);
  const texts = [];
  for (const m of s.matchAll(/itemprop="description"/gi)) {
    const open = s.lastIndexOf('<', m.index);
    const text = open >= 0 ? htmlToText(innerHtmlAt(s, open)) : null;
    if (text && !texts.some((t) => t.includes(text))) texts.push(text);
  }
  return {
    description: texts.join('\n\n') || null,
    datePosted: meta(html, 'datePosted'),
    hiringOrganization: meta(html, 'hiringOrganization'),
  };
}

function normalizeItem(row, { slug, companyName, detail }) {
  const d = detail || {};
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: row.title || null,
    companyName: companyName || d.hiringOrganization || null,
    location: row.location || null,
    postedAt: toIso(d.datePosted) || toIso(row.date),
    link: row.link || null,
    descriptionText: d.description || null,
    seniorityLevel: null,
    employmentType: null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id: row.id, link: row.link, title: row.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

async function fetchJobs(slug, { companyName, titles, limit, keep } = {}) {
  const base = siteBase(slug);
  if (!base) throw new Error(`SuccessFactors: malformed identifier "${slug}"`);
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const t = cleanTitles(titles);
  const byId = new Map();
  for (const kw of t.length ? t : ['']) {
    for (const row of await listRows(base, { keywords: kw, cap: cap * 4 })) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }
  const survivors = [...byId.values()]
    .filter((row) => titleMatchesAny(row.title, t))
    .filter((row) => row.title && row.link && (!keep || keep(normalizeItem(row, { slug, companyName }))))
    .slice(0, cap);
  const jobs = await pooled(survivors, cfg().detailConcurrency, async (row) => {
    try {
      const html = await fetchText(row.link, { platform, browser: true });
      return normalizeItem(row, { slug, companyName, detail: parseDetail(html) });
    } catch (e) {
      console.error(`successfactors fetchJobs: detail failed for "${row.link}":`, e.message || e);
      return null;
    }
  });
  return jobs.filter(Boolean);
}

// Contract-drift canary (18.3). Two tenants, one per template generation, so
// a change to either one is visible. Asserts on the normalized job.
const CANARIES = [
  { slug: 'jobs.exxonmobil.com', name: 'ExxonMobil' },
  { slug: 'jobs.aa.com', name: 'American Airlines' },
];
const contractCheck = {
  name: platform,
  requiredFields: ['classicTitle', 'classicLink', 'classicDescription', 'classicPostedAt', 'unifyTitle', 'unifyLink', 'unifyDescription', 'unifyPostedAt'],
  run: async () => {
    const [classic, unify] = await Promise.all(
      CANARIES.map((c) => fetchJobs(c.slug, { companyName: c.name, limit: 1 }).then((j) => j[0] || {}))
    );
    return {
      classicTitle: classic.title || null,
      classicLink: classic.link || null,
      classicDescription: classic.descriptionText || null,
      classicPostedAt: classic.postedAt || null,
      unifyTitle: unify.title || null,
      unifyLink: unify.link || null,
      unifyDescription: unify.descriptionText || null,
      unifyPostedAt: unify.postedAt || null,
    };
  },
};

module.exports = { platform, parseIdentifier, extractSlugFromUrl, probe, fetchJobs, normalizeItem, parseClassicRows, parseDetail, contractCheck };

// Oracle Taleo Enterprise adapter — ATS Direct enterprise platform set
// (§15 #65). Covers the careersections that run Taleo's REST job board;
// verified live 2026-09-26 against D.R. Horton (drhorton.taleo.net, section 2).
//
//   portal: the section's own jobsearch page embeds its job-board id:
//           GET https://{tenant}.taleo.net/careersection/{section}/jobsearch.ftl?lang=en
//           -> "...portal=101430233..."
//   list:   POST https://{tenant}.taleo.net/careersection/rest/jobboard/searchjobs?lang=en&portal={portal}
//           headers tz / tzname (without them the endpoint 500s with
//           "An Error Occurred in TEE" — the same two headers the page's own
//           script sends)
//           body { fieldData: { fields: { KEYWORD, LOCATION } }, pageNo, ... }
//           -> { requisitionList: [{ jobId, contestNo, column: [title,
//                "[\"Location\"]", "Sep 25, 2026"], linkedColumn, locationsColumns }],
//                pagingData: { currentPageNo, pageSize: 25, totalCount } }
//   detail: GET https://{tenant}.taleo.net/careersection/{section}/jobdetail.ftl?job={contestNo}&lang=en
//           The page is a JSF form whose content ships in one hidden input,
//           `initialHistory`, as "!|!"-separated fields; the HTML description
//           and qualification fields are the ones prefixed "!*!", with ':'
//           escaped as '\:'.
//
// Identifier is "{tenant}:{section}" (colon-delimited like workday.js's
// composite). The portal id is read from the live page at fetch time rather
// than stored, so a tenant re-issuing it cannot strand the row.
//
// LEGACY careersections (United Airlines' ual-pro 10400, Enterprise Products'
// epco) render no portal id — their search runs through a stateful ftl form
// post instead of this REST board. probe() reports those as a clean miss;
// they are recorded as unresolved in data/ats-research/fortune200_us.csv
// rather than scraped through a session-driven form.
//
// Never in name-guess: a {tenant, section} pair is not derivable from a name,
// and no board name is returned to verify against.

const tunables = require('../../tunables.json');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { fetchJson, fetchText, pooled, cleanTitles, titleMatchesAny, toIso } = require('./webFetch');

const platform = 'taleo';
const TZ_HEADERS = { tz: 'GMT-05:00', tzname: 'America/Chicago', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

function cfg() {
  return tunables.atsDirect.platforms.taleo;
}

function parseIdentifier(id) {
  if (!id) return null;
  const [tenant, section, ...rest] = String(id).split(':');
  if (rest.length || !tenant || !section || !/^[a-z0-9-]+$/i.test(tenant) || !/^[A-Za-z0-9_-]+$/.test(section)) return null;
  return { tenant: tenant.toLowerCase(), section };
}

function host(tenant) {
  return `https://${tenant}.taleo.net`;
}

// {tenant}.taleo.net/careersection/{section}/{page}.ftl — any page of a section.
function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const m = /^([a-z0-9-]+)\.taleo\.net$/.exec(parsed.hostname.toLowerCase());
  if (!m) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('careersection');
  const section = i >= 0 ? parts[i + 1] : null;
  if (!section || section === 'rest' || section === 'iam') return { platform, slug: null };
  return { platform, slug: `${m[1]}:${section}` };
}

async function portalId({ tenant, section }) {
  const html = await fetchText(`${host(tenant)}/careersection/${encodeURIComponent(section)}/jobsearch.ftl?lang=en`, { platform });
  const m = /portal=(\d{5,})/.exec(html);
  return m ? m[1] : null;
}

function searchBody({ keyword, pageNo }) {
  return JSON.stringify({
    multilineEnabled: false,
    sortingSelection: { sortBySelectionParam: '3', ascendingSortingOrder: 'false' },
    fieldData: { fields: { KEYWORD: keyword || '', LOCATION: '' }, valid: true },
    filterSelectionParam: { searchFilterSelections: [] },
    advancedSearchFiltersSelectionParam: { searchFilterSelections: [] },
    pageNo,
  });
}

async function searchPage({ tenant }, portal, { keyword, pageNo }) {
  return fetchJson(`${host(tenant)}/careersection/rest/jobboard/searchjobs?lang=en&portal=${portal}`, {
    platform,
    method: 'POST',
    body: searchBody({ keyword, pageNo }),
    headers: TZ_HEADERS,
    browser: true,
  });
}

// A requisition's columns are laid out by each section's own configuration,
// so the title column is `linkedColumn`, the location columns are
// `locationsColumns`, and the posting date is whichever remaining column
// parses as a date.
function readRow(req) {
  const cols = Array.isArray(req.column) ? req.column : [];
  const title = cols[req.linkedColumn != null ? req.linkedColumn : 0] || null;
  const locs = [];
  for (const i of req.locationsColumns || []) {
    const raw = cols[i];
    if (!raw) continue;
    try {
      const arr = JSON.parse(raw);
      locs.push(...(Array.isArray(arr) ? arr : [arr]));
    } catch {
      locs.push(raw);
    }
  }
  let date = null;
  cols.forEach((c, i) => {
    if (date || i === req.linkedColumn || (req.locationsColumns || []).includes(i)) return;
    if (/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(String(c || '').trim())) date = c;
  });
  return { id: String(req.contestNo || req.jobId), title: title ? String(title).trim() : null, location: locs.join(' | ') || null, date };
}

async function listRows(parsed, { keyword, cap }) {
  const portal = await portalId(parsed);
  if (!portal) {
    const err = new Error(`Taleo ${parsed.tenant}:${parsed.section} exposes no REST job board (legacy careersection)`);
    err.status = 404;
    throw err;
  }
  const out = [];
  for (let pageNo = 1; pageNo <= cfg().maxListPages; pageNo++) {
    const body = await searchPage(parsed, portal, { keyword, pageNo });
    const list = Array.isArray(body?.requisitionList) ? body.requisitionList : [];
    out.push(...list.map(readRow));
    const paging = body?.pagingData || {};
    if (!list.length || out.length >= (paging.totalCount || 0) || out.length >= cap) break;
  }
  return out;
}

async function probe(id) {
  const parsed = parseIdentifier(id);
  if (!parsed) return { ok: false, status: 0, boardName: null, error: 'malformed identifier' };
  try {
    const rows = await listRows(parsed, { keyword: '', cap: 1 });
    return { ok: rows.length > 0, status: 200, boardName: null, error: rows.length ? null : 'no requisitions' };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

// The "!*!" fields of the detail page's initialHistory input, decoded.
function parseDetail(html) {
  const m = /id="initialHistory"[^>]*value="([^"]*)"/.exec(String(html)) || /value="([^"]*)"[^>]*id="initialHistory"/.exec(String(html));
  if (!m) return { description: null };
  const decode = (p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return unescape(p);
    }
  };
  const texts = [];
  for (const raw of m[1].split('!|!')) {
    if (!raw.startsWith('!*!') && !decode(raw).startsWith('!*!')) continue;
    const html_ = decode(raw).replace(/^!\*!/, '').replace(/\\:/g, ':');
    const text = htmlToText(html_);
    if (text && !texts.includes(text)) texts.push(text);
  }
  return { description: texts.join('\n\n') || null };
}

function detailUrl({ tenant, section }, id) {
  return `${host(tenant)}/careersection/${encodeURIComponent(section)}/jobdetail.ftl?job=${encodeURIComponent(id)}&lang=en`;
}

function normalizeItem(row, { slug, companyName, parsed, detail }) {
  const link = detailUrl(parsed, row.id);
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: row.title || null,
    companyName: companyName || null,
    location: row.location || null,
    postedAt: toIso(row.date),
    link,
    descriptionText: (detail && detail.description) || null,
    seniorityLevel: null,
    employmentType: null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id: row.id, link, title: row.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

async function fetchJobs(slug, { companyName, titles, limit, keep } = {}) {
  const parsed = parseIdentifier(slug);
  if (!parsed) throw new Error(`Taleo: malformed identifier "${slug}"`);
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const t = cleanTitles(titles);
  const byId = new Map();
  for (const kw of t.length ? t : ['']) {
    for (const row of await listRows(parsed, { keyword: kw, cap: cap * 4 })) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }
  const survivors = [...byId.values()]
    .filter((row) => row.title && titleMatchesAny(row.title, t))
    .filter((row) => !keep || keep(normalizeItem(row, { slug, companyName, parsed })))
    .slice(0, cap);
  const jobs = await pooled(survivors, cfg().detailConcurrency, async (row) => {
    try {
      const html = await fetchText(detailUrl(parsed, row.id), { platform });
      return normalizeItem(row, { slug, companyName, parsed, detail: parseDetail(html) });
    } catch (e) {
      console.error(`taleo fetchJobs: detail failed for "${slug}/${row.id}":`, e.message || e);
      return null;
    }
  });
  return jobs.filter(Boolean);
}

const CONTRACT_CHECK_SLUG = 'drhorton:2';
const contractCheck = {
  name: platform,
  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt', 'firstLocation'],
  run: async () => {
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: 'D.R. Horton', limit: 1 });
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

module.exports = { platform, parseIdentifier, extractSlugFromUrl, probe, fetchJobs, normalizeItem, readRow, parseDetail, contractCheck };

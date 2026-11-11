// Avature adapter — ATS Direct Tier 2.5 (spec 18.1). Phase 5.5, §15 #41.
//
// §18.1 gated this platform on a build-time determination of whether a
// tenant carries a verifiable board name; live testing surfaced a more
// fundamental issue first, so this adapter's shape and honesty about its own
// limits matter more than usual — read this header before touching probe()
// or fetchJobs() below.
//
// LIVE FINDING: Avature's `{tenant}.avature.net` root is a recruiter LOGIN
// app, not a career board — every tenant tested (`pwc`, `deloitte`,
// `siemens`, `vodafone`, `ibmglobal`, `cisco`) returns an identical ~830-byte
// login redirect stub there, so a 200 at the root proves nothing about a
// public board existing. The real public portal lives at
// `{tenant}.avature.net/{site}/...` where `site` is a per-tenant name (e.g.
// Avature's own is "main", IBM's is "careers") — NOT derivable from the
// tenant or company name, so, like every other Tier 2.5 composite, this is
// URL-match-only and never joins the name-guess sweep.
//
// LIVE FINDING: unlike every other ATS Direct platform (Tier 1, Workday,
// Workable, Oracle, Eightfold), Avature exposes NO clean JSON API anywhere.
// The only machine-readable format found is an RSS 2.0 feed at
// `{site}/SearchJobs/feed/?jobRecordsPerPage=N` (title, link/guid, pubDate,
// and a "{location} - {reqId}" description — no full description text; a
// per-posting HTML fetch of the job's own detail page is required for that,
// scraped via a repeated `article__content__view__field__value` div class
// found consistent across every real posting checked). Both `jobRecordsPerPage`
// and `jobOffset` were found to have NO effect on Avature's own tenant (17
// items back regardless) — the feed appears to just return the tenant's
// whole open-board in one shot, same one-request-whole-board shape as
// Workable, just XML instead of JSON.
//
// LIVE FINDING, the one that matters most: **feasibility is genuinely
// tenant-dependent, not platform-wide.** Avature's own tenant
// (`careers.avature.net/main`) is NOT bot-protected — the feed and every
// job-detail page return real content, repeatably, with a plain
// `User-Agent`. A real enterprise customer tenant (IBM,
// `ibmglobal.avature.net/careers`) IS bot-protected — its HTML browse path
// serves an AWS WAF JavaScript challenge (`window.gokuProps` +
// `token.awswaf.com/challenge.js`, HTTP 202) and its feed path returns HTTP
// 200 with a genuinely empty body — reproduced repeatedly, with full
// browser-like headers, across multiple site-name guesses. This reads as an
// opt-in bot-management layer some Avature customers configure on top of
// their hosted portal, not a platform default; this codebase does not
// attempt to work around it (no CAPTCHA/challenge-solving, ever — 14). The
// practical consequence: `probe()` will correctly return `ok: false` for a
// bot-protected tenant, the exact same outcome as a genuinely dead board —
// this adapter simply won't resolve companies whose Avature tenant has this
// protection enabled, a real and expected limitation, not a bug to chase.
//
// Net effect: this adapter is real and useful for the (unknown, likely
// significant) share of Avature tenants without bot protection, and cleanly
// inert — never a false positive, never a workaround attempt — for the rest.
// Flagged here plainly per this session's own instruction not to guess
// through a live finding.

const tunables = require('../../tunables.json');
const { requestTimeoutMs } = require('./scanContext');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { UA, readBodyText } = require('./httpClient');
const { agent: defaultDispatcher } = require('./dispatcher');

const platform = 'avature';

function cfg() {
  return tunables.atsDirect.platforms.avature;
}

// slug_or_identifier is a composite "{tenant}:{site}" — colon-delimited,
// same reasoning as every other Tier 2.5 composite: `site` isn't derivable
// from the tenant/company name and must be captured from a real observed URL.
function buildIdentifier({ tenant, site }) {
  return `${tenant}:${site}`;
}

function parseIdentifier(id) {
  if (!id) return null;
  const parts = String(id).split(':');
  if (parts.length !== 2) return null;
  const [tenant, site] = parts;
  if (!tenant || !site) return null;
  return { tenant, site };
}

function siteBase({ tenant, site }) {
  return `https://${tenant}.avature.net/${site}`;
}

const LOCALE_RE = /^[a-z]{2}_[A-Z]{2}$/;

// Recognizes both the browser SearchJobs/JobDetail URL forms, with or
// without a leading locale segment (Avature's canonical guid/link URLs carry
// no locale prefix; its browsable SearchJobs URLs do). A bare tenant root
// with no path (the login-app case, see this module's header) yields
// "platform known, slug isn't" — same shape as Greenhouse's embedded
// `?gh_jid=` case.
function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const hostMatch = /^([a-z0-9-]+)\.avature\.net$/.exec(host);
  if (!hostMatch) return null;
  const [, tenant] = hostMatch;

  let parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length && LOCALE_RE.test(parts[0])) parts = parts.slice(1);
  const site = parts[0] || null;
  return site ? { platform, slug: buildIdentifier({ tenant, site }) } : { platform, slug: null };
}

async function getText(url, { ms, dispatcher = defaultDispatcher } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || requestTimeoutMs());
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal, dispatcher });
    const contentType = resp.headers.get('content-type') || '';
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${resp.status} from ${url}`);
      err.status = resp.status;
      throw err;
    }
    const text = await readBodyText(resp);
    return { text, contentType };
  } finally {
    clearTimeout(timer);
  }
}

function feedUrl({ tenant, site }) {
  return `${siteBase({ tenant, site })}/SearchJobs/feed/?jobRecordsPerPage=${cfg().feedRequestSize}`;
}

// Minimal RSS <item> extraction — deliberately regex-based rather than a new
// XML-parser dependency, matching this codebase's existing lightweight-regex
// posture (htmlToText.js) for a format this flat (no nested item-like tags
// in a job-board RSS feed).
function parseFeedItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const body = m[1];
    const title = extractCdataOrText(body, 'title');
    const link = extractTag(body, 'link') || extractTag(body, 'guid');
    const pubDate = extractTag(body, 'pubDate');
    const description = extractCdataOrText(body, 'description');
    if (title && link) items.push({ title, link, pubDate, description });
  }
  return items;
}

function extractTag(body, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(body);
  return m ? m[1].trim() : null;
}

function extractCdataOrText(body, tag) {
  const raw = extractTag(body, tag);
  if (raw == null) return null;
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw.trim());
  return (cdata ? cdata[1] : raw).trim();
}

// The feed's description is "{location} - {reqId}" — reqId is only ever
// numeric, so split on the LAST " - " and keep the left side as location.
// The id itself is read from the link's trailing numeric path segment
// instead of this string, which is more robust against a location that
// itself legitimately contains a hyphen.
function locationFromDescription(description) {
  if (!description) return null;
  const m = /^(.*)\s-\s\d+$/.exec(description);
  return (m ? m[1] : description).trim() || null;
}

function idFromLink(link) {
  const m = /\/(\d+)(?:[/?#]|$)/.exec(link || '');
  return m ? m[1] : null;
}

// Cheap existence probe: fetch the feed, ok iff it parses as XML and carries
// at least one item. A bot-protected tenant (this module's header) fails
// here cleanly — either a non-2xx, a non-XML content-type, or zero items —
// same as any other platform's "board doesn't respond usefully" case. A
// bogus tenant fails at DNS resolution before any status is seen. No board
// display name is exposed anywhere, so boardName is always null.
async function probe(id, { dispatcher } = {}) {
  const parsed = parseIdentifier(id);
  if (!parsed) return { ok: false, status: 0, boardName: null, error: 'malformed identifier' };
  try {
    const { text, contentType } = await getText(feedUrl(parsed), { dispatcher });
    if (!/xml/i.test(contentType)) return { ok: false, status: 200, boardName: null, error: 'non-XML response (likely bot-protected tenant)' };
    const items = parseFeedItems(text);
    return { ok: items.length > 0, status: 200, boardName: null, error: null };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length)))
    .fill(0)
    .map(async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return out;
}

function listItemMatchesTitle(item, title) {
  if (!title) return true;
  return !!(item.title && item.title.toLowerCase().includes(title.toLowerCase().trim()));
}

// Multi-title scans (4.6.15) — true if the item matches ANY of the given
// titles, or if the list is empty (no title filter at all).
function listItemMatchesAnyTitle(item, titles) {
  if (!titles || !titles.length) return true;
  return titles.some((t) => listItemMatchesTitle(item, t));
}

// Detail description is scraped from the job's own detail page: every
// occurrence of Avature's repeated field-value wrapper div (confirmed across
// real postings — intro, responsibilities, requirements, about-us each get
// their own instance), concatenated and run through htmlToText.
const FIELD_VALUE_RE = /class="article__content__view__field__value"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;

function extractDescriptionHtml(html) {
  const chunks = [];
  let m;
  FIELD_VALUE_RE.lastIndex = 0;
  while ((m = FIELD_VALUE_RE.exec(html))) chunks.push(m[1]);
  return chunks.join('\n');
}

function normalizeItem(feedItem, detailHtml, { slug, companyName }) {
  const id = idFromLink(feedItem.link);
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: feedItem.title || null,
    // Avature's payload carries no company name anywhere — from the caller,
    // same posture as every other adapter here.
    companyName: companyName || null,
    location: locationFromDescription(feedItem.description),
    postedAt: toIso(feedItem.pubDate),
    link: feedItem.link || null,
    descriptionText: htmlToText(extractDescriptionHtml(detailHtml || '')),
    seniorityLevel: null,
    employmentType: null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id, link: feedItem.link, title: feedItem.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pull every open posting for an Avature site, title-narrowed and
 * detail-enriched, normalized into the 4.2 internal schema. Returns an empty
 * array (not a throw) for a bot-protected tenant — same "probe would have
 * already said no" posture as any other clean miss.
 *
 * @param {string} slug composite "{tenant}:{site}" identifier
 * @param {{companyName?: string, titles?: string[], limit?: number, dispatcher?: *}} opts
 *   `titles` is applied as a local substring any-match against each feed
 *   item's own title — the feed exposes no server-side title filter to
 *   narrow against, unlike Workday/Oracle. `keep` is NOT applied here, same
 *   reasoning as those two adapters — location exists at list time but the
 *   full description only exists after the per-posting detail fetch below.
 */
async function fetchJobs(slug, { companyName, titles, limit, dispatcher } = {}) {
  const c = cfg();
  const parsed = parseIdentifier(slug);
  if (!parsed) throw new Error(`Avature: malformed identifier "${slug}"`);

  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const realTitles = Array.isArray(titles) ? titles.filter(Boolean) : titles ? [titles] : [];

  const { text, contentType } = await getText(feedUrl(parsed), { dispatcher });
  if (!/xml/i.test(contentType)) return []; // bot-protected or otherwise non-functional tenant
  const feedItems = parseFeedItems(text);

  const survivors = feedItems.filter((item) => listItemMatchesAnyTitle(item, realTitles)).slice(0, cap);

  const results = await pooled(survivors, c.detailConcurrency, async (item) => {
    try {
      const { text: detailHtml } = await getText(item.link, { dispatcher });
      return normalizeItem(item, detailHtml, { slug, companyName });
    } catch (e) {
      // Per-company failure isolation (12.4) is the CALLER's job for a whole
      // board going down; one bad posting detail inside an otherwise-healthy
      // board must not take the rest of the board down with it.
      console.error(`avature fetchJobs: detail fetch failed for "${item.link}":`, e.message || e);
      return null;
    }
  });

  return results.filter((j) => j && j.title && j.link);
}

// Contract-drift canary (18.3, §15 #44) — the most load-bearing of the eight,
// because this is the only adapter with no JSON anywhere: an RSS feed plus an
// HTML scrape on a repeated div class (FIELD_VALUE_RE above). A template
// change on Avature's side renames or restructures that class and the scrape
// silently returns an empty string, which 12.4's per-company failure isolation
// then swallows as "no matching jobs right now."
//
// That is precisely what a naive requiredFields list would MISS: assertShape
// treats only undefined/null as missing, and an empty string passes (that
// behaviour is deliberate and unit-tested). So `run()` normalizes the scraped
// description to `null` when empty — the check must fail loudly on an empty
// description, not merely on a failed request.
//
// The tenant is Avature's own board, chosen deliberately: per this module's
// header, customer tenants may enable AWS WAF bot protection, whose correct
// outcome here is indistinguishable from a dead board. Canarying against a
// bot-protected tenant would produce permanent red that says nothing about the
// contract. `careers:main` is confirmed unprotected.
const CONTRACT_CHECK_SLUG = 'careers:main';
const contractCheck = {
  name: platform,
  requiredFields: ['items', 'firstTitle', 'firstLink', 'firstDescription'],
  run: async () => {
    const parsed = parseIdentifier(CONTRACT_CHECK_SLUG);
    const { text, contentType } = await getText(feedUrl(parsed));
    if (!/xml/i.test(contentType)) throw new Error(`non-XML response from Avature feed (content-type: ${contentType})`);
    const parsedItems = parseFeedItems(text);
    const items = parsedItems.length ? parsedItems : null;
    const first = parsedItems[0] || {};
    let firstDescription = null;
    if (first.link) {
      const { text: detailHtml } = await getText(first.link);
      firstDescription = extractDescriptionHtml(detailHtml) || null;
    }
    return { items, firstTitle: first.title || null, firstLink: first.link || null, firstDescription };
  },
};

module.exports = { platform, buildIdentifier, parseIdentifier, extractSlugFromUrl, probe, fetchJobs, normalizeItem, contractCheck };

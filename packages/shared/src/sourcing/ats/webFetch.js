// Shared HTTP + HTML plumbing for the ATS Direct adapters added in §15 #65
// (SmartRecruiters, Recruitee, BambooHR, Breezy HR, Rippling, SAP
// SuccessFactors, Oracle Taleo, iCIMS, iCIMS career sites (Jibe), Radancy,
// YC Work at a Startup).
//
// The Tier 1-2.5 adapters each carry their own copy of the same
// abort/timeout/dispatcher/error-shape fetch wrapper (eightfold.js's
// getJsonEightfold, phenom.js's getJsonPhenom, oracle.js's getJsonOracle...).
// Eleven more copies would be eleven more places for the error contract to
// drift, so the new adapters share this one. It keeps the existing contract
// exactly:
//   * a non-2xx throws an Error carrying `status` (and `retryAfter`), so the
//     caller's per-company isolation (12.4) and the canary's throttling vs
//     drift reading (18.3) both see the real HTTP status;
//   * the probe budget applies outside a scan and the scan budget inside one
//     (scanContext.js);
//   * inside a scan, requests to one host are spaced (paceHost) and a
//     retryable failure is retried with Retry-After honoured (retry.js).
//
// Deliberately NOT a place for platform logic — every adapter still owns its
// own URL shapes, parsing and identifier model.

const { requestTimeoutMs, inScan, paceHost } = require('./scanContext');
const { withRetry } = require('./retry');
const { UA, readBodyText, getJsonArrayStreamed } = require('./httpClient');
const { agent: defaultDispatcher } = require('./dispatcher');
const { decodeEntities } = require('./htmlToText');
const tunables = require('../../tunables.json');

// A browser-shaped UA for HTML career sites. Several career-site CDNs serve a
// bot-interstitial or a stripped page to an unknown agent while serving the
// normal page to a browser one. This is NOT a bot-challenge bypass (14): no
// cookie is forged, no JavaScript challenge is solved, and a site that
// answers 403 anyway is treated as a clean miss.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

async function requestOnce(url, { method = 'GET', body, headers = {}, accept = 'application/json', browser = false, dispatcher = defaultDispatcher, ms } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || requestTimeoutMs());
  try {
    const resp = await fetch(url, {
      method,
      body,
      redirect: 'follow',
      headers: {
        Accept: accept,
        'User-Agent': browser ? BROWSER_UA : UA,
        // zstd is not decoded by this runtime's fetch (see custom/index.js's
        // IDENTITY_ENCODING note, found live on Amazon); asking for the
        // encodings it does decode keeps a CDN from choosing zstd.
        'Accept-Encoding': 'gzip, deflate, br',
        ...headers,
      },
      signal: controller.signal,
      dispatcher,
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${resp.status} from ${url}`);
      err.status = resp.status;
      err.retryAfter = resp.headers.get('retry-after');
      throw err;
    }
    const text = await readBodyText(resp);
    return { text, finalUrl: resp.url, headers: resp.headers };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET/POST and return `{ text, finalUrl, headers }`. Inside a scan, paced per
 * host and retried on a retryable failure; outside one (a probe), one shot.
 * @param {string} url
 * @param {object} [opts] method, body, headers, accept, browser, dispatcher, platform
 */
async function request(url, opts = {}) {
  if (!inScan()) return requestOnce(url, opts);
  return withRetry(async () => {
    await paceHost(url, opts.platform || 'default');
    return requestOnce(url, opts);
  }, { attempts: tunables.atsDirect.scan.pageAttempts });
}

/**
 * Stream a JSON array (optionally nested under `pick`) out of one response,
 * calling `makeHandler()` fresh for EVERY attempt and returning whatever its
 * `result()` yields. The same pacing and retry as `request` — inside a scan
 * the platform/host spacing applies and a retryable failure restarts the whole
 * attempt (a fresh handler, so a retry can never double-count items).
 *
 * This is for boards that can be tens of MB (one Recruitee board is 70 MB):
 * `fetchJson` would buffer the whole body and JSON.parse it, a ~250 MB
 * transient; here each element is parsed, handed over and released as it
 * arrives, so memory stays flat regardless of board size. `onItem` returning
 * `false` stops the download early (httpClient.streamJsonArray's contract).
 *
 * @param {string} url
 * @param {{platform?: string, pick?: string|null, makeHandler: () => {onItem: (raw: any) => boolean|void, result: () => any}}} opts
 */
async function streamBoard(url, { platform, pick = null, makeHandler } = {}) {
  const attempt = async () => {
    const handler = makeHandler();
    await getJsonArrayStreamed(url, { pick, onItem: handler.onItem, ms: requestTimeoutMs() });
    return handler.result();
  };
  if (!inScan()) return attempt();
  return withRetry(async () => {
    await paceHost(url, platform || 'default');
    return attempt();
  }, { attempts: tunables.atsDirect.scan.pageAttempts });
}

async function fetchJson(url, opts = {}) {
  const { text } = await request(url, { accept: 'application/json', ...opts });
  try {
    return JSON.parse(text);
  } catch {
    // A 200 carrying HTML where JSON was expected is a contract break or a
    // soft error page, never a board — reported with the start of the body so
    // the canary row says what came back.
    const err = new Error(`Non-JSON response from ${url}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    err.status = 200;
    throw err;
  }
}

async function fetchText(url, opts = {}) {
  const { text } = await request(url, { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...opts });
  return text;
}

// Small bounded-concurrency map, same shape as the pooled() helpers inside
// eightfold.js/phenom.js/detect.js.
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function cleanTitles(titles) {
  if (!titles) return [];
  return (Array.isArray(titles) ? titles : [titles]).map((t) => String(t || '').trim()).filter(Boolean);
}

// The list-level any-title substring match (4.6.15) every list-then-detail
// adapter applies before its detail fan-out. The caller's own filter
// (atsDirectAdapter.js) still runs afterwards regardless.
function titleMatchesAny(title, titles) {
  const t = cleanTitles(titles);
  if (!t.length) return true;
  const hay = String(title || '').toLowerCase();
  return t.some((x) => hay.includes(x.toLowerCase()));
}

function toIso(v) {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Every schema.org JobPosting in a page's `<script type="application/ld+json">`
 * blocks (a block may hold one object, an array, or an `@graph`). Malformed
 * blocks are skipped rather than thrown — a page with one broken block and one
 * good JobPosting is still a readable page.
 */
function extractJobPostings(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of String(html || '').matchAll(re)) {
    let parsed;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (stack.length) {
      const node = stack.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
      const type = node['@type'];
      if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) out.push(node);
    }
  }
  return out;
}

// A JobPosting's jobLocation as one readable string ("Austin, Texas, United
// States"), across the shapes seen live: a Place, an array of Places, an
// address object or a bare string.
function jobPostingLocation(jp) {
  if (!jp) return null;
  const locs = Array.isArray(jp.jobLocation) ? jp.jobLocation : jp.jobLocation ? [jp.jobLocation] : [];
  const parts = locs
    .map((l) => {
      if (!l) return null;
      if (typeof l === 'string') return l;
      const a = l.address || l;
      if (typeof a === 'string') return a;
      const country = a.addressCountry && typeof a.addressCountry === 'object' ? a.addressCountry.name : a.addressCountry;
      return [a.addressLocality, a.addressRegion, country].filter(Boolean).join(', ') || l.name || null;
    })
    .filter(Boolean);
  if (parts.length) return [...new Set(parts)].join(' | ');
  if (jp.jobLocationType === 'TELECOMMUTE') return 'Remote';
  return null;
}

/**
 * The inner HTML of the element that opens at or after `fromIndex` — counting
 * nested tags of the same name, so a `<span>` holding further `<span>`s is
 * returned whole rather than cut at its first child's close. Returns null when
 * no such element exists or it never closes.
 */
function innerHtmlAt(html, fromIndex) {
  const s = String(html || '');
  const open = s.indexOf('<', fromIndex);
  if (open < 0) return null;
  const nameMatch = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(s.slice(open, open + 40));
  if (!nameMatch) return null;
  const tag = nameMatch[1].toLowerCase();
  const openEnd = s.indexOf('>', open);
  if (openEnd < 0) return null;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = openEnd + 1;
  let depth = 1;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[0].endsWith('/>')) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return s.slice(openEnd + 1, m.index);
  }
  return null;
}

/**
 * Inner HTML of the first element whose opening tag carries `attr="value"`
 * (exact attribute value, or a class list containing `value` when attr is
 * "class"). Used for the handful of server-rendered career pages whose
 * description sits in a known container.
 */
function innerHtmlByAttr(html, attr, value) {
  const s = String(html || '');
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A class must match as a whole whitespace-separated token: "description"
  // must not match "job-description-header" (\b treats the hyphen as a word
  // boundary, which is how Breezy's breadcrumb header was picked up first).
  const re = attr === 'class'
    ? new RegExp(`<[a-zA-Z][^>]*\\bclass=["'](?:[^"']*\\s)?${esc}(?:\\s[^"']*)?["'][^>]*>`, 'i')
    : new RegExp(`<[a-zA-Z][^>]*\\b${attr}=["']${esc}["'][^>]*>`, 'i');
  const m = re.exec(s);
  if (!m) return null;
  return innerHtmlAt(s, m.index);
}

// Attribute-safe decode for values read straight out of HTML attributes.
function attrDecode(v) {
  return v == null ? null : decodeEntities(String(v)).trim();
}

module.exports = {
  BROWSER_UA,
  request,
  fetchJson,
  streamBoard,
  fetchText,
  pooled,
  cleanTitles,
  titleMatchesAny,
  toIso,
  extractJobPostings,
  jobPostingLocation,
  innerHtmlAt,
  innerHtmlByAttr,
  attrDecode,
};

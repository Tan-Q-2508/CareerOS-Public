// Workable adapter — ATS Direct Tier 2 (spec 4.6.1). Phase 4, §15 #27.
//
// The spec's originally-documented endpoint (`GET /api/v3/accounts/{slug}/jobs`)
// is WRONG on two counts, confirmed live 2026-08-10: that path is a POST, not a
// GET, and its payload carries no description at all. The endpoint actually
// used here is the "apply" widget:
//
//   GET https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true
//     -> { name, description, jobs: [{ title, shortcode, employment_type,
//          department, url, published_on, city, state, country, description,
//          ... }] }
//
// One request returns the WHOLE board with full descriptions already inlined —
// no per-job detail call needed (contrast Workday, which needs one). Dropping
// `details=true` returns the same shape minus `description` (~6 KB vs the full
// board), which is what `probe()` uses — and it's the one Tier 2 platform,
// alongside Greenhouse, that returns the board's own display name (`name`),
// so a guessed slug CAN be verified here (detect.js's VERIFIES_BOARD_NAME set).
//
// RATE-LIMIT POSTURE — the primary build risk per spec 4.6.1, not the payload
// shape: Workable is reported to deploy aggressive IP-based rate limiting with
// direct centralized polling risking a permanent ban, closer to a platform
// resisting third-party aggregation than one built for it. No `X-RateLimit-*`
// headers were observed on any live response (Cloudflare-fronted), so there is
// no server-declared budget to read — backoff here is self-imposed:
//   * every request funnels through one module-level serialized gate enforcing
//     a minimum inter-request interval (tunables...workable.minRequestIntervalMs)
//     — this makes Workable's EFFECTIVE per-process concurrency 1 regardless of
//     tunables.atsDirect.companyFetchConcurrency, a deliberate throughput
//     sacrifice for this one platform.
//   * a 429/403/503 triggers exponential backoff + jitter, honoring
//     `Retry-After` (seconds or an HTTP-date) when the response carries one.
//   * a 404 is a legitimate "no such board" miss, same as every other Tier 1/2
//     platform — never retried, never treated as a rate-limit signal.

const tunables = require('../../tunables.json');
const { requestTimeoutMs } = require('./scanContext');
const { dedupKey } = require('../dedup');
const { htmlToText } = require('./htmlToText');
const { UA, streamJsonArray, streamParseThreshold, readBodyJson } = require('./httpClient');
const { agent: defaultDispatcher } = require('./dispatcher');

const platform = 'workable';

// Shared with the contract-drift canary (18.3) — see retry.js for why these
// three moved out of this file. MAX_ATTEMPTS stays here: it is Workable's own
// tuning, not shared policy.
const { RETRYABLE_STATUS, parseRetryAfter, backoffMs, sleep } = require('./retry');

const MAX_ATTEMPTS = 5;

function cfg() {
  return tunables.atsDirect.platforms.workable;
}

function widgetUrl(slug, details) {
  const base = cfg().widgetApi;
  return `${base}/${encodeURIComponent(slug)}${details ? '?details=true' : ''}`;
}

// apply.workable.com/{slug} is the board; apply.workable.com/j/{shortcode} is
// a single-job permalink with no board slug to extract (falls through to
// name-guess, same "platform known, slug isn't" shape as Greenhouse's
// embedded ?gh_jid= case).
function extractSlugFromUrl(u) {
  if (!u) return null;
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    return null;
  }
  if (!/(^|\.)workable\.com$/.test(parsed.hostname.toLowerCase())) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === 'j') return { platform, slug: null };
  return { platform, slug: parts[0] };
}

// --- The serialized rate gate. `queue` tracks slot completion timing only
// (via .catch(() => {}) so one request's failure can't wedge the chain for
// every request behind it); each caller's own promise still carries its real
// result/rejection back independently.
let queue = Promise.resolve();
let lastRequestAt = 0;

function gated(fn) {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastRequestAt + cfg().minRequestIntervalMs - Date.now());
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

// Note: Workable's own serialized rate gate (below) already keeps effective
// concurrency at 1 for this platform regardless of companyFetchConcurrency,
// so the shared per-origin Agent's connections cap (4.6.13) never actually
// binds here — wired through anyway for consistency (and in case the rate
// gate is ever loosened), not because it changes today's behavior.
async function rawFetch(url, { dispatcher = defaultDispatcher } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs());
  try {
    return await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: controller.signal,
      dispatcher,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Runs the gate + retry/backoff loop, returning the raw ok Response
// UNCONSUMED — callers decide whether to buffer (.json()) or stream the
// body. A failed attempt's body is always drained before retrying so the
// gate's next request isn't left waiting behind a dangling connection.
async function getRespWithBackoff(url, { dispatcher } = {}) {
  for (let attempt = 1; ; attempt++) {
    const resp = await gated(() => rawFetch(url, { dispatcher }));
    if (resp.ok) return resp;
    await resp.body?.cancel().catch(() => {});
    if (!RETRYABLE_STATUS.has(resp.status) || attempt >= MAX_ATTEMPTS) {
      const err = new Error(`HTTP ${resp.status} from ${url}`);
      err.status = resp.status;
      throw err;
    }
    const retryAfter = parseRetryAfter(resp.headers.get('retry-after'));
    await sleep(retryAfter != null ? retryAfter : backoffMs(attempt));
  }
}

async function getJsonWithBackoff(url, opts) {
  const resp = await getRespWithBackoff(url, opts);
  return await readBodyJson(resp);
}

// Size-threshold streaming (4.6.13) layered under the same rate gate +
// backoff as getJsonWithBackoff — a large Workable board still needs the
// gate/retry wrapper, it just doesn't get buffered whole once the response
// arrives.
async function getJsonArrayStreamedWithBackoff(url, { pickKey = null, onItem, dispatcher } = {}) {
  const resp = await getRespWithBackoff(url, { dispatcher });
  const lenHeader = resp.headers.get('content-length');
  const len = lenHeader != null ? Number(lenHeader) : null;
  if (len != null && Number.isFinite(len) && len < streamParseThreshold()) {
    const body = await readBodyJson(resp);
    const arr = pickKey ? (body && body[pickKey]) || [] : Array.isArray(body) ? body : [];
    for (const item of arr) {
      if (onItem(item) === false) break;
    }
    return;
  }
  await streamJsonArray(resp.body, { pickKey, onItem });
}

/**
 * Cheap probe: the widget without `details=true` (~6 KB), returns the board
 * name and how many jobs it lists.
 *
 * `jobCount` exists because a Workable board name proves less than it looks:
 * anyone can register an account called "walmart" or "tesla", and the widget
 * then answers with that name and zero jobs. Eight such empty accounts were
 * found mapped to Fortune-200 companies (§15 #65) — each passed name
 * verification and each blocked the company's real board, since the registry
 * dedups by name. detect.js now requires a GUESSED Workable slug to list at
 * least one job; a URL-matched slug is unaffected.
 */
async function probe(slug) {
  try {
    const body = await getJsonWithBackoff(widgetUrl(slug, false));
    const jobCount = Array.isArray(body && body.jobs) ? body.jobs.length : null;
    return { ok: true, status: 200, boardName: (body && body.name) || null, jobCount, error: null };
  } catch (e) {
    return { ok: false, status: e.status || 0, boardName: null, error: e.message || String(e) };
  }
}

function normalizeItem(j, { slug, companyName }) {
  const city = j.city || (j.location && j.location.city) || null;
  const state = j.state || (j.location && j.location.region) || null;
  const country = j.country || (j.location && j.location.country) || null;
  const link = j.url || j.application_url || j.shortlink || null;
  const id = j.shortcode || null;
  return {
    source: 'ats_direct',
    atsPlatform: platform,
    atsSlug: slug,
    title: j.title || null,
    // The widget's top-level `name` is the board's own company name, but the
    // per-job objects don't repeat it — same caller-supplies-it posture as
    // every other Tier 1/2 adapter.
    companyName: companyName || null,
    location: [city, state, country].filter(Boolean).join(', ') || null,
    // published_on is a real date ("2026-08-06"), unlike Workday's relative
    // postedOn string.
    postedAt: toIso(j.published_on || j.created_at),
    link,
    // Filled in by fetchJobs's onItem AFTER the keep filter passes (4.6.15) —
    // see greenhouse.js's identical comment for why this is safe to defer.
    descriptionText: null,
    // `experience` is Workable's own platform-provided seniority signal (not
    // inferred from the title) — passed through as-is, same posture as
    // employmentType below.
    seniorityLevel: j.experience || null,
    employmentType: j.employment_type || null,
    salaryMin: null,
    salaryMax: null,
    dedupKey: dedupKey({ id, link, title: j.title, companyName, atsPlatform: platform, atsSlug: slug }),
  };
}

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pull every open posting for a board in ONE request (descriptions already
 * inlined — no per-job detail fan-out, unlike Workday). Streams above the
 * size threshold (4.6.13), still gated through the same serialized
 * rate-limit posture as every other Workable request. `keep`, when supplied,
 * is applied per posting as they stream in, and `limit` caps the number that
 * PASS `keep` — see greenhouse.js's fetchJobs doc for why this ordering
 * matters.
 */
async function fetchJobs(slug, { companyName, limit, keep, dispatcher } = {}) {
  const cap = limit || tunables.atsDirect.fetchLimitDefault;
  const kept = [];
  await getJsonArrayStreamedWithBackoff(widgetUrl(slug, true), {
    pickKey: 'jobs',
    dispatcher,
    onItem: (raw) => {
      const job = normalizeItem(raw, { slug, companyName });
      if (!job.title || !job.link) return true;
      if (keep && !keep(job)) return true;
      job.descriptionText = htmlToText(raw.description);
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
const CONTRACT_CHECK_SLUG = "1000heads"; // a real, stable registry board

const contractCheck = {
  name: platform,  requiredFields: ['jobs', 'firstTitle', 'firstLink', 'firstDescription', 'firstPostedAt', 'boardName'],
  run: async () => {
    // Every request here goes through the module-level rate gate, so this
    // check is slower than the others by design. boardName is asserted for
    // the same reason as Greenhouse's — Workable is the other half of
    // detect.js's VERIFIES_BOARD_NAME pair.
    const p = await probe(CONTRACT_CHECK_SLUG);
    const jobs = await fetchJobs(CONTRACT_CHECK_SLUG, { companyName: '1000heads', limit: 1 });
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

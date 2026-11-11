// Custom Adapter Tier shared scaffolding (spec 18.2, Phase 5.5 §15 #44).
//
// Six proprietary in-house career sites, none publishing a contract — each is
// its own adapter with no shared vendor logic (unlike the Tier 2.5 platforms
// in ../eightfold.js, ../avature.js, ../oracle.js, which all front a real
// multi-tenant vendor). What IS shared, and lives here, is:
//   1. The "plain, hand-assigned key" identity model §18.2 asks for — there is
//      no vendor slug/tenant scheme to match against, so a company here is
//      just its platform key (e.g. slug_or_identifier === platform === "apple"),
//      not a colon-composite or guessable string like every other adapter.
//   2. Two thin fetch wrappers mirroring eightfold.js's getJsonEightfold
//      (packages/shared/src/sourcing/ats/eightfold.js:128), because these five
//      files would otherwise each reimplement the same abort/timeout/
//      dispatcher/error-shape boilerplate — one for JSON APIs (amazon, meta,
//      phenom-adjacent), one for HTML-embedded-JSON pages (apple, google).
//
// Tesla is deliberately NOT a member of CUSTOM_PLATFORMS — live discovery
// (2026-08-27) found tesla.com's careers API sits behind Akamai Bot Manager:
// every /cua-api/* request returns 200 in a real browser (which holds the
// Akamai sensor's _abck cookie) and 403 from a plain server-side fetch under
// every header combination tried. Bypassing bot/CAPTCHA protection is off the
// table per this codebase's standing rule, so Tesla has no adapter file and no
// registry platform value — see CareerOS_Changelog.md under `## 18` for the
// full dated finding. Microsoft is also not here: live discovery found
// jobs.careers.microsoft.com now redirects to a Phenom People-hosted board
// (apply.careers.microsoft.com), a real multi-tenant vendor with a documented-
// feeling JSON API — that makes it a Tier-2.5-style vendor adapter
// (../phenom.js), not a Custom Adapter Tier company at all.
const tunables = require('../../../tunables.json');
const { UA, readBodyText } = require('../httpClient');
const { agent: defaultDispatcher } = require('../dispatcher');
const { requestTimeoutMs } = require('../scanContext');

// Tier membership — the single fact "is this platform best-effort/Custom
// Adapter Tier" is read from here everywhere else needs it (park-dead-boards,
// the registry UI's reliability note), rather than re-listing the five names.
const CUSTOM_PLATFORMS = new Set(['apple', 'amazon', 'google', 'meta']);

function fixedIdentifier(platformKey) {
  return platformKey;
}

// A Custom Adapter Tier identifier is never derived or composite — it must
// equal the adapter's own platform key exactly. Anything else (a guessed
// slug, an empty string, a stray composite) is rejected rather than silently
// coerced, since accepting one would imply this tier has a slug scheme it
// deliberately does not have.
function parseFixedIdentifier(platformKey, id) {
  return id === platformKey ? platformKey : null;
}

// Probe budget normally, scan budget inside a scan (../scanContext.js).
function timeoutMs() {
  return requestTimeoutMs();
}

// `Accept-Encoding: identity` on every custom-tier request — a real bug found
// live building the Amazon adapter (Session 45): Amazon's search.json endpoint
// serves `content-encoding: zstd` by default, which this Node runtime's
// fetch/undici does NOT auto-decompress (unlike gzip/br, which it handles
// transparently — confirmed live: Apple's endpoint negotiates gzip and reads
// fine). Left alone, the raw zstd bytes get decoded as UTF-8 text and look
// like a plausible-but-truncated JSON string for the first ~1KB before
// breaking — exactly the "truncated body" failure mode this module originally
// guarded against with a text-then-JSON.parse fallback (kept below as
// defense-in-depth for a genuine short read, e.g. a connection reset) — but
// requesting identity encoding up front is the real fix, applied once here so
// every adapter in this tier is protected, not just Amazon's.
const IDENTITY_ENCODING = { 'Accept-Encoding': 'identity' };

// GET and parse a JSON API response. Same throw-on-non-2xx contract as every
// other adapter's fetch helper (12.4: the caller sees a real failure, not a
// swallowed one).
async function getJsonCustom(url, { ms, dispatcher = defaultDispatcher, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || timeoutMs());
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': UA, ...IDENTITY_ENCODING, ...headers },
      signal: controller.signal,
      dispatcher,
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${resp.status} from ${url}`);
      err.status = resp.status;
      throw err;
    }
    // Read as text first: a truncated/interrupted body throws a clear JSON
    // parse error here rather than an opaque undici stream error inside
    // resp.json() (a real failure mode seen live against Amazon's endpoint
    // during discovery — an occasional short read, not a shape problem).
    const text = await readBodyText(resp);
    try {
      return JSON.parse(text);
    } catch (e) {
      const err = new Error(`Malformed JSON from ${url}: ${e.message} (body len ${text.length})`);
      err.status = resp.status;
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

// GET raw HTML for a server-rendered page (apple.js, google.js both need the
// full document text, not JSON) — same abort/timeout/dispatcher shape as
// getJsonCustom above, just no JSON.parse.
async function getHtmlCustom(url, { ms, dispatcher = defaultDispatcher, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || timeoutMs());
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': UA, ...IDENTITY_ENCODING, ...headers },
      signal: controller.signal,
      dispatcher,
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${resp.status} from ${url}`);
      err.status = resp.status;
      throw err;
    }
    return await readBodyText(resp);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  CUSTOM_PLATFORMS,
  fixedIdentifier,
  parseFixedIdentifier,
  getJsonCustom,
  getHtmlCustom,
};

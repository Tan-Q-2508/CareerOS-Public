// The single shared ATS platform-detection service (spec 4.6.2). All four of
// 4.6.3's entry points — Core/BYO Scraper results, manual job entry, a
// user-requested lookup, and the periodic unresolved re-sweep — call this one
// function; there is no second code path.
//
// NO AI ANYWHERE (4.6.2): URL pattern matching and a bounded slug-guess sweep,
// nothing else. Adding AI here needs to be a deliberate, flagged exception.

const tunables = require('../../tunables.json');
const greenhouse = require('./greenhouse');
const lever = require('./lever');
const ashby = require('./ashby');
const workday = require('./workday');
const workable = require('./workable');
const oracle = require('./oracle');
const eightfold = require('./eightfold');
const avature = require('./avature');
const apple = require('./custom/apple');
const amazon = require('./custom/amazon');
const google = require('./custom/google');
const meta = require('./custom/meta');
const phenom = require('./phenom');
const smartrecruiters = require('./smartrecruiters');
const recruitee = require('./recruitee');
const bamboohr = require('./bamboohr');
const breezy = require('./breezy');
const rippling = require('./rippling');
const successfactors = require('./successfactors');
const taleo = require('./taleo');
const icims = require('./icims');
const jibe = require('./jibe');
const radancy = require('./radancy');
const ycombinator = require('./ycombinator');
const { normalizeCompanyName } = require('./companyName');
const { slugCandidates } = require('./slugRules');

// The name-guess sweep (4.6.2) — platforms in NAME_GUESS_EXCLUDED (below) are
// deliberately left out. A Workday identifier is a {tenant, wd-host, site}
// triple and an Oracle identifier is a {tenant, dc, site} triple (18.1);
// neither is derivable from a company's display name the way a
// Greenhouse/Lever/Ashby/Workable slug plausibly is. Eightfold is excluded
// for a related but distinct reason: it's white-labeled per customer with no
// shared hostname convention at all (18.1), so there is nothing even
// resembling a plausible transform of a company's display name to guess.
// Apple/Amazon/Google (the Custom Adapter Tier, 18.2) are excluded for yet
// another reason — their identifier is a fixed, hand-assigned platform key
// (never a slug derived from ANY company's name), so "guess Apple's slug
// from a display name" is a category error, not merely low-confidence.
// Phenom (18.1/18.2) is excluded like Eightfold — white-labeled per tenant
// with no shared hostname convention, so there is nothing to guess either.
// Either way, an "unverifiable guess" here wouldn't just be low-confidence,
// it would be structurally made up. Order matters only for reporting
// stability; a slug is probed against every adapter in this list.
//
// SmartRecruiters, Recruitee, Breezy HR and Rippling (§15 #65) join the sweep
// because every one of them returns the board's own company name, and each
// returns it only from a real posting — a board with nothing open yields no
// name and a guess against it is rejected (VERIFIES_BOARD_NAME below). That is
// stricter than Workable's widget, which names an empty squatter account after
// whatever its registrant typed (see workable.js's probe note).
const ADAPTERS = [greenhouse, lever, ashby, workable, smartrecruiters, recruitee, breezy, rippling];
// URL-match mode (4.6.2) tries every KNOWN platform's URL pattern, including
// the excluded ones — URL-match is deterministic (the slug is read directly
// off the URL, never guessed), so their unguessability above doesn't apply
// here.
//
// Host-signature adapters come first; the four whose only signature is a URL
// SHAPE on the company's own domain (phenom, successfactors, jibe, radancy)
// come last, so a URL carrying a real vendor host is never claimed by a shape.
const URL_MATCH_ADAPTERS = [
  greenhouse, lever, ashby, workday, workable, oracle, eightfold, avature, apple, amazon, google, meta,
  smartrecruiters, recruitee, bamboohr, breezy, rippling, taleo, icims, ycombinator,
  phenom, successfactors, jibe, radancy,
];
const BY_PLATFORM = {
  greenhouse, lever, ashby, workday, workable, oracle, eightfold, avature, apple, amazon, google, meta, phenom,
  smartrecruiters, recruitee, bamboohr, breezy, rippling, successfactors, taleo, icims, jibe, radancy, ycombinator,
};
// Platforms whose probe endpoint returns the board's own display name, so a
// guessed slug can be cross-checked rather than merely assumed (4.6.2's
// false-positive guard). Every platform past Workable expose no such name.
const VERIFIES_BOARD_NAME = new Set(['greenhouse', 'workable', 'smartrecruiters', 'recruitee', 'breezy', 'rippling']);
// Platforms excluded from the name-guess sweep (see comment above ADAPTERS)
// — a URL that matched one of these with no extractable slug has nothing
// left to guess and falls straight through to the miss branch below, same as
// it always has for Workday. Avature's `site` segment is no more guessable
// than Workday's/Oracle's composite parts (18.1). Apple/Amazon/Google are
// here for the fixed-key reason explained above ADAPTERS; Phenom for the
// white-labeled reason Eightfold already established.
// §15 #65 adds BambooHR (no company name anywhere to verify against), the
// four company-domain platforms (SuccessFactors, Jibe, Radancy — the host IS
// the company's domain — and classic iCIMS/Taleo, whose portal and section
// names are not derivable), and YC's board, which is only ever populated from
// YC's own company list (scripts/import-startups.js), never guessed.
const NAME_GUESS_EXCLUDED = new Set([
  'workday', 'oracle', 'eightfold', 'avature', 'apple', 'amazon', 'google', 'meta', 'phenom',
  'bamboohr', 'successfactors', 'taleo', 'icims', 'jibe', 'radancy', 'ycombinator',
]);

function detectCfg() {
  return tunables.atsDirect.detect;
}

// Run tasks with a small concurrency cap so a name-guess sweep doesn't fire a
// dozen simultaneous requests at three third-party APIs.
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

/**
 * Resolve a company to an ATS platform + slug.
 *
 * @param {{companyName?: string, link?: string}} input
 * @returns {Promise<{
 *   outcome: 'url_match'|'name_guess'|'url_no_match'|'name_guess_failed',
 *   platform: string|null, slug: string|null, boardName: string|null,
 *   matchAttemptType: 'url_no_match'|'name_guess_failed'|null,
 *   candidatesTried: string[], careersUrlGuess: string|null,
 * }>}
 *
 * `matchAttemptType` is populated only on a miss, and its two values are exactly
 * company_ats_unresolved.match_attempt_type's (4.6.5) — #23 persists the result
 * as-is rather than translating it.
 *
 * NOTE — a "board exists but has zero open postings" outcome was designed for
 * this contract and then deliberately dropped, because it turned out to be both
 * unreachable and meaningless here:
 *   * Lever answers 200 with [] for a real board with nothing open (verified
 *     live against `plaid`), but the cheap probes can't see it — HEAD reports
 *     only the status, and only Lever could have surfaced it at all, so the
 *     signal would have existed on one platform out of three.
 *   * More importantly it maps to nothing in the data model: 4.6.5's registry
 *     status is `active` | `pending_adapter`, with no third state, and parking
 *     an existing board in company_ats_unresolved would be wrong — the company
 *     IS resolved, it just isn't hiring today, and may be next week.
 * Detection answers "which platform hosts this company's board"; how many roles
 * happen to be open is a scan-time fact (4.6.6), not a detection classification.
 */
async function detectPlatform({ companyName, link } = {}) {
  const result = {
    outcome: null,
    platform: null,
    slug: null,
    boardName: null,
    matchAttemptType: null,
    candidatesTried: [],
    careersUrlGuess: link || null,
  };

  // ---- URL-match mode (4.6.2): deterministic pattern matching, no guessing.
  let urlPlatform = null;
  if (link) {
    for (const adapter of URL_MATCH_ADAPTERS) {
      const hit = adapter.extractSlugFromUrl(link);
      if (!hit) continue;
      if (!urlPlatform) urlPlatform = hit.platform; // first hit wins for the name-guess fallback below
      if (!hit.slug) break; // e.g. an embedded ?gh_jid= — platform known, slug isn't; unambiguous, stop here
      // One cheap probe confirms the slug actually resolves. The spec describes
      // URL-match as needing no lookup, and it doesn't need one to *guess* —
      // but without this, a stale or malformed URL would enter the registry as
      // `active` and then silently source nothing on every future scan.
      const p = await adapter.probe(hit.slug);
      if (p.ok) {
        return {
          ...result,
          outcome: 'url_match',
          platform: hit.platform,
          slug: hit.slug,
          boardName: p.boardName,
        };
      }
      // A failed probe for THIS adapter's shape-based match doesn't rule out
      // another adapter whose own fallback shape (never a unique signature by
      // construction — e.g. eightfold.js's and phenom.js's shared
      // "/careers/job/{numericId}" candidate shape, confirmed to collide live
      // 2026-08-27) coincidentally matches the same URL. Try the rest of
      // URL_MATCH_ADAPTERS before falling through to a miss — this is what
      // lets a genuine Phenom URL still resolve even though Eightfold's
      // shape-fallback matches it first and fails to probe.
    }
  }

  // ---- Name-guess mode (4.6.2): also the fall-through when a URL identified
  // the platform but carried no slug (the embedded-link case).
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) {
    return {
      ...result,
      outcome: link ? 'url_no_match' : 'name_guess_failed',
      matchAttemptType: link ? 'url_no_match' : 'name_guess_failed',
    };
  }

  // Mined rules (4.6.11) are opt-in per-rule via tunables and empty by default —
  // a rule only lands here after slugMining.js reports it clearing both gates on
  // the real registry. See slugRules.js's header for why that gate exists.
  const candidates = slugCandidates(companyName, detectCfg().maxSlugCandidates, {
    minedRuleIds: detectCfg().minedRules || [],
  });
  result.candidatesTried = candidates;

  // If a URL already told us the platform, only guess against that one — but
  // never against a composite-identifier platform (see NAME_GUESS_EXCLUDED
  // above): a URL that matched one of those host patterns with no extractable
  // site (rare) has nothing left to try and falls straight through to the
  // miss branch below.
  const adapters = urlPlatform
    ? !NAME_GUESS_EXCLUDED.has(urlPlatform) && BY_PLATFORM[urlPlatform]
      ? [BY_PLATFORM[urlPlatform]]
      : []
    : ADAPTERS;

  const pairs = [];
  for (const slug of candidates) for (const adapter of adapters) pairs.push({ slug, adapter });

  const probes = await pooled(pairs, detectCfg().probeConcurrency, async ({ slug, adapter }) => {
    try {
      const p = await adapter.probe(slug);
      return { slug, adapter, ...p };
    } catch (e) {
      // Per-platform isolation (12.4): one platform erroring can't abort
      // detection against the other two.
      return { slug, adapter, ok: false, status: 0, boardName: null, error: e.message || String(e) };
    }
  });

  // Candidates are ordered most-likely-first, and `pairs` preserves that, so the
  // first ok probe is the best guess rather than whichever call returned first.
  for (const p of probes) {
    if (!p.ok) continue;
    // Greenhouse and Workable are the only two adapters whose probe returns
    // the company's own name, so a guess there is verified rather than
    // assumed. Lever and Ashby expose no name at all — which is exactly why
    // slugCandidates stays conservative (no truncation, no acronyms); an
    // unverifiable guess that hit an unrelated company's board would go into
    // the GLOBAL registry (4.6.5) and feed the wrong company's postings to
    // every user until manual review.
    if (!acceptsGuess(p, companyName)) continue;
    return {
      ...result,
      outcome: 'name_guess',
      platform: p.adapter.platform,
      slug: p.slug,
      boardName: p.boardName || null,
    };
  }

  // A miss. If a URL was supplied and matched no known platform pattern, that's
  // the stronger `url_no_match` signal (4.6.5) — a confirmed miss rather than
  // just a failed guess.
  const attempt = link && !urlPlatform ? 'url_no_match' : 'name_guess_failed';
  return { ...result, outcome: attempt, matchAttemptType: attempt };
}

/**
 * Whether one ok probe of a GUESSED slug may be accepted (4.6.2). Pure, so the
 * rule is testable without a network: a board-naming platform must name the
 * company, and a Workable account must also list at least one job — an empty
 * account named after the company is a squatter, not its board (see
 * workable.js's probe note; eight were found mapped to Fortune-200 names).
 */
function acceptsGuess(p, companyName) {
  if (!p || !p.ok || !p.adapter) return false;
  if (VERIFIES_BOARD_NAME.has(p.adapter.platform) && !boardNameMatches(p.boardName, companyName)) return false;
  if (p.adapter.platform === 'workable' && !(p.jobCount > 0)) return false;
  return true;
}

// Verification for a guessed Greenhouse slug. Deliberately tolerant of the
// normal display-name/legal-name gap ("Stripe" vs "Stripe, Inc.") but not of a
// different company: one normalized name must contain the other, which rejects
// an unrelated board while accepting a suffix or short-form difference.
function boardNameMatches(boardName, companyName) {
  const a = normalizeCompanyName(boardName).replace(/ /g, '');
  const b = normalizeCompanyName(companyName).replace(/ /g, '');
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Pull live postings for an already-resolved company (4.6.1). Thin dispatch —
 * #24's scan integration calls this per selected tracked company.
 *
 * `titles`, added §15 #27 (multi-title 4.6.15), is passed through to
 * whichever adapter wants it — today only Workday reads it (as its own
 * server-side `searchText`, one narrowing pre-pass PER TITLE ahead of its
 * per-posting detail fetch); every other adapter's `fetchJobs` ignores an
 * unrecognized opt. The caller's own
 * title/location/postedWithin filtering (atsDirectAdapter.js) still runs
 * regardless — this is never a substitute for it.
 *
 * `keep` (4.6.13) is an optional per-job predicate — greenhouse/lever/ashby/
 * workable's streaming `fetchJobs` apply it PER POSTING as the board streams
 * in and cap `limit` against postings that pass it (fixing the old cap-before-
 * filter ordering bug on a board with more postings than `limit`); Workday
 * ignores it (its own list-level title filter already runs before its cap,
 * and location/postedWithin need per-posting detail-fetched fields it doesn't
 * have at list time) — atsDirectAdapter.js's own outer filter, unaffected by
 * this parameter, still runs on every platform's returned jobs regardless, so
 * Workday's location/postedWithin filtering is unchanged by this.
 * `dispatcher` (4.6.13, step 2) is an optional undici Agent/Pool.
 */
async function fetchCompanyJobs({ platform, slug, companyName, titles, limit, keep, dispatcher }) {
  const adapter = BY_PLATFORM[platform];
  if (!adapter) throw new Error(`Unknown ATS platform: ${platform}`);
  return adapter.fetchJobs(slug, { companyName, titles, limit, keep, dispatcher });
}

module.exports = { detectPlatform, fetchCompanyJobs, boardNameMatches, acceptsGuess, ADAPTERS, URL_MATCH_ADAPTERS, BY_PLATFORM, VERIFIES_BOARD_NAME, NAME_GUESS_EXCLUDED };

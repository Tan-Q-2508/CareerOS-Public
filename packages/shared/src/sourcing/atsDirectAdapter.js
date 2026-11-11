const { fetchCompanyJobs } = require('./ats');
const { matchLocation } = require('./locationMatch');
const tunables = require('../tunables.json');
const { runInScan } = require('./ats/scanContext');
const { withRetry, classifyFetchError } = require('./ats/retry');

// ATS Direct sourcing (spec 4.6.6; Phase 4, §15 #24, rewritten §26/4.6.12) — a
// peer of jsearchAdapter/apifyAdapter so runScan.js stays shape-symmetric
// across all three sourcing paths, even though this one has no "actor": it
// pulls every open posting from a SELECTED TRACKED COMPANY's own board (§22's
// Tier 1 adapters, via fetchCompanyJobs) rather than querying a third-party
// search API. Jobs already carry `source: 'ats_direct'` and a namespaced
// `ats:{platform}:{slug}:{id}` dedup key from the platform adapters (§22) — no
// re-normalization needed here.
//
//   sourceCompanyJobs({ company, titles, location, postedWithinDays })
//     -> { jobs: NormalizedJob[], failure: {company, platform, slug, message} | null }
//
// Single-company shape (replaced the old multi-company sourceJobs() this
// session) — §26's bounded fetch pool (atsDirectRun.js) now owns dispatching
// N of these concurrently and deciding when to stop; this function just
// answers "what does THIS ONE company have," so it composes cleanly with a
// worker pool instead of hiding a serial loop that the pool would otherwise
// be dispatching one giant batch into at a time.
//
// Two things this function does that a Tier 1/2 adapter can't do itself:
//   1. Title narrowing (4.6.6) — none of the Tier 1 adapters support server-side
//      title filtering, so every open posting comes back and gets a coarse
//      case-insensitive SUBSTRING match against the scan's title here, before
//      anything reaches the pre-filter. Deliberately looser than 4.3 Step 3's
//      keyword-overlap check (that runs against JD body text for a different
//      purpose — dropping off-domain survivors, not initial title narrowing);
//      reusing it here would be a category mismatch, not a simplification.
//   2. Per-company failure isolation (12.4) — a single unreachable board (bad
//      slug, adapter throws, platform outage) must not fail the whole scan or
//      the sourcing of every OTHER selected company. The fetch is caught here;
//      a failure is returned for the caller to notify on, never thrown.

function titleMatches(jobTitle, scanTitle) {
  if (!jobTitle || !scanTitle) return false;
  return jobTitle.toLowerCase().includes(scanTitle.toLowerCase().trim());
}

// Multi-title scans (4.6.15, ATS Direct only) — any ONE of the scan's titles
// matching is enough to keep a posting. This is free here: every open
// posting from a selected company's board is fetched regardless of how many
// titles the scan has (unlike jsearch/apify/scraperApi, which each build one
// paid search query PER title), so widening from "match this title" to
// "match any of these titles" costs nothing extra.
function anyTitleMatches(jobTitle, scanTitles) {
  const titles = Array.isArray(scanTitles) ? scanTitles : scanTitles ? [scanTitles] : [];
  return titles.some((t) => titleMatches(jobTitle, t));
}

// 4.6.6's location field, added §15 #25c-2, rewritten §4.6.16 — was a raw
// case-insensitive substring match (`"san jose, ca".includes("usa")` →
// false), which silently rejected almost everything for any filter wider
// than a literal substring (USA, California, Remote all failed). Now backed
// by packages/shared/src/sourcing/locationMatch.js's real country/region/
// metro containment. Empty filter = no filtering at all (every posting from
// the selected companies proceeds regardless of location, per 4.6.6). A
// posting with no location value is always KEPT, never dropped for missing
// data — matchLocation returns 'unknown' rather than a false 'mismatch'
// whenever either side can't be confidently placed, and only 'mismatch' is
// ever excluded here.
function locationMatches(jobLocation, filter) {
  return matchLocation(jobLocation, filter) !== 'mismatch';
}

// 4.6.6's new "posted within" filter, added §15 #25c-2 — filters each
// posting's own postedAt (already normalized by every Tier 1 adapter) before
// anything reaches the pre-filter. Defaults to "any time" (this session,
// maintainer decision): null/absent `days` means no filtering, so existing
// ATS Direct schedules don't silently start returning fewer jobs the moment
// this ships. A posting with no postedAt is always KEPT, same missing-data
// posture as locationMatches above.
function postedWithin(jobPostedAt, days) {
  if (!days) return true;
  if (!jobPostedAt) return true;
  const posted = new Date(jobPostedAt).getTime();
  if (Number.isNaN(posted)) return true;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return posted >= cutoff;
}

/**
 * Queries exactly one company's board. No cap here — the old combined-batch
 * `limit`/`cap` slice is gone along with the multi-company shape; a target
 * ceiling is a SURVIVOR-count concept the caller (atsDirectRun.js) already
 * enforces via `shouldStop()`, not a raw-postings-per-company one.
 *
 * @param {object} input
 * @param {{platform: string, slug_or_identifier: string, company_name_display: string}} input.company
 * @param {string[]} input.titles scan's required job title(s) (4.1, multi-title 4.6.15) —
 *   any ONE substring-matching a posting's own title keeps it
 * @param {string|string[]} [input.location] optional location filter or list of filters (4.6.6),
 *   matched via locationMatch against each posting's own location — a posting matching ANY entry
 *   passes; empty = no filtering; a posting with no location is kept
 * @param {number} [input.postedWithinDays] optional "posted within" window (4.6.6) — defaults to
 *   no filtering (ATS Direct's "any time" default); a posting with no postedAt is kept
 * @param {*} [input.dispatcher] undici Agent/Pool (4.6.13, step 2) threaded through to the adapter's HTTP calls
 * @returns {Promise<{jobs: object[], failure: {company: string, platform: string, slug: string, message: string} | null, locationStats: {filtered: number, unknown: number}}>}
 *   `locationStats` counts postings that matched title+postedWithin but were
 *   excluded ('filtered') or passed-through-unsure ('unknown') on location
 *   (new §4.6.16) — only meaningful when `location` is set.
 */
async function sourceCompanyJobs({ company, titles, location, postedWithinDays, dispatcher }) {
  const titleList = Array.isArray(titles) ? titles.filter(Boolean) : titles ? [titles] : [];
  const locationStats = { filtered: 0, unknown: 0 };
  // Dedup stat counting by link — `keep` gets invoked more than once per
  // posting for platforms whose fetchJobs already applies it inline during
  // streaming AND again via the outer `.filter(keep)` below (see that
  // comment); without this a mismatch/unknown could be double-counted for
  // every platform except Workday, whose outer filter is the only place
  // `keep` ever runs.
  const statCounted = new Set();
  function countedLocationCheck(j) {
    const status = matchLocation(j.location, location);
    if (j.link && !statCounted.has(j.link)) {
      statCounted.add(j.link);
      if (status === 'mismatch') locationStats.filtered += 1;
      else if (status === 'unknown') locationStats.unknown += 1;
    }
    return status !== 'mismatch';
  }
  // The same title/location/postedWithin composite predicate serves two
  // purposes now (4.6.13): passed down as `keep`, it lets a streaming
  // adapter (greenhouse/lever/ashby/workable) filter PER POSTING and only
  // count `limit` against postings that actually match, fixing a bug where a
  // board with more raw postings than `limit` could silently drop matches
  // sitting past that position. It's then re-applied below as an outer
  // filter, unconditionally, on whatever `fetchCompanyJobs` returns — a
  // no-op for the platforms whose fetchJobs already applied it via `keep`,
  // and the ONLY filtering mechanism for Workday, whose list-level cap
  // already runs before its own title-only pre-filter and whose
  // location/postedAt fields don't exist until its own per-posting detail
  // fetch completes (fetchJobs's own docstring).
  //
  // Title/date are checked before location (§4.6.16) — cheap, deterministic,
  // and it means location stats only ever count postings that were otherwise
  // relevant, not ones already excluded for an unrelated reason.
  const keep = (j) => {
    if (!anyTitleMatches(j.title, titleList)) return false;
    if (!postedWithin(j.postedAt, postedWithinDays)) return false;
    return countedLocationCheck(j);
  };
  // Scan context (ats/scanContext.js): every request inside gets the scan
  // timeout, not the probe one, and paginated adapters retry per page. The
  // whole company fetch is also retried on a transient failure (timeout,
  // throttling, 5xx, network) — a fresh attempt restarts the adapter's own
  // state, and location stats are deduped by link so a retry can't double-
  // count them. A 404/410 is never retried: the board is gone.
  try {
    const posted = await runInScan(() =>
      withRetry(
        () =>
          fetchCompanyJobs({
            platform: company.platform,
            slug: company.slug_or_identifier,
            companyName: company.company_name_display,
            // §15 #27/4.6.15: Workday's adapter uses this as its own server-side
            // narrowing pre-pass (searchText, one pass per title) ahead of a
            // per-posting detail fetch — every other adapter ignores it.
            titles: titleList,
            keep,
            dispatcher,
          }),
        { attempts: tunables.atsDirect.scan.companyAttempts }
      )
    );
    const matched = (posted || []).filter(keep);
    return { jobs: matched, failure: null, locationStats };
  } catch (e) {
    return {
      jobs: [],
      failure: {
        company: company.company_name_display,
        platform: company.platform,
        slug: company.slug_or_identifier,
        registryId: company.id || null,
        kind: classifyFetchError(e),
        status: e.status || null,
        message: e.message || String(e),
      },
      locationStats,
    };
  }
}

module.exports = { sourceCompanyJobs, titleMatches, anyTitleMatches, locationMatches, postedWithin };

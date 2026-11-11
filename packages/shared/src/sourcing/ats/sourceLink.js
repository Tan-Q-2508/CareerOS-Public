// Is a source job's `link` usable as company-careers URL context for detection?
//
// WHY THIS EXISTS. detect.js reports the STRONGER `url_no_match` miss signal
// whenever a link was supplied and matched no platform pattern (detect.js:161).
// 4.6.5 draws a real distinction there: `url_no_match` means "had a URL, matched
// no known platform — a confirmed miss," while `name_guess_failed` is the weaker
// "may just be a wrong guess." That distinction drives the manual review pass.
//
// But a BYO Scraper / LinkedIn-style job's link is `linkedin.com/jobs/view/...`
// — an aggregator's own URL, never the company's board, and so never capable of
// matching a platform pattern. Feeding it in would stamp `url_no_match` on
// essentially every BYO-sourced company, drowning the genuinely-confirmed misses
// in noise and making the review signal worthless.
//
// 4.6.2 already anticipates exactly this ("whose `link` is a platform URL like
// linkedin.com/jobs/view/..., not the company's own board"), and 4.6.3 scopes
// URL-match mode to "when the source job's `link` is USABLE". This is that
// usability test, applied by the entry points before they call detectPlatform.
//
// A fixed denylist, deliberately not a smart classifier — same posture as
// companyName.js's LEGAL_SUFFIXES. Being wrong in the permissive direction is
// cheap (one extra pattern-match that fails, then name-guessing runs anyway);
// being wrong in the restrictive direction only costs the URL-match shortcut.

// Job boards / aggregators / search engines. A link on one of these hosts tells
// us nothing about which ATS the company runs.
const AGGREGATOR_HOSTS = [
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'monster.com',
  'dice.com',
  'simplyhired.com',
  'careerbuilder.com',
  'wellfound.com',
  'angel.co',
  'builtin.com',
  'jobs.google.com',
  'google.com',
  'bing.com',
  'facebook.com',
  'x.com',
  'twitter.com',
  'reddit.com',
  'craigslist.org',
  'upwork.com',
  'naukri.com',
  'seek.com.au',
  'totaljobs.com',
  'reed.co.uk',
  'stepstone.de',
  'jobstreet.com',
  'flexjobs.com',
  'remoteok.com',
  'weworkremotely.com',
  'otta.com',
  'hired.com',
  'talent.com',
  'jooble.org',
  'adzuna.com',
  'lensa.com',
];

/**
 * True when `link` is worth passing to detectPlatform as URL context.
 *
 * Rejects anything that isn't an http(s) URL, and anything hosted on a known
 * aggregator. Subdomains count as the same host (`www.linkedin.com`,
 * `uk.indeed.com`), but a lookalike suffix does not (`linkedin.com.evil.co`),
 * which is why this matches on host boundaries rather than with `includes`.
 *
 * @param {string|null|undefined} link
 * @returns {boolean}
 */
function isUsableCompanyLink(link) {
  if (!link || typeof link !== 'string') return false;

  let host;
  try {
    const u = new URL(link.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false; // not a parseable absolute URL
  }
  if (!host) return false;

  return !AGGREGATOR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

module.exports = { isUsableCompanyLink, AGGREGATOR_HOSTS };

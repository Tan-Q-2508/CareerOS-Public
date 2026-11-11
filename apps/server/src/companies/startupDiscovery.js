// Startup board discovery (spec 4.6.9a, §15 #65) — finds which job board a
// startup uses from the startup's OWN website, for scripts/import-startups.js.
//
// Why the website and not the name: 4.6.2's name-guess is deliberately narrow
// because a guessed slug can land on an unrelated company's board, and a
// directory of 1,000+ startups is exactly where names collide ("Flex" the
// fintech vs Flex Ltd.). A careers link on the company's own site is the
// company saying where its board is, which makes it the strongest identity
// evidence available short of a human check — the same reason URL-match mode
// outranks name-guess in detect.js.
//
// Only links to KNOWN ATS HOSTS are read (ATS_HOST below), and they are passed
// through each adapter's own extractSlugFromUrl — never a second parser. The
// four shape-only adapters (phenom, successfactors, jibe, radancy) are not
// consulted: their URL shapes are only candidates on a company's own domain,
// and an arbitrary marketing site is full of paths that look like job pages.
// A link to the company's YC profile is not its board either (sites link it
// as "Backed by Y Combinator"), so YC's board is only ever the importer's
// explicit fallback, never something discovered here.

const { atsDirect } = require('@careeros/shared');

// BOARD hosts only, not vendor marketing hosts: a footer "Powered by
// Workable" link to www.workable.com/careers would otherwise read as a board
// named "careers", since several extractors accept any subdomain.
const ATS_HOST = new RegExp(
  '^(' +
    [
      '(boards|job-boards|boards-api)\\.greenhouse\\.io',
      '(jobs|api)\\.lever\\.co',
      '(jobs|api)\\.ashbyhq\\.com',
      'apply\\.workable\\.com',
      '(jobs|careers|api)\\.smartrecruiters\\.com',
      '(?!www\\.|app\\.)[a-z0-9-]+\\.recruitee\\.com',
      '(?!www\\.|api\\.|app\\.)[a-z0-9-]+\\.bamboohr\\.com',
      '(?!www\\.|app\\.|jobs\\.|assets-cdn\\.|gallery-cdn\\.)[a-z0-9-]+\\.breezy\\.hr',
      '(ats|api)\\.rippling\\.com',
      '[a-z0-9-]+\\.wd\\d+\\.myworkdayjobs\\.com',
      '[a-z0-9-]+\\.fa(\\.[a-z0-9-]+)?\\.oraclecloud\\.com',
      '(?!www\\.|app\\.)[a-z0-9-]+\\.eightfold\\.ai',
      '[a-z0-9-]+\\.avature\\.net',
      '[a-z0-9-]+\\.taleo\\.net',
      '(?!www\\.|careers\\.|internal-)[a-z0-9-]+\\.icims\\.com',
    ].join('|') +
    ')$',
  'i'
);

// Discovery-eligible adapters, in preference order for a tie.
const DISCOVERY_PLATFORMS = [
  'ashby', 'greenhouse', 'lever', 'workable', 'rippling', 'smartrecruiters', 'recruitee', 'breezy', 'bamboohr',
  'workday', 'oracle', 'eightfold', 'avature', 'taleo', 'icims',
];

// Every absolute URL a page mentions — in attributes, inline scripts and plain
// text, since embeds are often wired up in a <script> rather than an <a>.
function urlsIn(html, pageUrl) {
  const s = String(html || '');
  const out = new Set();
  for (const m of s.matchAll(/(?:href|src|data-src|action)\s*=\s*["']([^"'<>\s]+)["']/gi)) {
    try {
      out.add(new URL(m[1].replace(/&amp;/g, '&'), pageUrl).href);
    } catch {
      /* not a URL */
    }
  }
  // JSON-escaped URLs ("https:\/\/jobs.lever.co\/acme") keep their "\/" pairs
  // inside the match and are unescaped after.
  for (const m of s.matchAll(/https?:(?:\\?\/){2}(?:[^\s"'<>()\\]|\\\/)+/gi)) out.add(m[0].replace(/\\\//g, '/').replace(/&amp;/g, '&'));
  return [...out];
}

/**
 * Board candidates a page links to, most-linked first.
 * @returns {{platform: string, slug: string, count: number}[]}
 */
function extractBoardCandidates(html, pageUrl) {
  const counts = new Map();
  for (const url of urlsIn(html, pageUrl)) {
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (!ATS_HOST.test(host)) continue;
    for (const platform of DISCOVERY_PLATFORMS) {
      const hit = atsDirect.adapters[platform].extractSlugFromUrl(url);
      if (!hit || !hit.slug) continue;
      const key = `${platform}\u0000${hit.slug}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      break;
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [platform, slug] = key.split('\u0000');
      return { platform, slug, count };
    })
    .sort((a, b) => b.count - a.count || DISCOVERY_PLATFORMS.indexOf(a.platform) - DISCOVERY_PLATFORMS.indexOf(b.platform));
}

// Same-site links that look like a careers page, for the second hop.
function careersLinks(html, pageUrl) {
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  const out = new Set();
  for (const m of String(html || '').matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    let u;
    try {
      u = new URL(m[1], pageUrl);
    } catch {
      continue;
    }
    if (u.origin !== origin) continue;
    if (/\/(careers?|jobs|join(-us)?|work-with-us|open-roles|hiring|positions)(\/|$)/i.test(u.pathname)) out.add(u.origin + u.pathname);
  }
  return [...out].slice(0, 3);
}

function normalizeWebsite(site) {
  if (!site) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`);
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Crawl a startup's homepage, then its careers pages, for a job-board link.
 * `fetchText` is injected so the caller controls timeouts/UA (and tests can
 * run offline).
 * @returns {Promise<{candidates: object[], pagesRead: number}>}
 */
async function discoverBoard(website, { fetchText }) {
  const origin = normalizeWebsite(website);
  if (!origin) return { candidates: [], pagesRead: 0 };
  const seen = new Set();
  const pages = [origin, `${origin}/careers`, `${origin}/jobs`];
  let pagesRead = 0;
  let found = [];
  while (pages.length && pagesRead < 5) {
    const url = pages.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let html;
    try {
      html = await fetchText(url);
    } catch {
      continue;
    }
    pagesRead += 1;
    found = found.concat(extractBoardCandidates(html, url));
    if (found.length) break;
    if (url === origin) pages.unshift(...careersLinks(html, url).filter((u) => !seen.has(u)));
  }
  const merged = new Map();
  for (const c of found) {
    const key = `${c.platform}:${c.slug}`;
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, count: prev.count + c.count } : c);
  }
  return { candidates: [...merged.values()].sort((a, b) => b.count - a.count), pagesRead };
}

module.exports = { extractBoardCandidates, careersLinks, discoverBoard, normalizeWebsite, ATS_HOST, DISCOVERY_PLATFORMS };

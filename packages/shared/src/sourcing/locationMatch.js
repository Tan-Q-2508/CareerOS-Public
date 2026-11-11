// Deterministic, synchronous location matching (new §4.6.16) — Layer 1 of the
// three-layer location-filtering fix. Replaces the old raw substring compare
// in atsDirectAdapter.js (`"san jose, ca".includes("usa")` → false, the
// reported false-rejection bug) with real geographic containment: a filter
// matches a posting when the filter is equal-to-or-an-ancestor-of the
// posting's own place in the country > region > metro/city hierarchy.
//
// This module is pure and has zero dependencies (no AI, no DB) so it can run
// synchronously inside the per-posting `keep` predicate that §4.6.13 depends
// on staying synchronous (it gates each streaming adapter's fetchLimitDefault
// cap as postings arrive). Layer 2 (locationResolver.js, AI + cache) handles
// strings this gazetteer can't place; Layer 3 (atsDirectRun.js) re-applies
// this same matchLocation() against Layer 2's resolved structure before the
// deterministic §4.3 pre-filter runs.
//
// Three-value result, never a plain boolean — 'unknown' is a first-class
// outcome (maintainer decision, this session): when we can't confidently
// place either side, we keep the posting rather than guess a mismatch. A
// confident 'mismatch' is reserved for cases the gazetteer can actually prove
// are a different country/region/metro.

const gazetteer = require('./gazetteer.json');

// Multi-country regions used only for scoping a REMOTE posting (e.g.
// "Remote - EMEA"), never for a plain place string — plain places always
// resolve through the country/region/metro gazetteer above. Membership only
// needs to be right about whether a given country IS or ISN'T in the group;
// these lists don't need to be exhaustive of the world, just of the
// gazetteer's own known countries.
const REGION_GROUPS = {
  emea: ['uk', 'de', 'ie', 'fr', 'nl', 'es', 'pl', 'pt', 'il', 'ch', 'se', 'ua', 'ro', 'ae', 'za', 'it', 'dk', 'no', 'fi', 'be', 'at', 'cz', 'hu'],
  apac: ['in', 'au', 'sg', 'jp', 'cn', 'nz', 'ph', 'kr', 'tw', 'hk', 'th', 'my', 'id', 'vn'],
  latam: ['mx', 'br', 'ar', 'co', 'cl'],
  na: ['us', 'ca', 'mx'],
  amer: ['us', 'ca', 'mx', 'br', 'ar', 'co', 'cl'],
};

const GLOBAL_REMOTE_WORDS = new Set(['global', 'worldwide']);

function normalize(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lookupCountryAlias(token) {
  if (!token) return null;
  for (const [name, data] of Object.entries(gazetteer.countries)) {
    if (token === name || data.aliases.includes(token)) return data.code;
  }
  return null;
}

// Matches a token against either a region's full name (the map's key) or its
// short code (the map's value) — "california" and "ca" both resolve the same
// way, same as a human reading either form would expect.
function lookupRegion(token, map) {
  if (!token) return null;
  if (map[token]) return map[token];
  if (Object.values(map).includes(token)) return token;
  return null;
}

function findMetroForCity(city) {
  if (!city) return null;
  for (const [key, data] of Object.entries(gazetteer.metros)) {
    if (data.cities.includes(city)) return { key, data };
  }
  return null;
}

// Splits a posting's own location field on delimiters ATS boards actually use
// to join MULTIPLE distinct postings/offices into one string (Ashby/Lever
// "New York, NY; London, UK" being the canonical shape) — deliberately NOT on
// plain commas, since "City, State" and "City, Country" both rely on the
// comma to mean something. Any ONE resolved segment matching is enough to
// keep the posting (4.6.6's existing multi-location posture).
function splitSegments(raw) {
  return String(raw)
    .split(/\s*;\s*|\s*\|\s*|\s*\/\s*|\s+or\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolvePlace(norm) {
  const tokens = norm.split(',').map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return { kind: 'unknown' };

  let country = null;
  let region = null;
  const remaining = tokens.slice();

  if (remaining.length) {
    const cc = lookupCountryAlias(remaining[remaining.length - 1]);
    if (cc) {
      country = cc;
      remaining.pop();
    }
  }

  if (remaining.length) {
    const last = remaining[remaining.length - 1];
    const usR = lookupRegion(last, gazetteer.usStates);
    const caR = usR ? null : lookupRegion(last, gazetteer.caProvinces);
    const inR = usR || caR ? null : lookupRegion(last, gazetteer.inStates);
    if (usR) {
      region = usR;
      country = country || 'us';
      remaining.pop();
    } else if (caR) {
      region = caR;
      country = country || 'ca';
      remaining.pop();
    } else if (inR) {
      region = inR;
      country = country || 'in';
      remaining.pop();
    }
  }

  let city = remaining.length ? remaining.join(', ') : null;

  let metro = null;
  if (city) {
    // A token can itself BE a metro's name ("Bay Area", "Delhi NCR"), not
    // just one of its member cities — check that first so a filter typed as
    // the metro name resolves the same as typing one of its cities would.
    if (gazetteer.metros[city]) {
      const data = gazetteer.metros[city];
      metro = city;
      country = country || data.country;
      region = region || data.region;
    } else {
      const metroEntry = findMetroForCity(city);
      if (metroEntry) {
        metro = metroEntry.key;
        country = country || metroEntry.data.country;
        region = region || metroEntry.data.region;
      }
    }
  }

  // A bare, unrecognized city with no country/region/metro fix is too weak to
  // reason about hierarchically — surfaced as 'unknown' rather than a place
  // with only a city, so containment checks below don't have to special-case
  // "city known, nothing else is."
  if (!country && !region && !metro) {
    return { kind: 'unknown' };
  }

  return { kind: 'place', country, region, metro, city };
}

function resolveRemote(norm, remoteWord) {
  const idx = norm.indexOf(remoteWord);
  const after = norm
    .slice(idx + remoteWord.length)
    .replace(/^[\s\-–—:()·|,]+/, '')
    .replace(/[\s()]+$/, '')
    .trim();
  // The scope can precede the remote word instead of following it — ATS
  // boards commonly write "Switzerland, Remote" (scope before) as often as
  // "Remote - Switzerland" (scope after). Checking only `after` treated
  // "Switzerland, Remote" as an EMPTY remainder (nothing follows "Remote"),
  // which silently downgraded it to unscoped-global — a real leak caught by
  // testing against Datadog's live board (an EMEA-scoped "Paris, France;
  // Switzerland, Remote" posting passed a "USA" filter). `after` wins when
  // both sides have content, since "Remote - US" style is the more explicit
  // shape.
  const before = norm
    .slice(0, idx)
    .replace(/[\s\-–—:()·|,]+$/, '')
    .trim();
  let remainder = after || before;

  if (!remainder || GLOBAL_REMOTE_WORDS.has(remainder)) {
    return { kind: 'remote', scopeType: null };
  }
  if (REGION_GROUPS[remainder]) {
    return { kind: 'remote', scopeType: 'group', scopeKey: remainder };
  }
  const cc = lookupCountryAlias(remainder);
  if (cc) {
    return { kind: 'remote', scopeType: 'country', scopeCountry: cc };
  }
  const asPlace = resolvePlace(remainder);
  if (asPlace.kind === 'place') {
    return { kind: 'remote', scopeType: 'place', scopePlace: asPlace };
  }
  return { kind: 'remote', scopeType: 'unresolved' };
}

/**
 * Parses one location-ish string (a filter, or a single segment of a
 * posting's location field) into a structured place or remote descriptor.
 * Never throws; unrecognized input resolves to `{ kind: 'unknown' }`.
 */
function resolveLocation(raw) {
  const norm = normalize(raw);
  if (!norm) return { kind: 'unknown' };

  const remoteWord = gazetteer.remoteWords.find((w) => new RegExp(`\\b${escapeRegex(w)}\\b`).test(norm));
  if (remoteWord) return resolveRemote(norm, remoteWord);

  return resolvePlace(norm);
}

// Country/region/metro containment: filterLoc matches jobLoc when filterLoc
// is equal-to-or-coarser-than jobLoc at every level filterLoc actually
// specifies. Missing data on the job side at a level the filter cares about
// is 'unknown', never 'mismatch' — same missing-data posture 4.6.6 already
// uses for empty location/postedAt fields.
function containsPlace(filterLoc, jobLoc) {
  if (filterLoc.country) {
    if (!jobLoc.country) return 'unknown';
    if (jobLoc.country !== filterLoc.country) return 'mismatch';
  }
  if (filterLoc.region) {
    if (!jobLoc.region) return 'unknown';
    if (jobLoc.region !== filterLoc.region) return 'mismatch';
  }
  if (filterLoc.metro) {
    if (!jobLoc.metro) return 'unknown';
    if (jobLoc.metro !== filterLoc.metro) return 'mismatch';
  }
  if (filterLoc.city && !filterLoc.metro) {
    // Filter names a specific city we don't have in the metro table — only a
    // literal city match is confident; anything else is 'unknown', not a
    // proven mismatch (could be the same metro area under a name we don't
    // carry).
    if (!jobLoc.city) return 'unknown';
    if (jobLoc.city !== filterLoc.city) return 'unknown';
  }
  return 'match';
}

function matchRemoteSegment(segLoc, filterLoc) {
  if (segLoc.scopeType == null) return 'match'; // unscoped remote — always kept, per 4.6.6
  if (filterLoc.kind === 'remote') return 'unknown'; // remote-vs-remote scoping isn't reasoned about here
  if (filterLoc.kind !== 'place') return 'unknown';

  if (segLoc.scopeType === 'unresolved') return 'unknown';

  if (segLoc.scopeType === 'place') return containsPlace(filterLoc, segLoc.scopePlace);

  if (segLoc.scopeType === 'country') {
    if (!filterLoc.country) return 'unknown';
    if (segLoc.scopeCountry !== filterLoc.country) return 'mismatch';
    return filterLoc.region ? 'unknown' : 'match'; // can't confirm a sub-region for a country-scoped remote posting
  }

  if (segLoc.scopeType === 'group') {
    if (!filterLoc.country) return 'unknown';
    const members = REGION_GROUPS[segLoc.scopeKey];
    if (!members) return 'unknown';
    return members.includes(filterLoc.country) ? 'match' : 'mismatch';
  }

  return 'unknown';
}

// Core match decision for an ALREADY-RESOLVED location descriptor (the same
// `{kind, country, region, metro, city}` / `{kind: 'remote', scopeType, ...}`
// shape resolveLocation() produces) against a resolved filter. Exported
// separately from matchSegment so Layer 2 (locationResolver.js's AI cache)
// can feed its own resolved structure through the identical hierarchy logic
// instead of re-deriving match rules independently.
function matchResolvedSegment(segLoc, filterLoc) {
  if (!segLoc || segLoc.kind === 'unknown') return 'unknown';
  if (segLoc.kind === 'remote') return matchRemoteSegment(segLoc, filterLoc);
  if (filterLoc.kind === 'remote') {
    // User asked for remote only; a posting resolved to a specific place is a
    // confident non-match for that request.
    return filterLoc.scopeType == null ? 'unknown' : 'mismatch';
  }
  return containsPlace(filterLoc, segLoc);
}

function matchSegment(segStr, filterLoc) {
  return matchResolvedSegment(resolveLocation(segStr), filterLoc);
}

// Converts locationResolver.js's AI-resolved row shape ({city, region,
// country, metro, isRemote, remoteScope, confidence}) into the same
// descriptor shape resolveLocation() produces, so matchResolvedSegment can't
// tell the difference between a gazetteer hit and a cached AI resolution.
function structuredFromResolved(row) {
  if (!row) return { kind: 'unknown' };
  if (row.isRemote) {
    const scope = row.remoteScope || null;
    if (!scope) return { kind: 'remote', scopeType: null };
    if (REGION_GROUPS[scope]) return { kind: 'remote', scopeType: 'group', scopeKey: scope };
    // A bare country code (e.g. "us") from the AI is trusted directly rather
    // than re-resolved through lookupCountryAlias — the resolver's own
    // SYSTEM_INSTRUCTION already constrains it to ISO alpha-2.
    return { kind: 'remote', scopeType: 'country', scopeCountry: scope };
  }
  if (!row.country && !row.region && !row.metro) return { kind: 'unknown' };
  return { kind: 'place', country: row.country || null, region: row.region || null, metro: row.metro || null, city: row.city || null };
}

/**
 * Three-way location match, replacing the old substring `locationMatches`.
 * @param {string} jobLocation posting's own location field (may contain
 *   multiple offices joined by ';'/'|'/'/'/' or ')
 * @param {string|string[]} filter scan's free-text location field, or a
 *   list of them (multi-location scan, 4.6.6) — a posting matching ANY
 *   entry is a match
 * @returns {'match'|'mismatch'|'unknown'}
 */
function matchLocation(jobLocation, filter) {
  if (Array.isArray(filter)) {
    const filters = filter.filter((f) => f && f.trim());
    if (filters.length > 1) return bestStatus(filters.map((f) => matchLocation(jobLocation, f)));
    filter = filters[0];
  }
  if (!filter || !filter.trim()) return 'match'; // empty filter = unfiltered, 4.6.6
  if (!jobLocation || !jobLocation.trim()) return 'match'; // missing data is never a mismatch, 4.6.6

  const filterLoc = resolveLocation(filter);
  if (filterLoc.kind === 'unknown') return 'unknown'; // can't judge against a filter we can't place either

  const statuses = splitSegments(jobLocation).map((seg) => matchSegment(seg, filterLoc));
  if (statuses.includes('match')) return 'match';
  if (statuses.includes('unknown')) return 'unknown';
  return 'mismatch';
}

/** Combines per-filter results for a multi-location scan: any match wins,
 * then any unsure, else mismatch. */
function bestStatus(statuses) {
  if (statuses.includes('match')) return 'match';
  if (statuses.includes('unknown')) return 'unknown';
  return 'mismatch';
}

module.exports = {
  resolveLocation,
  matchLocation,
  bestStatus,
  matchResolvedSegment,
  structuredFromResolved,
  containsPlace,
  splitSegments,
  normalize,
  REGION_GROUPS,
};

// Multi-title scans (4.6.15) — ATS Direct only. `scan_history.config` is a
// jsonb blob with no title column, so `config.job_titles: string[]` is the
// canonical field going forward, but every scan writer also keeps writing
// `config.job_title` as the FIRST title (buildConfig in scan.js) so every
// pre-existing reader (dashboard header, scan-picker option, schedule row,
// notification strings, the COS transaction label) keeps working untouched
// on both new rows and every legacy row that only ever had `job_title`.
//
// Every multi-title-aware reader goes through this instead of reading
// `config.job_title` / `config.job_titles` directly, so "what are this
// scan's titles" has exactly one definition.

/**
 * @param {{job_titles?: string[], job_title?: string}} config
 * @returns {string[]} always an array, oldest legacy rows included; empty
 *   only if the config genuinely has neither field.
 */
function scanTitles(config) {
  if (!config) return [];
  if (Array.isArray(config.job_titles) && config.job_titles.length) return config.job_titles;
  if (config.job_title) return [config.job_title];
  return [];
}

/** Normalizes a list of raw title strings the same way everywhere they're
 * accepted: trim, drop empties, dedupe case-insensitively (order-preserving,
 * first occurrence wins) so "Product Manager" and "product manager " aren't
 * treated as two distinct titles. */
function normalizeTitles(raw) {
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const trimmed = String(t == null ? '' : t).trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

// Multi-location scans (4.6.6) follow the same contract: `locations: string[]`
// is canonical, and `location` keeps a single display string (the list
// joined by " or ") for every pre-existing reader — the dashboard header,
// schedule rows, the empty-scan message, and preference-fit scoring's
// "searched location". Multi-location is ATS Direct only; Core/BYO Scraper
// send `location` to a paid upstream search as one query.

/** @returns {string[]} a config's location filters; empty = unfiltered. */
function scanLocations(config) {
  if (!config) return [];
  if (Array.isArray(config.locations) && config.locations.length) return config.locations;
  if (config.location) return [config.location];
  return [];
}

/** The display/legacy `location` string for a location list. */
function locationLabel(locations) {
  return locations && locations.length ? locations.join(' or ') : null;
}

module.exports = { scanTitles, normalizeTitles, scanLocations, locationLabel };

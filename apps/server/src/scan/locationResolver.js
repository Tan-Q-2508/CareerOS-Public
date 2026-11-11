// Location resolution cache + batched AI fallback (new §4.6.16, Layer 2 of
// the ATS Direct location fix). Modeled directly on
// apps/server/src/companies/sectors.js — same shape (global cache table,
// batched cheap-tier AI call, platform-overhead/unbilled) applied to a
// different fact: "what place does this raw location string refer to"
// instead of "what industry is this company in."
//
// packages/shared/src/sourcing/locationMatch.js (Layer 1, pure/synchronous)
// already resolves the common cases — country names, US/CA/IN states,
// the handful of metro areas — for free, inline in the streaming `keep`
// predicate. This module only runs on what THAT layer couldn't place
// ('unknown'), and only once per distinct string ever, platform-wide: the
// cache is keyed on the normalized string alone (never on a user or a
// scan's filter), so a string like "Hybrid - EMEA hub" gets AI-resolved
// exactly once and every future scan, for every user, reads it back for
// free from location_resolutions.
//
// COST/BILLING: same posture as sectors.js — never billed to any user.
// logLocationUsage() writes ai_usage_log with user_id: null and this module
// never calls cosGuard.debitCos. ATS Direct's flat-fee cost (4.6.7) is
// unaffected.

const aiRouter = require('../lib/aiRouter');
const { tunables, locationMatch } = require('@careeros/shared');
const { normalize } = locationMatch;

const PLATFORM_CREDENTIAL = { mode: 'cai' };

const RESOLVE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          location_id: { type: 'string' },
          city: { type: 'string' },
          region: { type: 'string' },
          country: { type: 'string' },
          metro: { type: 'string' },
          is_remote: { type: 'boolean' },
          remote_scope: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'low'] },
        },
        required: ['location_id', 'city', 'region', 'country', 'metro', 'is_remote', 'remote_scope', 'confidence'],
      },
    },
  },
  required: ['results'],
};

const SYSTEM_INSTRUCTION = [
  'You parse job-posting location strings from ATS boards (Greenhouse, Lever, Ashby, Workday, Workable) into structured geography for a job-search platform.',
  'For each input string, determine: city (the specific city, or "" if none), region (US state / Canadian province / Indian state as its 2-letter code, lowercase, or "" if none), country (ISO 3166-1 alpha-2 code, lowercase, or "" if you cannot determine a country), metro (a well-known metro-area label like "bay area" or "new york city" if the city belongs to one, or "" otherwise), is_remote (true if the string describes a remote/distributed/work-from-home role), and remote_scope (if is_remote, a country code the remote role is restricted to, or a region group like "emea"/"apac"/"latam", or "" if the remote role is unscoped/global).',
  'Use confidence "low" whenever you are genuinely unsure of the country — never guess a specific country just to fill the field; leave country "" instead. Use confidence "high" only when you are confident.',
  'Never invent a city, region, or country that isn\'t actually implied by the string. An ambiguous, garbled, or purely internal-codename string should have all geography fields "", is_remote false, and confidence "low".',
  'Return strict JSON matching the schema, with exactly one result object per input location_id, using only the location_id values you were given.',
].join('\n');

function makeValidator(ids) {
  const idSet = new Set(ids);
  return function validate(p) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.results)) return 'results must be an array';
    for (const r of p.results) {
      if (!r || typeof r !== 'object') return 'each result must be an object';
      if (typeof r.location_id !== 'string' || !idSet.has(r.location_id)) {
        return `result.location_id "${r.location_id}" is not one of the input locations`;
      }
      if (r.confidence !== 'high' && r.confidence !== 'low') {
        return `result for location_id "${r.location_id}" has invalid confidence`;
      }
    }
    return null;
  };
}

function rowToResolved(row) {
  return {
    city: row.city || null,
    region: row.region || null,
    country: row.country || null,
    metro: row.metro || null,
    isRemote: !!row.is_remote,
    remoteScope: row.remote_scope || null,
    confidence: row.confidence,
  };
}

/**
 * Log one platform-overhead ai_usage_log row for a location-resolve call.
 * user_id is deliberately null (never billed to any user, same as sectors.js)
 * — nothing here ever calls cosGuard.debitCos.
 */
async function logLocationUsage(db, result, { locationCount } = {}) {
  if (!result || !result.usage) return;
  const { error } = await db.from('ai_usage_log').insert({
    user_id: null,
    action_type: 'location_resolve',
    provider: 'gemini',
    connection_mode: result.connectionMode,
    model: result.model,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cached_tokens: result.usage.cached_tokens,
    total_tokens: result.usage.total_tokens,
    raw_usage: { ...result.usage.raw, locationCount },
    cost_usd: result.costUsd,
  });
  if (error) console.error('location_resolve ai_usage_log insert failed:', error.message);
}

/**
 * Resolve a batch of raw location strings to structured geography, using
 * location_resolutions as a permanent cache and falling back to one batched
 * AI call (or more, chunked to resolveBatchSize) for whatever isn't cached.
 *
 * @param {object} db
 * @param {string[]} rawStrings
 * @returns {Promise<Map<string, {city, region, country, metro, isRemote, remoteScope, confidence}>>}
 *   keyed by the ORIGINAL raw string (not the normalized form)
 */
async function resolveLocations(db, rawStrings) {
  const byNorm = new Map(); // norm -> [originalStrings]
  for (const raw of rawStrings || []) {
    if (!raw || !raw.trim()) continue;
    const norm = normalize(raw);
    if (!norm) continue;
    if (!byNorm.has(norm)) byNorm.set(norm, []);
    byNorm.get(norm).push(raw);
  }

  const norms = Array.from(byNorm.keys());
  const out = new Map();
  if (!norms.length) return out;

  const { data: cached, error: cacheErr } = await db
    .from('location_resolutions')
    .select('location_norm, city, region, country, metro, is_remote, remote_scope, confidence')
    .in('location_norm', norms);
  if (cacheErr) throw new Error(cacheErr.message);

  const resolvedNorms = new Set();
  for (const row of cached || []) {
    resolvedNorms.add(row.location_norm);
    const resolved = rowToResolved(row);
    for (const orig of byNorm.get(row.location_norm) || []) out.set(orig, resolved);
  }

  const missingNorms = norms.filter((n) => !resolvedNorms.has(n));
  if (!missingNorms.length) return out;

  const batchSize = (tunables.atsDirect && tunables.atsDirect.location && tunables.atsDirect.location.resolveBatchSize) || 40;
  for (let i = 0; i < missingNorms.length; i += batchSize) {
    const batch = missingNorms.slice(i, i + batchSize);
    const validate = makeValidator(batch);
    const prompt = ['LOCATIONS TO RESOLVE:', ...batch.map((n) => `location_id=${n} | text=${n}`)].join('\n');

    let result;
    try {
      result = await aiRouter.structuredCall(PLATFORM_CREDENTIAL, {
        tier: 'cheap',
        systemInstruction: SYSTEM_INSTRUCTION,
        prompt,
        responseSchema: RESOLVE_SCHEMA,
        validate,
      });
    } catch (e) {
      // A resolution failure must never fail the scan — every string in this
      // batch just stays 'unknown' for the caller (Layer 1's safe default:
      // kept, counted, not dropped).
      console.error('locationResolver: AI resolution failed for batch:', e.message);
      continue;
    }

    await logLocationUsage(db, result, { locationCount: batch.length });

    const rows = [];
    for (const r of result.parsed.results) {
      rows.push({
        location_norm: r.location_id,
        city: r.city || null,
        region: r.region || null,
        country: r.country || null,
        metro: r.metro || null,
        is_remote: !!r.is_remote,
        remote_scope: r.remote_scope || null,
        confidence: r.confidence,
        source: 'ai',
      });
    }
    if (rows.length) {
      const { error } = await db.from('location_resolutions').upsert(rows, { onConflict: 'location_norm', ignoreDuplicates: false });
      if (error) console.error('location_resolutions upsert failed:', error.message);
    }

    for (const r of result.parsed.results) {
      const resolved = rowToResolved({
        city: r.city,
        region: r.region,
        country: r.country,
        metro: r.metro,
        is_remote: r.is_remote,
        remote_scope: r.remote_scope,
        confidence: r.confidence,
      });
      for (const orig of byNorm.get(r.location_id) || []) out.set(orig, resolved);
    }
  }

  return out;
}

module.exports = { resolveLocations, makeValidator, logLocationUsage, RESOLVE_SCHEMA };

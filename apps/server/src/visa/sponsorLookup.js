// CareerOS — per-scan sponsorship lookup (spec 19.4, §15 #49).
//
// Resolves a job's employer to its `visa_sponsors` row so runFit can weigh a
// real DOL filing record instead of guessing at "visa/sponsorship reality"
// (5.1's callback_odds). Populated by the quarterly ETL in ./sponsors.js.
//
// ONE LOOKUP PER DISTINCT EMPLOYER PER SCAN, not one per job (19.4). A scan
// routinely returns twenty postings from the same company, and this is a plain
// indexed read whose answer cannot change mid-scan.
//
// The cache stores PROMISES, not resolved values, and that is deliberate:
// atsDirectPipeline drives scoreOne through a bounded concurrent worker pool
// (§26), so two workers can reach the same employer before either query
// returns. Caching the promise means the second worker awaits the first
// worker's in-flight query instead of issuing a duplicate — and because the
// map is written synchronously in the same await-free span that reads it, two
// concurrent callers cannot interleave into a read-modify-write race (§26
// rule 2, the same reasoning jobScorer's priorRawCos accumulator documents).

const { atsDirect } = require('@careeros/shared');
const { aggregateSponsorRows } = require('./aggregate');

const { normalizeCompanyName } = atsDirect;

// employer_name_normalized is the table's unique key and is selected on every
// tier, because it is what de-duplicates the union below: the same filing
// entity can be reached by more than one tier, and counting it twice would
// inflate the company total.
const SPONSOR_COLS =
  'employer_name_normalized, employer_name_display, filing_count_last_fy, avg_wage, wage_level_distribution, top_job_titles, source_fiscal_year, source_quarter, retrieved_at';

// --- the alias tier (19.2) -------------------------------------------------
//
// A THIRD resolution tier, consulted when the registry-id tier misses — and
// then weighed AGAINST the direct normalized-name hit rather than merely
// filling in for its absence (see biggestFiling's note in the resolver).
// `visa_sponsor_aliases` is a short, hand-seeded,
// manually maintained list mapping a registry company's normalized name to the
// subsidiary legal names it actually files under — "amazon" ->
// "amazon com services", "meta" -> "meta platforms". Without it the two
// employers 19.2 names explicitly as the worst misses stay unjoined forever,
// because normalizeCompanyName() cannot bridge a legal-name change and is not
// being asked to: this is a lookup list, not a second matching algorithm.
//
// Loaded ONCE per process, not per job or per scan. The table is ~85 rows and
// only changes when someone edits it by hand, so a per-lookup query would be
// pure overhead. A load failure degrades to "no aliases" rather than throwing:
// the alias tier is an enrichment on an enrichment.
let aliasMapPromise = null;

function loadAliasMap(db) {
  if (aliasMapPromise) return aliasMapPromise;
  aliasMapPromise = db
    .from('visa_sponsor_aliases')
    .select('registry_normalized_name, filing_employer_name')
    .then(({ data, error }) => {
      if (error) throw new Error(error.message);
      const byRegistryName = new Map();
      for (const r of data || []) {
        if (!byRegistryName.has(r.registry_normalized_name)) byRegistryName.set(r.registry_normalized_name, []);
        byRegistryName.get(r.registry_normalized_name).push(r.filing_employer_name);
      }
      return byRegistryName;
    })
    .catch((e) => {
      console.error(`sponsorLookup: alias map load failed, continuing without aliases: ${e.message || e}`);
      return new Map();
    });
  return aliasMapPromise;
}

// --- the exclusion list (19.2) ---------------------------------------------
//
// The INVERSE of the alias map, and needed for the same reason it exists: name
// matching is a plain equality join, and two unrelated real companies can share
// a name. The registry row `vertex` is Vertex Pharmaceuticals (Workday tenant
// `vrtx`); the DOL file also contains `Vertex, Inc.`, the tax-software company,
// whose legal name normalizes to the same `vertex`. Blending them produced a
// "company-wide" figure describing no real company.
//
// Applied HERE and not only at ETL time because the exact-name tier below never
// consults company_ats_registry_id: it queries employer_name_normalized
// directly, so it finds the colliding entity whether or not the ETL linked it.
// Nulling the FK alone would leave this path wrong.
//
// Same loading posture as the alias map — one load per process, a failure
// degrades to "no exclusions" rather than throwing. That degradation direction
// is worth naming: losing the exclusions means over-reporting a company's
// filings, the direction 19.3 does NOT tolerate. It is accepted only because
// the alternative is failing the whole lookup, and a load failure here is the
// same class of event as the alias map's.
let exclusionMapPromise = null;

function loadExclusionMap(db) {
  if (exclusionMapPromise) return exclusionMapPromise;
  exclusionMapPromise = db
    .from('visa_sponsor_exclusions')
    .select('registry_normalized_name, filing_employer_name')
    .then(({ data, error }) => {
      if (error) throw new Error(error.message);
      const byRegistryName = new Map();
      for (const r of data || []) {
        if (!byRegistryName.has(r.registry_normalized_name)) byRegistryName.set(r.registry_normalized_name, new Set());
        byRegistryName.get(r.registry_normalized_name).add(r.filing_employer_name);
      }
      return byRegistryName;
    })
    .catch((e) => {
      console.error(`sponsorLookup: exclusion list load failed, continuing without exclusions: ${e.message || e}`);
      return new Map();
    });
  return exclusionMapPromise;
}

/**
 * Drop every filing entity excluded for `registryName` from a candidate row
 * set. A no-op for the overwhelming majority of companies, which have no
 * exclusions at all.
 *
 * @param {object[]} rows candidate `visa_sponsors` rows
 * @param {Map<string, Set<string>>} exclusions the loaded map
 * @param {?string} registryName the normalized name of the company being resolved
 */
function applyExclusions(rows, exclusions, registryName) {
  if (!registryName || !exclusions || !exclusions.size) return rows;
  const excluded = exclusions.get(registryName);
  if (!excluded || !excluded.size) return rows;
  return rows.filter((r) => !excluded.has(r.employer_name_normalized));
}

// Test seam: drop the cached maps so a later call reloads them.
function _resetAliasCache() {
  aliasMapPromise = null;
  exclusionMapPromise = null;
}

// Of two candidate sponsor rows for the same company, the one with more
// certified filings. Nulls lose; two nulls give null.
//
// Still used where a SINGLE representative row is wanted rather than a company
// total — notably picking which entity's name and registry link lead. The
// company-facing figure comes from aggregateSponsorRows (19.2), not from here.
function biggestFiling(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return Number(b.filing_count_last_fy || 0) > Number(a.filing_count_last_fy || 0) ? b : a;
}

/**
 * @param {object} db service-role Supabase client
 * @returns {{resolve: (companyName: string, registryId: ?string) => Promise<?object>, stats: object}}
 */
function createSponsorResolver(db) {
  const cache = new Map();
  const stats = { lookups: 0, hits: 0, misses: 0, cached: 0 };

  // THREE TIERS, UNIONED — not short-circuited. Each names filing entities that
  // may belong to this company, and a real company is often reachable by more
  // than one: Amazon's registry-id tier finds the entities the ETL managed to
  // join, while its alias tier finds the ones whose legal names never
  // normalized to `amazon`. Taking the first tier that hits, as this used to,
  // silently discarded the rest of the company.
  //
  // aggregateSponsorRows de-duplicates by employer_name_normalized, so an
  // entity found by two tiers is counted once (19.2).
  async function query(companyName, registryId) {
    const rows = [];

    // The link the ETL actually resolved — it survives the
    // display-name/legal-name gap that leaves most large employers unjoined.
    if (registryId) {
      const { data, error } = await db
        .from('visa_sponsors')
        .select(SPONSOR_COLS)
        .eq('company_ats_registry_id', registryId)
        .order('filing_count_last_fy', { ascending: false });
      if (error) throw new Error(`visa_sponsors lookup by registry id failed: ${error.message}`);
      rows.push(...(data || []));
    }

    const normalized = normalizeCompanyName(companyName);
    if (!normalized) return aggregateSponsorRows(rows);

    // The exact legal name, which is how a company with no registry row still
    // gets an answer.
    const { data, error } = await db
      .from('visa_sponsors')
      .select(SPONSOR_COLS)
      .eq('employer_name_normalized', normalized)
      .maybeSingle();
    if (error) throw new Error(`visa_sponsors lookup by name failed: ${error.message}`);
    if (data) rows.push(data);

    // The hand-seeded alias list (19.2) — the subsidiary legal names a registry
    // company actually files under. This tier is what makes the totals real for
    // the household names: "Deloitte LLP" matches `deloitte` exactly with SIX
    // certified filings, while "Deloitte Consulting LLP", the same company's
    // real hiring entity, filed 2,613. Position alone would have put the 6 on
    // the badge; now both are part of one company total.
    const filingNames = (await loadAliasMap(db)).get(normalized);
    if (filingNames && filingNames.length) {
      const { data: aliased, error: aliasErr } = await db
        .from('visa_sponsors')
        .select(SPONSOR_COLS)
        .in('employer_name_normalized', filingNames)
        .order('filing_count_last_fy', { ascending: false });
      if (aliasErr) throw new Error(`visa_sponsors lookup by alias failed: ${aliasErr.message}`);
      rows.push(...(aliased || []));
    }

    // Last, so it catches an entity reached by ANY tier — the registry-id tier
    // included, since a table linked before the exclusion existed still carries
    // the old FK until the next ETL run.
    return aggregateSponsorRows(applyExclusions(rows, await loadExclusionMap(db), normalized));
  }

  /**
   * @returns {Promise<?object>} the sponsor row, or null when this employer has
   *   no matched filing record. A null is NEVER "this employer does not
   *   sponsor" (19.4) — absence of a filing is not evidence of refusal, and
   *   large employers frequently file under subsidiary legal names that do not
   *   normalize to their registry display name.
   */
  function resolve(companyName, registryId) {
    const key = `${registryId || ''}|${normalizeCompanyName(companyName) || ''}`;
    if (key === '|') return Promise.resolve(null);

    const cached = cache.get(key);
    if (cached) {
      stats.cached++;
      return cached;
    }

    stats.lookups++;
    // A failed lookup must not fail the scan or poison the cache with a
    // rejected promise every later caller re-throws: this is an enrichment
    // signal, and scoring without it is strictly better than not scoring.
    const p = query(companyName, registryId)
      .then((row) => {
        if (row) stats.hits++;
        else stats.misses++;
        return row;
      })
      .catch((e) => {
        console.error(`sponsorLookup: ${companyName}: ${e.message || e}`);
        stats.misses++;
        return null;
      });
    cache.set(key, p);
    return p;
  }

  return { resolve, stats };
}

/**
 * The one-line vintage string 19.3 requires wherever this data is shown or
 * stated. Never build this by hand at a call site — 19.3's whole point is that
 * no surface hardcodes or guesses the quarter.
 */
function sponsorVintage(sponsor) {
  if (!sponsor) return null;
  const retrieved = sponsor.retrieved_at ? String(sponsor.retrieved_at).slice(0, 10) : 'unknown date';
  return `FY${sponsor.source_fiscal_year} Q${sponsor.source_quarter}, retrieved ${retrieved}`;
}

/**
 * Compact, human-readable wage-level mix, biggest share first — "II 44%,
 * III 27%, IV 19%". Shared by the fit prompt's facts block and the badge so
 * the number a user reads and the number the model weighed are the same one.
 */
function wageLevelSummary(sponsor) {
  const dist = sponsor && sponsor.wage_level_distribution;
  if (!dist || typeof dist !== 'object') return null;
  const parts = Object.entries(dist)
    .filter(([, share]) => Number(share) > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([level, share]) => `${level} ${Math.round(share * 100)}%`);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Attach each job's matched `visa_sponsors` row as `job.visa_sponsor` (19.5's
 * badge data), in two bulk queries for the whole list rather than one per job.
 * The per-scan resolver above is for the SCORING path, which sees jobs one at a
 * time; this is for the read APIs, which already have the whole list in hand.
 *
 * Mutates nothing and never throws: a sponsorship lookup failure must not take
 * down the dashboard, so on error every job simply comes back with a null
 * `visa_sponsor` — which the badge renders as "No sponsorship data", the same
 * as a genuine no-record. That equivalence is safe here precisely because that
 * state means "we don't know" and never "does not sponsor" (19.3/19.4/19.5).
 */
async function attachSponsors(db, jobs) {
  if (!jobs || !jobs.length) return jobs || [];

  const registryIds = new Set();
  const names = new Set();
  for (const j of jobs) {
    if (j.company_ats_registry_id) registryIds.add(j.company_ats_registry_id);
    const n = normalizeCompanyName(j.company_name);
    if (n) names.add(n);
  }
  if (!registryIds.size && !names.size) return jobs.map((j) => ({ ...j, visa_sponsor: null }));

  // Every filing entity found for a registry id / normalized name, not just the
  // biggest — the aggregation below needs the whole set (19.2).
  const byRegistryId = new Map();
  const byName = new Map();
  let exclusions = new Map();

  const push = (map, key, row) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  };

  try {
    const CHUNK = 200;
    const ids = [...registryIds];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await db
        .from('visa_sponsors')
        .select(`company_ats_registry_id, ${SPONSOR_COLS}`)
        .in('company_ats_registry_id', ids.slice(i, i + CHUNK))
        .order('filing_count_last_fy', { ascending: false });
      if (error) throw new Error(error.message);
      for (const r of data || []) push(byRegistryId, r.company_ats_registry_id, r);
    }

    const nameList = [...names];
    for (let i = 0; i < nameList.length; i += CHUNK) {
      const { data, error } = await db
        .from('visa_sponsors')
        .select(SPONSOR_COLS)
        .in('employer_name_normalized', nameList.slice(i, i + CHUNK));
      if (error) throw new Error(error.message);
      for (const r of data || []) push(byName, r.employer_name_normalized, r);
    }

    // Alias tier. One extra chunked query for the whole page of jobs, not one
    // per job. Run for every name, not only the unresolved ones: a company's
    // exact-name entity and its alias entities are all part of the same total.
    exclusions = await loadExclusionMap(db);

    const aliasMap = await loadAliasMap(db);
    const wanted = new Map(); // filing name -> registry normalized name
    for (const n of nameList) {
      for (const filingName of aliasMap.get(n) || []) wanted.set(filingName, n);
    }
    const filingNames = [...wanted.keys()];
    for (let i = 0; i < filingNames.length; i += CHUNK) {
      const { data, error } = await db
        .from('visa_sponsors')
        .select(SPONSOR_COLS)
        .in('employer_name_normalized', filingNames.slice(i, i + CHUNK))
        .order('filing_count_last_fy', { ascending: false });
      if (error) throw new Error(error.message);
      // Folded in under the REGISTRY name, so a company's alias entities join
      // the same bucket its exact-name entity is already in.
      for (const r of data || []) {
        const registryName = wanted.get(r.employer_name_normalized);
        if (registryName) push(byName, registryName, r);
      }
    }
  } catch (e) {
    console.error(`attachSponsors: ${e.message || e}`);
    return jobs.map((j) => ({ ...j, visa_sponsor: null }));
  }

  return jobs.map((j) => {
    const normalized = normalizeCompanyName(j.company_name) || '';
    const rows = [
      ...(j.company_ats_registry_id ? byRegistryId.get(j.company_ats_registry_id) || [] : []),
      ...(byName.get(normalized) || []),
    ];
    return { ...j, visa_sponsor: aggregateSponsorRows(applyExclusions(rows, exclusions, normalized)) };
  });
}

module.exports = {
  createSponsorResolver,
  attachSponsors,
  sponsorVintage,
  wageLevelSummary,
  SPONSOR_COLS,
  _resetAliasCache,
  // exported for testing, and for sponsorTracklists.js — the alias map has one
  // loader (19.2's "no second matching system" applies to the reader too).
  loadAliasMap,
  biggestFiling,
  // Same one-loader rule as the alias map — sponsorTracklists.js consumes this
  // rather than re-reading the table (19.2's "no second matching system"
  // applies to the reader too).
  loadExclusionMap,
  applyExclusions,
};

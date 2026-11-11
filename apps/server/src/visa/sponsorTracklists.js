// CareerOS — sponsor system tracklists (spec 19.5, §15 #49).
//
// Keeps two is_system tracklists in sync with visa_sponsors, the same way
// companies/sectors.js's syncSectorTracklists() keeps the sector lists in
// sync with company_sectors. Deliberately the same shape (id cache by name,
// diff desired-vs-current, upsert-then-delete) rather than a new mechanism —
// these lists subscribe, browse and scan through the existing 4.6.6/4.6.8/4.6.9
// paths with no scan-side code at all.
//
// Two differences from the sector sync, both forced by the data:
//
// - Sector sync runs over a BOUNDED batch of registry ids (it is called after
//   classifying a handful of newly-detected companies). This runs over the
//   WHOLE table, because the source is a quarterly bulk refresh — there is no
//   "the companies that just changed" to scope it to. Hence the pagination
//   below: PostgREST silently caps a select at 1000 rows.
// - Membership is a JOIN condition, not a stored tag. 19.5: a company enters
//   only where it has both a visa_sponsors row and an ACTIVE registry row,
//   since a sponsor with no reachable board can't be scanned and listing it
//   would be misleading.
//
// A company is reached two ways, and both are needed. The ETL's own
// company_ats_registry_id covers the employers whose legal name normalized to
// their registry name; the hand-seeded visa_sponsor_aliases map (19.2) covers
// the ones it didn't — which is most of the household names, because they file
// through subsidiaries. Reading only the first left Amazon and Meta badged and
// scored as sponsors but absent from the list of sponsors, which is the kind of
// inconsistency a user notices before a maintainer does. The alias map is
// loaded through sponsorLookup.js's loader, not re-read here.
//
// Thresholds apply to the aggregated COMPANY (19.2), not to its largest legal
// entity, so an employer that files 6 through one subsidiary and 2,613 through
// another is judged on 2,619.
//
// The exclusion list (19.2) is applied here too, and this is the third of three
// places it has to be: a name collision that survives to this point does not
// merely misprint a badge, it decides LIST MEMBERSHIP. `Vertex, Inc.` blended
// into Vertex Pharmaceuticals moved that company's entry-level share across the
// threshold — in the direction that happened to be right, off a number that was
// wrong. Same single loader sponsorLookup.js owns; this is a second consumer,
// not a second mechanism.

const { tunables } = require('@careeros/shared');
const { aggregateSponsorRows } = require('./aggregate');
const { loadAliasMap, loadExclusionMap, applyExclusions } = require('./sponsorLookup');

// Enough to aggregate a company: the identity key, the count, the distribution
// and the vintage aggregateSponsorRows guards on.
const SPONSOR_SELECT =
  'company_ats_registry_id, employer_name_normalized, employer_name_display, filing_count_last_fy, avg_wage, wage_level_distribution, top_job_titles, source_fiscal_year, source_quarter, retrieved_at';

const SPONSORS_LIST = 'H-1B Sponsors';
const ENTRY_LEVEL_LIST = 'H-1B Sponsors — Entry-Level Friendly';

// Seeded by 20260828010000_sponsor_tracklists.sql and never renamed (system
// lists are not user-editable), so caching ids for the process lifetime is
// safe — the same reasoning sectors.js's systemTracklistIdCache uses.
let idCache = null;

async function sponsorTracklistIds(db) {
  if (idCache) return idCache;
  const { data, error } = await db
    .from('tracklists')
    .select('id, name')
    .eq('is_system', true)
    .in('name', [SPONSORS_LIST, ENTRY_LEVEL_LIST]);
  if (error) throw new Error(`sponsor tracklist lookup failed: ${error.message}`);

  const byName = {};
  for (const row of data || []) byName[row.name] = row.id;
  if (!byName[SPONSORS_LIST] || !byName[ENTRY_LEVEL_LIST]) {
    throw new Error(
      'sponsor system tracklists are missing — apply supabase/migrations/20260828010000_sponsor_tracklists.sql'
    );
  }
  idCache = byName;
  return idCache;
}

/**
 * Entry-level friendliness, the whole reason 19.2 stores a distribution rather
 * than a count: the share of this employer's certified filings at OES wage
 * levels I and II. A company filing 200 roles at 90% Level III-IV is a poor
 * early-career target no matter how large its raw sponsor volume is.
 *
 * 'N/A' rows are excluded from the denominator rather than counted as senior —
 * they mean the employer didn't determine an OES level, which is not evidence
 * either way, and at ~25-40% of some employers' filings, silently treating them
 * as senior would misclassify real entry-level sponsors.
 */
function entryLevelShare(dist) {
  if (!dist || typeof dist !== 'object') return null;
  let junior = 0;
  let graded = 0;
  for (const [level, share] of Object.entries(dist)) {
    const n = Number(share) || 0;
    if (level === 'N/A') continue;
    graded += n;
    if (level === 'I' || level === 'II') junior += n;
  }
  return graded > 0 ? junior / graded : null;
}

// PostgREST caps a single select at 1000 rows regardless of a missing .limit()
// — silently, no error, no truncation flag (the same 25b gotcha
// scripts/classify-sectors.js and companies/registry.js's selectAllPages both
// document).
async function selectAllPages(build) {
  const pageSize = 1000;
  const all = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await build().range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

/**
 * Rebuild both sponsor tracklists' membership from the current visa_sponsors
 * and company_ats_registry state. Idempotent — re-running it makes no changes
 * when nothing moved.
 *
 * @returns {Promise<{sponsors: number, entryLevel: number, added: number, removed: number}>}
 */
async function syncSponsorTracklists(db) {
  const ids = await sponsorTracklistIds(db);
  const cfg = (tunables.visaSponsors && tunables.visaSponsors.tracklists) || {};
  const minFilings = cfg.minFilings ?? 1;
  const entryLevelMinShare = cfg.entryLevelMinShare ?? 0.4;
  const entryLevelMinFilings = cfg.entryLevelMinFilings ?? 10;

  // Sponsors the ETL managed to join to a registry row by name.
  const sponsors = await selectAllPages(() =>
    db
      .from('visa_sponsors')
      .select(SPONSOR_SELECT)
      .not('company_ats_registry_id', 'is', null)
      .order('company_ats_registry_id', { ascending: true })
  );

  // ...and only where that registry row is still active (19.5's membership
  // rule). Checked against the registry rather than trusted from the FK, since
  // a board can be parked between quarterly refreshes.
  //
  // company_name_normalized comes along because it is the alias table's key —
  // see the alias pass below.
  const activeRegistry = await selectAllPages(() =>
    db
      .from('company_ats_registry')
      .select('id, company_name_normalized')
      .eq('status', 'active')
      .order('id', { ascending: true })
  );
  const activeIds = new Set(activeRegistry.map((r) => r.id));
  // The exclusion list is keyed by the registry company's normalized name, so
  // membership needs the reverse of the alias pass's lookup.
  const normalizedNameById = new Map(activeRegistry.map((r) => [r.id, r.company_name_normalized]));

  // Group every filing entity under its registry company, so the thresholds
  // below are applied to a COMPANY, not to whichever legal entity happened to
  // be biggest (19.2).
  const rowsByRegistryId = new Map();
  const addRow = (registryId, row) => {
    if (!activeIds.has(registryId)) return;
    if (!rowsByRegistryId.has(registryId)) rowsByRegistryId.set(registryId, []);
    rowsByRegistryId.get(registryId).push(row);
  };
  for (const s of sponsors) addRow(s.company_ats_registry_id, s);

  // THE ALIAS PASS (19.2). Without it these lists read a strictly narrower view
  // of the table than the badge does: Amazon and Meta are badged and scored as
  // sponsors but were not members of "H-1B Sponsors", because their filing
  // entities' legal names never normalize to their registry names and so their
  // company_ats_registry_id is null. Same hand-seeded map, same single loader
  // sponsorLookup.js uses — this is a second CONSUMER, not a second mechanism.
  const exclusions = await loadExclusionMap(db);

  const aliasMap = await loadAliasMap(db);
  if (aliasMap.size) {
    const registryIdByName = new Map();
    for (const r of activeRegistry) {
      if (r.company_name_normalized) registryIdByName.set(r.company_name_normalized, r.id);
    }

    // Only aliases pointing at a real active registry row are worth querying.
    const wanted = new Map(); // filing employer name -> registry id
    for (const [registryName, filingNames] of aliasMap) {
      const registryId = registryIdByName.get(registryName);
      if (!registryId) continue;
      for (const filingName of filingNames) wanted.set(filingName, registryId);
    }

    const filingNames = [...wanted.keys()];
    const CHUNK = 200;
    for (let i = 0; i < filingNames.length; i += CHUNK) {
      const { data, error } = await db
        .from('visa_sponsors')
        .select(SPONSOR_SELECT)
        .in('employer_name_normalized', filingNames.slice(i, i + CHUNK));
      if (error) throw new Error(`sponsor tracklist alias lookup failed: ${error.message}`);
      for (const r of data || []) addRow(wanted.get(r.employer_name_normalized), r);
    }
  }

  const desired = new Map([
    [ids[SPONSORS_LIST], new Set()],
    [ids[ENTRY_LEVEL_LIST], new Set()],
  ]);
  for (const [registryId, rows] of rowsByRegistryId) {
    // aggregateSponsorRows de-duplicates, so an entity reached both by the
    // registry join and by an alias is counted once.
    const company = aggregateSponsorRows(applyExclusions(rows, exclusions, normalizedNameById.get(registryId)));
    if (!company || company.filing_count_last_fy < minFilings) continue;

    desired.get(ids[SPONSORS_LIST]).add(registryId);
    const share = entryLevelShare(company.wage_level_distribution);
    if (share !== null && share >= entryLevelMinShare && company.filing_count_last_fy >= entryLevelMinFilings) {
      desired.get(ids[ENTRY_LEVEL_LIST]).add(registryId);
    }
  }

  const current = await selectAllPages(() =>
    db
      .from('tracklist_companies')
      .select('id, tracklist_id, company_ats_registry_id')
      .in('tracklist_id', [ids[SPONSORS_LIST], ids[ENTRY_LEVEL_LIST]])
      .order('id', { ascending: true })
  );

  const currentByList = new Map([
    [ids[SPONSORS_LIST], new Map()],
    [ids[ENTRY_LEVEL_LIST], new Map()],
  ]);
  for (const row of current) {
    const m = currentByList.get(row.tracklist_id);
    if (m) m.set(row.company_ats_registry_id, row.id);
  }

  const toInsert = [];
  const toDelete = [];
  for (const [tracklistId, want] of desired) {
    const have = currentByList.get(tracklistId);
    for (const registryId of want) {
      if (!have.has(registryId)) toInsert.push({ tracklist_id: tracklistId, company_ats_registry_id: registryId });
    }
    for (const [registryId, rowId] of have) {
      if (!want.has(registryId)) toDelete.push(rowId);
    }
  }

  // tracklist_companies' (tracklist_id, company_ats_registry_id) unique is
  // PLAIN, so it is a safe onConflict target — unlike tracklists' own partial
  // name indexes (20260806000000_tracklists.sql's header).
  const BATCH = 500;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const { error } = await db
      .from('tracklist_companies')
      .upsert(toInsert.slice(i, i + BATCH), {
        onConflict: 'tracklist_id,company_ats_registry_id',
        ignoreDuplicates: true,
      });
    if (error) throw new Error(`sponsor tracklist insert failed: ${error.message}`);
  }
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const { error } = await db.from('tracklist_companies').delete().in('id', toDelete.slice(i, i + BATCH));
    if (error) throw new Error(`sponsor tracklist delete failed: ${error.message}`);
  }

  return {
    sponsors: desired.get(ids[SPONSORS_LIST]).size,
    entryLevel: desired.get(ids[ENTRY_LEVEL_LIST]).size,
    added: toInsert.length,
    removed: toDelete.length,
  };
}

module.exports = { syncSponsorTracklists, entryLevelShare, SPONSORS_LIST, ENTRY_LEVEL_LIST };

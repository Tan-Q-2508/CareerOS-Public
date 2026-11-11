// The built-in Startups tracklist (spec 4.6.9a, §15 #65).
//
// Keeps one is_system tracklist, "Startups — Y Combinator", in sync with
// company_startup_profiles — the same shape as visa/sponsorTracklists.js and
// companies/sectors.js's syncSectorTracklists (id cached by name, desired vs
// current diff, insert-then-delete), so the list subscribes, browses and scans
// through the existing 4.6.6/4.6.8 paths with no scan-side code at all.
//
// MEMBERSHIP: a company is on the list when it has a startup profile that is
// currently hiring AND an ACTIVE registry row. A profile whose board went dead
// cannot be scanned, and a startup that is not hiring would only make every
// scan of the list slower for no postings; both rejoin automatically on the
// next sync once that changes.

// Every row a query matches, past PostgREST's 1000-row page. `build` returns
// a fresh ordered query per page — the same helper runScan.js keeps, copied
// rather than required so this module does not load the scan pipeline.
async function selectAllRows(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

const STARTUPS_LIST = 'Startups — Y Combinator';

// Seeded by 20260926000000_expanded_ats_coverage_and_startups.sql and never
// renamed (system lists are not user-editable), so caching is safe.
let idCache = null;

async function startupTracklistId(db) {
  if (idCache) return idCache;
  const { data, error } = await db.from('tracklists').select('id').eq('is_system', true).eq('name', STARTUPS_LIST).maybeSingle();
  if (error) throw new Error(`startup tracklist lookup failed: ${error.message}`);
  if (!data) throw new Error('startup system tracklist is missing — apply supabase/migrations/20260926000000_expanded_ats_coverage_and_startups.sql');
  idCache = data.id;
  return idCache;
}

/**
 * Pure membership rule, separated so it is testable without a database.
 * @param {{company_ats_registry_id: string, is_hiring: boolean|null}[]} profiles
 * @param {Set<string>} activeIds registry ids with status 'active'
 */
function desiredMembers(profiles, activeIds) {
  const out = new Set();
  for (const p of profiles) {
    if (p.is_hiring === false) continue;
    if (activeIds.has(p.company_ats_registry_id)) out.add(p.company_ats_registry_id);
  }
  return out;
}

/**
 * Rebuild the list's membership. Idempotent.
 * @returns {Promise<{members: number, added: number, removed: number}>}
 */
async function syncStartupTracklist(db) {
  const tracklistId = await startupTracklistId(db);
  const profiles = await selectAllRows(() =>
    db.from('company_startup_profiles').select('company_ats_registry_id, is_hiring').order('company_ats_registry_id', { ascending: true })
  );
  const ids = profiles.map((p) => p.company_ats_registry_id);
  const activeIds = new Set();
  const CHUNK = 300;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await db.from('company_ats_registry').select('id').eq('status', 'active').in('id', ids.slice(i, i + CHUNK));
    if (error) throw new Error(`startup tracklist registry lookup failed: ${error.message}`);
    for (const r of data || []) activeIds.add(r.id);
  }
  const want = desiredMembers(profiles, activeIds);

  const current = await selectAllRows(() =>
    db.from('tracklist_companies').select('id, company_ats_registry_id').eq('tracklist_id', tracklistId).order('id', { ascending: true })
  );
  const have = new Map(current.map((r) => [r.company_ats_registry_id, r.id]));

  const toInsert = [...want].filter((id) => !have.has(id)).map((id) => ({ tracklist_id: tracklistId, company_ats_registry_id: id }));
  const toDelete = [...have].filter(([id]) => !want.has(id)).map(([, rowId]) => rowId);

  const BATCH = 500;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const { error } = await db
      .from('tracklist_companies')
      .upsert(toInsert.slice(i, i + BATCH), { onConflict: 'tracklist_id,company_ats_registry_id', ignoreDuplicates: true });
    if (error) throw new Error(`startup tracklist insert failed: ${error.message}`);
  }
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const { error } = await db.from('tracklist_companies').delete().in('id', toDelete.slice(i, i + BATCH));
    if (error) throw new Error(`startup tracklist delete failed: ${error.message}`);
  }
  return { members: want.size, added: toInsert.length, removed: toDelete.length };
}

module.exports = { syncStartupTracklist, desiredMembers, STARTUPS_LIST };

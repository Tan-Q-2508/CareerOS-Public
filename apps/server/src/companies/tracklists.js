// Tracklists — personal, multi-list company organization (spec 4.6.8).
// Phase 4, §15 #25a.
//
// Replaces user_tracked_companies (4.6.5, §23) as the write/read surface for
// company tracking. CRUD + membership lives here; registry.js's dedup-then-
// detect functions (trackCompany/untrackCompany/listTrackedCompanies/
// listKnownCompanies/listScanCompanies) are retargeted onto this module rather
// than duplicating the query shapes.
//
// Follows the house helper-module shape: a plain module taking the supabase
// client as its first argument (no DAO layer exists in this codebase).
//
// PARTIAL-INDEX GOTCHA (CLAUDE.md standing note, migration 20260806000000):
// tracklists' two name-uniqueness indexes both carry a WHERE clause, so
// .upsert({onConflict}) cannot target them — the upsert API exposes neither a
// repeated WHERE nor a named-constraint reference. Every insert path below that
// could collide with one of those indexes uses select-then-insert-or-update
// instead, the same pattern provider_credentials already uses.
// tracklist_companies' uniqueness (tracklist_id, company_ats_registry_id) has
// no WHERE clause, so onConflict IS safe there and is used directly.

const { STARTUPS_LIST } = require('./startupTracklist');
const { SPONSORS_LIST, ENTRY_LEVEL_LIST } = require('../visa/sponsorTracklists');
const REGISTRY_COLS =
  'id, company_name_normalized, company_name_display, platform, slug_or_identifier, status, source, detected_at, last_seen_at';

/** Postgres unique-violation. */
function isUniqueViolation(error) {
  return error && (error.code === '23505' || /duplicate key value/i.test(error.message || ''));
}

function assertOwned(tracklist, userId) {
  if (!tracklist) {
    const e = new Error('Tracklist not found');
    e.status = 404;
    throw e;
  }
  if (tracklist.is_system || tracklist.user_id !== userId) {
    const e = new Error('Not your tracklist');
    e.status = 403;
    throw e;
  }
}

/** Fetch + ownership-check a personal tracklist in one call. */
async function getOwnedTracklist(db, userId, tracklistId) {
  const { data, error } = await db
    .from('tracklists')
    .select('id, user_id, name, is_system')
    .eq('id', tracklistId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  assertOwned(data, userId);
  return data;
}

// ---------------------------------------------------------------------------
// List CRUD (4.6.8)
// ---------------------------------------------------------------------------

/**
 * The user's personal tracklists plus any system tracklists they're
 * subscribed to (25b populates system rows; this already supports them),
 * each annotated with its company count.
 */
async function listTracklists(db, userId) {
  const [{ data: personal, error: pErr }, { data: subs, error: sErr }] = await Promise.all([
    db.from('tracklists').select('id, name, is_system, created_at, updated_at').eq('user_id', userId).order('created_at', { ascending: true }),
    db
      .from('tracklist_subscriptions')
      .select('subscribed_at, tracklist:tracklists (id, name, is_system, created_at, updated_at)')
      .eq('user_id', userId),
  ]);
  if (pErr) throw new Error(pErr.message);
  if (sErr) throw new Error(sErr.message);

  const subscribed = (subs || []).filter((s) => s.tracklist).map((s) => ({ ...s.tracklist, subscribed_at: s.subscribed_at }));
  const all = [...(personal || []), ...subscribed];
  if (!all.length) return [];

  // §15 #25b guard (c) — this used to pull EVERY tracklist_companies row for
  // every listed list just to count them; harmless at 25a's scale (a handful
  // of personal lists) but a Settings-page load could pull thousands of rows
  // the moment a user subscribes broadly to sector tracklists (4.6.9). A
  // head-count query per list avoids ever materializing membership rows here.
  const counts = await Promise.all(
    all.map((t) => db.from('tracklist_companies').select('id', { count: 'exact', head: true }).eq('tracklist_id', t.id))
  );
  for (const { error: cErr } of counts) if (cErr) throw new Error(cErr.message);

  return all.map((t, i) => ({ ...t, company_count: counts[i].count || 0 }));
}

/** Create a personal tracklist. Rejects a case-insensitive duplicate name explicitly. */
async function createTracklist(db, userId, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    const e = new Error('Tracklist name is required');
    e.status = 400;
    throw e;
  }
  const { data, error } = await db
    .from('tracklists')
    .insert({ user_id: userId, name: trimmed, is_system: false })
    .select('id, name, is_system, created_at, updated_at')
    .single();
  if (!error) return { ...data, company_count: 0 };
  if (isUniqueViolation(error)) {
    const e = new Error('You already have a tracklist with that name');
    e.status = 409;
    throw e;
  }
  throw new Error(error.message);
}

async function renameTracklist(db, userId, tracklistId, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    const e = new Error('Tracklist name is required');
    e.status = 400;
    throw e;
  }
  await getOwnedTracklist(db, userId, tracklistId);
  const { data, error } = await db
    .from('tracklists')
    .update({ name: trimmed })
    .eq('id', tracklistId)
    .select('id, name, is_system, created_at, updated_at')
    .single();
  if (!error) return data;
  if (isUniqueViolation(error)) {
    const e = new Error('You already have a tracklist with that name');
    e.status = 409;
    throw e;
  }
  throw new Error(error.message);
}

/** Deletes the tracklist and its membership rows. Never touches company_ats_registry (4.6.8). */
async function deleteTracklist(db, userId, tracklistId) {
  await getOwnedTracklist(db, userId, tracklistId);
  const { error } = await db.from('tracklists').delete().eq('id', tracklistId);
  if (error) throw new Error(error.message);
}

/**
 * A list's companies, joined to the global registry, optionally name-filtered/paginated.
 *
 * §15 #25b guard (d): with `q` set, this used to `.range()` FIRST and filter
 * by name in JS after — searching an 800-company sector list only ever
 * searched the first `limit` rows, silently missing real matches further in.
 * Fixed by resolving membership ids first (cheap: two narrow columns, no
 * REGISTRY_COLS join), then letting Postgres do the `ilike` + pagination on
 * the actual query. Membership without `q` still just paginates by added_at,
 * same as before.
 */
async function listTracklistCompanies(db, userId, tracklistId, { q, limit = 200, offset = 0 } = {}) {
  const tracklist = await getOwnedTracklistOrSubscribed(db, userId, tracklistId);
  if (!tracklist) {
    const e = new Error('Tracklist not found');
    e.status = 404;
    throw e;
  }

  const { data: members, error: mErr } = await db
    .from('tracklist_companies')
    .select('company_ats_registry_id, added_at')
    .eq('tracklist_id', tracklistId);
  if (mErr) throw new Error(mErr.message);
  if (!members || !members.length) return [];

  const addedAtById = new Map(members.map((m) => [m.company_ats_registry_id, m.added_at]));
  const memberIds = members.map((m) => m.company_ats_registry_id);

  if (q) {
    const { data, error } = await db
      .from('company_ats_registry')
      .select(REGISTRY_COLS)
      .in('id', memberIds)
      .ilike('company_name_display', `%${q}%`)
      .order('company_name_display', { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw new Error(error.message);
    return (data || []).map((c) => ({ ...c, added_at: addedAtById.get(c.id) }));
  }

  // No search term — keep the original added_at-desc ordering, paginated on
  // membership (cheap: just ids) before the registry fetch.
  const sortedIds = [...memberIds].sort((a, b) => new Date(addedAtById.get(b)) - new Date(addedAtById.get(a)));
  const pageIds = sortedIds.slice(offset, offset + limit);
  if (!pageIds.length) return [];
  const { data, error } = await db.from('company_ats_registry').select(REGISTRY_COLS).in('id', pageIds);
  if (error) throw new Error(error.message);
  const byId = new Map((data || []).map((c) => [c.id, c]));
  return pageIds.map((id) => byId.get(id)).filter(Boolean).map((c) => ({ ...c, added_at: addedAtById.get(c.id) }));
}

/** A personal tracklist the user owns, OR a system tracklist they're subscribed to (read access). */
async function getOwnedTracklistOrSubscribed(db, userId, tracklistId) {
  const { data: tl, error } = await db.from('tracklists').select('id, user_id, name, is_system').eq('id', tracklistId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!tl) return null;
  if (!tl.is_system && tl.user_id === userId) return tl;
  if (tl.is_system) {
    const { data: sub } = await db
      .from('tracklist_subscriptions')
      .select('id')
      .eq('user_id', userId)
      .eq('tracklist_id', tracklistId)
      .maybeSingle();
    if (sub) return tl;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Membership (4.6.8's bulk multiselect add flow)
// ---------------------------------------------------------------------------

/**
 * Add one or more companies to one or more of the user's own tracklists in one
 * action, optionally creating a new tracklist inline first.
 *
 * @param {object} db
 * @param {string} userId
 * @param {{registryIds: string[], tracklistIds?: string[], newTracklistName?: string}} input
 * @returns {Promise<{tracklistIds: string[], added: number}>}
 */
async function addCompaniesToTracklists(db, userId, { registryIds, tracklistIds, newTracklistName } = {}) {
  const ids = Array.from(new Set((registryIds || []).filter(Boolean)));
  if (!ids.length) {
    const e = new Error('Select at least one company');
    e.status = 400;
    throw e;
  }

  let targetListIds = Array.from(new Set((tracklistIds || []).filter(Boolean)));

  if (newTracklistName && newTracklistName.trim()) {
    const created = await createTracklist(db, userId, newTracklistName);
    targetListIds.push(created.id);
  }

  if (!targetListIds.length) {
    const e = new Error('Select at least one tracklist, or name a new one');
    e.status = 400;
    throw e;
  }

  // Ownership check on every target list — a spoofed id in tracklistIds must
  // not silently add companies to (or reveal membership of) another user's list.
  const { data: owned, error: ownedErr } = await db
    .from('tracklists')
    .select('id, user_id, is_system')
    .in('id', targetListIds);
  if (ownedErr) throw new Error(ownedErr.message);
  const ownedIds = new Set((owned || []).filter((t) => !t.is_system && t.user_id === userId).map((t) => t.id));
  const unauthorized = targetListIds.filter((id) => !ownedIds.has(id));
  if (unauthorized.length) {
    const e = new Error('Not your tracklist');
    e.status = 403;
    throw e;
  }

  const rows = [];
  for (const tracklistId of targetListIds) {
    for (const companyId of ids) rows.push({ tracklist_id: tracklistId, company_ats_registry_id: companyId });
  }

  const { error } = await db
    .from('tracklist_companies')
    .upsert(rows, { onConflict: 'tracklist_id,company_ats_registry_id', ignoreDuplicates: true });
  if (error) throw new Error(error.message);

  return { tracklistIds: targetListIds, added: rows.length };
}

async function removeCompanyFromTracklist(db, userId, tracklistId, registryId) {
  await getOwnedTracklist(db, userId, tracklistId);
  const { error } = await db
    .from('tracklist_companies')
    .delete()
    .eq('tracklist_id', tracklistId)
    .eq('company_ats_registry_id', registryId);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// System (sector) tracklists (spec 4.6.9) — §15 #25b
// ---------------------------------------------------------------------------

/** Every system tracklist, with its company count and whether this user subscribes. */
async function listSystemTracklists(db, userId) {
  const [{ data: systemLists, error: sErr }, { data: subs, error: subErr }] = await Promise.all([
    db.from('tracklists').select('id, name, is_system, created_at, updated_at').eq('is_system', true).order('name', { ascending: true }),
    db.from('tracklist_subscriptions').select('tracklist_id').eq('user_id', userId),
  ]);
  if (sErr) throw new Error(sErr.message);
  if (subErr) throw new Error(subErr.message);

  const subscribedIds = new Set((subs || []).map((s) => s.tracklist_id));
  const lists = systemLists || [];
  if (!lists.length) return [];

  // Head-counts, same guard-(c) reasoning as listTracklists — a sector list
  // can hold thousands of companies and this only needs the count.
  const counts = await Promise.all(
    lists.map((t) => db.from('tracklist_companies').select('id', { count: 'exact', head: true }).eq('tracklist_id', t.id))
  );
  for (const { error: cErr } of counts) if (cErr) throw new Error(cErr.message);

  return lists
    .map((t, i) => ({ ...t, kind: systemListKind(t.name), company_count: counts[i].count || 0, subscribed: subscribedIds.has(t.id) }))
    .sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || x.name.localeCompare(y.name));
}

// Which built-in family a system list belongs to (§15 #65), so the browser can
// show the Startups and sponsor lists apart from the sector lists instead of
// alphabetically among them. Read from the lists' fixed seeded names — system
// lists are never renamed.
const KIND_ORDER = ['startup', 'sponsor', 'sector'];
function systemListKind(name) {
  if (name === STARTUPS_LIST) return 'startup';
  if (name === SPONSORS_LIST || name === ENTRY_LEVEL_LIST) return 'sponsor';
  return 'sector';
}

function assertSystemTracklist(tracklist) {
  if (!tracklist) {
    const e = new Error('Tracklist not found');
    e.status = 404;
    throw e;
  }
  if (!tracklist.is_system) {
    const e = new Error('Not a system tracklist');
    e.status = 400;
    throw e;
  }
}

async function subscribeToSystemTracklist(db, userId, tracklistId) {
  const { data: tl, error: tErr } = await db.from('tracklists').select('id, is_system').eq('id', tracklistId).maybeSingle();
  if (tErr) throw new Error(tErr.message);
  assertSystemTracklist(tl);

  const { error } = await db
    .from('tracklist_subscriptions')
    .upsert({ user_id: userId, tracklist_id: tracklistId }, { onConflict: 'user_id,tracklist_id', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}

async function unsubscribeFromSystemTracklist(db, userId, tracklistId) {
  const { data: tl, error: tErr } = await db.from('tracklists').select('id, is_system').eq('id', tracklistId).maybeSingle();
  if (tErr) throw new Error(tErr.message);
  assertSystemTracklist(tl);

  const { error } = await db.from('tracklist_subscriptions').delete().eq('user_id', userId).eq('tracklist_id', tracklistId);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Named lazily-created lists — §15 #25c-1 generalizes what was a single
// "default list" helper (4.6.5's auto-track target) into a by-name lookup,
// since 4.6.10 now needs TWO such lists: the pre-existing personal default
// ("My Tracked Companies", the per-job "Track this company" action's default
// target) and the new opt-in-toggle target ("Scraped Companies", 4.6.10) —
// kept separate so automatic and curated tracking stay visibly distinct.
// ---------------------------------------------------------------------------

const DEFAULT_TRACKLIST_NAME = 'My Tracked Companies';
const SCRAPED_TRACKLIST_NAME = 'Scraped Companies';

/** Lazily creates a named personal tracklist for the user if it doesn't already exist. */
async function namedTracklistId(db, userId, name) {
  const { data: existing, error } = await db
    .from('tracklists')
    .select('id')
    .eq('user_id', userId)
    .ilike('name', name)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (existing) return existing.id;

  const { data: created, error: insErr } = await db
    .from('tracklists')
    .insert({ user_id: userId, name, is_system: false })
    .select('id')
    .single();
  if (!insErr) return created.id;
  if (isUniqueViolation(insErr)) {
    // Concurrent caller won the race — re-select rather than erroring.
    const { data: race } = await db
      .from('tracklists')
      .select('id')
      .eq('user_id', userId)
      .ilike('name', name)
      .maybeSingle();
    if (race) return race.id;
  }
  throw new Error(insErr.message);
}

/** Lazily creates the user's default tracklist if it doesn't already exist. */
async function defaultTracklistId(db, userId) {
  return namedTracklistId(db, userId, DEFAULT_TRACKLIST_NAME);
}

/** Lazily creates the user's "Scraped Companies" auto-track list (4.6.10). */
async function scrapedTracklistId(db, userId) {
  return namedTracklistId(db, userId, SCRAPED_TRACKLIST_NAME);
}

module.exports = {
  listTracklists,
  createTracklist,
  renameTracklist,
  deleteTracklist,
  listTracklistCompanies,
  addCompaniesToTracklists,
  removeCompanyFromTracklist,
  namedTracklistId,
  defaultTracklistId,
  scrapedTracklistId,
  DEFAULT_TRACKLIST_NAME,
  SCRAPED_TRACKLIST_NAME,
  getOwnedTracklist,
  getOwnedTracklistOrSubscribed,
  listSystemTracklists,
  subscribeToSystemTracklist,
  unsubscribeFromSystemTracklist,
  REGISTRY_COLS,
};

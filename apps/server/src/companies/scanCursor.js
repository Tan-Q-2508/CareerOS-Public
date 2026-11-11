// Rotating cursor for an ATS Direct scan's company selection (spec 4.6.6,
// Phase 4 §15 #25c-2). A fixed sort order (alphabetical, or most-recently-
// detected) systematically starves whichever end of the list sorts last, so
// each distinct SELECTION (the resolved set of tracklist/subscription/
// narrow-registry-id inputs, not the user or a single tracklist) tracks where
// the last scan against it left off and the next scan picks up from there.
//
// "Cursor stability bug" (4.6.6, caught pre-build) — the cursor is NOT an
// integer index into "the" ordering. A tracklist's membership isn't static
// (companies added/removed, sector tracklists reclassify automatically), so a
// bare integer offset silently points at a different company once the
// underlying set has shifted. Resolved: the cursor is the
// company_ats_registry id of the LAST COMPANY ACTUALLY QUERIED, plus that
// same fixed, immutable, monotonically-assigned key (the id itself — never
// detected_at or any other mutable field) used to resolve "next." A scan
// resumes by re-querying the current selection's live company set, sorting by
// id, and starting from the first id greater than the stored cursor id,
// wrapping to the start if it reaches the end — so an addition/removal
// anywhere else in the list can't shift what "resume from here" means.

const crypto = require('crypto');

// F4: guards saveCursor's update against a stale/smaller value overwriting a
// newer one — see saveCursor's comment below for the exact race this closes.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A stable key identifying one distinct company selection — sorted, deduped
 * so id-list/title-list ORDER never matters (the same tracklist picked with
 * the same titles in a different order is the same selection and must share
 * one rotation).
 *
 * `titles` (4.6.15) is folded in deliberately: changing a scan's job titles
 * is a different search and should start a fresh rotation from a new random
 * point, not resume mid-way through the old titles' progress. This is why a
 * single tracklist run with titles ["Product Manager"] and the SAME
 * tracklist run with ["Product Manager", "Business Analyst"] get two
 * independent `ats_scan_cursors` rows, each with its own progress — neither
 * overwrites or resumes the other.
 *
 * @param {{tracklistIds?: string[], registryIds?: string[], titles?: string[]}} selection
 * @returns {string} sha256 hex
 */
function selectionKey({ tracklistIds, registryIds, titles } = {}) {
  const t = Array.from(new Set((tracklistIds || []).filter(Boolean))).sort();
  const r = Array.from(new Set((registryIds || []).filter(Boolean))).sort();
  const j = Array.from(new Set((titles || []).filter(Boolean).map((s) => s.trim().toLowerCase()))).sort();
  const payload = JSON.stringify({ t, r, j });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Orders `companies` (each `{id, ...}`) starting just past `lastCompanyId` —
 * sorted by id (the fixed key), first element is the first id strictly
 * greater than the cursor, wrapping to the start if the cursor's id is at or
 * past the end (or the cursor's company isn't in the live set at all, e.g. it
 * was untracked or deleted since — falls back to "start from the top of the
 * sorted set" cleanly, no error).
 *
 * With no stored cursor (`lastCompanyId` null/undefined), a brand-new
 * selection starts at a RANDOM id in the live set (4.6.6) rather than
 * position zero, so distinct new selections don't all coincidentally begin
 * from the same alphabetically-or-id-first company.
 *
 * @param {Array<{id: string}>} companies
 * @param {string|null} lastCompanyId
 * @returns {Array<{id: string}>}
 */
function orderFromCursor(companies, lastCompanyId) {
  if (!companies || !companies.length) return [];
  const sorted = [...companies].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (!lastCompanyId) {
    const startIdx = Math.floor(Math.random() * sorted.length);
    return [...sorted.slice(startIdx), ...sorted.slice(0, startIdx)];
  }

  let resumeIdx = sorted.findIndex((c) => c.id > lastCompanyId);
  if (resumeIdx === -1) resumeIdx = 0; // cursor was at/past the tail — wrap to the start
  return [...sorted.slice(resumeIdx), ...sorted.slice(0, resumeIdx)];
}

/**
 * Persist how far this selection's rotation got — select-then-insert-or-
 * update (CLAUDE.md's standing partial-index gotcha doesn't apply here, the
 * (user_id, selection_key) unique has no WHERE clause, but this still follows
 * the house pattern for consistency with tracklists.js/registry.js rather
 * than mixing an .upsert() call into a module that otherwise never uses one).
 *
 * @param {object} db
 * @param {string} userId
 * @param {string} key selectionKey() output
 * @param {string} lastCompanyId the last company actually queried this run
 */
async function saveCursor(db, userId, key, lastCompanyId) {
  if (!lastCompanyId) return; // nothing was queried — leave any existing cursor untouched
  const { data: existing, error: selErr } = await db
    .from('ats_scan_cursors')
    .select('id')
    .eq('user_id', userId)
    .eq('selection_key', key)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);

  if (existing) {
    // F4: the old update was an unconditional select-then-write with no
    // guard against a smaller/stale value overwriting a larger one — safe
    // only because atsDirectRun.js's maybeCheckpoint keeps a single save
    // in flight per scan; a second concurrent scan against the identical
    // selection_key was not protected. The WHERE clause below makes the
    // "don't regress" guarantee atomic at the database level instead of
    // relying on the caller's own serialization: it only ever accepts a
    // larger id, OR the row's current value is null (company_ats_registry
    // id it pointed at was deleted, ON DELETE SET NULL — that's the same as
    // "no cursor yet," so any real value is always an improvement over null).
    if (!UUID_RE.test(lastCompanyId)) {
      throw new Error(`saveCursor: lastCompanyId is not a uuid: ${lastCompanyId}`);
    }
    const { error } = await db
      .from('ats_scan_cursors')
      .update({ last_company_id: lastCompanyId })
      .eq('id', existing.id)
      .or(`last_company_id.is.null,last_company_id.lt.${lastCompanyId}`);
    if (error) throw new Error(error.message);
    return;
  }

  const { error: insErr } = await db
    .from('ats_scan_cursors')
    .insert({ user_id: userId, selection_key: key, last_company_id: lastCompanyId });
  if (insErr && !/duplicate key value/i.test(insErr.message || '')) {
    // A concurrent scan against the identical selection lost the insert race
    // — the other write already recorded a cursor position, nothing lost.
    throw new Error(insErr.message);
  }
}

/** The selection's currently stored cursor, or null if it's never been run. */
async function loadCursor(db, userId, key) {
  const { data, error } = await db
    .from('ats_scan_cursors')
    .select('last_company_id')
    .eq('user_id', userId)
    .eq('selection_key', key)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? data.last_company_id : null;
}

module.exports = { selectionKey, orderFromCursor, saveCursor, loadCursor };

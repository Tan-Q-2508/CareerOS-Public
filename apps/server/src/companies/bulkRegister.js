// Bulk registration of already-researched company boards (spec 4.6.3/4.6.5,
// §15 #65) — the decision layer behind scripts/import-top-companies.js and
// scripts/import-startups.js. Each script owns argv, probing and reporting;
// this module owns what a row-level write means, so both imports follow one
// rule set.
//
// Three writes, each deliberate:
//
//   * register — insert a new registry row for a probed board. Refuses when the
//     BOARD is already in the registry under any name (a second row would
//     scan the same board twice), and reports a NAME conflict instead of
//     overwriting it — the normalized-name key is unique, and the existing
//     row may be a different company that happens to normalize the same way
//     (the "Flex" startup vs Flex Ltd.).
//   * repoint — change the platform/slug of an EXISTING row in place. Used only
//     for a mapping research proved wrong (the empty Workable squatter
//     accounts, MetLife's Colombian Lever board). Updating in place keeps the
//     row's id, so every user's tracklist membership and the row's sector tags
//     survive — deleting and re-inserting would silently drop both.
//   * retire — move a proved-wrong mapping with no reachable replacement into
//     company_ats_unresolved (4.6.5: a company lives in exactly one of the two
//     tables). The registry delete cascades out of tracklists, which is the
//     intended effect: a squatter board sources nothing.

const { normalizeCompanyName } = require('@careeros/shared').atsDirect;
const { insertRegistryRow, isUniqueViolation, REGISTRY_COLS } = require('./registry');

async function findByName(db, normalized) {
  const { data, error } = await db.from('company_ats_registry').select(REGISTRY_COLS).eq('company_name_normalized', normalized).maybeSingle();
  if (error) throw new Error(`registry name lookup failed: ${error.message}`);
  return data || null;
}

// Case-insensitive: some registry slugs were stored lower-cased by earlier
// imports ("citi:wd5:2", "cigna:wd5:cignacareers") while research reads them
// off live URLs in their original case.
async function findByBoard(db, platform, slug) {
  const { data, error } = await db
    .from('company_ats_registry')
    .select(REGISTRY_COLS)
    .eq('platform', platform)
    .ilike('slug_or_identifier', String(slug).replace(/[%_\\]/g, (c) => `\\${c}`));
  if (error) throw new Error(`registry board lookup failed: ${error.message}`);
  return (data && data[0]) || null;
}

async function clearUnresolved(db, normalized) {
  const { error } = await db.from('company_ats_unresolved').delete().eq('company_name_normalized', normalized);
  if (error) throw new Error(`unresolved cleanup failed: ${error.message}`);
}

async function stampProbed(db, id) {
  const now = new Date().toISOString();
  const { error } = await db
    .from('company_ats_registry')
    .update({ probed_at: now, probe_outcome: 'ok', last_seen_at: now, status: 'active' })
    .eq('id', id);
  if (error) throw new Error(`probe stamp failed: ${error.message}`);
}

/**
 * @returns {Promise<{action: 'inserted'|'board_exists'|'name_taken'|'failed', company: object|null, existing?: object}>}
 */
async function register(db, { display, platform, slug, source = 'manual', dryRun = false }) {
  const normalized = normalizeCompanyName(display);
  if (!normalized) return { action: 'failed', company: null, reason: 'unusable name' };

  const onBoard = await findByBoard(db, platform, slug);
  if (onBoard) return { action: 'board_exists', company: onBoard };

  const named = await findByName(db, normalized);
  if (named) return { action: 'name_taken', company: null, existing: named };

  if (dryRun) return { action: 'inserted', company: null, dryRun: true };
  const { company, created } = await insertRegistryRow(db, { normalized, display, platform, slug, source });
  if (!company) return { action: 'failed', company: null, reason: 'insert failed' };
  if (!created) return { action: 'name_taken', company: null, existing: company };
  await stampProbed(db, company.id);
  await clearUnresolved(db, normalized);
  return { action: 'inserted', company };
}

/**
 * Point an existing row (found by name) at a different, probed board.
 * @returns {Promise<{action: 'repointed'|'unchanged'|'missing'|'board_exists', company: object|null}>}
 */
async function repoint(db, { display, platform, slug, dryRun = false }) {
  const normalized = normalizeCompanyName(display);
  const row = await findByName(db, normalized);
  if (!row) return { action: 'missing', company: null };
  if (row.platform === platform && String(row.slug_or_identifier).toLowerCase() === String(slug).toLowerCase()) {
    return { action: 'unchanged', company: row };
  }
  const onBoard = await findByBoard(db, platform, slug);
  if (onBoard && onBoard.id !== row.id) return { action: 'board_exists', company: onBoard, previous: row };
  if (dryRun) return { action: 'repointed', company: row, previous: { platform: row.platform, slug: row.slug_or_identifier }, dryRun: true };
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('company_ats_registry')
    .update({ platform, slug_or_identifier: slug, status: 'active', probed_at: now, probe_outcome: 'ok', last_seen_at: now })
    .eq('id', row.id)
    .select(REGISTRY_COLS)
    .single();
  if (error) {
    if (isUniqueViolation(error)) return { action: 'board_exists', company: row };
    throw new Error(`repoint failed: ${error.message}`);
  }
  return { action: 'repointed', company: data, previous: { platform: row.platform, slug: row.slug_or_identifier } };
}

/**
 * Move a proved-wrong mapping out of the registry into the unresolved table.
 * Only retires a row whose CURRENT board matches `expect` — a row someone else
 * already fixed is left alone.
 */
async function retire(db, { display, expect, careersUrl, dryRun = false }) {
  const normalized = normalizeCompanyName(display);
  const row = await findByName(db, normalized);
  if (!row) return { action: 'missing' };
  if (expect && (row.platform !== expect.platform || String(row.slug_or_identifier).toLowerCase() !== String(expect.slug).toLowerCase())) {
    return { action: 'not_matching', company: row };
  }
  if (dryRun) return { action: 'retired', company: row, dryRun: true };
  const { error: insErr } = await db.from('company_ats_unresolved').insert({
    company_name_normalized: normalized,
    company_name_display: row.company_name_display,
    match_attempt_type: 'name_guess_failed',
    careers_url_guess: careersUrl || null,
    source: 'manual',
  });
  if (insErr && !isUniqueViolation(insErr)) throw new Error(`unresolved insert failed: ${insErr.message}`);
  const { error: delErr } = await db.from('company_ats_registry').delete().eq('id', row.id);
  if (delErr) throw new Error(`registry delete failed: ${delErr.message}`);
  return { action: 'retired', company: row };
}

/**
 * Give an existing row (by id) the company's real name. For rows an earlier
 * bulk import named after its ATS slug or page title ("Jci", "Egug",
 * "For nearly 160 years, PNC") — the board was reachable but no one could find
 * it by the company's name, and sector classification (4.6.9) read the junk
 * name. Refuses if another row already holds the target name; never merges.
 */
async function rename(db, { id, display, dryRun = false }) {
  const normalized = normalizeCompanyName(display);
  if (!normalized) return { action: 'failed', reason: 'unusable name' };
  const holder = await findByName(db, normalized);
  if (holder && holder.id === id) return { action: 'unchanged', company: holder };
  if (holder) return { action: 'name_taken', existing: holder };
  if (dryRun) return { action: 'renamed', dryRun: true };
  const { data, error } = await db
    .from('company_ats_registry')
    .update({ company_name_normalized: normalized, company_name_display: display })
    .eq('id', id)
    .select(REGISTRY_COLS)
    .single();
  if (error) {
    if (isUniqueViolation(error)) return { action: 'name_taken' };
    throw new Error(`rename failed: ${error.message}`);
  }
  await clearUnresolved(db, normalized);
  await clearDerivedSectors(db, id);
  return { action: 'renamed', company: data };
}

// A rename changes the classifier's only real input (4.6.9 classifies from
// name, platform and slug), so tags derived from the old junk name are stale —
// "Mpc" had made Marathon Petroleum `media_entertainment`. Removing the
// AI-derived rows makes scripts/classify-sectors.js select the company again;
// an admin override is kept, as the classifier itself would keep it.
async function clearDerivedSectors(db, id) {
  const { error } = await db.from('company_sectors').delete().eq('company_ats_registry_id', id).neq('source', 'admin');
  if (error) throw new Error(`sector reset failed: ${error.message}`);
}

module.exports = { register, repoint, retire, rename, findByBoard, findByName };

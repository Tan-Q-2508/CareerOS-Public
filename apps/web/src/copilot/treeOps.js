// Pure content_tree mutations for Copilot Mode Stage 3 (spec 7.14.3 step 2).
// Every function takes a tree and returns a NEW tree — no React, no fetch —
// so these are verifiable offline against the server's own validateTree
// (apps/server/src/generation/copilotTree.js). Mirrors that file's shape
// exactly; it is the only other place that is allowed to know this shape.
//
// Entry `order` is scoped PER KIND (experience and project entries both start
// at 0 — assembleFromTree sorts each kind independently), so every reorder
// here renumbers within one kind, never globally.

function clone(tree) {
  return JSON.parse(JSON.stringify(tree));
}

function renumber(list) {
  list.forEach((item, i) => {
    item.order = i;
  });
}

// containerId for a bullet list is an entry_id, or the literal 'summary'.
function containerBullets(tree, containerId) {
  if (containerId === 'summary') return tree.summary;
  const entry = tree.entries.find((e) => e.entry_id === containerId);
  return entry ? entry.bullets : null;
}

export function reorderEntries(tree, kind, orderedEntryIds) {
  const next = clone(tree);
  const idIndex = new Map(orderedEntryIds.map((id, i) => [id, i]));
  const ofKind = next.entries.filter((e) => e.kind === kind);
  // Active entries take the requested order; any not named (graveyarded ones
  // omitted by the caller) keep their relative order, appended after.
  ofKind.sort((a, b) => {
    const ai = idIndex.has(a.entry_id) ? idIndex.get(a.entry_id) : Infinity;
    const bi = idIndex.has(b.entry_id) ? idIndex.get(b.entry_id) : Infinity;
    if (ai !== bi) return ai - bi;
    return a.order - b.order;
  });
  renumber(ofKind);
  return next;
}

export function reorderBullets(tree, containerId, orderedBulletIds) {
  const next = clone(tree);
  const bullets = containerBullets(next, containerId);
  if (!bullets) return tree;
  const idIndex = new Map(orderedBulletIds.map((id, i) => [id, i]));
  bullets.sort((a, b) => {
    const ai = idIndex.has(a.bullet_id) ? idIndex.get(a.bullet_id) : Infinity;
    const bi = idIndex.has(b.bullet_id) ? idIndex.get(b.bullet_id) : Infinity;
    if (ai !== bi) return ai - bi;
    return a.order - b.order;
  });
  renumber(bullets);
  return next;
}

// Moves a bullet from one container (entry_id or 'summary') to another,
// inserting at toIndex. Permitted by validateTree — a bullet_id just has to
// stay known and unduplicated, moving containers isn't itself checked.
export function moveBullet(tree, bulletId, fromContainerId, toContainerId, toIndex) {
  const next = clone(tree);
  const from = containerBullets(next, fromContainerId);
  const to = containerBullets(next, toContainerId);
  if (!from || !to) return tree;
  const idx = from.findIndex((b) => b.bullet_id === bulletId);
  if (idx < 0) return tree;
  const [bullet] = from.splice(idx, 1);
  renumber(from);
  const clampedIndex = Math.max(0, Math.min(toIndex, to.length));
  to.splice(clampedIndex, 0, bullet);
  renumber(to);
  return next;
}

// The ordered set of picks a bullet's variant cycler may land on. 'custom'
// only appears once an AI edit (or the assembler's own truncation) has
// actually produced custom_text — so cycling can always return to that text
// without inventing one, and the server's tampered_custom_text gate can never
// fire from a cycle (this file never writes custom_text).
export function variantRing(bullet) {
  const base = ['short', 'one_line', 'two_line'].filter((k) => !!(bullet.variants && bullet.variants[k]));
  if (bullet.custom_text) base.push('custom');
  return base;
}

export function setVariant(tree, bulletId, picked) {
  const next = clone(tree);
  const found = findBulletIn(next, bulletId);
  if (!found) return tree;
  const ring = variantRing(found.bullet);
  if (!ring.includes(picked)) return tree;
  found.bullet.picked = picked;
  return next;
}

export function cycleVariant(tree, bulletId, dir = 1) {
  const found = findBulletIn(tree, bulletId);
  if (!found) return tree;
  const ring = variantRing(found.bullet);
  if (ring.length < 2) return tree;
  const i = ring.indexOf(found.bullet.picked);
  const nextPick = ring[(i < 0 ? 0 : i + dir + ring.length) % ring.length];
  return setVariant(tree, bulletId, nextPick);
}

export function graveyardEntry(tree, entryId) {
  const next = clone(tree);
  const entry = next.entries.find((e) => e.entry_id === entryId);
  if (!entry || entry.graveyard) return tree;
  entry.graveyard = true;
  renumber(next.entries.filter((e) => e.kind === entry.kind && !e.graveyard));
  return next;
}

export function restoreEntry(tree, entryId) {
  const next = clone(tree);
  const entry = next.entries.find((e) => e.entry_id === entryId);
  if (!entry || !entry.graveyard) return tree;
  entry.graveyard = false;
  const ofKind = next.entries.filter((e) => e.kind === entry.kind && !e.graveyard);
  entry.order = ofKind.length - 1; // append to the end of the active list
  renumber(ofKind.sort((a, b) => a.order - b.order));
  return next;
}

function findBulletIn(tree, bulletId) {
  for (const b of tree.summary || []) if (b.bullet_id === bulletId) return { bullet: b, containerId: 'summary' };
  for (const e of tree.entries || []) {
    for (const b of e.bullets || []) if (b.bullet_id === bulletId) return { bullet: b, containerId: e.entry_id };
  }
  for (const b of tree.graveyard_bullets || []) if (b.bullet_id === bulletId) return { bullet: b, containerId: null };
  return null;
}

// Removes a bullet from its container into tree.graveyard_bullets, stamping
// graveyard_from_entry_id ('summary' for a summary bullet) so restore is
// possible after a reload — validateTree ignores unknown bullet fields, so
// this marker round-trips through PATCH untouched.
export function removeBullet(tree, bulletId) {
  const next = clone(tree);
  const found = findBulletIn(next, bulletId);
  if (!found || found.containerId === null) return tree; // already graveyarded
  const bullets = containerBullets(next, found.containerId);
  const idx = bullets.findIndex((b) => b.bullet_id === bulletId);
  if (idx < 0) return tree;
  const [bullet] = bullets.splice(idx, 1);
  renumber(bullets);
  bullet.graveyard_from_entry_id = found.containerId;
  next.graveyard_bullets = next.graveyard_bullets || [];
  next.graveyard_bullets.push(bullet);
  return next;
}

export function restoreBullet(tree, bulletId) {
  const next = clone(tree);
  const list = next.graveyard_bullets || [];
  const idx = list.findIndex((b) => b.bullet_id === bulletId);
  if (idx < 0) return tree;
  const [bullet] = list.splice(idx, 1);
  const toContainerId = bullet.graveyard_from_entry_id || 'summary';
  delete bullet.graveyard_from_entry_id;
  const bullets = containerBullets(next, toContainerId);
  if (!bullets) {
    // Origin entry itself is gone/graveyarded relative to what we know —
    // fall back to summary rather than dropping the bullet on the floor.
    next.summary = next.summary || [];
    bullet.order = next.summary.length;
    next.summary.push(bullet);
    renumber(next.summary);
    return next;
  }
  bullet.order = bullets.length;
  bullets.push(bullet);
  renumber(bullets);
  return next;
}

// Applies a server-returned AI edit (rewrite/inject-keyword/AI-new-bullet) to
// a LOCAL tree copy, mirroring the server's own applyEditAndBill exactly
// (spec 7.14.6). CHANGED 2026-08-02 (Phase 3 bug fix): the server now returns
// up to THREE band-passing variants + a real `picked` key, not a single
// custom string — `variants` REPLACES the bullet's variants map (so the
// existing VariantCycler chips become the picker for the new text) and
// custom_text is cleared, rather than routing everything through 'custom'.
// This file never invents the text itself; it only mirrors what the server
// already committed to BOTH content_tree and origin_tree, so the resulting
// local tree stays byte-identical to the server's — the caller must advance
// savedRevision in the same action that applies this (see CopilotContext's
// AI_EDIT_SUCCESS), or the next debounced PATCH would needlessly re-send text
// the server already has.
export function applyAiEdit(tree, bulletId, { variants, picked, rejected, origin, grounded }) {
  const next = clone(tree);
  const found = findBulletIn(next, bulletId);
  if (!found) return tree;
  found.bullet.prev_variants = found.bullet.variants;
  found.bullet.prev_picked = found.bullet.picked;
  found.bullet.prev_custom_text = found.bullet.custom_text;
  found.bullet.variants = variants;
  found.bullet.picked = picked;
  found.bullet.custom_text = null;
  found.bullet.origin = origin;
  found.bullet.grounded = grounded;
  found.bullet.rejected_variants = rejected;
  return next;
}

// There is deliberately no applyRevert here. One existed as a local mirror of
// the server's /revert, written for an optimistic local update — but the revert
// caller has always dispatched SERVER_TREE_UPDATE with the server's own tree,
// which is authoritative, so the mirror had zero call sites for its entire
// life. Removed in §15 #59. If an optimistic revert is ever wanted, the
// prev_* fields applyAiEdit writes above are what it would read.

export { clone, findBulletIn };

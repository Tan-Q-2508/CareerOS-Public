const { tunables } = require('@careeros/shared');
const { isOngoing } = require('./contentDirector');
const { fmtDates } = require('./renderResume');
const { fitHeader } = require('./generateResume');
const { geometry, DEFAULT_RENDER } = require('./metrics');
const { flattenBullets } = require('./copilotTree');

// Resume Vault drawer (spec 7.14.11) + Custom Bullet Injector (spec 7.14.14).
// Pure, no DB, no AI — everything here is derivable from the master profile
// (resume_versions.parsed_profile) plus the session's current content_tree.
// This is the diff/node-building half; routes/copilot.js owns the HTTP layer
// and the origin_tree-advancing write (the same applyToBothTrees path AI
// edits already use).

// ---- diff: what's in the master profile but not in the tree ----

// A role/project entry is "in the tree" iff some (non-graveyarded OR
// graveyarded — a graveyarded entry is already restorable in-tree via a plain
// PATCH, so it must not also appear in the Vault) tree.entries row has this
// kind+source_index. Graveyard state is irrelevant to the diff itself.
function entryPresent(tree, kind, sourceIndex) {
  return (tree.entries || []).some((e) => e.kind === kind && e.source_index === sourceIndex);
}

function preview(text, max = 90) {
  const t = String(text || '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function buildVault({ tree, profile }) {
  // flattenBullets already walks graveyard_bullets, which is correct: a
  // graveyarded bullet's source id must count as "used" (it's already
  // restorable in-tree, not vault-eligible).
  const usedSourceIds = new Set(flattenBullets(tree).map((b) => b.source_bullet_id).filter(Boolean));

  const entries = [];
  (profile.roles || []).forEach((role, i) => {
    if (entryPresent(tree, 'experience', i)) return;
    entries.push({
      kind: 'experience',
      source_index: i,
      title: role.title || '',
      company: role.company || '',
      dates: fmtDates(role.dates),
      bullet_count: (role.bullets || []).length,
      preview: preview((role.bullets && role.bullets[0] && role.bullets[0].text) || ''),
    });
  });
  (profile.projects || []).forEach((proj, i) => {
    if (entryPresent(tree, 'project', i)) return;
    entries.push({
      kind: 'project',
      source_index: i,
      title: proj.title || '',
      company: '',
      dates: fmtDates(proj.dates),
      bullet_count: (proj.bullets || []).length,
      preview: preview((proj.bullets && proj.bullets[0] && proj.bullets[0].text) || ''),
    });
  });

  // Loose bullets: master bullets not yet used, whose OWNING entry IS present
  // in the tree (an omitted entry's bullets travel with it via vaultEntryNode,
  // not as loose items here).
  const bullets = [];
  (profile.roles || []).forEach((role, i) => {
    if (!entryPresent(tree, 'experience', i)) return;
    const targetEntryId = `role-${i}`;
    (role.bullets || []).forEach((b) => {
      if (usedSourceIds.has(b.id)) return;
      bullets.push({ source_bullet_id: b.id, text: b.text, target_entry_id: targetEntryId, entry_title: role.title || '' });
    });
  });
  (profile.projects || []).forEach((proj, i) => {
    if (!entryPresent(tree, 'project', i)) return;
    const targetEntryId = `project-${i}`;
    (proj.bullets || []).forEach((b) => {
      if (usedSourceIds.has(b.id)) return;
      bullets.push({ source_bullet_id: b.id, text: b.text, target_entry_id: targetEntryId, entry_title: proj.title || '' });
    });
  });

  return { entries, bullets };
}

// ---- node builders: real content, never AI, always via the server ----

// A restored master bullet has no short/one_line/two_line variants — it ships
// as picked:'custom' with its verbatim master text. validateTree's
// sameVariants compares {}-vs-{} by strict equality on each key (all
// undefined), which passes; with picked==='custom' only custom_text equality
// is checked, so `variants:{}` is the correct minimal shape.
function vaultBulletNode({ bulletId, text, sourceBulletId, order }) {
  return {
    bullet_id: bulletId,
    source_bullet_id: sourceBulletId || null,
    variants: {},
    picked: 'custom',
    custom_text: text,
    origin: 'vault_restored',
    grounded: true,
    order,
  };
}

// A user-typed bullet: real user-authored content, not an AI hallucination —
// exempt from the AI-grounding check (5.6/7.7) per 7.14.14, still subject to
// every mechanical check (fill-band, page-fit) at the route layer.
function customBulletNode({ bulletId, text, order }) {
  return {
    bullet_id: bulletId,
    source_bullet_id: null,
    variants: {},
    picked: 'custom',
    custom_text: text,
    origin: 'user_custom',
    grounded: false,
    order,
  };
}

// Builds a whole omitted role/project Entry exactly the way assemble() does
// (generateResume.js) — header via fitHeader, ongoing via isOngoing on the
// MASTER dates (never client-supplied), entry_id/bullet_ids in the same
// `role-{i}`/`project-{i}` scheme the Director's own output uses. Guaranteed
// collision-free: the entry being absent from the tree is exactly what made
// it vault-eligible.
function vaultEntryNode({ profile, kind, sourceIndex, order }) {
  const geom = geometry(DEFAULT_RENDER.marginIn);
  const usableW = geom.usableW;
  const maxBullets = tunables.generation.bulletsPerEntry.max;

  if (kind === 'experience') {
    const role = profile.roles[sourceIndex] || {};
    const companyWithLoc = [role.company, role.location].filter(Boolean).join(', ');
    const hdr = fitHeader(role.title || '', companyWithLoc, fmtDates(role.dates), usableW);
    const sourceBullets = (role.bullets || []).slice(0, maxBullets);
    const bullets = sourceBullets.map((b, bi) => vaultBulletNode({ bulletId: `role-${sourceIndex}-b${bi}`, text: b.text, sourceBulletId: b.id, order: bi }));
    return {
      entry_id: `role-${sourceIndex}`,
      kind: 'experience',
      source_index: sourceIndex,
      order,
      graveyard: false,
      ongoing: isOngoing(role.dates),
      bullet_target: bullets.length,
      header: { title: hdr.title, company: hdr.company, dates: fmtDates(role.dates) },
      bullets,
    };
  }
  const proj = profile.projects[sourceIndex] || {};
  const hdr = fitHeader(proj.title || '', '', fmtDates(proj.dates), usableW);
  const sourceBullets = (proj.bullets || []).slice(0, maxBullets);
  const bullets = sourceBullets.map((b, bi) => vaultBulletNode({ bulletId: `project-${sourceIndex}-b${bi}`, text: b.text, sourceBulletId: b.id, order: bi }));
  return {
    entry_id: `project-${sourceIndex}`,
    kind: 'project',
    source_index: sourceIndex,
    order,
    graveyard: false,
    ongoing: false,
    bullet_target: bullets.length,
    header: { title: hdr.title, company: '', dates: fmtDates(proj.dates) },
    bullets,
  };
}

module.exports = { buildVault, vaultBulletNode, customBulletNode, vaultEntryNode };

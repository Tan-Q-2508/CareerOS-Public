const { tunables } = require('@careeros/shared');
const { isOngoing } = require('./contentDirector');
const { measureLayout, DEFAULT_RENDER } = require('./metrics');
const { fitToPage, buildModelFrom } = require('./generateResume');

// Copilot Mode's editable résumé shape (spec 7.14.3/7.14.8) — the assembler's
// output (generateResume.js's runDraftPhase, steps 1-6) converted into a
// JSON tree a client can reorder/cycle-variant/graveyard/AI-edit, and back
// into the render model runFinishPhase's step 9 (render) consumes. This file
// is the ONLY place that knows the content_tree shape.
//
// Bullet: { bullet_id, source_bullet_id, variants:{short,one_line,two_line},
//           picked: 'short'|'one_line'|'two_line'|'custom', custom_text,
//           origin: 'shotgun'|'assembler_truncated'|'ai_rewrite'|'ai_inject_keyword',
//           grounded, order }
// Entry:  { entry_id, kind:'experience'|'project', source_index, order,
//           graveyard, ongoing, bullet_target, header:{title,company,dates}, bullets:[Bullet] }

const T = tunables.bulletFill.strict;

function bulletText(b) {
  return b.picked === 'custom' ? b.custom_text : (b.variants && b.variants[b.picked]);
}

// Build one Bullet from an assemble()-internal { key, text, ... } pick plus
// the raw draft bullet-variant object it was chosen from (which carries the
// real short/one_line/two_line text and, for role/project bullets, the
// grounded source_bullet_id — summary bullets have none, per draftResume.js).
function bulletFromPick(pick, sourceVariant, bulletId, order) {
  return {
    bullet_id: bulletId,
    source_bullet_id: (sourceVariant && sourceVariant.source_bullet_id) || null,
    variants: {
      short: sourceVariant ? sourceVariant.short : undefined,
      one_line: sourceVariant ? sourceVariant.one_line : undefined,
      two_line: sourceVariant ? sourceVariant.two_line : undefined,
    },
    picked: pick.key,
    custom_text: pick.key === 'custom' ? pick.text : null,
    origin: pick.key === 'custom' ? 'assembler_truncated' : 'shotgun',
    grounded: true,
    order,
  };
}

/**
 * Seed a content_tree from a fresh runDraftPhase() result. `asm` must be the
 * assemble() output carrying the additive `detail` field (experience/projects/
 * summaryChosen with every measured variant + the picked choice).
 */
function contentTreeFromAssembly({ asm, draft, contact, roleTargets = {}, projectTargets = {}, profile, promptVersion }) {
  const { experience, projects, summaryChosen } = asm.detail;

  const entries = [];
  experience.forEach((r, idx) => {
    const bullets = r.chosen.map((pick, bi) => bulletFromPick(pick, r.sourceBullets[bi], `role-${r.roleIndex}-b${bi}`, bi));
    entries.push({
      entry_id: `role-${r.roleIndex}`,
      kind: 'experience',
      source_index: r.roleIndex,
      order: idx,
      graveyard: false,
      ongoing: isOngoing(profile.roles[r.roleIndex] && profile.roles[r.roleIndex].dates),
      bullet_target: roleTargets[r.roleIndex] || bullets.length,
      header: { title: r.title, company: r.company, dates: r.dates },
      bullets,
    });
  });
  projects.forEach((p, idx) => {
    const bullets = p.chosen.map((pick, bi) => bulletFromPick(pick, p.sourceBullets[bi], `project-${p.projectIndex}-b${bi}`, bi));
    entries.push({
      entry_id: `project-${p.projectIndex}`,
      kind: 'project',
      source_index: p.projectIndex,
      order: idx,
      graveyard: false,
      ongoing: false,
      bullet_target: projectTargets[p.projectIndex] || bullets.length,
      header: { title: p.title, company: '', dates: p.dates },
      bullets,
    });
  });

  const summary = summaryChosen.map((pick, bi) => bulletFromPick(pick, (draft.summary || [])[bi], `summary-b${bi}`, bi));

  return {
    version: 1,
    prompt_version: promptVersion,
    professional_title: draft.professional_title,
    contact,
    education: asm.model.education,
    skills: asm.model.skills,
    summary,
    entries,
    graveyard_bullets: [],
  };
}

/**
 * Convert an edited content_tree back into the { model, opts, meas, preFitMeas,
 * outOfBand, totalBullets } shape runFinishPhase's render step expects — the
 * Copilot counterpart to assemble(). Deliberately does NOT run assemble()'s
 * fill-up or overflow-shed loops: the user's curation is authoritative, and
 * overflow must surface as a named rejection at export (spec 7.14.4), never a
 * silent auto-shed of content the user placed there on purpose.
 */
function assembleFromTree({ tree, contact }) {
  const activeByKind = (kind) => (tree.entries || [])
    .filter((e) => e.kind === kind && !e.graveyard)
    .slice()
    .sort((a, b) => a.order - b.order);

  const mapEntry = (e, withCompany) => {
    const bullets = (e.bullets || []).slice().sort((a, b) => a.order - b.order).map(bulletText);
    return withCompany
      ? { title: e.header.title, company: e.header.company, dates: e.header.dates, bullets }
      : { title: e.header.title, dates: e.header.dates, bullets };
  };

  const experience = activeByKind('experience').map((e) => mapEntry(e, true));
  const projects = activeByKind('project').map((e) => mapEntry(e, false));
  const sortedSummary = (tree.summary || []).slice().sort((a, b) => a.order - b.order);
  const summary = sortedSummary.map(bulletText);

  // bulletOrder: the bullet_id at each position measureLayout's own `bullets`
  // array will land in — same traversal order (summary, then each experience
  // entry's bullets, then each project entry's bullets) as measureLayout
  // walks model.summary/model.experience/model.projects, so the caller (the
  // PATCH/export routes' `layout` response) can name exactly which bullet a
  // given measurement belongs to.
  const bulletOrder = [
    ...sortedSummary.map((b) => b.bullet_id),
    ...activeByKind('experience').flatMap((e) => (e.bullets || []).slice().sort((a, b) => a.order - b.order).map((b) => b.bullet_id)),
    ...activeByKind('project').flatMap((e) => (e.bullets || []).slice().sort((a, b) => a.order - b.order).map((b) => b.bullet_id)),
  ];

  const model = buildModelFrom({
    contact,
    professionalTitle: tree.professional_title,
    summary,
    experience,
    projects,
    education: tree.education,
    skills: tree.skills,
  });

  // preFitMeas mirrors assemble()'s own convention: measured under
  // DEFAULT_RENDER, before fitToPage's cosmetic lineSpacing/headerScale/margin
  // stretch. Not consumed by Copilot's export (fill pass never runs there —
  // options.allowRedraft:false), kept for shape parity with assemble()'s return.
  const preFitMeas = measureLayout(model, { thresholds: T, render: DEFAULT_RENDER });
  const fit = fitToPage(model, T);
  const finalMeas = measureLayout(model, { thresholds: T, render: fit.opts });
  return {
    model,
    opts: fit.opts,
    meas: finalMeas,
    preFitMeas,
    outOfBand: finalMeas.bullets.filter((b) => !b.inBand).length,
    totalBullets: finalMeas.bullets.length,
    bulletOrder,
  };
}

function flattenBullets(tree) {
  const list = [...(tree.summary || [])];
  (tree.entries || []).forEach((e) => list.push(...(e.bullets || [])));
  list.push(...(tree.graveyard_bullets || []));
  return list;
}

// Locate one bullet + its containing entry (null for a summary bullet, which
// has none) — used by the rewrite/inject-keyword routes to build the AI
// call's context and by the PATCH/export routes' error reporting.
function findBullet(tree, bulletId) {
  for (const b of tree.summary || []) if (b.bullet_id === bulletId) return { bullet: b, entry: null };
  for (const e of tree.entries || []) {
    for (const b of e.bullets || []) if (b.bullet_id === bulletId) return { bullet: b, entry: e };
  }
  for (const b of tree.graveyard_bullets || []) if (b.bullet_id === bulletId) return { bullet: b, entry: null };
  return null;
}

// The `layout` object returned on every debounced PATCH and consumed by the
// export gate (spec 7.14.4/7.14.5) — the server's authoritative verdict on
// what the current tree measures to, with each measured bullet correlated
// back to its bullet_id via assembleFromTree's parallel `bulletOrder`.
function layoutSummary(asm) {
  return {
    onePage: asm.meas.onePage,
    fillFraction: asm.meas.fillFraction,
    wellFilled: asm.meas.wellFilled,
    opts: asm.opts,
    usableHeightPt: asm.meas.usableHeightPt,
    contentHeightPt: asm.meas.contentHeightPt,
    // Skills-section packing groups (7.10, 2026-07-28) — same packSkillRows
    // decision the .docx was rendered with, so the Canvas never has to
    // re-derive (and potentially disagree with) the grouping itself.
    skillLines: asm.meas.skillLines,
    bullets: asm.meas.bullets.map((b, i) => ({
      bullet_id: asm.bulletOrder[i] || null,
      path: b.path,
      L: b.L,
      lineCount: b.lineCount,
      inBand: b.inBand,
      want: b.want,
      endPt: b.endPt,
    })),
  };
}

const sameVariants = (a, b) => (a || {}).short === (b || {}).short && (a || {}).one_line === (b || {}).one_line && (a || {}).two_line === (b || {}).two_line;

// CHANGED 2026-08-02 (Phase 3 bug fix): tree.skills/education/contact/
// professional_title were ALREADY client-writable via a plain PATCH — this
// function only ever inspected entries/summary/graveyard_bullets, while
// `PATCH /sessions/:id` writes content_tree wholesale — no confirm-once gate,
// no length cap, nothing. The new dedicated routes (PATCH .../header, PATCH
// .../skills) are now the ONLY server-authored way to change these four
// fields; a plain PATCH must leave them byte-identical to origin_tree, same
// contract sameVariants already enforces for bullet text.
function validateStaticSections(tree, originTree) {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!eq(tree.skills, originTree.skills)) {
    return { ok: false, status: 422, code: 'tampered_static_section', message: 'Skills/Certifications can only be changed through the Skills editor.' };
  }
  if (!eq(tree.education, originTree.education)) {
    return { ok: false, status: 422, code: 'tampered_static_section', message: 'Education is not editable.' };
  }
  if (!eq(tree.contact, originTree.contact)) {
    return { ok: false, status: 422, code: 'tampered_static_section', message: 'Contact info can only be changed through the header editor.' };
  }
  if (tree.professional_title !== originTree.professional_title) {
    return { ok: false, status: 422, code: 'tampered_static_section', message: 'The title can only be changed through the header editor.' };
  }
  return null;
}

/**
 * Validate an incoming content_tree against the session's origin_tree (spec
 * 7.14.4) before any write — the server-side gate that stops a client from
 * PATCHing arbitrary un-grounded text into content_tree and bypassing every
 * 5.6/7.7/7.11 grounding rule without ever calling an AI edit endpoint.
 * origin_tree is the server's own last-approved baseline: it's updated by the
 * server itself after a seed or an AI edit, but a plain client PATCH can never
 * change it — so a bullet's variants/custom_text here must always match what
 * the server already put there.
 *
 * `strict` hard-enforces the per-entry bullet floor (used at export); PATCH
 * only warns (returned as `warnings`, not a rejection).
 */
function validateTree(tree, { originTree, strict = false }) {
  if (!tree || typeof tree !== 'object' || !Array.isArray(tree.entries) || !Array.isArray(tree.summary)) {
    return { ok: false, status: 422, code: 'invalid_shape', message: 'content_tree is missing entries or summary.' };
  }
  const staticErr = validateStaticSections(tree, originTree);
  if (staticErr) return staticErr;
  const validPicks = new Set(['short', 'one_line', 'two_line', 'custom']);
  const originEntries = new Map((originTree.entries || []).map((e) => [e.entry_id, e]));
  const originBullets = new Map(flattenBullets(originTree).map((b) => [b.bullet_id, b]));

  const warnings = [];
  const seenEntryIds = new Set();
  for (const e of tree.entries) {
    if (!e || typeof e.entry_id !== 'string' || !['experience', 'project'].includes(e.kind) || !Array.isArray(e.bullets)) {
      return { ok: false, status: 422, code: 'invalid_shape', message: 'A content_tree entry is malformed.' };
    }
    if (seenEntryIds.has(e.entry_id)) return { ok: false, status: 422, code: 'invalid_shape', message: `Duplicate entry_id ${e.entry_id}.` };
    seenEntryIds.add(e.entry_id);

    const origin = originEntries.get(e.entry_id);
    if (!origin) return { ok: false, status: 422, code: 'unknown_entry', message: `Entry ${e.entry_id} was not part of this session.`, entryId: e.entry_id };

    // Ongoing-role protection (7.14.4) — authoritative from origin_tree, never
    // trusted from the client's own copy of `ongoing`.
    if (e.graveyard && origin.kind === 'experience' && origin.ongoing) {
      return { ok: false, status: 422, code: 'ongoing_role_protected', message: "Your current role can't be removed from the résumé.", entryId: e.entry_id };
    }

    if (!e.graveyard) {
      const floor = tunables.generation.bulletsPerEntry.min;
      if (e.bullets.length < floor) {
        if (strict) return { ok: false, status: 422, code: 'below_bullet_floor', message: `${e.entry_id} has fewer than ${floor} bullets.`, entryId: e.entry_id };
        warnings.push({ code: 'below_bullet_floor', entryId: e.entry_id, count: e.bullets.length, floor });
      }
    }
  }

  const seenBulletIds = new Set();
  const checkBullets = (bullets) => {
    for (const b of bullets) {
      if (!b || typeof b.bullet_id !== 'string' || !validPicks.has(b.picked)) {
        return { ok: false, status: 422, code: 'invalid_shape', message: 'A bullet is malformed.' };
      }
      if (seenBulletIds.has(b.bullet_id)) return { ok: false, status: 422, code: 'invalid_shape', message: `Duplicate bullet_id ${b.bullet_id}.` };
      seenBulletIds.add(b.bullet_id);

      const origin = originBullets.get(b.bullet_id);
      if (!origin) return { ok: false, status: 422, code: 'unknown_bullet', message: `Bullet ${b.bullet_id} was not part of this session.`, bulletId: b.bullet_id };
      if (!sameVariants(b.variants, origin.variants)) {
        return { ok: false, status: 422, code: 'tampered_variant', message: `Bullet ${b.bullet_id}'s variants don't match the session's original text.`, bulletId: b.bullet_id };
      }
      if (b.picked === 'custom' && b.custom_text !== origin.custom_text) {
        return { ok: false, status: 422, code: 'tampered_custom_text', message: `Bullet ${b.bullet_id}'s custom text wasn't produced by this session.`, bulletId: b.bullet_id };
      }
      if (b.picked !== 'custom' && !origin.variants[b.picked]) {
        return { ok: false, status: 422, code: 'invalid_pick', message: `Bullet ${b.bullet_id} has no "${b.picked}" variant.`, bulletId: b.bullet_id };
      }
    }
    return null;
  };

  for (const e of tree.entries) {
    const err = checkBullets(e.bullets);
    if (err) return err;
  }
  const summaryErr = checkBullets(tree.summary);
  if (summaryErr) return summaryErr;
  if (tree.graveyard_bullets) {
    const gErr = checkBullets(tree.graveyard_bullets);
    if (gErr) return gErr;
  }

  return { ok: true, warnings };
}

module.exports = { bulletText, contentTreeFromAssembly, assembleFromTree, validateTree, validateStaticSections, flattenBullets, findBullet, layoutSummary };

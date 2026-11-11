const { tunables, humanizer } = require('@careeros/shared');
const aiRouter = require('../lib/aiRouter');
const { charTargets } = require('./draftResume');
const { repairVariants } = require('./variantFit');

// Fill pass (2026-07-27) — the LAST step before rendering. If assemble()'s
// deterministic fill-up loop (generateResume.js) still leaves genuine leftover
// room at the bottom of the page, ask the AI to pick from the candidate's OWN
// already-parsed, currently-unused résumé bullets and write them in the same
// three-variant format used everywhere else — prioritizing ones that add more
// JD-matching keywords. Never fabricates: every bullet must cite a real
// source_bullet_id that isn't already used elsewhere in the draft. A separate
// dedicated call from the mechanical repair round (generateResume.js) on
// purpose — repair fires on a low ATS score and REWRITES within a fixed
// bullet count; this fires on leftover PAGE ROOM (independent of score) and
// GROWS the bullet count, so the two have unrelated trigger conditions and
// validator shapes.

const FILL_VAR = {
  type: 'object',
  properties: {
    entry_type: { type: 'string', enum: ['role', 'project'] },
    entry_index: { type: 'number' },
    source_bullet_id: { type: 'string' },
    short: { type: 'string' },
    one_line: { type: 'string' },
    two_line: { type: 'string' },
  },
  required: ['entry_type', 'entry_index', 'source_bullet_id', 'short', 'one_line', 'two_line'],
};
const FILL_SCHEMA = {
  type: 'object',
  properties: { bullets: { type: 'array', items: FILL_VAR } },
  required: ['bullets'],
};

// Per-entry-scoped spare pool (deliberately NOT a flat id set — fitCall.js's
// bulletIdSet() is flat across the whole profile, which would let a bullet
// cite the wrong entry's id undetected; this pool's shape is what lets
// makeValidateFill catch that instead of propagating the same gap).
function computeSparePool({ profile, draft, selected }) {
  const sparseFrom = (allBullets, usedIds) =>
    (allBullets || [])
      .filter((b) => !usedIds.has(b.id))
      .map((b) => ({ id: b.id, text: b.text, skills_demonstrated: b.skills_demonstrated || [] }));

  const roles = [];
  for (const i of selected.roleIndices || []) {
    const group = (draft.experience || []).find((g) => g.role_index === i);
    const used = new Set(((group && group.bullets) || []).map((b) => b.source_bullet_id));
    const spare = sparseFrom(profile.roles && profile.roles[i] && profile.roles[i].bullets, used);
    if (spare.length) roles.push({ role_index: i, spare });
  }
  const projects = [];
  for (const i of selected.projectIndices || []) {
    const group = (draft.projects || []).find((g) => g.project_index === i);
    const used = new Set(((group && group.bullets) || []).map((b) => b.source_bullet_id));
    const spare = sparseFrom(profile.projects && profile.projects[i] && profile.projects[i].bullets, used);
    if (spare.length) projects.push({ project_index: i, spare });
  }
  return { roles, projects };
}

// Entries the Director left out that the fill pass may RESTORE whole when the
// page has room: a short (<=3-month) internship it skipped, or a project it
// did not pick. Every bullet of such an entry is eligible. Mandatory roles
// (7.5) are always selected already, so they never appear here.
function computeAddBackPool({ profile, selected }) {
  const pick = (list, chosen, key) =>
    (list || [])
      .map((e, i) => ({ e, i }))
      .filter(({ e, i }) => !(chosen || []).includes(i) && (e.bullets || []).length)
      .map(({ e, i }) => ({ [key]: i, title: e.title || '', company: e.company || '', dates: e.dates || null, spare: e.bullets.map((b) => ({ id: b.id, text: b.text, skills_demonstrated: b.skills_demonstrated || [] })) }));
  return {
    roles: pick(profile.roles, selected.roleIndices, 'role_index'),
    projects: pick(profile.projects, selected.projectIndices, 'project_index'),
  };
}

// A restored entry carries the same 2-bullet floor as every other entry
// (7.5/7.8), unless its master entry has fewer bullets than that.
function addBackFloor(entry) {
  return Math.min(tunables.generation.bulletsPerEntry.min, entry.spare.length);
}

function makeValidateFill({ sparePool, selected, maxBullets, addBackPool = { roles: [], projects: [] } }) {
  return function validate(p) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.bullets)) return 'root must be { bullets: [] }';
    if (p.bullets.length > maxBullets) return `at most ${maxBullets} bullets allowed, got ${p.bullets.length}`;
    const seen = new Set();
    for (const b of p.bullets) {
      if (b.entry_type !== 'role' && b.entry_type !== 'project') {
        return `entry_type must be "role" or "project", got ${JSON.stringify(b.entry_type)}`;
      }
      const indices = b.entry_type === 'role' ? selected.roleIndices : selected.projectIndices;
      const key = b.entry_type === 'role' ? 'role_index' : 'project_index';
      const restorable = (b.entry_type === 'role' ? addBackPool.roles : addBackPool.projects).find((e) => e[key] === b.entry_index);
      if (!(indices || []).includes(b.entry_index) && !restorable) {
        return `entry_index ${b.entry_index} (${b.entry_type}) is neither an entry already on the page nor one listed under RESTORABLE ENTRIES — never introduce any other role/project`;
      }
      const pool = restorable ? [restorable] : (b.entry_type === 'role' ? sparePool.roles : sparePool.projects);
      const entryPool = pool.find((e) => e[key] === b.entry_index);
      if (!entryPool || !entryPool.spare.some((s) => s.id === b.source_bullet_id)) {
        return `source_bullet_id "${b.source_bullet_id}" is not an available spare bullet for ${b.entry_type} ${b.entry_index} — cite one of the given spare ids for that exact entry`;
      }
      if (seen.has(b.source_bullet_id)) return `source_bullet_id "${b.source_bullet_id}" used more than once`;
      seen.add(b.source_bullet_id);
      if (!b.short || !b.one_line || !b.two_line) return 'short/one_line/two_line must all be non-empty strings';
    }
    for (const type of ['role', 'project']) {
      const key = type === 'role' ? 'role_index' : 'project_index';
      for (const entry of type === 'role' ? addBackPool.roles : addBackPool.projects) {
        const n = p.bullets.filter((b) => b.entry_type === type && b.entry_index === entry[key]).length;
        if (n && n < addBackFloor(entry)) return `restored ${type} ${entry[key]} has ${n} bullet; a restored entry needs at least ${addBackFloor(entry)} of its own bullets, or leave it out`;
      }
    }
    return null;
  };
}

async function runFillPass({ profile, jobContext, selected, sparePool, addBackPool = { roles: [], projects: [] }, budget, addKeywords = [], moveToCoreCandidates = [], overusedVerbs = [], credential }) {
  // The cap follows the measured room (plus one, since trimFillToFit cuts an
  // overshoot bullet by bullet) instead of a flat 3: a page with 8 free lines
  // used to get 3 bullets and ship at ~91% full.
  const maxBullets = Math.max(1, Math.min(tunables.generation.fillPass.maxBullets, budget.oneLineBullets + 1));
  const ct = charTargets();

  const poolLines = [];
  for (const r of sparePool.roles) {
    for (const b of r.spare) {
      poolLines.push(`- entry_type=role entry_index=${r.role_index} id=${b.id}: "${b.text}"${b.skills_demonstrated.length ? ` [skills: ${b.skills_demonstrated.join(', ')}]` : ''}`);
    }
  }
  for (const p of sparePool.projects) {
    for (const b of p.spare) {
      poolLines.push(`- entry_type=project entry_index=${p.project_index} id=${b.id}: "${b.text}"${b.skills_demonstrated.length ? ` [skills: ${b.skills_demonstrated.join(', ')}]` : ''}`);
    }
  }

  const restoreLines = [];
  for (const [type, list, key] of [['role', addBackPool.roles, 'role_index'], ['project', addBackPool.projects, 'project_index']]) {
    for (const e of list) {
      const when = e.dates ? ` (${e.dates.start || '?'} to ${e.dates.end || 'present'})` : '';
      restoreLines.push(`- entry_type=${type} entry_index=${e[key]}: ${e.title}${e.company ? ` @ ${e.company}` : ''}${when}`);
      for (const b of e.spare) restoreLines.push(`    id=${b.id}: "${b.text}"${b.skills_demonstrated.length ? ` [skills: ${b.skills_demonstrated.join(', ')}]` : ''}`);
    }
  }

  const sys = [
    'The résumé you are finishing has genuine leftover room at the bottom of its one page — real content is missing, not filler. Pick from the candidate\'s OWN already-parsed, currently-UNUSED résumé bullets listed below and write them in the SAME three-variant format every other bullet in this résumé uses.',
    `LEFTOVER BUDGET (a guide for how much to add, not a hard target — a later deterministic step measures the real result and discards this entire pass if it doesn't fit): roughly ${budget.oneLineBullets} one-line bullet(s) of room, or ${budget.twoLineBullets} two-line bullet(s) of room, whichever combination you choose.`,
    `Add AT MOST ${maxBullets} bullets total, and ONLY from the SPARE POOL or RESTORABLE ENTRIES below — never invent a new bullet, never restate one already used elsewhere in the résumé.`,
    'TWO KINDS OF ADDITION: (a) a spare bullet for an entry already on the page; (b) RESTORING a whole entry that was left out: write at least 2 of its own bullets (or all of them if it has fewer), and remember its header line costs about one bullet line of room.',
    'ORDER OF VALUE, highest first: (1) restoring a left-out WORK ROLE (a real job missing from the page under-states the candidate\'s experience) when the room allows its header plus 2 bullets; (2) a spare bullet that truthfully adds a keyword from the list below; (3) a spare bullet that adds a distinct accomplishment the page does not already show; (4) restoring a relevant project. List bullets in that order, most valuable FIRST: if the page overflows, a later step removes bullets from the END of your list.',
    'For EACH bullet you add, output THREE truthful variants of the SAME fact (same source_bullet_id, same metrics — only the level of detail differs):',
    `  short ≈ ${ct.short} chars (compact, but never below ${ct.shortFloor} chars — a real sentence, not a stub), one_line ≈ ${ct.one} chars (write it to fill the whole line edge-to-edge — never past ${ct.oneCap} chars), two_line ≈ ${ct.two} chars (fills TWO full lines).`,
    'The layout engine picks whichever variant lays out cleanest — so all three must be self-contained, truthful, and grounded in the SAME source bullet. Never invent facts, tools, or metrics not in that source bullet.',
    'PRIORITIZE spare bullets whose real content genuinely supports the keywords below — use the JD\'s exact spelling for a keyword only where the bullet\'s real facts truthfully support it.',
    'It is fine to add FEWER bullets than the budget suggests if nothing left is a real match, but an empty band at the bottom of a one-page résumé reads as thin experience, so use the room when real content exists. Never force filler.',
    overusedVerbs.length ? `These opening verbs already start 2 bullets each, so do not open a new bullet with them: ${overusedVerbs.join(', ')}.` : '',
  ].filter(Boolean).join('\n') + (humanizer.isEnabled() ? `\n${humanizer.humanizerInstruction('resume')}` : '');
  const baseValidate = makeValidateFill({ sparePool, selected, maxBullets, addBackPool });
  const validate = humanizer.isEnabled()
    ? humanizer.nudgeOnce(baseValidate, (p) => (p.bullets || []).flatMap((b) => [b.short, b.one_line, b.two_line]), { allow: humanizer.jdAllowList(jobContext), where: 'a fill-pass bullet' })
    : baseValidate;

  const prompt = `SPARE POOL (unused bullets of entries already on the page; cite the id exactly, on its own entry_type/entry_index):\n${poolLines.join('\n') || '(none)'}\n\nRESTORABLE ENTRIES (left off the page; restore one with at least 2 of its own bullets):\n${restoreLines.join('\n') || '(none)'}\n\nTARGET JOB: ${JSON.stringify({ title: jobContext.title, company: jobContext.company })}\n\nPRIORITIZE THESE KEYWORDS if a spare bullet's real content genuinely supports them:\n${[...addKeywords, ...moveToCoreCandidates].join(', ') || '(none particularly outstanding)'}`;

  const res = await aiRouter.structuredCall(credential, {
    tier: 'strong',
    systemInstruction: sys,
    prompt,
    responseSchema: FILL_SCHEMA,
    validate,
  });
  // 2026-08-04 2nd bullet-fill bug fix — same repair draftResume.js's
  // runShotgunDraft applies, so a fill-pass bullet is held to the identical
  // bar as every other bullet in the résumé rather than shipping an
  // un-trimmed overshoot.
  const bullets = (res.parsed.bullets || []).map((b) => {
    if (humanizer.isEnabled()) b = { ...b, short: humanizer.stripFillerTail(humanizer.scrubTells(b.short)), one_line: humanizer.stripFillerTail(humanizer.scrubTells(b.one_line)), two_line: humanizer.stripFillerTail(humanizer.scrubTells(b.two_line)) };
    const { variants } = repairVariants(b);
    return { ...b, short: variants.short, one_line: variants.one_line, two_line: variants.two_line };
  });
  return { bullets, usage: res.usage, costUsd: res.costUsd, model: res.model, connectionMode: res.connectionMode, tier: 'strong' };
}

// Pure — returns a NEW draft object (never mutates the input), so the caller
// can cheaply revert to the pre-fill-pass draft if the result overflows.
// A bullet for an entry not yet in the draft starts that entry's group: a
// restored entry, validated against the add-back pool already.
function mergeFillPass(draft, bullets) {
  const next = { ...draft, experience: (draft.experience || []).map((g) => ({ ...g, bullets: [...g.bullets] })), projects: (draft.projects || []).map((g) => ({ ...g, bullets: [...g.bullets] })) };
  for (const b of bullets) {
    const list = b.entry_type === 'role' ? next.experience : next.projects;
    const key = b.entry_type === 'role' ? 'role_index' : 'project_index';
    let group = list.find((g) => g[key] === b.entry_index);
    if (!group) { group = { [key]: b.entry_index, bullets: [] }; list.push(group); }
    group.bullets.push({ short: b.short, one_line: b.one_line, two_line: b.two_line, source_bullet_id: b.source_bullet_id });
  }
  return next;
}

// Takes the fill bullets in the fill pass's own order of value and cuts from
// the END until the result holds one page without pushing out content that
// was already there. A restored entry goes whole once it would fall below its
// floor. `tryDraft(draft)` assembles and returns a truthy result only when the
// page holds (one page, nothing shed).
function trimFillToFit(draft, bullets, addBackPool, tryDraft) {
  let list = [...bullets];
  const floorOf = (b) => {
    const key = b.entry_type === 'role' ? 'role_index' : 'project_index';
    const entry = (b.entry_type === 'role' ? addBackPool.roles : addBackPool.projects).find((e) => e[key] === b.entry_index);
    return entry ? addBackFloor(entry) : 0;
  };
  while (list.length) {
    const merged = mergeFillPass(draft, list);
    const result = tryDraft(merged);
    if (result) return { draft: merged, bullets: list, result };
    const last = list[list.length - 1];
    list = list.slice(0, -1);
    const same = (b) => b.entry_type === last.entry_type && b.entry_index === last.entry_index;
    const floor = floorOf(last);
    if (floor && list.filter(same).length < floor) list = list.filter((b) => !same(b));
  }
  return { draft, bullets: [], result: null };
}

module.exports = { computeSparePool, computeAddBackPool, addBackFloor, runFillPass, mergeFillPass, trimFillToFit, makeValidateFill, FILL_SCHEMA };

const { tunables, humanizer } = require('@careeros/shared');
const aiRouter = require('../lib/aiRouter');
const { bulletIdSet } = require('../scoring/fitCall');
const { charTargets } = require('./draftResume');
const { measureLine, SIZE, geometry, DEFAULT_RENDER } = require('./metrics');
const { skillPresent } = require('./atsCheck');
const { repairVariants } = require('./variantFit');

// Copilot Mode's billable AI call sites (spec 7.14.6) — a targeted edit on ONE
// bullet's text, never a full re-draft. Follows the same conventions as
// contentDirector.js/draftResume.js: cheap tier (mechanical, narrow-scope
// work per 5.5's tiering logic), an enum-constrained `grounded_in` so an
// invented source bullet id is structurally unrepresentable (the same
// defence draftResume.js added after the DoorDash job's hallucinated
// "r4b1-a" id), and a validator fed back into aiRouter.structuredCall's
// retry loop for anything mechanically checkable.
//
// Grounding itself (does the rewritten text actually stick to the source
// bullet's facts?) is NOT enforced by rejection here (2026-07-27 sign-off):
// an ungrounded rewrite ships with `grounded: false` so the UI can badge it
// (Stage 3) rather than blocking the user's edit outright. Only mechanical
// violations (too long, empty, missing a required keyword) are hard errors.
//
// CHANGED 2026-08-02 (Phase 3 bug fix): every edit call now returns THREE
// length variants (short/one_line/two_line) from ONE billed call — matching
// generation's own draftResume.js shotgun-draft shape — instead of a single
// string, and multi-keyword requests must preserve every keyword already in
// the bullet across all three. See EDIT_SCHEMA/hardValidate/bandVerdict below.

const T = tunables.bulletFill.strict;

function measureBullet(text) {
  const geom = geometry(DEFAULT_RENDER.marginIn);
  return measureLine(text, SIZE.bullet, geom.bulletAvailW, false, T);
}

// Three-variant schema (mirrors draftResume.js's varSchema minus
// source_bullet_id — grounded_in already serves that same enum-constrained
// defence here, at the top level rather than per-variant, since all three
// variants of one edit share one grounding source).
const EDIT_SCHEMA = (validIds) => ({
  type: 'object',
  properties: {
    variants: {
      type: 'object',
      properties: {
        short: { type: 'string' },
        one_line: { type: 'string' },
        two_line: { type: 'string' },
      },
      required: ['short', 'one_line', 'two_line'],
    },
    grounded_in: { type: 'string', enum: [...validIds] },
    changed: { type: 'boolean' },
  },
  required: ['variants', 'grounded_in'],
});

// Layer A — fed into aiRouter.structuredCall's retry loop. Per-variant
// mechanical bounds (never past 2 lines / the safety ceiling) plus, across
// the whole set, every required/preserved keyword present in EVERY variant.
// Deliberately does NOT require every variant to hit its length BAND — see
// bandVerdict below — a single all-band validator here would burn both
// structuredCall retries on one imperfect variant (e.g. an honest "I
// couldn't truthfully fill two lines") and 502 the whole billed call.
function hardValidate({ requireKeywords = [], preserveKeywords = [] } = {}) {
  const targets = charTargets();
  return function validate(p) {
    if (!p || typeof p !== 'object' || !p.variants) return 'root must have a `variants` object';
    const { short, one_line: one, two_line: two } = p.variants;
    for (const [key, text] of [['short', short], ['one_line', one], ['two_line', two]]) {
      if (typeof text !== 'string' || !text.trim()) return `variants.${key} must be a non-empty string`;
      const t = text.trim();
      if (/^[•\-*]\s*/.test(t)) return `variants.${key} must not include a leading bullet marker — return the bullet text only`;
      if (t.length > tunables.copilot.maxBulletChars) return `variants.${key} is too long (${t.length} chars, max ${tunables.copilot.maxBulletChars})`;
      const m = measureBullet(t);
      if (m.lineCount > 2) return `variants.${key} is too long (${m.lineCount} lines) — trim to fit within two lines (~${targets.two} characters for a full two-line bullet)`;
      if (m.L > (tunables.generation.twoLineSafetyCeiling || 1.9)) return `variants.${key} is slightly too long for a safe two-line fit — trim toward ~${targets.two} characters`;
    }
    const allTexts = [short, one, two].map((t) => t.trim().toLowerCase());
    for (const kw of requireKeywords) {
      if (!allTexts.every((t) => skillPresent(t, kw))) return `the target keyword "${kw}" must appear (in the JD's own spelling) in ALL THREE variants`;
    }
    for (const kw of preserveKeywords) {
      if (!allTexts.every((t) => skillPresent(t, kw))) return `"${kw}" is already in this bullet and must still appear in ALL THREE variants — do not drop it while editing`;
    }
    return null;
  };
}

// Layer B — post-hoc, no retry. Which variants actually hit the SAME
// fill-band predicates generateResume.js's bulletChoices() uses to pick a
// generated bullet's variant, so a Copilot-edited bullet is held to the
// identical bar as a freshly-generated one. A variant that fails its band is
// dropped (not nulled) rather than failing the whole edit — see
// runEdit()/pickVariants() below.
function bandVerdict(text) {
  const m = measureBullet((text || '').trim());
  if (m.lineCount === 1) return { ok: m.L >= T.oneLine, lineCount: 1, L: m.L };
  if (m.lineCount === 2) return { ok: m.L >= T.twoLine && m.L <= (tunables.generation.twoLineSafetyCeiling || 1.9), lineCount: 2, L: m.L };
  return { ok: false, lineCount: m.lineCount, L: m.L };
}

// `short` deliberately has no lower L bound — bulletChoices() itself treats
// short as the no-floor 1-line fallback, so imposing one here would reject a
// variant the assembler would happily accept.
const BAND_CHECK = {
  short: (v) => v.lineCount === 1,
  one_line: (v) => v.lineCount === 1 && v.L >= T.oneLine,
  two_line: (v) => v.lineCount === 2 && v.L >= T.twoLine && v.L <= (tunables.generation.twoLineSafetyCeiling || 1.9),
};

// 2026-08-04 bug fix (reported: an AI-edited bullet loses its length chips —
// only a single static pill remains): this used to write ONLY band-passing
// keys into the stored `variants` map, and applyEditAndBill (routes/copilot.js)
// replaces the bullet's variants wholesale in both content_tree AND
// origin_tree — so a band-failing variant wasn't just unpicked, it was gone,
// and variantRing() (treeOps.js) renders one chip per surviving key. Now:
// repair each raw string first (variantFit.repairVariants — the same
// word-boundary trim draftResume.js/fillPass.js apply), THEN band-check the
// repaired text only to choose `picked` and to report which keys still read
// off-target (`rejected`, advisory metadata for the UI note) — but ALL THREE
// repaired strings are returned as `variants` regardless of band verdict.
// This is safe for page-fit: hardValidate() already rejects (with a retry)
// any raw variant over 2 lines or over the safety ceiling, and repairVariants
// trims anything that still overflows before this even runs — so a
// kept-but-band-failing variant can only ever be stubby, never page-breaking,
// same as a freshly-seeded bullet's raw variants already are.
function pickVariants(rawVariants, previousPicked) {
  const { variants: repaired } = repairVariants(rawVariants);
  const rejected = {};
  const passes = {};
  for (const key of ['short', 'one_line', 'two_line']) {
    const text = (repaired[key] || '').trim();
    const v = bandVerdict(text);
    passes[key] = BAND_CHECK[key](v);
    if (!passes[key]) rejected[key] = `didn't fill its ${key === 'two_line' ? 'two lines' : 'line'} cleanly (${v.lineCount} line${v.lineCount === 1 ? '' : 's'})`;
  }
  // `picked` still prefers the bullet's PRE-EDIT length so an edit doesn't
  // silently reflow the page, falling back to the nearest surviving
  // neighbour (two_line -> one_line -> short) among BAND-PASSING keys first,
  // then — since every key is now always present — any key at all, so
  // `picked` can never end up undefined (the previous version's `.find()`
  // over a possibly-empty `accepted` could, which would then trip
  // validateTree's invalid_pick/invalid_shape gate on the next PATCH).
  const fallbackOrder = ['two_line', 'one_line', 'short'];
  const order = previousPicked && passes[previousPicked] ? [previousPicked] : fallbackOrder;
  const picked = order.concat(fallbackOrder).find((k) => passes[k])
    || (previousPicked && repaired[previousPicked] ? previousPicked : null)
    || fallbackOrder.find((k) => repaired[k]);
  return { accepted: repaired, rejected, picked };
}

// 2026-08-04 bug fix: this used to give the model zero character numbers
// ("short ≈ a snug single line", etc.) — purely qualitative, unlike
// draftResume.js's shotgun-draft prompt, which spells out real char targets
// from charTargets(). With no numeric target the model routinely returned
// three barely-differentiated strings that landed in the same band, which is
// the other half of why an edit could leave only one surviving chip (see
// pickVariants() above for the other half — variants used to be dropped
// outright). `ct` is computed once at module load — charTargets() is a pure
// function of font metrics, not per-call state, matching draftResume.js's own
// module-level-safe usage.
const ct = charTargets();
const SYSTEM_PREAMBLE = [
  'You are editing EXACTLY ONE résumé bullet. The facts available to you are: this bullet\'s source text, the candidate\'s confirmed skills, AND the user\'s own instruction below — the user IS the candidate describing their own work, so a fact they state about themselves is truthful, not fabrication.',
  'You may reword, compress, re-emphasize, re-order, and — when the user\'s instruction says so — substantively revise the bullet\'s content. You may NEVER introduce a metric, tool, employer, outcome, scope, or timeframe that is not present in at least one of those three sources — that would be fabrication.',
  'Write in third person (no "I"/"my"), past tense unless the role is explicitly ongoing. Return ONE bullet, no leading bullet marker, no markdown.',
  `Return THREE length variants of the SAME edited bullet: short ≈ ${ct.short} chars (compact, but never below ${ct.shortFloor} — a real sentence, not a stub), one_line ≈ ${ct.one} chars (write it to fill the whole line edge-to-edge — never past ${ct.oneCap}), two_line ≈ ${ct.two} chars (fills BOTH lines but must NOT run past two lines). All three must be truthful and grounded in the same source. If you cannot truthfully fill two full lines, still return your best two_line attempt — a rejected variant is fine, a fabricated one is not.`,
].join(' ');

function buildContext({ bulletText, sourceBullet, entry, jobContext, confirmedNaked = [], confirmedContext = [] }) {
  const confirmedLines = [
    ...confirmedNaked.map((t) => `- ${t}`),
    ...confirmedContext.map((c) => `- ${c.term}: "${c.context}"`),
  ].join('\n') || '(none)';
  return [
    `ENTRY: ${entry.title}${entry.company ? ` @ ${entry.company}` : ''} (${entry.dates})`,
    `CURRENT BULLET TEXT: "${bulletText}"`,
    `SOURCE BULLET (the ground truth this bullet must stay traceable to): ${JSON.stringify(sourceBullet || {})}`,
    `TARGET JOB: ${jobContext.title} @ ${jobContext.company}`,
    `JD REQUIRED SKILLS: ${(jobContext.jdProfile.required_skills || []).join(', ')}`,
    `JD NICE-TO-HAVE SKILLS: ${(jobContext.jdProfile.nice_to_have_skills || []).join(', ')}`,
    `CONFIRMED SKILLS:\n${confirmedLines}`,
  ].join('\n');
}

// Humanizer (spec 7.15): the anti-AI-tells prompt block, one corrective
// retry on word/phrase tells, and a code fix for dashes and curly quotes. All
// three are no-ops while tunables.humanizer.enabled is off.
function humanizeSys(sys) {
  return humanizer.isEnabled() ? `${sys}\n${humanizer.humanizerInstruction('bulletEdit')}` : sys;
}
function humanizeValidate(validate, jobContext) {
  if (!humanizer.isEnabled()) return validate;
  return humanizer.nudgeOnce(validate, (p) => Object.values((p && p.variants) || {}), { allow: humanizer.jdAllowList(jobContext), where: 'the bullet' });
}
function scrubVariants(variants) {
  if (!humanizer.isEnabled() || !variants) return variants;
  const out = { ...variants };
  for (const k of ['short', 'one_line', 'two_line']) out[k] = humanizer.stripFillerTail(humanizer.scrubTells(out[k]));
  return out;
}

const usageFromEdit = (r, actionType) => ({ actionType, model: r.model, connectionMode: r.connectionMode, usage: r.usage, costUsd: r.costUsd, tier: 'cheap' });

// A4 bug fix (2026-08-12): the model's own `changed` boolean (EDIT_SCHEMA
// above) was requested on every edit call but never read anywhere in the
// codebase — a dead field — while applyEditAndBill (routes/copilot.js)
// billed COS unconditionally. `temperature: 0` is hardcoded
// (geminiAdapter.js), so a light-touch instruction on a bullet that's
// already close to ideal can deterministically come back near-identical to
// its input, and that no-op cost exactly as much as a real rewrite.
//
// The AUTHORITATIVE no-op signal is a deterministic text comparison (below),
// not the model's own self-report — a model can misjudge "did I change
// this," normalized text equality can't. `modelReportedChanged` is still
// surfaced (routes/copilot.js logs it) so the schema field isn't left dead,
// but it never drives the billing decision by itself.
function normalizeForCompare(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isNoOpEdit(preEditText, pickedVariantText) {
  return normalizeForCompare(preEditText) === normalizeForCompare(pickedVariantText);
}

function modelReportedChanged(res) {
  return typeof res.parsed.changed === 'boolean' ? res.parsed.changed : null;
}

function groundedFor(res, sourceBullet) {
  // A summary bullet has no single source_bullet_id (draftResume.js: it
  // synthesizes across the whole profile) — the schema's enum already
  // guarantees grounded_in is a REAL id somewhere in the profile, and there is
  // no more specific single id to check it against, so it's treated as
  // grounded by default. A role/project bullet DOES have one specific source
  // id — grounded only if the model cited that exact one.
  const expectedSourceId = sourceBullet && sourceBullet.source_bullet_id;
  return expectedSourceId ? res.parsed.grounded_in === expectedSourceId : true;
}

/**
 * bullet/rewrite (spec 7.14.6): free-text instruction, higher-latitude
 * rewording of one bullet. Cheap tier. Returns three variants; `preserve`
 * (every JD keyword already in the bullet's current text, computed by the
 * caller from the PRE-EDIT text) must survive in all three.
 */
async function runBulletRewrite({ bulletText, sourceBullet, entry, profile, jobContext, confirmedNaked = [], confirmedContext = [], instruction, preserveKeywords = [], previousPicked, credential }) {
  const validIds = bulletIdSet(profile);
  const sys = `${SYSTEM_PREAMBLE}\nThe user has given you an editing instruction below — apply it SUBSTANTIVELY, not cosmetically. If it points out the current bullet doesn't make sense, corrects it, or adds missing context about what they actually did, rewrite the bullet's content to reflect that; a one-word or trivial wording change in response to a substantive instruction is a failure to follow it. Still obey the truthfulness rules above.`;
  const prompt = `${buildContext({ bulletText, sourceBullet, entry, jobContext, confirmedNaked, confirmedContext })}\n\nINSTRUCTION FROM THE USER: ${instruction}${preserveKeywords.length ? `\n\nKEYWORDS ALREADY IN THIS BULLET THAT MUST SURVIVE IN ALL THREE VARIANTS: ${preserveKeywords.join(', ')}` : ''}`;
  const res = await aiRouter.structuredCall(credential, {
    tier: 'cheap',
    systemInstruction: humanizeSys(sys),
    prompt,
    responseSchema: EDIT_SCHEMA(validIds),
    validate: humanizeValidate(hardValidate({ preserveKeywords }), jobContext),
  });
  const { accepted, rejected, picked } = pickVariants(scrubVariants(res.parsed.variants), previousPicked);
  return {
    variants: accepted, rejected, picked, grounded: groundedFor(res, sourceBullet), usage: usageFromEdit(res, 'copilot_bullet_rewrite'),
    noOp: isNoOpEdit(bulletText, accepted[picked]), modelReportedChanged: modelReportedChanged(res),
  };
}

/**
 * bullet/inject-keyword (spec 7.14.6): weave one or more already-confirmed-
 * or-scan-vouched keywords into the bullet truthfully, in the JD's own
 * spelling, WITHOUT dropping any keyword already present. The confirm-once
 * gate (is each keyword actually something the candidate has?) runs in the
 * route BEFORE this is ever called — see routes/copilot.js.
 */
async function runBulletKeywordInjection({ bulletText, sourceBullet, entry, profile, jobContext, confirmedNaked = [], confirmedContext = [], keywords, preserveKeywords = [], previousPicked, credential }) {
  const validIds = bulletIdSet(profile);
  const kwList = Array.isArray(keywords) ? keywords : [keywords];
  const sys = `${SYSTEM_PREAMBLE}\nWeave ALL of the target keywords into the bullet naturally and truthfully, using the JD's exact spelling for each. Do not simply append them as tacked-on phrases — integrate them into the sentence. Never drop a keyword that's already in the bullet to make room for a new one.`;
  const preserveLine = preserveKeywords.length ? `\n\nKEYWORDS ALREADY IN THIS BULLET THAT MUST ALSO SURVIVE: ${preserveKeywords.join(', ')}` : '';
  const prompt = `${buildContext({ bulletText, sourceBullet, entry, jobContext, confirmedNaked, confirmedContext })}\n\nTARGET KEYWORDS TO WEAVE IN (exact spelling, each must appear verbatim in your output): ${kwList.join(', ')}${preserveLine}`;
  const res = await aiRouter.structuredCall(credential, {
    tier: 'cheap',
    systemInstruction: humanizeSys(sys),
    prompt,
    responseSchema: EDIT_SCHEMA(validIds),
    validate: humanizeValidate(hardValidate({ requireKeywords: kwList, preserveKeywords }), jobContext),
  });
  const { accepted, rejected, picked } = pickVariants(scrubVariants(res.parsed.variants), previousPicked);
  return {
    variants: accepted, rejected, picked, grounded: groundedFor(res, sourceBullet), usage: usageFromEdit(res, 'copilot_bullet_inject_keyword'),
    // Never a no-op by construction for inject-keyword: hardValidate's
    // requireKeywords already rejects (with a retry) any variant missing a
    // target keyword the pre-edit text didn't already contain, so a REAL
    // no-op here would mean every target keyword was already present verbatim
    // — still worth the deterministic check rather than assuming.
    noOp: isNoOpEdit(bulletText, accepted[picked]), modelReportedChanged: modelReportedChanged(res),
  };
}

/**
 * bullets/new (spec 7.14.14 extension, 2026-08-02): an AI-AUTHORED new bullet
 * on a given entry, from a free-text instruction — the "write it for me"
 * counterpart to the user-typed Custom Bullet Injector. Grounded against the
 * entry's own source bullets via the same enum defence; three variants, same
 * band validator, billed like a rewrite (cheap tier).
 */
async function runNewBullet({ entry, entryBullets = [], sourceBullets = [], profile, jobContext, confirmedNaked = [], confirmedContext = [], instruction, credential }) {
  const validIds = bulletIdSet(profile);
  const sys = [
    'You are writing ONE NEW résumé bullet for the entry below, anchored to one of its existing source bullets via `grounded_in` (never an invented id).',
    'The facts available to you are: the cited source bullet, the candidate\'s confirmed skills, AND the user\'s own instruction below — the user IS the candidate describing their own work, so a fact they state about themselves is truthful, not fabrication. Citing an existing source bullet as the anchor does NOT mean the new bullet must restate that bullet\'s content — its content should reflect what the user\'s instruction actually describes, grounded in this entry\'s context.',
    'You may NEVER introduce a metric, tool, employer, outcome, scope, or timeframe that is not present in at least one of those three sources — that would be fabrication.',
    'Write in third person (no "I"/"my"), past tense unless the role is explicitly ongoing. Return ONE bullet, no leading bullet marker, no markdown.',
    `Return THREE length variants of the SAME new bullet: short ≈ ${ct.short} chars (compact, but never below ${ct.shortFloor} — a real sentence, not a stub), one_line ≈ ${ct.one} chars (write it to fill the whole line edge-to-edge — never past ${ct.oneCap}), two_line ≈ ${ct.two} chars (fills BOTH lines but must NOT run past two lines). If you cannot truthfully fill two full lines, still return your best two_line attempt — a rejected variant is fine, a fabricated one is not.`,
  ].join(' ');
  const confirmedLines = [
    ...confirmedNaked.map((t) => `- ${t}`),
    ...confirmedContext.map((c) => `- ${c.term}: "${c.context}"`),
  ].join('\n') || '(none)';
  const prompt = [
    `ENTRY: ${entry.title}${entry.company ? ` @ ${entry.company}` : ''} (${entry.dates})`,
    `EXISTING BULLETS ON THIS ENTRY: ${JSON.stringify(entryBullets)}`,
    `THIS ENTRY'S REAL SOURCE BULLETS TO GROUND A NEW ONE IN: ${JSON.stringify(sourceBullets)}`,
    `TARGET JOB: ${jobContext.title} @ ${jobContext.company}`,
    `JD REQUIRED SKILLS: ${(jobContext.jdProfile.required_skills || []).join(', ')}`,
    `JD NICE-TO-HAVE SKILLS: ${(jobContext.jdProfile.nice_to_have_skills || []).join(', ')}`,
    `CONFIRMED SKILLS:\n${confirmedLines}`,
    `INSTRUCTION FROM THE USER: ${instruction}`,
  ].join('\n');
  const res = await aiRouter.structuredCall(credential, {
    tier: 'cheap',
    systemInstruction: humanizeSys(sys),
    prompt,
    responseSchema: EDIT_SCHEMA(validIds),
    validate: humanizeValidate(hardValidate(), jobContext),
  });
  const { accepted, rejected, picked } = pickVariants(scrubVariants(res.parsed.variants), null);
  const sourceBullet = { source_bullet_id: res.parsed.grounded_in };
  return { variants: accepted, rejected, picked, grounded: true, sourceBulletId: res.parsed.grounded_in, sourceBullet, usage: usageFromEdit(res, 'copilot_bullet_new') };
}

// Single-bullet mechanical length/shape check, shared by the manual-edit and
// user-typed custom-bullet routes (routes/copilot.js) — extracted so a typed
// bullet and an AI-drafted one are held to the exact same fill-band bar.
function validateSingleBulletText(text) {
  if (!text || typeof text !== 'string' || !text.trim()) return 'text must be a non-empty string';
  const t = text.trim();
  if (/^[•\-*]\s*/.test(t)) return 'do not include a leading bullet marker — return the bullet text only';
  if (t.length > tunables.copilot.maxBulletChars) return `text is too long (${t.length} chars, max ${tunables.copilot.maxBulletChars})`;
  const m = measureBullet(t);
  const targets = charTargets();
  if (m.lineCount > 2) return `too long (${m.lineCount} lines) — trim to fit within two lines (~${targets.two} characters for a full two-line bullet)`;
  if (m.L > (tunables.generation.twoLineSafetyCeiling || 1.9)) return `slightly too long for a safe two-line fit — trim toward ~${targets.two} characters`;
  return null;
}

module.exports = {
  runBulletRewrite,
  runBulletKeywordInjection,
  runNewBullet,
  hardValidate,
  bandVerdict,
  pickVariants,
  validateSingleBulletText,
  isNoOpEdit,
};

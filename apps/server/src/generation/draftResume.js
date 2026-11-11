const { tunables, humanizer } = require('@careeros/shared');
const aiRouter = require('../lib/aiRouter');
const { bulletIdSet, bulletIdsByEntry } = require('../scoring/fitCall');
const { measureTextWidth, geometry, SIZE, DEFAULT_RENDER } = require('./metrics');
const { vouchedSkills, isConfirmableSkill } = require('./atsCheck');
const { repairVariants } = require('./variantFit');

// Step 4 of generation — the SHOTGUN draft (strong tier). Rather than ask the
// AI to hit a physical line-width it can't see, it writes THREE truthful
// length variants per bullet (short / one_line / two_line); the deterministic
// assembler then MEASURES and picks the one that lays out cleanly. The AI
// still owns content: every bullet cites a real source bullet_id (grounding),
// uses the JD's exact terminology, and never fabricates. Each entry writes
// EXACTLY the bullet_target the Content Director assigned it (relevance-tiered
// depth, not a flat range). Confirmed skills are routed by whether the user
// gave an explanation: naked (no context) go to Skills only; ones with a
// "how I used it" explanation must be woven into a specific bullet. At least
// half of the JD's matched skills must be demonstrated in a real bullet, not
// just listed in Skills — enforced both by this prompt and by a mechanical
// repair round (see generateResume.js) when the first draft falls short.

function charTargets() {
  const geom = geometry(DEFAULT_RENDER.marginIn);
  const avg = measureTextWidth('the quick brown fox jumps over a lazy dog and runs', SIZE.bullet) / 50;
  const perLine = Math.floor(geom.bulletAvailW / avg);
  return {
    perLine,
    // 2026-08-04 2nd bug fix: the maintainer flagged that after the FIRST fix
    // (one: perLine*0.95, below) bullets stopped overflowing but now
    // noticeably underfill — real measurement across 8 live sessions (~180
    // bullets/era) confirmed it: median fill L~0.933 at that target, visible
    // empty space. But going back to a high target alone reproduces the
    // ORIGINAL bug (perLine*1.05 measured L~1.02-1.05, 82% wrapped and fell
    // back to `short` since nothing repaired an overflow — see git history on
    // this file). The real defect was never the target, it was the absence of
    // a repair step: variantFit.js's repairVariants() (applied in
    // runShotgunDraft/runFillPass/bulletEdit.js's pickVariants) now trims any
    // variant that overflows its band, at a word boundary, instead of
    // discarding it. With that safety net in place, the target can go back up
    // — perLine*1.0 (~126 chars) measured median L~0.97 on the same 8-session
    // corpus with the repair applied, vs 0.933 before, at a median cost of 1
    // trimmed word on the ~30% of bullets that overflow. `short` and `two`
    // multipliers were already correct and are untouched by this change.
    short: Math.round(perLine * 0.9),
    // Explicit floor (2nd fix) — `short` real output ranged L~0.655-0.94
    // across sessions (as low as ~60% of a line), well below what the prompt
    // asked for. shortFloor gives the prompt a stated minimum; short's target
    // itself is unchanged, since short's whole purpose is staying compact.
    shortFloor: Math.round(perLine * 0.82),
    one: Math.round(perLine * 1.0),
    // oneCap's job changed with the repair step: previously a "never wrap"
    // wall: now an overshoot CEILING — repairVariants() trims a wrapping
    // one_line back to fit, but a wild overshoot past this ceiling would lose
    // too many words to trim cleanly, so the prompt still asks the model not
    // to blow past it.
    oneCap: Math.round(perLine * 1.04),
    // Targets just under the assembler's two-line safety ceiling (see
    // generateResume.js) rather than a flat 1.95 — writing to a target ABOVE
    // the ceiling means most two_line variants land in the rejected sliver,
    // pushing the assembler into its fallback path far more than intended and
    // reading as "underfilled" even though the fallback itself is correct.
    // Confirmed correct against real data (median L~1.74-1.76, in-band) —
    // untouched by either bug fix.
    two: Math.round(perLine * ((tunables.generation.twoLineSafetyCeiling || 1.9) - 0.05)),
  };
}

// Summary bullets use the EXACT SAME three-variant shape as Experience/Project
// bullets (no separate tight cap) — the layout engine picks whichever variant
// lays out cleanest, exactly like any other bullet. No source_bullet_id: a
// summary line synthesizes across the whole profile rather than citing one bullet.
const SUMMARY_VAR = {
  type: 'object',
  properties: { short: { type: 'string' }, one_line: { type: 'string' }, two_line: { type: 'string' } },
  required: ['short', 'one_line', 'two_line'],
};
// source_bullet_id gets an `enum` of the profile's real ids, built per-call (see
// buildDraftSchema) — Gemini's controlled generation then makes an invented id
// structurally unrepresentable, rather than relying solely on post-hoc validation
// to catch it (the DoorDash job once hit a hallucinated "r4b1-a" id here).
function varSchema(validIds) {
  return {
    type: 'object',
    properties: { short: { type: 'string' }, one_line: { type: 'string' }, two_line: { type: 'string' }, source_bullet_id: { type: 'string', enum: [...validIds] } },
    required: ['short', 'one_line', 'two_line', 'source_bullet_id'],
  };
}
function buildDraftSchema(validIds) {
  const VAR = varSchema(validIds);
  return {
    type: 'object',
    properties: {
      professional_title: { type: 'string' },
      summary: { type: 'array', items: SUMMARY_VAR },
      experience: { type: 'array', items: { type: 'object', properties: { role_index: { type: 'number' }, bullets: { type: 'array', items: VAR } }, required: ['role_index', 'bullets'] } },
      projects: { type: 'array', items: { type: 'object', properties: { project_index: { type: 'number' }, bullets: { type: 'array', items: VAR } }, required: ['project_index', 'bullets'] } },
      skills: { type: 'object', properties: { technical: { type: 'array', items: { type: 'string' } }, management: { type: 'array', items: { type: 'string' } }, business: { type: 'array', items: { type: 'string' } }, certifications: { type: 'array', items: { type: 'string' } } }, required: ['technical', 'management', 'business', 'certifications'] },
    },
    required: ['professional_title', 'summary', 'experience', 'projects', 'skills'],
  };
}

// Deterministic fallback for a professional_title that survived to the second
// (unenforced, see makeValidate) attempt still verbatim-equal to the target
// title — §7.2's locked rule ("never the target job's exact title verbatim")
// still has to hold even though the model didn't self-correct. Repairs from
// the candidate's own real profile rather than inventing anything: the
// candidate's own most-recent role title is truthful, grounded text. If that
// ALSO happens to equal the target verbatim (a real edge case, not just
// theoretical — someone targeting their own current title), fall back to an
// explicit non-verbatim suffix so the locked rule holds either way.
function repairProfessionalTitle(title, profile, targetTitle) {
  const target = String(targetTitle || '').trim().toLowerCase();
  if (!title || String(title).trim().toLowerCase() !== target) return title;
  const roleTitle = profile.roles && profile.roles[0] && profile.roles[0].title;
  if (roleTitle && String(roleTitle).trim().toLowerCase() !== target) return roleTitle;
  return `${targetTitle} Professional`;
}

// 2026-08-04 2nd bullet-fill bug fix: applies variantFit.repairVariants() to
// every bullet the shotgun draft returned (summary + every role/project's
// bullets), so a raw one_line/two_line/short that overshoots its band is
// trimmed at a word boundary instead of shipping unfixed into the assembler
// (one-click path) or the Copilot content_tree (Copilot path) — same single
// call site both paths already share via runShotgunDraft. Mutates each
// bullet's short/one_line/two_line in place; every other field (including
// source_bullet_id) is untouched.
function repairDraftVariants(draft) {
  const fixOne = (b) => {
    if (!b) return;
    const { variants } = repairVariants(b);
    b.short = variants.short;
    b.one_line = variants.one_line;
    b.two_line = variants.two_line;
  };
  (draft.summary || []).forEach(fixOne);
  (draft.experience || []).forEach((g) => (g.bullets || []).forEach(fixOne));
  (draft.projects || []).forEach((g) => (g.bullets || []).forEach(fixOne));
  return draft;
}

// Humanizer check (spec 7.15) over a whole draft: word/phrase tells in any
// variant of any bullet, then document-level tells (the same opening verb or
// the same result-tail template on too many bullets) over the one_line
// variants. Returns a retry message, or null.
// Every problem is reported in one message: the humanizer gets a single
// retry, so naming only the first would leave the rest for the page.
function draftTells(p, allow, profile, sharedGroundingLc = null) {
  const problems = [];
  // A bullet may only name what its OWN entry's source says (plus the
  // candidate's confirmed-skill notes and this job's scan-vouched matches):
  // "Tableau" is a real skill of the candidate, but not in a job whose source
  // bullets only ever used Power BI. Summary bullets draw on the whole profile.
  const entryFor = (where) => {
    const m = /^(experience role_index|projects project_index) (\d+)$/.exec(where);
    if (!m || !profile) return null;
    return m[1].startsWith('experience') ? (profile.roles || [])[Number(m[2])] : (profile.projects || [])[Number(m[2])];
  };
  const groups = [['summary', p.summary || []]];
  const pastLines = [];
  const ended = (entry) => entry && entry.dates && entry.dates.end && !/present|current/i.test(String(entry.dates.end));
  for (const g of p.experience || []) {
    groups.push([`experience role_index ${g.role_index}`, g.bullets || []]);
    if (profile && ended((profile.roles || [])[g.role_index])) pastLines.push(...(g.bullets || []).map((b) => b && b.one_line));
  }
  for (const g of p.projects || []) {
    groups.push([`projects project_index ${g.project_index}`, g.bullets || []]);
    if (profile && ended((profile.projects || [])[g.project_index])) pastLines.push(...(g.bullets || []).map((b) => b && b.one_line));
  }
  const present = humanizer.presentTenseOpeners(pastLines);
  if (present.length) problems.push(`bullets of FINISHED roles/projects open in present tense (${present.map((w) => `"${w}"`).join(', ')}); rewrite them in past tense`);
  for (const [where, bullets] of groups) {
    for (const [i, b] of bullets.entries()) {
      const label = `${where} bullet ${i + 1}${b && b.source_bullet_id ? ` (${b.source_bullet_id})` : ''}`;
      const texts = ['short', 'one_line', 'two_line'].map((k) => b && b[k]);
      const hits = texts.flatMap((t) => humanizer.rewriteHits(t, { allow }));
      if (hits.length) problems.push(humanizer.describeHits(hits, label));
      if (sharedGroundingLc != null) {
        const hay = `${JSON.stringify(entryFor(where) || profile).toLowerCase()} ${sharedGroundingLc}`;
        const names = [...new Set(texts.flatMap((t) => humanizer.ungroundedNames(t, hay)))];
        if (names.length) problems.push(`${label} names ${names.map((n) => `"${n}"`).join(', ')}, which this entry's source never mentions; use only tools and names from this entry's own source bullets`);
        const source = `${JSON.stringify(entryFor(where) || profile)} ${sharedGroundingLc}`;
        const nums = [...new Set(texts.flatMap((t) => humanizer.ungroundedNumbers(t, source)))];
        if (nums.length) problems.push(`${label} has ${nums.map((n) => `"${n}"`).join(', ')}, which the source does not say (a number and its unit must be copied exactly, "17%" is never "17 points"); use the source's number or drop it`);
      }
    }
  }
  const lines = groups.flatMap(([, bullets]) => bullets.map((b) => b && b.one_line));
  const doc = humanizer.documentTells(lines);
  if (doc.problems.length) problems.push(`the bullets read as templated: ${doc.problems.join('; ')}`);
  return problems.length ? `${problems.join(' | ')}. Rewrite only the bullets named, keeping every fact, id and keyword.` : null;
}

// A tool the entry's own source never mentions, riding along as one item of
// a list ("Power BI and Tableau" where the source only ever said Power BI),
// is dropped from that list. The first-call retry asks for this already; the
// keyword-coverage targets (7.12) push it straight back, and a skill with no
// "how I used it" note belongs in Skills only (7.13). A lone ungrounded name
// that is not a list item is left for the ATS check to report.
function dropUngroundedListNames(draft, profile, sharedGroundingLc) {
  const fix = (entry, bullets) => {
    const hay = `${JSON.stringify(entry || {}).toLowerCase()} ${sharedGroundingLc}`;
    for (const b of bullets || []) {
      if (!b) continue;
      for (const k of ['short', 'one_line', 'two_line']) {
        for (const name of humanizer.ungroundedNames(b[k], hay)) b[k] = humanizer.dropListItem(b[k], name);
      }
    }
  };
  for (const g of draft.experience || []) fix((profile.roles || [])[g.role_index], g.bullets);
  for (const g of draft.projects || []) fix((profile.projects || [])[g.project_index], g.bullets);
  return draft;
}

// Dashes and curly quotes are fixed in code rather than spent on a retry.
function scrubDraft(draft) {
  const fix = (b) => { if (b) for (const k of ['short', 'one_line', 'two_line']) b[k] = humanizer.stripFillerTail(humanizer.scrubTells(b[k])); };
  (draft.summary || []).forEach(fix);
  (draft.experience || []).forEach((g) => (g.bullets || []).forEach(fix));
  (draft.projects || []).forEach((g) => (g.bullets || []).forEach(fix));
  if (typeof draft.professional_title === 'string') draft.professional_title = humanizer.scrubTells(draft.professional_title);
  return draft;
}

function makeValidate(profile, selected, targetTitle, roleTargets, projectTargets, skillsGuard, humanize = null) {
  const validIds = bulletIdSet(profile);
  // Per-entry scoping, not just "is this id real somewhere". A wholly invented
  // id was already caught by validIds; a REAL id belonging to a different role
  // was not, and that is the harder failure to spot downstream because the
  // bullet it pulls in is genuine text attributed to the wrong job. Mirrors
  // fillPass.js's computeSparePool() shape rather than inventing a second one.
  const idsByEntry = bulletIdsByEntry(profile);
  const target = String(targetTitle || '').trim().toLowerCase();
  // Attempt counter, shared by two checks below that only ever fire on the
  // FIRST call: the Skills guard (Phase 3 #20 Stage 2) and the bullet-count
  // check (Phase 3, shotgun bullet_target soft-repair).
  let attemptNumber = 0;
  const validate = function validate(p) {
    // Counts EVERY invocation of validate() — i.e., every AI call attempt,
    // regardless of which check below (if any) rejects it — so the Skills
    // guard below can reliably tell "this is the model's last attempt" even
    // when an earlier check (bullet count, dropped role, etc.) is what
    // actually failed attempt 1.
    attemptNumber += 1;
    if (!p || typeof p !== 'object') return 'root is not an object';
    if (typeof p.professional_title !== 'string' || !p.professional_title.trim()) return 'professional_title must be a non-empty string';
    // Verbatim-target-title check — ONLY hard-enforced on the FIRST call, same
    // gate/rationale as the bullet_target and Skills-guard checks below. A
    // model that echoes the target title back (common when the JD title and a
    // truthful paraphrase legitimately overlap in wording) has a real
    // deterministic fallback: runShotgunDraft repairs the title in place from
    // the candidate's own most-recent role title after the draft returns, so
    // leaving this enforced on the retry only bought a 502'd generation for no
    // benefit (confirmed live 2026-08-03, job e017e7fd-…: the model echoed the
    // target title on both attempts, failing the whole generation outright
    // instead of a soft repair — see 7.2's locked "never verbatim" rule, which
    // the deterministic repair still upholds).
    if (attemptNumber <= 1 && p.professional_title.trim().toLowerCase() === target) return 'professional_title must not be the target job title verbatim — paraphrase it (e.g. use your own role identity, not the posting\'s title)';
    if (!Array.isArray(p.summary) || p.summary.length !== 3) return 'summary must be exactly 3 items';
    const targetsFor = { experience: roleTargets, projects: projectTargets };
    for (const key of ['experience', 'projects']) {
      if (!Array.isArray(p[key])) return `${key} must be an array`;
      for (const g of p[key]) {
        if (!Array.isArray(g.bullets)) return `${key} entry bullets must be an array`;
        const idx = key === 'experience' ? g.role_index : g.project_index;
        const want = targetsFor[key][idx] || 3;
        // Exact bullet_target match — ONLY enforced on the FIRST call
        // (attemptNumber <= 1), same gate/rationale as the Skills-guard check
        // below. Unlike a fake source_bullet_id or a dropped role (both still
        // hard-rejected on both attempts just below/above), a bullet-count
        // miss has a real deterministic fallback downstream: the assembler
        // already trims/drops bullets for page-fit on its own (see
        // generateResume.js's overflow loop), and a new reconcileBulletCounts
        // pass (generateResume.js, applied right after this draft returns)
        // pads an under-delivered entry from that role's own unused master
        // bullets or truncates an over-delivered one — so leaving this
        // enforced on the retry only bought a 502'd generation for no
        // benefit (confirmed live 2026-08-02, job d5cf782e-…: the model
        // missed the exact count on BOTH attempts, failing the whole
        // generation outright instead of a soft repair).
        if (attemptNumber <= 1 && g.bullets.length !== want) {
          return `${key} entry (index ${idx}) has ${g.bullets.length} bullets — the Director assigned this entry a bullet_target of EXACTLY ${want}`;
        }
        const entryIds = (key === 'experience' ? idsByEntry.roles : idsByEntry.projects).get(idx);
        for (const b of g.bullets) {
          if (!validIds.has(b.source_bullet_id)) return `${key} bullet source_bullet_id "${b.source_bullet_id}" is not a real résumé bullet id — cite an existing bullet`;
          // Real id, wrong entry. Rejected on BOTH attempts, like the fake-id and
          // dropped-entry checks above and unlike the soft-repairable ones — there
          // is no deterministic downstream fallback that can re-home a bullet to
          // the entry it actually belongs to.
          if (entryIds && !entryIds.has(b.source_bullet_id)) {
            return `${key} entry (index ${idx}) cites source_bullet_id "${b.source_bullet_id}", which is a real bullet but belongs to a DIFFERENT entry — cite only bullets from this entry`;
          }
        }
      }
    }
    // Every Director-selected role AND project must be present with >=1 bullet
    // (no silent drops) — the schema alone doesn't forbid the AI from just
    // omitting a selected entry from its output array.
    const haveRoles = new Set(p.experience.filter((e) => Array.isArray(e.bullets) && e.bullets.length).map((e) => e.role_index));
    for (const idx of selected.roleIndices) if (!haveRoles.has(idx)) return `you dropped role_index ${idx}; output ALL selected roles`;
    const haveProjects = new Set(p.projects.filter((e) => Array.isArray(e.bullets) && e.bullets.length).map((e) => e.project_index));
    for (const idx of selected.projectIndices) if (!haveProjects.has(idx)) return `you dropped project_index ${idx}; output ALL selected projects`;
    // Fabricated-Skills-entry rejection (Phase 3 #20 Stage 2, flag-gated —
    // skillsGuard is only built when tunables.scoring.useUnifiedAtsEngineV2 is
    // on): reject a Skills-section item not grounded in the real profile,
    // confirmed_skills, or this job's own scan-vouched already_demonstrated/
    // transferable/hidden_strengths — one corrective retry via the same
    // validate-then-retry mechanism the source_bullet_id check above already
    // uses. isConfirmableSkill exempts credentials/soft traits, same filter
    // atsCheck's own pending-confirmation ask uses, so this never flags e.g.
    // "Bachelor's Degree" or "Communication skills." A deterministic strip
    // pass after the draft returns (generateResume.js) is the hard guarantee
    // if the model doesn't self-correct on retry.
    //
    // ONLY fires on the FIRST call (attemptNumber <= 1), never the
    // second — aiRouter/geminiAdapter's structuredCall gives every validator
    // exactly ONE shared retry, then THROWS if validation still fails,
    // failing the whole generation. That's the right contract for a
    // structural violation (a fake bullet id, a dropped role) where there is
    // no fallback. It is NOT right here: confirmed live 2026-07-29 (3/3 real
    // jobs hit this on BOTH attempts) — a compound/paraphrased business skill
    // (e.g. "Cross-Functional Leadership") the model synthesizes from real
    // experience routinely isn't a literal substring match, and re-asking
    // doesn't reliably fix that, so leaving this enforced on the retry made
    // EVERY generation under the flag fail outright. Skipping enforcement on
    // the second call preserves the "one corrective nudge" intent while
    // guaranteeing the deterministic strip — not a thrown error — is what
    // actually removes anything still ungrounded.
    if (skillsGuard && attemptNumber <= 1) {
      for (const key of ['technical', 'management', 'business', 'certifications']) {
        for (const item of p.skills[key] || []) {
          if (isConfirmableSkill(item) && !skillsGuard.isHeld(item)) {
            return `Skills entry "${item}" (${key}) is not grounded in the candidate's real profile, confirmed skills, or this job's already-vouched skills — remove it or replace it with something the candidate genuinely has.`;
          }
        }
      }
    }
    return null;
  };
  if (!humanize) return validate;
  // Humanizer (spec 7.15): one corrective nudge on the FIRST call only, same
  // gate as the soft checks above. It rides along with any other first-call
  // failure rather than waiting behind it: the second call is the last one
  // and skips it, so a tell that only surfaced after a bullet-count miss used
  // to ship unflagged. A draft that still carries a tell after the retry is
  // accepted: the humanizer never fails a generation.
  let calls = 0;
  return function humanizedValidate(p) {
    calls += 1;
    const base = validate(p);
    if (calls > 1 || !p || typeof p !== 'object') return base;
    const tells = draftTells(p, humanize.allow, profile, humanize.groundingLc);
    if (!tells) return base;
    return base ? `${base}. ALSO fix this in the same pass: ${tells}` : tells;
  };
}

/**
 * Run the shotgun draft.
 * @param selected  { roleIndices[], projectIndices[] } chosen by the Director (+ safety net)
 * @param roleTargets/projectTargets   {index: 2|3|4} bullet_target per entry, from the Director
 * @param confirmedNaked     string[] confirmed skills with NO user explanation — Skills section only
 * @param confirmedContext   [{term, context}] confirmed skills WITH a user explanation — must be woven into a bullet
 * @param scanAnalysis       { atsMatch, callbackOdds, overallFit, riskTags } from the job's own scan scoring
 * @param addKeywords optional truthful JD keywords a prior draft under-covered (ATS pass)
 * @param moveToCore  optional JD skills the previous draft matched ONLY in the Skills
 *                    section — this round must move at least half of them into a real
 *                    bullet, explaining concretely how the candidate used them there
 * @param weaveKeywords optional (Phase 3 #20 Stage 2, flag-gated) — truthful JD keywords
 *                    the candidate already genuinely has (master profile / confirmed /
 *                    scan-vouched), handed to the FIRST draft up front rather than only
 *                    on a repair round, each carrying its truthful synonym equivalents.
 *                    Distinct from addKeywords/moveToCore, which stay repair-only.
 * @returns { draft, usage, costUsd, model, connectionMode }
 */
async function runShotgunDraft({ profile, jobContext, selected, roleTargets = {}, projectTargets = {}, confirmedNaked = [], confirmedContext = [], scanAnalysis = {}, addKeywords = [], moveToCore = [], weaveKeywords = [], credential }) {
  const ct = charTargets();
  const roles = selected.roleIndices.map((i) => ({ role_index: i, bullet_target: roleTargets[i] || 3, title: profile.roles[i].title, company: profile.roles[i].company, bullets: (profile.roles[i].bullets || []).map((b) => ({ id: b.id, text: b.text, skills: b.skills_demonstrated })) }));
  const projects = selected.projectIndices.map((i) => ({ project_index: i, bullet_target: projectTargets[i] || 3, title: profile.projects[i].title, bullets: (profile.projects[i].bullets || []).map((b) => ({ id: b.id, text: b.text, skills: b.skills_demonstrated })) }));
  const jd = jobContext.jdProfile || {};
  // entry_ref (2026-08-05 fix): when the user explicitly picked which
  // role/project an explanation belongs to (GapCheckModal's Explain picker),
  // state that directly instead of asking the model to infer it — inference
  // could (and per a reported bug, did) land on the wrong, unrelated entry.
  const describeEntryRef = (ref) => {
    const m = /^(role|project):(\d+)$/.exec(ref || '');
    if (!m) return null;
    return `${m[1]}_index ${m[2]}`;
  };
  const notes = (confirmedContext || []).filter((c) => c && c.term && c.context).map((c) => {
    const entryDesc = describeEntryRef(c.entryRef);
    return entryDesc
      ? `- ${c.term}: "${c.context}" — the candidate specified this belongs to ${entryDesc}; weave it into one of that entry's bullets, do not put it anywhere else.`
      : `- ${c.term}: "${c.context}"`;
  });

  const sys = [
    'You draft the CONTENT of a one-page résumé as structured data. Another stage measures and lays it out.',
    'DEPTH: each role/project below carries an explicit bullet_target (2, 3, or 4), assigned by the Director based on relevance to the target job — write EXACTLY that many bullets for EVERY selected role/project, no more, no less, no exceptions, and no empty bullets arrays. This holds even if a MANDATORY REPAIR note appears below asking you to rework specific bullets — a repair note changes WHAT a bullet says for the entries it names, it NEVER reduces any entry (named or not) below its full bullet_target. Do not second-guess the target. Even a bullet_target-2 entry must be substantive, not filler.',
    'For EACH bullet, output THREE truthful variants of the SAME fact (same source_bullet_id, same metrics — only the level of detail differs):',
    `  short ≈ ${ct.short} chars (compact, but never below ${ct.shortFloor} chars — a real sentence, not a stub), one_line ≈ ${ct.one} chars (write it to fill the whole line edge-to-edge — never past ${ct.oneCap} chars), two_line ≈ ${ct.two} chars (fills TWO full lines).`,
    `IMPORTANT — writers habitually undershoot length. one_line must genuinely fill the line (~${ct.one} characters, i.e. reach close to the right margin): add a concrete detail, tool, or metric until it's full — but do not push past ${ct.oneCap} characters. short must still read as a complete, substantive sentence (~${ct.short} characters, never below ${ct.shortFloor}) — not a fragment. two_line must fill BOTH lines (~${ct.two} chars) but must NOT run past two lines — if you can't truthfully fill two full lines without a 3rd line starting, keep it truthful and let the short/one_line variant win instead.`,
    'The layout engine picks whichever variant lays out cleanest — so all three must be self-contained, truthful, and grounded in the SAME source bullet. Never invent facts, tools, or metrics not in the source bullet.',
    'GROUNDING: every bullet cites the source_bullet_id it derives from. Copy that id EXACTLY as given in the `id` field above (e.g. "r0b2" or "p1b0") — never invent, modify, or append a suffix/letter to it.',
    'TERMINOLOGY: use the JD\'s exact wording for skills the candidate genuinely has. Use any given JD keyword AT MOST ONCE per bullet — do NOT repeat a keyword to pad length (put secondary keywords in the skills section instead).',
    'KEYWORDS + RESULTS: every bullet should maximize truthful use of JD terminology while staying grounded in the source bullet, AND should read as an accomplishment (what you did + the result), not a duty list.',
    `CORE-CONTENT KEYWORD TARGETS — these are HARD numeric targets, not suggestions, and they are DIFFERENT for the two tiers: of the JD REQUIRED skills the candidate genuinely has, AT LEAST ${Math.round((tunables.generation.bulletCoverageTargets?.required ?? 0.9) * 100)}% must be demonstrated INSIDE a real Experience/Project bullet, not merely listed in Skills. Of the JD NICE-TO-HAVE skills the candidate genuinely has, AT LEAST ${Math.round((tunables.generation.bulletCoverageTargets?.niceToHave ?? 0.5) * 100)}% must land in a bullet the same way. Required skills come first — if you have to choose which skills get bullet space, prioritize required over nice-to-have. For every skill you're about to place in Skills, first ask: "does the JD say the candidate needs experience WITH this, and do I have a real bullet where they used it?" If yes, put it in the bullet instead (or in addition) — explain concretely HOW/WHERE the candidate applied it, grounded in that bullet\'s real facts. A skill belongs in Skills-ONLY when there is truly no honest bullet to attach it to (e.g. a standalone certification or tool with no demonstrated-use story). Before finalizing, count each tier separately: if fewer than 90% of held REQUIRED skills or 50% of held NICE-TO-HAVE skills live in a bullet, go back and move more of them in, required first.`,
    `QUANTIFIED METRICS — RESUME-WIDE, NOT PER-BULLET: across the WHOLE résumé (summary + experience + projects combined), at least ${Math.round((tunables.generation.quantifiedRatioTarget || 0.5) * 100)}% of all bullets must include a real, truthful quantifiable result (a number, %, $, count, or multiplier) drawn from the source bullet. It is fine — expected — for some bullets to have no metric; do not fabricate a number to hit the ratio, and do not force a metric into every single bullet.`,
    'SUMMARY: exactly 3 bullets, using the SAME short/one_line/two_line variant system and the SAME length targets as Experience/Project bullets above (no separate rule) — the layout engine picks whichever fills cleanest, exactly like any other bullet. Substance lives in Experience; keep these high-level and punchy, but do not artificially shorten them below a real bullet\'s length.',
    'professional_title: a fresh header title based on your OWN role identity (e.g. your most recent real job title, truthfully phrased) — it must NOT be the target job title copied verbatim, even with minor punctuation changes.',
    'skills: sort real/confirmed skills into technical/management/business/certifications; prefer JD spelling. The candidate\'s own certifications are added to the certifications row verbatim by code after this draft — list only OTHER held certifications there (e.g. a confirmed one), never a shortened copy of theirs. This is where secondary JD keywords and NAKED confirmed skills (below) belong — but see KEYWORDS + RESULTS above: don\'t default a demonstrable skill here just because it\'s easier.',
    'Output every role/project index given, each with EXACTLY its assigned bullet_target.',
  ].join('\n') + (humanizer.isEnabled() ? `\n${humanizer.humanizerInstruction('resume')}` : '');

  const nakedLine = (confirmedNaked || []).length
    ? `\n\nCONFIRMED SKILLS — NO CONTEXT GIVEN (route to the Skills/Certifications section ONLY; do NOT invent a bullet or accomplishment around these, do NOT weave into Experience/Projects): ${confirmedNaked.join(', ')}`
    : '';
  const notesLine = notes.length
    ? `\n\nCONFIRMED SKILLS WITH PROVEN CONTEXT (the candidate explained exactly how they used these — use the specified role/project when one is given below, otherwise identify the most relevant role or project yourself, and weave the skill + context into one of its bullets; you may NOT simply append the keyword to a sentence):\n${notes.join('\n')}`
    : '';
  const addLine = addKeywords.length
    ? `\n\nALSO WEAVE IN these truthful JD keywords the candidate genuinely has but the previous draft under-covered — use each one's exact JD spelling, PREFERABLY inside the most relevant bullet (only fall back to the skills section if no bullet can honestly carry it): ${addKeywords.join(', ')}`
    : '';
  const weaveLine = weaveKeywords.length
    ? `\n\nUPFRONT KEYWORD LIST — these JD required/nice-to-have skills are truthfully true of this candidate (verified against their real profile/confirmations before this draft even started). Weave as many as honestly fit into a real Experience/Project bullet on THIS first pass — don't wait for a repair round. A term shown as "X (or: Y, Z)" means any of X/Y/Z is an acceptable truthful phrasing — use whichever reads most naturally in context; you are never required to use the exact literal string: ${weaveKeywords.join('; ')}`
    : '';
  const moveLine = moveToCore.length
    ? `\n\nMANDATORY REPAIR — these skills are ALREADY TRUE of the candidate and are already in Skills, but the previous draft failed the ${Math.round((tunables.generation.coreKeywordRatioTarget || 0.5) * 100)}% core-content target by leaving them Skills-ONLY. For AT LEAST HALF of the ones listed below, find the most relevant existing role/project and rewrite ONE of its bullets (all 3 length variants) to explicitly explain HOW the candidate used that skill there — grounded in that bullet's real facts, never a fabricated new accomplishment. Keep the skill in Skills too if it still fits, but it must now ALSO appear inside a bullet. REMINDER: this only changes the content of ONE bullet per role/project you touch — every role and project (touched or not) still needs its FULL bullet_target of bullets in the output, never fewer: ${moveToCore.join(', ')}`
    : '';
  const scanLine = (scanAnalysis && (scanAnalysis.atsMatch != null || scanAnalysis.callbackOdds != null || scanAnalysis.overallFit != null || (scanAnalysis.riskTags || []).length))
    ? `\n\nSCAN ANALYSIS FOR THIS JOB (how this candidate was scored against it — use this to decide what to emphasize; specifically close the gaps that are dragging the score down, truthfully): ${JSON.stringify({ ats_match: scanAnalysis.atsMatch, callback_odds: scanAnalysis.callbackOdds, overall_fit: scanAnalysis.overallFit, risk_tags: scanAnalysis.riskTags })}`
    : '';

  const prompt = `SELECTED ROLES — you MUST output every one of these role_index values, each with EXACTLY its bullet_target:\n${JSON.stringify(roles)}\n\nSELECTED PROJECTS (by project_index, each with EXACTLY its bullet_target):\n${JSON.stringify(projects)}\n\nTARGET JOB: ${JSON.stringify({ title: jobContext.title, company: jobContext.company, jd })}\n\nSCORING ANALYSIS (adopt transferable rewordings truthfully):\n${JSON.stringify(jobContext.tiered || {})}${scanLine}${nakedLine}${notesLine}${weaveLine}${addLine}${moveLine}`;

  // Fabricated-Skills-entry guard (Phase 3 #20 Stage 2, flag-gated): only
  // built when the flag is on, so the validator (and the prompt/draft above)
  // are completely unaffected when it's off.
  const skillsGuard = (tunables.scoring && tunables.scoring.useUnifiedAtsEngineV2)
    ? vouchedSkills({
        profile,
        confirmedSkills: [...confirmedNaked, ...confirmedContext.map((c) => c.term)],
        alreadyDemonstrated: (jobContext.tiered || {}).already_demonstrated,
        transferable: (jobContext.tiered || {}).transferable,
        hiddenStrengths: (jobContext.tiered || {}).hidden_strengths,
      })
    : null;

  // Grounding shared by every bullet on top of its own entry: the candidate's
  // confirmed-skill explanations and this job's scan-vouched matches. Never
  // the raw posting: a tool the JD lists is not a tool the candidate used.
  const groundingLc = [JSON.stringify(confirmedContext), JSON.stringify(jobContext.tiered || {})].join(' ').toLowerCase();
  const humanize = humanizer.isEnabled() ? { allow: humanizer.jdAllowList(jobContext), groundingLc } : null;
  const res = await aiRouter.structuredCall(credential, { tier: 'strong', systemInstruction: sys, prompt, responseSchema: buildDraftSchema(bulletIdSet(profile)), validate: makeValidate(profile, selected, jobContext.title, roleTargets, projectTargets, skillsGuard, humanize) });
  const draft = res.parsed;
  draft.professional_title = repairProfessionalTitle(draft.professional_title, profile, jobContext.title);
  if (humanize) dropUngroundedListNames(draft, profile, groundingLc);
  if (humanizer.isEnabled()) scrubDraft(draft);
  repairDraftVariants(draft);
  return { draft, usage: res.usage, costUsd: res.costUsd, model: res.model, connectionMode: res.connectionMode, tier: 'strong' };
}

module.exports = { runShotgunDraft, charTargets, repairProfessionalTitle, repairDraftVariants, makeValidate, draftTells, scrubDraft, dropUngroundedListNames };

const { tunables, synonymsFor, humanizer } = require('@careeros/shared');
const { runDirector, mandatoryRoleIndices } = require('./contentDirector');
const { runShotgunDraft } = require('./draftResume');
const { renderResume, fmtDates, eduParts } = require('./renderResume');
const { measureLine, measureLayout, geometry, SIZE, measureTextWidth, DEFAULT_RENDER, leftoverBulletBudget, fitContactLinks } = require('./metrics');
const { atsCheck, vouchedSkills, isConfirmableSkill, coreKeywordText, skillsKeywordText, skillPresent } = require('./atsCheck');
const { computeSparePool, computeAddBackPool, runFillPass, trimFillToFit } = require('./fillPass');
const { fitWholeClause, lastResortTrim } = require('./variantFit');

// Generation orchestrator (spec 7.12): CONTENT DIRECTOR picks entries and
// assigns each a relevance-tiered bullet_target (2/3/4) -> SHOTGUN draft
// writes per-bullet length variants, exactly bullet_target per entry -> the
// deterministic ASSEMBLER measures and picks the variant that fills a clean
// line (no AI in the spatial loop; a bullet can never ship past 2 lines) ->
// a mechanical repair pass fires if ATS coverage is low OR too many matched
// keywords are Skills-only instead of demonstrated in real content. Code
// MEASURES; the AI owns content. Returns
// { docxBuffer, atsScore, checksPassed, pendingConfirmations, usages }.
//
// SPLIT (2026-07-27, Copilot Mode Stage 1): the body below is factored into
// runDraftPhase (steps 1-6: Director -> shotgun -> assemble -> atsCheck) and
// runFinishPhase (steps 7-9: repair round -> literal-keyword safety net ->
// fill pass -> render -> report). generateResume() itself is now a thin
// composition of the two, so its behavior is byte-identical to before the
// split — Copilot Mode is a pause INSERTED between these two halves, never a
// second implementation (spec 7.14.1/7.14.10).

const T = tunables.bulletFill.strict;
const usageFrom = (r) => ({ actionType: 'resume_generation', model: r.model, connectionMode: r.connectionMode, usage: r.usage, costUsd: r.costUsd, tier: r.tier });

// Phase 3 #20 Stage 2: logged rows must stay attributable to the path that
// actually ran a given generation — bumped only under the flag, so every
// existing `resume-gen-v4` row on disk keeps meaning exactly what it always
// meant. Callers (routes/generate.js, routes/copilot.js, runCopilotSeed.js)
// read this instead of tunables.generation.promptVersion directly.
function resolvedPromptVersion() {
  return (tunables.scoring && tunables.scoring.useUnifiedAtsEngineV2)
    ? (tunables.generation.promptVersionV2 || tunables.generation.promptVersion)
    : tunables.generation.promptVersion;
}

// ---- deterministic page-fit: tune spacing/margin/header to fill one page (no AI) ----
function fitToPage(model, thresholds) {
  const cfg = tunables.generation.pageFit;
  const measure = (render) => measureLayout(model, { thresholds, render });
  let opts = { ...DEFAULT_RENDER };
  let meas = measure(opts);
  if (!meas.onePage) {
    while (!meas.onePage && opts.lineSpacing > cfg.lineSpacing.min) {
      opts = { ...opts, lineSpacing: Math.max(cfg.lineSpacing.min, Number((opts.lineSpacing - cfg.lineSpacing.step).toFixed(3))) };
      meas = measure(opts);
    }
    return { opts, meas };
  }
  // Stretch spacing toward the fill TARGET (7.1: ~750 of 756pt), not just
  // past the 0.9 minimum — stopping at the minimum is what left every page
  // at 90-92% with a visible empty band at the bottom.
  const target = thresholds.pageFillTarget || thresholds.pageFillMin;
  const reached = (m) => m.fillFraction >= target;
  if (reached(meas)) return { opts, meas };
  const stepUp = (key, max, step) => {
    while (!reached(meas) && opts[key] < max) {
      const next = { ...opts, [key]: Math.min(max, Number((opts[key] + step).toFixed(3))) };
      const m = measure(next);
      if (!m.onePage) break;
      opts = next; meas = m;
    }
  };
  stepUp('lineSpacing', cfg.lineSpacing.max, cfg.lineSpacing.step);
  stepUp('headerScale', cfg.headerScale.max, cfg.headerScale.step);
  if (!meas.wellFilled) {
    const wide = measure({ ...opts, marginIn: cfg.marginIn.expanded });
    if (wide.onePage) { opts = { ...opts, marginIn: cfg.marginIn.expanded }; meas = wide; stepUp('lineSpacing', cfg.lineSpacing.max, cfg.lineSpacing.step); }
  }
  return { opts, meas };
}

// ---- deterministic assembler ----
function measureVar(text, geom) { return measureLine(text, SIZE.bullet, geom.bulletAvailW, false, T); }

// A real user found a bullet our engine measured as a clean 2 lines (L=0.986,
// comfortably inside the [1.75, 2.0) 2-line band) that still rendered 3 lines
// in real MS Word — Carlito is a metric-compatible PROXY for Calibri, not a
// byte-identical match, and small kerning/hinting gaps compound over a long
// bullet, worst right at the top of the 2-line band. Rather than shrink the
// width budget for every bullet (tried first — tanked fill quality across the
// board), reject only candidates in that specific danger zone: a 2-line
// candidate above this ceiling doesn't get accepted as "two" even though our
// own measurement calls it in-band; it falls through to `one` or the
// truncation fallback below instead. Safely-short and safely-2-line bullets
// are untouched.
const TWO_LINE_SAFETY_CEILING = tunables.generation.twoLineSafetyCeiling || 1.9;
// Ceiling for the truncation fallback itself — same danger zone, so a
// truncated bullet can't land right back in the risky sliver it's escaping.
const MAX_SAFE_L = TWO_LINE_SAFETY_CEILING;

// Best clean 1-line and 2-line choice among a bullet's measured variants.
function bulletChoices(v, geom) {
  const cand = [];
  for (const key of ['short', 'one_line', 'two_line']) {
    if (!v[key]) continue;
    const m = measureVar(v[key], geom);
    cand.push({ key, text: v[key], L: m.L, lineCount: m.lineCount, inBand: m.inBand });
  }
  const ones = cand.filter((c) => c.lineCount === 1).sort((a, b) => b.L - a.L);
  const twos = cand.filter((c) => c.lineCount === 2 && c.L >= T.twoLine && c.L <= TWO_LINE_SAFETY_CEILING).sort((a, b) => b.L - a.L);
  const one = ones.find((c) => c.L >= T.oneLine) || ones[0] || null;
  const two = twos[0] || null;
  return { one, two, cand };
}

// Shorten an over-wide role/project header so it never wraps into the date tab.
function fitHeader(title, company, dates, usableW) {
  const width = (t, c) => measureTextWidth(c ? `${t} — ${c}` : t, SIZE.roleTitle, true) + (dates ? measureTextWidth(dates, SIZE.roleDates, true) + 14 : 0);
  if (width(title, company) <= usableW) return { title, company };
  for (const t of [company.split('(')[0].trim(), company.split(/\s+(?:for|of|—|-|·)\s+/)[0].trim()]) {
    if (t && width(title, t) <= usableW) return { title, company: t };
  }
  let c = company;
  while (c.length > 4 && width(title, c) > usableW) c = c.slice(0, -2);
  return { title, company: c };
}

// Quantified-result detector: a number, %, $, or multiplier ("3x", "2.5x") drawn
// from the source bullet. Deliberately loose — this only counts, it doesn't gate.
const QUANT_RE = /\d/;

function quantifiedRatio(model) {
  const all = [...(model.summary || []), ...(model.experience || []).flatMap((r) => r.bullets || []), ...(model.projects || []).flatMap((p) => p.bullets || [])];
  if (!all.length) return { ratio: 1, quantified: 0, total: 0 };
  const quantified = all.filter((b) => QUANT_RE.test(b)).length;
  return { ratio: Number((quantified / all.length).toFixed(3)), quantified, total: all.length };
}

const maxSameOpener = () => (tunables.humanizer && tunables.humanizer.maxSameOpeningVerb) || 2;
const openerKey = (t) => (String(t || '').match(/^[A-Za-z][A-Za-z-]*/) || [''])[0].toLowerCase();

// Opening verbs already used maxSameOpener times on the page (summary +
// experience + project bullets), for the fill pass to avoid.
function openersAtLimit(model) {
  const counts = new Map();
  for (const l of [...(model.summary || []), ...(model.experience || []).flatMap((r) => r.bullets || []), ...(model.projects || []).flatMap((p) => p.bullets || [])]) {
    const k = openerKey(l);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= maxSameOpener()).map(([k]) => k.charAt(0).toUpperCase() + k.slice(1));
}

// Walks the assembled page top to bottom; the first maxSameOpener uses of a
// verb stay, each later use is swapped (in all three variants of that draft
// bullet, so whichever variant the assembler picks agrees) for an
// alternative that is not itself at the limit. A stilted opener
// (humanizer.STILTED_OPENERS: "Constructed", "Elevated", ... — what a model
// writes when told to vary its verbs) is swapped at any count. Returns a new
// draft; the caller re-assembles and keeps it only if the page still holds.
function diversifyOpeners(draft, asm) {
  const next = JSON.parse(JSON.stringify(draft));
  const detail = asm.detail || {};
  const slots = [];
  (detail.summaryChosen || []).forEach((c, i) => slots.push({ text: c.text, bullet: (next.summary || [])[i] }));
  for (const e of detail.experience || []) {
    const g = (next.experience || []).find((x) => x.role_index === e.roleIndex);
    (e.chosen || []).forEach((c, bi) => slots.push({ text: c.text, bullet: g && g.bullets[bi] }));
  }
  for (const e of detail.projects || []) {
    const g = (next.projects || []).find((x) => x.project_index === e.projectIndex);
    (e.chosen || []).forEach((c, bi) => slots.push({ text: c.text, bullet: g && g.bullets[bi] }));
  }
  const max = maxSameOpener();
  const counts = new Map();
  for (const s of slots) { const k = openerKey(s.text); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
  const seen = new Map();
  const swaps = [];
  for (const s of slots) {
    const verb = openerKey(s.text);
    if (!verb || !s.bullet) continue;
    seen.set(verb, (seen.get(verb) || 0) + 1);
    const stilted = humanizer.STILTED_OPENERS.has(verb);
    if (!stilted && (seen.get(verb) <= max || counts.get(verb) <= max)) continue;
    const alt = humanizer.openerAlternative(verb, counts, max);
    if (!alt) continue;
    for (const k of ['short', 'one_line', 'two_line']) if (s.bullet[k]) s.bullet[k] = humanizer.swapOpener(s.bullet[k], verb, alt);
    const altKey = openerKey(alt);
    counts.set(verb, counts.get(verb) - 1);
    counts.set(altKey, (counts.get(altKey) || 0) + 1);
    swaps.push({ from: verb, to: alt, text: s.text.slice(0, 60) });
  }
  return { draft: next, swaps };
}

// Hoisted out of assemble()'s closure (2026-07-27, Copilot Mode Stage 1) so
// assembleFromTree (copilotTree.js) can build the exact same render-model
// shape from an edited content_tree — one model-building implementation
// shared by both the one-click and Copilot paths (spec 7.14.1/7.14.10).
function buildModelFrom({ contact, professionalTitle, summary, experience, projects, education, skills }) {
  // Trim the header link set (7.2) to what fits the contact line in <=2 lines
  // BEFORE measuring or rendering, so metrics.measureLayout, renderResume's
  // contactChildren and buildContactLine all see the same links. Dropped link
  // types are recorded as a shortfall (checksPassed.contactLinksDropped).
  const fitted = fitContactLinks(contact || {});
  const contactForModel = contact ? { ...contact, links: fitted.links } : contact;
  return {
    header: {
      name: (contact && contact.name) || '',
      title: professionalTitle,
      contact: contactForModel,
      contactLine: fitted.contactLine,
      contactLinksDropped: fitted.dropped,
    },
    summary,
    experience,
    projects,
    education,
    skills,
  };
}

// The Certifications row is the master résumé's own certifications, verbatim
// (7.10), plus any other certification the draft listed that is genuinely held
// (a confirmed "NetSuite certification"). It used to be whatever the draft AI
// wrote — and the draft never SEES profile.certifications, so it rebuilt them
// from the posting's wording: "Lean Six Sigma Black Belt" came out as "Lean
// Six Sigma", and the Google Project Management Certificate as a fragment. A
// drafted item already contained in a master cert ("Lean Six Sigma") is the
// cut-down copy, so it is dropped rather than listed twice.
function certificationRow(profile, drafted) {
  const master = ((profile && profile.certifications) || []).map((c) => String(c || '').trim()).filter(Boolean);
  const words = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const masterWords = master.map((c) => new Set(words(c)));
  const seen = new Set(master.map((c) => c.toLowerCase()));
  const extra = [];
  for (const raw of drafted || []) {
    const item = String(raw || '').trim();
    const lc = item.toLowerCase();
    if (!item || seen.has(lc)) continue;
    // Every word of it is in one master cert: a cut-down or reordered copy.
    const w = words(item);
    if (w.length && masterWords.some((mw) => w.every((x) => mw.has(x)))) continue;
    seen.add(lc);
    extra.push(item);
  }
  return [...master, ...extra];
}

function assemble({ draft, profile, contact }) {
  const geom = geometry(DEFAULT_RENDER.marginIn);
  const usableW = geom.usableW;

  const experience = (draft.experience || [])
    .slice()
    .sort((a, b) => a.role_index - b.role_index) // reverse-chronological (profile is newest-first)
    .map((g) => {
      const role = profile.roles[g.role_index] || {};
      // Fold location into the company text so it's covered by fitHeader's own
      // overflow protection (shrinks/truncates before wrapping into the date tab).
      const companyWithLoc = [role.company, role.location].filter(Boolean).join(', ');
      const hdr = fitHeader(role.title || '', companyWithLoc, fmtDates(role.dates), usableW);
      return {
        roleIndex: g.role_index,
        sourceBullets: g.bullets || [],
        title: hdr.title,
        company: hdr.company,
        dates: fmtDates(role.dates),
        bulletChoices: (g.bullets || []).map((b) => bulletChoices(b, geom)),
      };
    });
  const projects = (draft.projects || [])
    .map((g) => {
      const proj = profile.projects[g.project_index] || {};
      const hdr = fitHeader(proj.title || '', '', fmtDates(proj.dates), usableW);
      return {
        projectIndex: g.project_index,
        sourceBullets: g.bullets || [],
        title: hdr.title,
        dates: fmtDates(proj.dates),
        _start: (proj.dates && proj.dates.start) || '',
        bulletChoices: (g.bullets || []).map((b) => bulletChoices(b, geom)),
      };
    })
    .sort((a, b) => String(b._start).localeCompare(String(a._start)));

  // Never ship a bullet past 2 lines: if none of the 3 variants naturally fit
  // within 1-2 lines, deterministically truncate the LARGEST candidate down to
  // the safe ceiling — maximizing fill while guaranteeing safety. (Picking the
  // SMALLEST candidate and leaving it untouched is how a stubby, barely-into-
  // line-2 bullet — e.g. one_line measuring L~1.04, deliberately written just
  // over a full line per its own prompt target, but nowhere near the 1.75
  // needed to count as a filled 2-liner — could ship unchanged instead of
  // being upgraded toward a properly full bullet.)
  const pick = (bc) => {
    if (bc.one) return bc.one;
    if (bc.two) return bc.two;
    const fallback = bc.cand.slice().sort((a, b) => b.L - a.L)[0];
    if (!fallback) return { key: 'custom', text: '', L: 0, lineCount: 1, inBand: false };
    // Whole clauses only (variantFit.js): a word-boundary cut leaves a
    // sentence that stops mid-thought.
    const capped = fitWholeClause(fallback.text, geom, MAX_SAFE_L) || lastResortTrim(fallback.text, geom, MAX_SAFE_L);
    const m = measureVar(capped, geom);
    return { key: 'custom', text: capped, L: m.L, lineCount: m.lineCount, inBand: m.inBand };
  };
  experience.forEach((r) => (r.chosen = r.bulletChoices.map(pick)));
  projects.forEach((p) => (p.chosen = p.bulletChoices.map(pick)));
  // Summary bullets use the SAME selection rule as any other bullet — no
  // special-cased shorter target.
  const summaryChoices = (draft.summary || []).slice(0, 3).map((s) => bulletChoices(s, geom));
  // summaryChosen: kept alongside summary (which just needs the text) so
  // content_tree seeding (copilotTree.js) knows which variant key was picked
  // for each summary bullet, same as experience/project bullets' `.chosen`.
  const summaryChosen = summaryChoices.map(pick);
  const summary = summaryChosen.map((c) => c.text);
  const skills = [
    { label: 'Technical', items: draft.skills.technical },
    { label: 'Management', items: draft.skills.management },
    { label: 'Business', items: draft.skills.business },
    { label: 'Certifications', items: certificationRow(profile, draft.skills.certifications) },
  ].filter((r) => r.items && r.items.length);

  const educationRows = (profile.education || [])
    .map((e) => { const p = eduParts(e); const institution = [p.institution, p.location].filter(Boolean).join(', '); return { degreeField: p.degreeField, institution, dates: fmtDates(e.dates) }; })
    .filter((e) => e.degreeField || e.institution);

  const buildModel = () => buildModelFrom({
    contact,
    professionalTitle: draft.professional_title,
    summary,
    experience: experience.map((r) => ({ title: r.title, company: r.company, dates: r.dates, bullets: r.chosen.map((c) => c.text) })),
    projects: projects.map((p) => ({ title: p.title, dates: p.dates, bullets: p.chosen.map((c) => c.text) })),
    education: educationRows,
    skills,
  });

  const measure = () => measureLayout(buildModel(), { thresholds: T, render: DEFAULT_RENDER });
  let meas = measure();

  // Fill: upgrade compact 1-line bullets to their clean 2-line variant (roles first)
  // until well-filled; never overflow.
  const upgradable = () => {
    const list = [];
    experience.forEach((r, ri) => r.bulletChoices.forEach((bc, bi) => { if (bc.two && r.chosen[bi].lineCount === 1) list.push({ arr: r.chosen, bi, bc, order: ri }); }));
    projects.forEach((p) => p.bulletChoices.forEach((bc, bi) => { if (bc.two && p.chosen[bi].lineCount === 1) list.push({ arr: p.chosen, bi, bc, order: 100 }); }));
    return list.sort((a, b) => a.order - b.order);
  };
  // Snapshot before any upgrade: the fill pass sizes its budget from THIS, so
  // genuinely new content (an unused bullet, a restored entry) gets the room
  // first and 1-line -> 2-line upgrades only top up what is left.
  const baseMeas = meas;
  let guard = 0;
  while (meas.fillFraction < (T.pageFillTarget || T.pageFillMin) && guard++ < 40) {
    const up = upgradable();
    if (!up.length) break;
    up[0].arr[up[0].bi] = up[0].bc.two;
    const m2 = measure();
    if (!m2.onePage) { up[0].arr[up[0].bi] = up[0].bc.one || up[0].arr[up[0].bi]; break; }
    meas = m2;
  }
  // Overflow safety: downgrade 2-line -> 1-line, then drop trailing project/experience
  // bullets — but NEVER below the 2-bullet floor, then drop the whole entry instead
  // of leaving a stubby 1- or 0-bullet entry.
  const floor = tunables.generation.bulletsPerEntry.min;
  // shed counts real content removed to hold one page (bullets and whole
  // projects; a 2-line -> 1-line downgrade is not content). The fill pass and
  // the opener pass compare it to reject an addition that pushes existing
  // content off the page.
  let shed = 0;
  guard = 0;
  while (!meas.onePage && guard++ < 60) {
    // First: shed the "bonus" 4th bullet from any entry that still has one —
    // only a bullet_target-4 entry can ever reach 4 chosen bullets, so this
    // implements "the single most-relevant entry gets 4 bullets, unless the
    // page can't afford it, in which case it settles for 3 like everyone else."
    const fourBullet = [...experience, ...projects].find((e) => e.chosen.length === 4);
    if (fourBullet) { fourBullet.chosen.pop(); fourBullet.bulletChoices.pop(); shed += 1; meas = measure(); continue; }
    const twoLine = [];
    experience.forEach((r) => r.chosen.forEach((c, bi) => { if (c.lineCount === 2 && r.bulletChoices[bi].one) twoLine.push({ arr: r.chosen, bi, one: r.bulletChoices[bi].one }); }));
    if (twoLine.length) { twoLine[0].arr[twoLine[0].bi] = twoLine[0].one; meas = measure(); continue; }
    const lp = projects[projects.length - 1];
    if (lp && lp.chosen.length > floor) { lp.chosen.pop(); lp.bulletChoices.pop(); shed += 1; meas = measure(); continue; }
    if (projects.length) { shed += projects.pop().chosen.length; meas = measure(); continue; }
    const lr = experience[experience.length - 1];
    if (lr && lr.chosen.length > floor) { lr.chosen.pop(); lr.bulletChoices.pop(); shed += 1; meas = measure(); continue; }
    break;
  }

  const model = buildModel();
  const fit = fitToPage(model, T);
  const finalMeas = measureLayout(model, { thresholds: T, render: fit.opts });
  // preFitMeas: the measurement right here, BEFORE fitToPage's cosmetic
  // lineSpacing/headerScale/margin stretch consumes any leftover room — the
  // fill pass (generateResume()) needs THIS, not finalMeas, to compute
  // genuine leftover bullet budget (2026-07-27).
  return {
    model,
    opts: fit.opts,
    meas: finalMeas,
    preFitMeas: meas,
    baseMeas,
    shed,
    outOfBand: finalMeas.bullets.filter((b) => !b.inBand).length,
    totalBullets: finalMeas.bullets.length,
    // detail: the internal per-entry arrays (headers, every measured bullet
    // variant, the picked choice) — additive, Copilot Mode Stage 1 only
    // consumer (copilotTree.js's contentTreeFromAssembly). Not used by the
    // one-click path, which only reads model/opts/meas as before.
    detail: { experience, projects, summaryChoices, summaryChosen },
  };
}

// Deterministic literal-keyword safety net (2026-07-27, reworked 2026-07-27). A
// live batch across 15 real jobs found roughly HALF of all missing-required-
// keyword misses were skills the job's OWN scan already confirmed the
// candidate genuinely has (already_demonstrated / transferable /
// hidden_strengths — i.e. `ats.addable`) that simply never landed as a
// literal substring anywhere in the rendered text. draftResume.js's repair
// prompt already instructs the AI to "use each keyword's exact JD spelling"
// — that instruction alone isn't reliably followed (a prior attempt at a
// broader prompt-only fix for this exact class of bug was tried and reverted
// for regressing quality elsewhere), and there's only one repair attempt with
// no verification that it actually landed. Since a Skills-only match still
// scores (atsSkillsOnlyWeight) and real ATS-optimized résumés routinely list
// exact JD phrasing in Skills for precisely this reason, this pass GUARANTEES
// literal presence in code — appending each still-missing-but-genuinely-held
// keyword's exact JD string to Skills — rather than depending on the model's
// compliance. Required keywords first (full weight), then nice-to-have if
// page room remains.
//
// REWORKED (2026-07-27): originally ran on the already-ASSEMBLED model, after
// the fill pass — i.e. after bullet content had already claimed however much
// page room the fill loop + fill pass decided to use, leaving keywords to
// compete for whatever scraps were left. Confirmed live on a real, repeated
// generation of the SAME job/profile/code: one run landed 3/3 addable
// keywords, a later run of the identical job landed only 1/3 — because the
// AI's draft phrasing isn't byte-identical run to run even at temperature 0,
// so the exact page space consumed by bullet content shifts by a hair each
// time, and whatever's left for Skills is a knife-edge. Now operates on the
// DRAFT (pre-assembly) instead, inserted into draft.skills and reassembled
// via the caller-supplied `reassemble` — same function the rest of the
// pipeline uses — so Skills claims its page room FIRST; the bullet-fill loop
// inside assemble() and the fill pass that runs after this both naturally see
// the space Skills already used (assemble()'s own fillFraction/onePage
// measurement covers the whole page, Skills section included) and fill only
// what's actually left, instead of the other way around. Tries each candidate
// individually (via a real reassemble, not a cheap estimate) and keeps only
// the ones that still fit — never touches bullet content.
//
// PARAMETRIZED (2026-07-27, Copilot Mode Stage 1): `reassemble` is now
// injected rather than a hardcoded call to assemble() — Copilot's seed phase
// calls this with the exact same `(d) => assemble({ draft: d, profile,
// contact })` one-click uses (Copilot applies this pass at seed time, before
// any content_tree exists, so there is no tree-shaped variant in Stage 1 —
// export runs with applyLiteralKeywords:false and never re-derives from the
// draft, which would discard the user's curated edits). One implementation,
// injectable reassembly — the same constraint spec 7.14.1 imposes elsewhere.
function ensureLiteralKeywords({ draft: srcDraft, ats, jobContext, reassemble }) {
  const required = jobContext.jdProfile.required_skills || [];
  const nice = jobContext.jdProfile.nice_to_have_skills || [];
  const addable = new Set((ats.addable || []).map((s) => s.toLowerCase().trim()));
  const matchedLc = new Set((ats.matched || []).map((s) => s.toLowerCase().trim()));
  const missingAddable = (list) => list.filter((s) => !matchedLc.has(s.toLowerCase().trim()) && addable.has(s.toLowerCase().trim()));
  const candidates = [...missingAddable(required), ...missingAddable(nice)];
  if (!candidates.length) return { draft: srcDraft, asm: null, added: [] };

  const skillsKeys = ['technical', 'management', 'business', 'certifications'];
  const targetKey = skillsKeys.find((k) => (srcDraft.skills[k] || []).length) || 'technical';
  let workingDraft = { ...srcDraft, skills: { ...srcDraft.skills, [targetKey]: [...(srcDraft.skills[targetKey] || [])] } };
  const already = new Set(skillsKeys.flatMap((k) => (workingDraft.skills[k] || []).map((i) => i.toLowerCase().trim())));

  const added = [];
  let asm = null;
  for (const s of candidates) {
    const key = s.toLowerCase().trim();
    if (already.has(key)) continue;
    const trialDraft = { ...workingDraft, skills: { ...workingDraft.skills, [targetKey]: [...workingDraft.skills[targetKey], s] } };
    const trialAsm = reassemble(trialDraft);
    // Skip (don't abandon the whole pass) if this specific candidate doesn't
    // fit — a later, shorter one still might, so keep trying the rest.
    if (!trialAsm.meas.onePage) continue;
    workingDraft = trialDraft;
    asm = trialAsm;
    already.add(key);
    added.push(s);
  }
  return { draft: workingDraft, asm, added };
}

const at = tunables.generation.atsTargets;
const IDEAL_PCT = Math.round(at.ideal * 100);
const FLOOR_PCT = Math.round(at.floor * 100);
const CORE_RATIO_TARGET = tunables.generation.coreKeywordRatioTarget || 0.5;
function coreRatioOf(a) {
  const c = (a.sectionBreakdown.core || []).length;
  const s = (a.sectionBreakdown.skillsOnly || []).length;
  return (c + s) ? c / (c + s) : 1;
}

// Per-tier bullet-coverage targets (Phase 3 bug fix, 2026-08-02) — replaces
// the single blended coreRatioOf() as the repair trigger. atsCheck.js's
// bulletCoverage is computed over HELD terms only (a term the candidate
// doesn't have never counts against coverage) and split required vs
// nice-to-have, matching the two different bars stated in draftResume.js's
// prompt. coreRatioOf/CORE_RATIO_TARGET stay in place (still feed
// checksPassed.atsCoreRatio and the report), just no longer the trigger.
const COVERAGE_TARGETS = tunables.generation.bulletCoverageTargets || { required: 0.9, niceToHave: 0.5 };
function coverageOk(a) {
  const bc = a.bulletCoverage || {};
  const reqOk = !bc.required || bc.required.held === 0 || bc.required.ratio >= (COVERAGE_TARGETS.required ?? 0.9);
  const niceOk = !bc.niceToHave || bc.niceToHave.held === 0 || bc.niceToHave.ratio >= (COVERAGE_TARGETS.niceToHave ?? 0.5);
  return { reqOk, niceOk, ok: reqOk && niceOk };
}
// Required-first ordering for the "move these Skills-only terms into a real
// bullet" repair hint — sectionBreakdown.skillsOnly doesn't itself carry tier,
// but every entry in it is necessarily a member of required_skills or
// nice_to_have_skills (score1 only ever runs on those two lists).
function tierOrderedSkillsOnly(a, jdProfile) {
  const reqSet = new Set((jdProfile.required_skills || []).map((s) => String(s).toLowerCase().trim()));
  const list = a.sectionBreakdown.skillsOnly || [];
  return [...list].sort((x, y) => {
    const xReq = reqSet.has(String(x).toLowerCase().trim()) ? 0 : 1;
    const yReq = reqSet.has(String(y).toLowerCase().trim()) ? 0 : 1;
    return xReq - yReq;
  });
}

// Upfront keyword injection (7.12 step 5, Phase 3 #20 Stage 2, flag-gated).
// Every JD required/nice-to-have skill vouchedSkills() already vouches for
// (master profile, confirmed_skills, or the job's own scan-vouched
// already_demonstrated/transferable/hidden_strengths — the SAME primitives
// the pre-generation gap check and the Skills-fabrication guard use, never a
// separately-tuned notion) is handed to the FIRST draft, not just the repair
// round, each carrying its truthful synonym equivalents (synonymsFor) so the
// model can use whichever phrasing is natural — never forced to a single
// verbatim string (the reverted 2026-07-26 experiment; see draftResume.js's
// prompt comment). Returns [] when the flag is off, so the first-draft prompt
// is byte-identical to the pre-Stage-2 pipeline.
function computeWeaveKeywords({ profile, jobContext, confirmedSkills }) {
  if (!(tunables.scoring && tunables.scoring.useUnifiedAtsEngineV2)) return [];
  const tiered = jobContext.tiered || {};
  const { isHeld } = vouchedSkills({
    profile,
    confirmedSkills,
    alreadyDemonstrated: tiered.already_demonstrated,
    transferable: tiered.transferable,
    hiddenStrengths: tiered.hidden_strengths,
  });
  const jd = jobContext.jdProfile || {};
  const allSkills = [...(jd.required_skills || []), ...(jd.nice_to_have_skills || [])];
  return allSkills
    .filter((s) => isConfirmableSkill(s) && isHeld(s))
    .map((s) => {
      const syns = synonymsFor(s).filter((v) => v !== String(s).toLowerCase().trim());
      return syns.length ? `${s} (or: ${syns.join(', ')})` : s;
    });
}

// Fabricated-Skills-entry strip (Phase 3 #20 Stage 2, flag-gated) — the hard
// guarantee behind draftResume.js's reject-and-retry validator: even if the
// model's corrective retry ALSO invents a Skills entry, this deterministic
// pass drops anything not grounded in the real profile/confirmed_skills/scan-
// vouched terms before that draft ever reaches assembly. Runs on both the
// first draft and any repair draft, and BEFORE ensureLiteralKeywords — that
// safety net's own deliberate additions are always genuinely held (it only
// ever adds a JD skill already classified `addable`), so ordering strip
// first can never touch them.
function stripFabricatedSkills({ draft, profile, jobContext, confirmedSkills }) {
  if (!(tunables.scoring && tunables.scoring.useUnifiedAtsEngineV2)) return { draft, rejected: [] };
  const tiered = jobContext.tiered || {};
  const { isHeld } = vouchedSkills({
    profile,
    confirmedSkills,
    alreadyDemonstrated: tiered.already_demonstrated,
    transferable: tiered.transferable,
    hiddenStrengths: tiered.hidden_strengths,
  });
  const skillsKeys = ['technical', 'management', 'business', 'certifications'];
  const rejected = [];
  const nextSkills = { ...draft.skills };
  for (const key of skillsKeys) {
    nextSkills[key] = (draft.skills[key] || []).filter((item) => {
      if (isConfirmableSkill(item) && !isHeld(item)) { rejected.push(item); return false; }
      return true;
    });
  }
  if (!rejected.length) return { draft, rejected: [] };
  return { draft: { ...draft, skills: nextSkills }, rejected };
}

// Deterministic bullet-count reconciler (Phase 3, shotgun bullet_target
// soft-repair) — the backstop behind draftResume.js's now-relaxed-on-retry
// bullet-count check (see that file's makeValidate for the full rationale).
// Runs on BOTH the first draft and any repair draft, same two call sites as
// stripFabricatedSkills just above, and NOT flag-gated (unlike that guard) —
// this is a crash fix, not a scoring-path feature, and must apply regardless
// of tunables.scoring.useUnifiedAtsEngineV2.
//
// Over target: truncate to the first `want` bullets — the model orders by
// relevance, and the assembler's own overflow loop already sheds trailing
// bullets on the same idiom (see the "shed the bonus 4th bullet" loop below).
// Under target: pad from that entry's own unused master-résumé bullets via
// computeSparePool (fillPass.js) — the SAME per-entry-scoped pool the fill
// pass uses, so a pad can never pull another entry's bullet. Each padded node
// reuses the master bullet's real text as all three variants (short/one_line/
// two_line) and its real id as source_bullet_id — zero AI, fully grounded,
// same no-AI node-building principle Session 21c's copilotVault.js
// established for the Resume Vault. If the pool is exhausted, the entry ships
// short rather than fabricate — recorded, never silent.
//
// Uses the SAME `|| 3` default as draftResume.js's validator for an unranked
// index (a safety-net role the Director itself didn't rank) — validator and
// reconciler must never disagree about what the target was.
function reconcileBulletCounts({ draft, profile, selected, roleTargets, projectTargets }) {
  const sparePool = computeSparePool({ profile, draft, selected });
  const repairs = [];

  const reconcileGroup = (key, groups, targets, poolList, poolKey) => {
    return groups.map((g) => {
      const idx = key === 'experience' ? g.role_index : g.project_index;
      const want = targets[idx] || 3;
      const have = (g.bullets || []).length;
      if (have === want) return g;
      if (have > want) {
        repairs.push({ kind: key === 'experience' ? 'role' : 'project', index: idx, target: want, from: have, truncated: have - want });
        return { ...g, bullets: g.bullets.slice(0, want) };
      }
      // have < want: pad from this entry's own spare pool.
      const entryPool = poolList.find((e) => e[poolKey] === idx);
      const usedIds = new Set(g.bullets.map((b) => b.source_bullet_id));
      const spare = ((entryPool && entryPool.spare) || []).filter((s) => !usedIds.has(s.id));
      const need = want - have;
      const padded = spare.slice(0, need).map((s) => ({ short: s.text, one_line: s.text, two_line: s.text, source_bullet_id: s.id }));
      if (padded.length) {
        repairs.push({ kind: key === 'experience' ? 'role' : 'project', index: idx, target: want, from: have, padded: padded.length });
      }
      const shortfall = need - padded.length;
      if (shortfall > 0) {
        repairs.push({ kind: key === 'experience' ? 'role' : 'project', index: idx, target: want, from: have + padded.length, shortfall });
      }
      return { ...g, bullets: [...g.bullets, ...padded] };
    });
  };

  const experience = reconcileGroup('experience', draft.experience || [], roleTargets, sparePool.roles, 'role_index');
  const projects = reconcileGroup('projects', draft.projects || [], projectTargets, sparePool.projects, 'project_index');

  if (!repairs.length) return { draft, repairs: [] };
  return { draft: { ...draft, experience, projects }, repairs };
}

const atsCheckFor = (model, profile, jobContext, confirmedSkills, tiered) => atsCheck({
  model,
  jdProfile: jobContext.jdProfile,
  profile,
  confirmedSkills,
  alreadyDemonstrated: tiered.already_demonstrated,
  transferable: tiered.transferable,
  hiddenStrengths: tiered.hidden_strengths,
});

/**
 * Steps 1-6 of spec 7.12: Content Director -> mandatory-role safety net ->
 * shotgun draft -> deterministic assembler -> ATS check. This is exactly
 * "Open in Copilot" per spec 7.14.2/7.14.3 — its output seeds a
 * resume_edit_sessions.content_tree instead of continuing to runFinishPhase.
 */
// `usagesOut`, if given, is pushed to as each AI call completes (Director,
// then shotgun draft) rather than only being available once this whole
// function resolves — lets a caller that wraps this in a try/catch (see
// runCopilotSeed.js) still bill/log the real cost already incurred if a
// LATER call in this same function throws (e.g. the shotgun draft's
// validator exhausting its retries). The function's own returned `usages`
// is unchanged — this is purely an additional sink, not a replacement.
async function runDraftPhase({ profile, contact, jobContext, confirmedNaked = [], confirmedContext = [], credential, onProgress = async () => {}, usagesOut = null }) {
  const usages = [];
  const record = (u) => { usages.push(u); if (usagesOut) usagesOut.push(u); };
  const confirmedSkills = [...confirmedNaked, ...confirmedContext.map((c) => c.term)];

  await onProgress('director', 'Selecting relevant experience');
  const dir = await runDirector({ profile, jobContext, confirmedContext, credential });
  record(usageFrom(dir));

  const roleTargets = {};
  const projectTargets = {};
  for (const e of dir.director.include_roles || []) roleTargets[e.index] = e.bullet_target;
  for (const e of dir.director.include_projects || []) projectTargets[e.index] = e.bullet_target;

  // SAFETY NET behind the Director (hard invariants, not judgment): every
  // role except a finished internship of 3 months or less MUST appear (7.5) —
  // the current role, every full-time role, and every longer internship.
  const mandatory = mandatoryRoleIndices(profile);
  // Safety-net roles the Director didn't itself select don't have a
  // relevance-ranked bullet_target — default them to 3, the "normal" depth.
  for (const i of mandatory) if (!(i in roleTargets)) roleTargets[i] = 3;
  const roleSet = Array.from(new Set([...(dir.director.include_roles || []).map((e) => e.index), ...mandatory]));
  const projectSet = (dir.director.include_projects || []).map((e) => e.index);
  const selected = { roleIndices: roleSet, projectIndices: projectSet };

  await onProgress('draft', 'Drafting bullet content');
  const weaveKeywords = computeWeaveKeywords({ profile, jobContext, confirmedSkills });
  const first = await runShotgunDraft({ profile, jobContext, selected, roleTargets, projectTargets, confirmedNaked, confirmedContext, scanAnalysis: jobContext.scanAnalysis, weaveKeywords, credential });
  record(usageFrom(first));
  const stripped = stripFabricatedSkills({ draft: first.draft, profile, jobContext, confirmedSkills });
  const reconciled = reconcileBulletCounts({ draft: stripped.draft, profile, selected, roleTargets, projectTargets });
  const draft = reconciled.draft;
  const skillsRejected = stripped.rejected;
  const bulletTargetRepairs = reconciled.repairs;
  await onProgress('assemble', 'Fitting content to one page');
  const asm = assemble({ draft, profile, contact });
  // The job's own scan scoring (D1a/D1b) already resolved some required skills
  // as genuinely held even when they're not a literal substring of the master
  // profile (e.g. "held the role" reasoning, a transferable reword, a hidden
  // strength) — atsCheck needs this to classify them as addable, not an
  // unconfirmed gap (2026-07-26 fix; see atsCheck.js's transferableSkillText).
  const tiered = jobContext.tiered || {};
  await onProgress('ats_check', 'Checking ATS keyword coverage');
  const ats = atsCheckFor(asm.model, profile, jobContext, confirmedSkills, tiered);

  return { draft, asm, ats, selected, roleTargets, projectTargets, confirmedSkills, usages, directorReasoning: dir.director.reasoning, skillsRejected, bulletTargetRepairs };
}

/**
 * Steps 7-9 of spec 7.12: ONE mechanical repair pass -> literal-keyword
 * safety net -> fill pass -> render -> report. `options.allowRedraft: false`
 * skips the repair round AND the fill pass (both re-draft via AI); Copilot
 * export uses this so a user's curated content_tree is never overwritten.
 * `options.applyLiteralKeywords: false` skips the safety net entirely —
 * Copilot applies it once, at seed time, and export must not re-derive from
 * the draft (see ensureLiteralKeywords' header comment).
 */
async function runFinishPhase({
  draft, asm, ats, selected, roleTargets, projectTargets, confirmedSkills, directorReasoning,
  profile, contact, jobContext, credential,
  confirmedNaked = [], confirmedContext = [],
  skillsRejected = [],
  bulletTargetRepairs = [],
  options = {},
  onProgress = async () => {},
}) {
  const allowRedraft = options.allowRedraft !== false;
  const applyLiteralKeywords = options.applyLiteralKeywords !== false;
  const usages = [];
  const tiered = jobContext.tiered || {};
  const reassemble = (d) => assemble({ draft: d, profile, contact });

  // Mechanical repair loop (Phase 3 bug fix, 2026-08-02: was capped at ONE
  // round regardless of tunables.generation.repairRounds.toIdeal; now actually
  // loops up to that cap). Fires each round if truthful ATS coverage is under
  // the ideal target with genuinely addable keywords, OR if held required/
  // nice-to-have keywords are under their per-tier bullet-coverage target
  // (coverageOk, required 90% / nice-to-have 50% by default — see
  // draftResume.js's CORE-CONTENT KEYWORD TARGETS prompt block). Keep
  // whichever draft scores better each round; stop as soon as both are
  // satisfied or a round fails to adopt.
  let repairRounds = 0;
  const maxRepairRounds = Math.max(0, (tunables.generation.repairRounds && tunables.generation.repairRounds.toIdeal) || 1);
  if (allowRedraft) {
    for (let round = 0; round < maxRepairRounds; round += 1) {
      const needsAts = ats.score < IDEAL_PCT && (ats.addable || []).length;
      const cov = coverageOk(ats);
      const needsCoverage = !cov.ok && (ats.sectionBreakdown.skillsOnly || []).length;
      if (!needsAts && !needsCoverage) break;

      await onProgress('repair', 'Repairing weak keyword coverage');
      const r2 = await runShotgunDraft({
        profile, jobContext, selected, roleTargets, projectTargets,
        confirmedNaked, confirmedContext,
        scanAnalysis: jobContext.scanAnalysis,
        addKeywords: needsAts ? ats.addable : [],
        moveToCore: needsCoverage ? tierOrderedSkillsOnly(ats, jobContext.jdProfile) : [],
        credential,
      });
      usages.push(usageFrom(r2));
      // Same fabricated-Skills strip as the first draft (generateResume.js's
      // stripFabricatedSkills header comment) — the repair round is still an
      // AI call and can still invent a Skills entry, so it gets the same
      // deterministic guarantee, not just the first pass.
      const strippedRepair = stripFabricatedSkills({ draft: r2.draft, profile, jobContext, confirmedSkills });
      if (strippedRepair.rejected.length) skillsRejected = [...skillsRejected, ...strippedRepair.rejected];
      // Same reconciler as the first draft — the repair round is still a fresh
      // runShotgunDraft call (its own makeValidate closure, attemptNumber
      // restarted at 0) and can independently miss a bullet_target.
      const reconciledRepair = reconcileBulletCounts({ draft: strippedRepair.draft, profile, selected, roleTargets, projectTargets });
      const asm2 = reassemble(reconciledRepair.draft);
      const ats2 = atsCheckFor(asm2.model, profile, jobContext, confirmedSkills, tiered);
      // Prefer the repaired draft if it improves EITHER the overall score or the
      // core-content ratio without tanking the other — a repair that boosts core
      // placement at the cost of matched coverage isn't actually progress.
      const scoreOk = ats2.score >= ats.score - 2;
      const coreOk = coreRatioOf(ats2) >= coreRatioOf(ats) - 0.02;
      const adopted = (ats2.score > ats.score || coreRatioOf(ats2) > coreRatioOf(ats)) && scoreOk && coreOk;
      if (!adopted) break; // a round that doesn't improve anything won't improve on retry either
      draft = reconciledRepair.draft; asm = asm2; ats = ats2;
      if (reconciledRepair.repairs.length) bulletTargetRepairs = [...bulletTargetRepairs, ...reconciledRepair.repairs];
      repairRounds += 1;
    }
  }

  // Literal-keyword safety net — see ensureLiteralKeywords' header comment.
  // Runs BEFORE the fill pass (reworked 2026-07-27) so Skills claims its page
  // room first — the fill pass's own leftoverBulletBudget below is computed
  // from asm.preFitMeas AFTER this reassigns asm, so it naturally sees
  // whatever's actually left once Skills has already been given first claim.
  let literalKeywordsAdded = [];
  if (applyLiteralKeywords) {
    await onProgress('keywords', 'Adding exact-match keywords');
    const literal = ensureLiteralKeywords({ draft, ats, jobContext, reassemble });
    if (literal.added.length) {
      draft = literal.draft; asm = literal.asm; literalKeywordsAdded = literal.added;
      ats = atsCheckFor(asm.model, profile, jobContext, confirmedSkills, tiered);
    }
  }

  // Fill pass (2026-07-27): if genuine leftover page room remains after the
  // repair round settles, pull from the candidate's own already-parsed,
  // currently-unused bullets (fillPass.js) rather than leaving that space
  // empty — prioritizing ones that add more JD-matching keywords. Measured
  // against preFitMeas (before fitToPage's cosmetic stretch), not asm.meas —
  // see assemble()'s own comment on why. Only appends (never rewrites), so
  // the only real risk is page overflow — that's the sole revert condition;
  // a score-regression guard isn't needed the way the repair round's is,
  // since appending can only add matched keywords, never remove them.
  // The budget is read from asm.baseMeas — the page BEFORE assemble() upgraded
  // any bullet to its 2-line variant — so new content gets the room first and
  // upgrades only top up what remains. The fill pass may also restore a whole
  // entry the Director left out (a <=3-month internship, an unpicked project).
  // Its bullets come back in order of value and trimFillToFit cuts from the
  // end until the page holds without shedding content that was already there
  // or lowering the ATS score.
  let fillPassBullets = 0;
  let addedBack = [];
  let fillPassBudget = { remainingPt: 0, oneLineBullets: 0, twoLineBullets: 0 };
  if (allowRedraft) {
    fillPassBudget = leftoverBulletBudget(asm.baseMeas || asm.preFitMeas, DEFAULT_RENDER);
    if (fillPassBudget.oneLineBullets >= (tunables.generation.fillPass.minOneLineBudget || 1)) {
      const sparePool = computeSparePool({ profile, draft, selected });
      const addBackPool = computeAddBackPool({ profile, selected });
      if (sparePool.roles.length || sparePool.projects.length || addBackPool.roles.length || addBackPool.projects.length) {
        await onProgress('fill', 'Filling leftover page space');
        const fp = await runFillPass({
          profile, jobContext, selected, sparePool, addBackPool, budget: fillPassBudget,
          addKeywords: ats.addable, moveToCoreCandidates: ats.sectionBreakdown.skillsOnly,
          overusedVerbs: openersAtLimit(asm.model),
          credential,
        });
        usages.push(usageFrom(fp));
        if (fp.bullets.length) {
          const before = { shed: asm.shed, score: ats.score };
          const fit = trimFillToFit(draft, fp.bullets, addBackPool, (d) => {
            const a = reassemble(d);
            if (!a.meas.onePage || a.shed > before.shed) return null;
            const at = atsCheckFor(a.model, profile, jobContext, confirmedSkills, tiered);
            return at.score >= before.score ? { asm: a, ats: at } : null;
          });
          if (fit.result) {
            draft = fit.draft; asm = fit.result.asm; ats = fit.result.ats; fillPassBullets = fit.bullets.length;
            const restored = (type) => [...new Set(fit.bullets.filter((b) => b.entry_type === type && !(type === 'role' ? selected.roleIndices : selected.projectIndices).includes(b.entry_index)).map((b) => b.entry_index))];
            addedBack = [...restored('role').map((i) => ({ entry_type: 'role', entry_index: i })), ...restored('project').map((i) => ({ entry_type: 'project', entry_index: i }))];
            selected = {
              roleIndices: [...selected.roleIndices, ...restored('role')],
              projectIndices: [...selected.projectIndices, ...restored('project')],
            };
          }
        }
      }
    }
  }

  // Opening-verb variety (7.15): no verb opens more than
  // humanizer.maxSameOpeningVerb bullets. The draft's one retry asks for this,
  // but the reconciler, repair round and fill pass can each reintroduce a
  // repeat, so the final page is checked here and later repeats get a close
  // synonym (humanizer.OPENER_SWAPS). Kept only if the page still holds and
  // the ATS score does not drop.
  let openerSwaps = [];
  if (humanizer.isEnabled()) {
    const dv = diversifyOpeners(draft, asm);
    if (dv.swaps.length) {
      const a = reassemble(dv.draft);
      if (a.meas.onePage && a.shed <= asm.shed) {
        const at = atsCheckFor(a.model, profile, jobContext, confirmedSkills, tiered);
        if (at.score >= ats.score) { draft = dv.draft; asm = a; ats = at; openerSwaps = dv.swaps; }
      }
    }
  }

  // Post-generation confirmed-skill verification (Phase 3 #20 Stage 2, flag-
  // gated; §7.13's second carried-forward gap). §7.13's routing rule (7.12
  // step 3): a confirmed skill WITH an explanation must be woven into a real
  // bullet, not just listed; one with no explanation only needs to appear
  // anywhere (core content or Skills). This is report-only — mirroring
  // pendingConfirmations, not a repair round — since by this point in the
  // pipeline nothing costs an extra AI call; the relevance-scoping fix
  // (2026-07-27) made the underlying miss far less likely, but never
  // guaranteed it, which is exactly the gap this closes.
  let confirmedSkillCheck = null;
  if (tunables.scoring && tunables.scoring.useUnifiedAtsEngineV2) {
    const coreText = coreKeywordText(asm.model);
    const skillsText = skillsKeywordText(asm.model);
    const woven = [];
    const missingFromCore = [];
    const missing = [];
    for (const c of confirmedContext || []) {
      const term = c && c.term;
      if (!term) continue;
      if (skillPresent(coreText, term)) woven.push(term);
      else if (skillPresent(skillsText, term)) missingFromCore.push(term);
      else missing.push(term);
    }
    for (const term of confirmedNaked || []) {
      if (!term) continue;
      if (skillPresent(coreText, term) || skillPresent(skillsText, term)) woven.push(term);
      else missing.push(term);
    }
    confirmedSkillCheck = { woven, missingFromCore, missing };
  }

  await onProgress('render', 'Rendering document');
  const docxBuffer = await renderResume(asm.model, asm.opts);
  const quant = quantifiedRatio(asm.model);
  const finalCoreRatio = coreRatioOf(ats);
  // User-facing shortfalls only. Individual bullets landing under the strict 0.9
  // (but within the 0.85-1.0 spec band) are NOT flagged — a slightly-short line
  // is spec-compliant, so surfacing it would cry "closest-fit" on good résumés.
  const unresolved = [];
  if (!asm.meas.onePage) unresolved.push('one_page');
  if (ats.score < FLOOR_PCT) unresolved.push(`ats_below_${FLOOR_PCT}`);
  if (quant.ratio < (tunables.generation.quantifiedRatioTarget || 0.5)) unresolved.push('quantified_ratio_below_target');
  const finalCoverage = coverageOk(ats);
  if (!finalCoverage.reqOk) unresolved.push('required_bullet_coverage_below_target');
  if (!finalCoverage.niceOk) unresolved.push('nice_bullet_coverage_below_target');
  if (confirmedSkillCheck && (confirmedSkillCheck.missing.length || confirmedSkillCheck.missingFromCore.length)) unresolved.push('confirmed_skill_missing');

  // Plain "N of M" keyword count, distinct from the weighted ats.score % —
  // required+nice-to-have skills literally matched (core or Skills-only, see
  // atsCheck.js) out of the JD's full skill list. Frontend display (2026-07-27).
  const requiredTotal = (jobContext.jdProfile.required_skills || []).length;
  const niceTotal = (jobContext.jdProfile.nice_to_have_skills || []).length;
  const keywordCoverage = {
    matched: (ats.matched || []).length,
    total: requiredTotal + niceTotal,
    required: { matched: requiredTotal - (ats.missingRequired || []).length, total: requiredTotal },
  };

  return {
    docxBuffer,
    atsScore: ats.score,
    // Additive (Phase 3 #20 Stage 3): the final, post-repair/literal-keyword/
    // fill-pass assembly + draft + bullet targets — nothing existing reads
    // these keys (runCopilotExport calls runFinishPhase with draft:null and
    // ignores this return's draft/roleTargets/projectTargets entirely), but
    // runGenerate.js needs them to seed a completed_generation content_tree
    // that reflects what the user actually downloaded, not the pre-repair
    // draft-phase assembly runCopilotSeed seeds a from-scratch session from.
    asm,
    draft,
    roleTargets,
    projectTargets,
    checksPassed: {
      onePage: asm.meas.onePage,
      wellFilled: asm.meas.fillFraction >= T.pageFillMin,
      fillRatio: asm.outOfBand === 0,
      fillFraction: asm.meas.fillFraction,
      bulletsInBand: `${asm.totalBullets - asm.outOfBand}/${asm.totalBullets}`,
      ats: ats.score >= FLOOR_PCT,
      atsIdeal: ats.score >= IDEAL_PCT,
      atsSectionBreakdown: ats.sectionBreakdown,
      // Fully-missing JD terms (Phase 4 bug fix, 2026-08-05) — atsCheck() already
      // computes these but they were being discarded, leaving the post-generation
      // UI with only an aggregate percentage and no way to say WHICH keywords to
      // add. Frontend: readyLines() in JobDetailView.jsx.
      missingRequired: ats.missingRequired,
      missingNice: ats.missingNice,
      atsCoreRatio: finalCoreRatio,
      bulletCoverage: ats.bulletCoverage,
      quantifiedRatio: quant.ratio,
      quantifiedCounts: { quantified: quant.quantified, total: quant.total },
      bulletTargets: { roles: roleTargets, projects: projectTargets },
      finalBulletCounts: {
        experience: asm.model.experience.map((r) => r.bullets.length),
        projects: asm.model.projects.map((p) => p.bullets.length),
      },
      // Phase 3, shotgun bullet_target soft-repair: every truncate/pad/
      // shortfall the deterministic reconciler performed, across the first
      // draft and (if adopted) the repair draft — observable, not silent.
      bulletTargetRepairs,
      repairRounds,
      literalKeywordsAdded,
      skillsRejected,
      fillPassBullets,
      fillPassBudget,
      // Entries the fill pass restored whole ({ entry_type, entry_index }) and
      // opening verbs swapped to keep any verb to two openers.
      addedBack,
      openerSwaps,
      directorReasoning,
      render: asm.opts,
      unresolved,
      keywordCoverage,
      confirmedSkillCheck,
      // Header links (7.2) that didn't fit the 2-line contact line and were
      // dropped, lowest registry priority first — surfaced only when non-empty,
      // same convention as the other shortfall fields above.
      contactLinksDropped: (asm.model.header && asm.model.header.contactLinksDropped) || [],
    },
    pendingConfirmations: ats.pendingConfirmations,
    usages,
  };
}

/**
 * Generate a tailored résumé. Same signature + return shape the old pipeline had,
 * so runGenerate.js is unchanged. Now a thin composition of runDraftPhase +
 * runFinishPhase (2026-07-27) — byte-identical to the pre-split behavior.
 */
async function generateResume({ profile, contact, jobContext, confirmedNaked = [], confirmedContext = [], credential, onProgress }) {
  const a = await runDraftPhase({ profile, contact, jobContext, confirmedNaked, confirmedContext, credential, onProgress });
  const b = await runFinishPhase({ ...a, profile, contact, jobContext, credential, confirmedNaked, confirmedContext, onProgress });
  return { ...b, usages: [...a.usages, ...b.usages] };
}

module.exports = {
  fitHeader, generateResume, runDraftPhase, runFinishPhase, fitToPage, assemble, buildModelFrom, certificationRow, ensureLiteralKeywords, quantifiedRatio, resolvedPromptVersion, reconcileBulletCounts, diversifyOpeners, openersAtLimit };

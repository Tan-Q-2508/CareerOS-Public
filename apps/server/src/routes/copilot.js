const path = require('path');
const { Router } = require('express');
const { getSupabaseAdmin, geminiAdapter, tunables, sanitizeJdProfile, jdGroundingText, isKnownLinkType, labelForType, MAX_CONTACT_LINKS } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const { loadJobAndResume } = require('../generation/loadJobAndResume');
const { buildGenerationInputs, buildJobContext, resolveConfirmedSkills } = require('../generation/generationInputs');
const { runCopilotSeed, runCopilotExport } = require('../generation/runCopilotSeed');
const { resolvedPromptVersion } = require('../generation/generateResume');
const { assembleFromTree, validateTree, findBullet, layoutSummary, bulletText } = require('../generation/copilotTree');
const { copilotAts } = require('../generation/copilotAts');
const { runBulletRewrite, runBulletKeywordInjection, runNewBullet, validateSingleBulletText } = require('../generation/bulletEdit');
const { buildVault, customBulletNode, vaultEntryNode } = require('../generation/copilotVault');
const { skillPresent } = require('../generation/atsCheck');
const { EMAIL_RE, PHONE_RE, resolveContact } = require('../generation/extractContact');
const crypto = require('crypto');
const { SIZE, SPACE, BULLET_INDENT, BASE_LINE_FACTOR, PT_PER_IN, PAGE_W, PAGE_H, geometry, DEFAULT_RENDER, fitContactLinks } = require('../generation/metrics');
const aiRouter = require('../lib/aiRouter');
const cosGuard = require('../lib/cosGuard');
const { runGenerationJob } = require('../lib/generationQueue');

const router = Router();

// buildContactLine's contract (see its header) is that it formats whatever link
// set it is handed — trimming to the 2-line rule is fitContactLinks's job, and
// the .docx path does both via buildModelFrom. The Canvas's render_header was
// calling buildContactLine on the UNTRIMMED set, so a user with enough links
// would see a live preview listing links the exported .docx and the measured
// layout/ats had already dropped. Both surfaces now derive the line the same way.
function fittedContactLine(contact) {
  return fitContactLinks(contact || {}).contactLine;
}

// Copilot Mode Stage 1 (spec 7.14) — the backend surface for the interactive
// résumé editor. See generation/runCopilotSeed.js for the seed/export
// persistence orchestrators and generation/copilotTree.js for the
// content_tree shape every route below reads and writes.

const JOB_COLS_FOR_GENERATION = 'ats_match, callback_odds, overall_fit, risk_tags';

// The confirm-once gate's own vouched-term set (spec 7.14.6/7.13's mid-session
// equivalent) — extracted so the inject-keyword route's gate and the GET
// route's `injectable_keywords` picker read the exact same union and can
// never drift apart (the picker must never offer a term the gate would then
// 422 on). `confirmedNaked`/`confirmedContext` and `jobContext.tiered` are
// already what loadEditContext resolves per-request. `exact:true` distinguishes
// confirmed_skills terms (matched exactly by the gate below) from tiered
// job-context terms (matched by substring either direction) — same two-tier
// rule the route's original inline check used, just now shared.
function vouchedKeywords(jobContext, confirmedNaked, confirmedContext) {
  const tiered = jobContext.tiered || {};
  const byTerm = new Map(); // lowercase term -> { term, source, exact }
  const push = (term, source, exact) => {
    const t = String(term || '').trim();
    if (!t) return;
    const key = t.toLowerCase();
    const existing = byTerm.get(key);
    if (existing) {
      // A term appearing under BOTH a confirmed (exact) and a tiered
      // (substring) source was already substring-matchable via the tiered
      // side under the ORIGINAL (pre-refactor) two-independent-Sets logic
      // regardless of also being confirmed — so the merged entry stays
      // permissive (exact:false) whenever any source for it is non-exact,
      // rather than silently reverting to exact-only matching.
      if (!exact) existing.exact = false;
      return;
    }
    byTerm.set(key, { term: t, source, exact });
  };
  confirmedNaked.forEach((s) => push(s, 'confirmed', true));
  confirmedContext.forEach((c) => push(c.term, 'confirmed', true));
  (tiered.already_demonstrated || []).forEach((s) => push(s, 'already_demonstrated', false));
  (tiered.transferable || []).forEach((t) => push(t.reword_to || t.have, 'transferable', false));
  (tiered.hidden_strengths || []).forEach((h) => push(h.skill, 'hidden_strengths', false));
  return [...byTerm.values()];
}

// The gate predicate itself: an `exact` (confirmed_skills) term must match
// exactly; a tiered term matches by word-boundary-safe presence either
// direction. CHANGED (B4 bug fix, 2026-08-12): was bare bidirectional
// `.includes()`, which let a short atom spuriously satisfy the confirm-once
// gate (e.g. a vouched term "go" would substring-match a keyword "django" or
// vice versa). Now reuses `skillPresent` (imported above from
// generation/atsCheck.js) — the SAME word-boundary/substring rule
// calculateAtsScore.js's matcher applies (multi-word/special-char terms
// still match as a literal substring; single plain words require a `\b`
// boundary) — rather than inventing a third comparison method.
function isVouchedKeyword(keyword, vouched) {
  const kwLc = keyword.toLowerCase();
  return vouched.some((v) => {
    const vLc = v.term.toLowerCase();
    return v.exact ? vLc === kwLc : skillPresent(vLc, kwLc) || skillPresent(kwLc, vLc);
  });
}

// Case-insensitive dedupe + trim/drop-empty for a client-supplied keyword
// list (inject-keyword's `keywords[]`) — shared normalization so the same
// term typed with different casing doesn't burn two slots of the 5-keyword
// cap or show up twice in the preserve/require sets.
function dedupeKeywords(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const t = String(raw || '').trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// Every JD required/nice-to-have term already present in `text` (case/
// synonym-aware via skillPresent) — the server-computed "must survive this
// edit" set for bullet/rewrite and bullet/inject-keyword, so a client can
// never weaken it by omission.
function jdTermsPresentIn(text, jdProfile) {
  const lc = String(text || '').toLowerCase();
  const jdTerms = [...((jdProfile || {}).required_skills || []), ...((jdProfile || {}).nice_to_have_skills || [])];
  return jdTerms.filter((t) => skillPresent(lc, t));
}

async function loadSession(db, userId, sessionId) {
  const { data, error } = await db.from('resume_edit_sessions').select('*').eq('id', sessionId).eq('user_id', userId).maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  return data;
}

async function loadSessionJobAndResume(db, userId, session) {
  const { data: job, error: jobErr } = await db
    .from('jobs')
    .select(`id, title, company_name, jd_profile, description_text, already_demonstrated, transferable, hidden_strengths, critical_missing, important_missing, nice_to_have_missing, ${JOB_COLS_FOR_GENERATION}`)
    .eq('id', session.job_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (jobErr) throw Object.assign(new Error(jobErr.message), { status: 500 });
  if (job) job.jd_profile = sanitizeJdProfile(job.jd_profile, jdGroundingText(job));
  const { data: resume, error: rErr } = await db
    .from('resume_versions')
    .select('id, storage_path, parsed_profile')
    .eq('id', session.resume_version_id)
    .maybeSingle();
  if (rErr) throw Object.assign(new Error(rErr.message), { status: 500 });
  return { job, resume };
}

// A narrow single-column lookup for the PATCH route (spec 7.14.13), which
// fires every ~3s and has no other reason to touch `jobs` — reusing
// loadSessionJobAndResume there would add a pointless second resume_versions
// read on every debounced write. One indexed (id, user_id) lookup instead of
// snapshotting jd_profile onto the session row, which would go stale the
// moment the job is rescored.
async function loadSessionJdProfile(db, userId, session) {
  const { data, error } = await db.from('jobs').select('title, jd_profile, description_text').eq('id', session.job_id).eq('user_id', userId).maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  return data ? sanitizeJdProfile(data.jd_profile, jdGroundingText(data)) : null;
}

// POST /api/jobs/:id/copilot/sessions — "Open in Copilot" (spec 7.14.2/7.14.3).
// Async 202 + poll, mirroring generate-resume — the Content Director +
// shotgun draft take 20-40s.
router.post('/api/jobs/:id/copilot/sessions', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    if (!geminiAdapter.isConfigured()) return res.status(503).json({ error: 'AI provider not configured' });

    const userId = req.user.id;
    const { job, resume, httpError } = await loadJobAndResume(db, userId, req.params.id, JOB_COLS_FOR_GENERATION);
    if (httpError) return res.status(httpError.status).json({ error: httpError.error });

    // One open session per job (409) — a concurrent second session would
    // double-charge the flat fee and race for the same export storage path.
    const { data: existingRows, error: existErr } = await db
      .from('resume_edit_sessions')
      .select('id, status')
      .eq('user_id', userId)
      .eq('job_id', job.id)
      .in('status', ['seeding', 'editing'])
      .limit(1);
    if (existErr) return next(Object.assign(new Error(existErr.message), { status: 500 }));
    if (existingRows && existingRows.length) {
      const existing = existingRows[0];
      return res.status(409).json({ error: 'A Copilot session is already open for this job.', session_id: existing.id, status: existing.status });
    }

    const cosCheck = await cosGuard.checkCosBalance(db, userId, 'copilot_session');
    if (!cosCheck.ok) return res.status(402).json({ error: cosGuard.paywallMessage(cosCheck.balance, cosCheck.required) });

    const { data: session, error: insErr } = await db
      .from('resume_edit_sessions')
      .insert({ user_id: userId, job_id: job.id, resume_version_id: resume.id, status: 'seeding' })
      .select('id')
      .single();
    if (insErr) return next(Object.assign(new Error(insErr.message), { status: 500 }));

    // Fire and forget — seeding continues in the background after we respond.
    runGenerationJob('runCopilotSeed', () => runCopilotSeed(session.id, userId, job, resume)).catch((e) => console.error('runCopilotSeed dispatch error:', e));

    res.status(202).json({ session_id: session.id, status: 'seeding' });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/copilot/continue — "Continue in Copilot" (spec 7.14.2),
// added Session 21 Stage 1. Re-opens the `completed_generation` row a
// one-click generation already left behind (Session 20c) rather than
// re-running the Content Director + shotgun draft — those AI calls already
// ran and were already billed at generation time, so this path is
// synchronous (no polling, zero AI calls) and priced at the cheaper
// `copilot_continue` flat fee (7.14.7), not `copilot_session`'s 8 COS.
router.post('/api/jobs/:id/copilot/continue', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const userId = req.user.id;
    const { job, resume, httpError } = await loadJobAndResume(db, userId, req.params.id, JOB_COLS_FOR_GENERATION);
    if (httpError) return res.status(httpError.status).json({ error: httpError.error });

    // Same one-open-session rule as "Open in Copilot" — a concurrent second
    // session for this job would race for the same export storage path.
    const { data: openRows, error: openErr } = await db
      .from('resume_edit_sessions')
      .select('id, status')
      .eq('user_id', userId)
      .eq('job_id', job.id)
      .in('status', ['seeding', 'editing'])
      .limit(1);
    if (openErr) return next(Object.assign(new Error(openErr.message), { status: 500 }));
    if (openRows && openRows.length) {
      const existing = openRows[0];
      return res.status(409).json({ error: 'A Copilot session is already open for this job.', session_id: existing.id, status: existing.status });
    }

    const { data: rows, error: selErr } = await db
      .from('resume_edit_sessions')
      .select('id, content_tree')
      .eq('user_id', userId)
      .eq('job_id', job.id)
      .eq('status', 'completed_generation')
      .limit(1);
    if (selErr) return next(Object.assign(new Error(selErr.message), { status: 500 }));
    if (!rows || !rows.length) {
      return res.status(404).json({ error: 'No generated résumé is available to continue for this job. Generate one first.' });
    }
    const row = rows[0];

    // A completed_generation row's own content_tree is its own origin_tree —
    // it hasn't been edited yet, so this only catches a row whose tree
    // predates a shape change, not a real tampering case (that's PATCH's job).
    const validation = validateTree(row.content_tree, { originTree: row.content_tree, strict: false });
    if (!validation.ok) {
      return res.status(422).json({ error: validation.message, code: validation.code });
    }

    const cosCheck = await cosGuard.checkCosBalance(db, userId, 'copilot_continue');
    if (!cosCheck.ok) return res.status(402).json({ error: cosGuard.paywallMessage(cosCheck.balance, cosCheck.required) });

    // Refresh contact info before reopening (2026-08-13 stale-portfolio-link
    // fix) — a completed_generation row's content_tree.contact is a frozen
    // snapshot from whenever it was originally generated, and this route
    // used to reopen it verbatim, never calling resolveContact. That meant
    // a résumé re-uploaded with a new portfolio/LinkedIn/etc. link AFTER
    // the original generation would still show the OLD link here, even
    // though resolveContact()/routes/resume.js's upload-time refresh had
    // already fixed the stored columns — this was the one surface that
    // could still serve a stale link despite the rest of the fix. Both
    // trees get the SAME refreshed contact (a completed_generation row's
    // content_tree and origin_tree are identical, per the validation above).
    const { data: u } = await db.from('users').select('full_name').eq('id', userId).maybeSingle();
    const contact = await resolveContact(db, userId, db, resume.storage_path, u && u.full_name);
    const refreshedTree = { ...row.content_tree, contact };

    const { error: updErr } = await db
      .from('resume_edit_sessions')
      .update({ status: 'editing', content_tree: refreshedTree, origin_tree: refreshedTree })
      .eq('id', row.id)
      .eq('user_id', userId);
    if (updErr) return next(Object.assign(new Error(updErr.message), { status: 500 }));

    // Bill only after the status flip actually succeeded — a failed
    // transition must never charge.
    await cosGuard.debitCos(db, userId, {
      actionType: 'copilot_session',
      flatFee: tunables.flatFees.copilot_continue,
      note: 'Continue in Copilot',
      relatedJobId: job.id,
    });

    res.status(200).json({ session_id: row.id, status: 'editing' });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/copilot/sessions — lets the job detail view render
// "Resume session" vs "Open in Copilot" without guessing a session id. Also
// the poll target for a seeding session (2026-08-04) — progress/error_message
// let the job page render a live console instead of navigating in blind.
router.get('/api/jobs/:id/copilot/sessions', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const userId = req.user.id;
    let q = db
      .from('resume_edit_sessions')
      .select('id, status, updated_at, progress, error_message')
      .eq('user_id', userId)
      .eq('job_id', req.params.id)
      .order('updated_at', { ascending: false });
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error } = await q;
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    res.json({ sessions: data || [] });
  } catch (err) {
    next(err);
  }
});

// GET /api/resume/copilot/sessions/:sessionId — session state + the server's
// authoritative layout verdict for the Canvas preview (spec 7.14.5).
router.get('/api/resume/copilot/sessions/:sessionId', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const userId = req.user.id;
    const session = await loadSession(db, userId, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Copilot session not found' });

    let layout = null;
    let ats = null;
    let matchedKeywords = [];
    let injectableKeywords = [];
    let isStale = false;
    // Tiered missing-skill severity (A5, spec 7.14.12 suggestions) — the same
    // AI-scored arrays already stored on the job row at scan time
    // (scoring/fitCall.js's tiered analysis, 5.3), threaded through so the
    // client can rank a "missing" ATS chip as critical/important/nice rather
    // than a flat undifferentiated red. No new AI call — purely a read of
    // data the scan already produced.
    let criticalMissing = [];
    let importantMissing = [];
    let niceToHaveMissing = [];
    if (session.content_tree) {
      const { job } = await loadSessionJobAndResume(db, userId, session);
      const asm = assembleFromTree({ tree: session.content_tree, contact: session.content_tree.contact });
      layout = layoutSummary(asm);
      if (job) {
        ats = copilotAts({ model: asm.model, jdProfile: job.jd_profile });
        criticalMissing = job.critical_missing || [];
        importantMissing = job.important_missing || [];
        niceToHaveMissing = job.nice_to_have_missing || [];
        // Derived from the SAME ats.terms the chips render, rather than a
        // separate required++nice concat — so the Canvas's highlight set and
        // the Missing Keywords pane's chip set can never quietly drift apart
        // (spec 7.14.12/7.14.13, Session 21b).
        matchedKeywords = ats ? ats.terms.map((t) => t.term) : [...(job.jd_profile || {}).required_skills || [], ...(job.jd_profile || {}).nice_to_have_skills || []];
      }

      // The same set the inject-keyword route's gate checks (see
      // vouchedKeywords above) — so the Workbench's keyword picker can never
      // offer a term the gate would then 422 on. Skipped when there's no job
      // to build context from (shouldn't happen for a real session, but keeps
      // this route resilient rather than throwing).
      if (job) {
        const jobContext = buildJobContext(job);
        const { confirmedNaked, confirmedContext } = await resolveConfirmedSkills(db, userId, job);
        injectableKeywords = vouchedKeywords(jobContext, confirmedNaked, confirmedContext).map((v) => v.term);
      }

      const { data: currentResume } = await db.from('resume_versions').select('id').eq('user_id', userId).eq('is_active', true).maybeSingle();
      isStale = !!(currentResume && currentResume.id !== session.resume_version_id);
    }

    // render_header: the one locked-formatting derivation (7.2's contact line —
    // which fields show, literal "LinkedIn"/"Portfolio" words, "|" separators)
    // the Canvas can't safely re-derive itself; everything else it needs
    // (education rows, skills, bullet text) is already display-ready inside
    // content_tree.
    const renderHeader = session.content_tree
      ? { name: (session.content_tree.contact || {}).name || '', title: session.content_tree.professional_title || '', contact_line: fittedContactLine(session.content_tree.contact) }
      : null;

    res.json({
      session: {
        id: session.id,
        job_id: session.job_id,
        status: session.status,
        content_tree: session.content_tree,
        generated_document_id: session.generated_document_id,
        resume_version_id: session.resume_version_id,
        error_message: session.error_message,
        progress: session.progress || [],
        updated_at: session.updated_at,
      },
      is_stale_resume_version: isStale,
      matched_keywords: matchedKeywords,
      injectable_keywords: injectableKeywords,
      critical_missing: criticalMissing,
      important_missing: importantMissing,
      nice_to_have_missing: niceToHaveMissing,
      layout,
      ats,
      render_header: renderHeader,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/resume/copilot/sessions/:sessionId — the debounced ~3s write
// (reorder/variant-cycle/graveyard). Validated against origin_tree before any
// write (spec 7.14.4) — see copilotTree.validateTree for the full gate list.
router.patch('/api/resume/copilot/sessions/:sessionId', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const userId = req.user.id;
    const session = await loadSession(db, userId, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Copilot session not found' });
    if (session.status !== 'editing') return res.status(409).json({ error: `Session is ${session.status}, not editing.` });

    const tree = req.body && req.body.content_tree;
    const check = validateTree(tree, { originTree: session.origin_tree, strict: false });
    if (!check.ok) return res.status(check.status).json({ error: check.message, code: check.code, entryId: check.entryId, bulletId: check.bulletId });

    const asm = assembleFromTree({ tree, contact: session.content_tree.contact });
    const layout = layoutSummary(asm);
    const jdProfile = await loadSessionJdProfile(db, userId, session);
    const ats = copilotAts({ model: asm.model, jdProfile });

    const { data: updated, error: updErr } = await db
      .from('resume_edit_sessions')
      .update({ content_tree: tree })
      .eq('id', session.id)
      .select('updated_at')
      .single();
    if (updErr) return next(Object.assign(new Error(updErr.message), { status: 500 }));

    res.json({ updated_at: updated.updated_at, layout, ats, warnings: check.warnings || [] });
  } catch (err) {
    next(err);
  }
});

// Shared body for both AI bullet-edit routes: load session+job+resume, locate
// the bullet, resolve credential+jobContext+confirmed skills (no contact —
// these are lighter than a full generation-inputs build, see
// generationInputs.js).
async function loadEditContext(db, userId, sessionId, bulletId) {
  const session = await loadSession(db, userId, sessionId);
  if (!session) return { httpError: { status: 404, error: 'Copilot session not found' } };
  if (session.status !== 'editing') return { httpError: { status: 409, error: `Session is ${session.status}, not editing.` } };

  const found = findBullet(session.content_tree, bulletId);
  if (!found) return { httpError: { status: 404, error: 'Bullet not found in this session.' } };

  const { job, resume } = await loadSessionJobAndResume(db, userId, session);
  const profile = resume.parsed_profile;
  const jobContext = buildJobContext(job);
  const { confirmedNaked, confirmedContext } = await resolveConfirmedSkills(db, userId, job);
  const credential = await aiRouter.resolveAiCredential(db, userId);

  const entry = found.entry
    ? { title: found.entry.header.title, company: found.entry.header.company, dates: found.entry.header.dates }
    : { title: 'Professional Summary', company: '', dates: '' };
  const sourceBullet = { short: found.bullet.variants.short, one_line: found.bullet.variants.one_line, two_line: found.bullet.variants.two_line, source_bullet_id: found.bullet.source_bullet_id };

  return { session, job, resume, profile, jobContext, confirmedNaked, confirmedContext, credential, bullet: found.bullet, entry, sourceBullet };
}

// The one code path for every SERVER-authored tree write — origin_tree is
// the server's own last-approved baseline (spec 7.14.8): it's advanced here,
// on the server, never by a plain client PATCH (copilotTree.validateTree
// rejects anything not already in origin_tree). Applies the SAME mutation to
// both content_tree and origin_tree (they must never diverge in shape), then
// recomputes layout/ats off the new content_tree so the caller's response is
// always fresh. Used by AI edits (applyEditAndBill below) and, this session,
// by the Vault-adopt and custom-bullet-insert routes — one mutation contract
// so insertion and AI edits can't drift on how origin_tree is advanced.
async function applyToBothTrees(db, session, mutate, jdProfile) {
  const newContentTree = mutate(JSON.parse(JSON.stringify(session.content_tree)));
  const newOriginTree = mutate(JSON.parse(JSON.stringify(session.origin_tree)));

  const { error: updErr } = await db.from('resume_edit_sessions').update({ content_tree: newContentTree, origin_tree: newOriginTree }).eq('id', session.id);
  if (updErr) throw Object.assign(new Error(updErr.message), { status: 500 });

  const asm = assembleFromTree({ tree: newContentTree, contact: newContentTree.contact });
  return { newContentTree, newOriginTree, layout: layoutSummary(asm), ats: copilotAts({ model: asm.model, jdProfile }) };
}

const ORIGIN_FOR_ACTION = {
  copilot_bullet_rewrite: 'ai_rewrite',
  copilot_bullet_inject_keyword: 'ai_inject_keyword',
};

// Shared AI-cost logger + biller, extracted (A1/A4 bug fixes, 2026-08-12)
// from what used to be inlined three times (applyEditAndBill below, the
// AI-new-bullet route, and now Vault-adopt's AI rewrite) — one place that
// writes ai_usage_log and debits COS so the three call sites can't drift on
// the shape of either write. `ai_usage_log` is ALWAYS written — tokens were
// genuinely spent even on a no-op edit (16.10 cost tracking needs the real
// number) — but the COS debit is skipped when `noOp` is true (A4). A no-op
// row is marked by suffixing its `action_type` with `_noop` (ai_usage_log.
// action_type has no CHECK constraint, unlike cos_transactions', so this
// needs no migration) rather than inventing a new column.
async function billAiEdit(db, userId, { actionType, usage, credential, relatedJobId, relatedResumeVersionId, note, noOp = false }) {
  const { error: logErr } = await db.from('ai_usage_log').insert({
    user_id: userId,
    action_type: noOp ? `${actionType}_noop` : actionType,
    provider: credential.mode === 'cai' ? 'gemini' : credential.provider,
    connection_mode: usage.connectionMode,
    model: usage.model,
    input_tokens: usage.usage.input_tokens,
    output_tokens: usage.usage.output_tokens,
    cached_tokens: usage.usage.cached_tokens,
    total_tokens: usage.usage.total_tokens,
    raw_usage: usage.usage.raw,
    cost_usd: usage.costUsd,
    related_job_id: relatedJobId,
    related_resume_version_id: relatedResumeVersionId,
  });
  if (logErr) console.error('ai_usage_log insert failed:', logErr.message);

  if (noOp) return; // A4: the AI's own output didn't change anything the user can see — no COS charge.

  const aiCostCos = aiRouter.computeAiFeeCos({ credential, usages: [usage] });
  await cosGuard.debitCos(db, userId, { actionType: 'copilot_session', flatFee: 0, aiCost: aiCostCos, relatedJobId, note });
}

// Server applies a three-variant AI edit result to both content_tree AND
// origin_tree (the client never writes AI text itself). Writes all THREE
// repaired variants into the bullet's own `variants` map (2026-08-04 —
// previously only band-passing ones survived, which is why an edited bullet
// could lose its length chips down to a single static pill; see
// bulletEdit.js's pickVariants) and its `picked` to a real variant key —
// never 'custom' — so the existing VariantCycler chips become the picker for
// the new options with zero new client persistence path. `prev_*` is
// snapshotted so a `/revert` call can restore exactly what was there before
// this edit.
//
// A4 bug fix (2026-08-12): `result.noOp` (bulletEdit.js's deterministic
// pre/post text comparison) skips the COS debit — see billAiEdit above —
// and is echoed back so the route can tell the client "no change suggested"
// instead of silently swapping in text that reads identically.
async function applyEditAndBill(db, userId, ctx, actionType, result, note) {
  const { layout, ats } = await applyToBothTrees(db, ctx.session, (tree) => {
    const found = findBullet(tree, ctx.bullet.bullet_id);
    found.bullet.prev_variants = found.bullet.variants;
    found.bullet.prev_picked = found.bullet.picked;
    found.bullet.prev_custom_text = found.bullet.custom_text;
    found.bullet.variants = result.variants;
    found.bullet.picked = result.picked;
    found.bullet.custom_text = null;
    found.bullet.origin = ORIGIN_FOR_ACTION[actionType] || actionType;
    found.bullet.grounded = result.grounded;
    found.bullet.rejected_variants = result.rejected;
    return tree;
  }, (ctx.job || {}).jd_profile);

  await billAiEdit(db, userId, {
    actionType, usage: result.usage, credential: ctx.credential,
    relatedJobId: ctx.session.job_id, relatedResumeVersionId: ctx.session.resume_version_id,
    note, noOp: !!result.noOp,
  });

  return { layout, ats, noOp: !!result.noOp };
}

// POST /api/resume/copilot/sessions/:sessionId/bullets/:bulletId/revert —
// undo the LAST AI edit on this bullet (Phase 3 bug fix, 2026-08-02). Zero
// AI, zero COS — restores the prev_variants/prev_picked/prev_custom_text
// snapshot applyEditAndBill took right before that edit. Without this, a
// three-variant AI edit is irreversible and strictly MORE destructive than
// the old single-text edit (which at least left the prior `variants` intact
// for the cycler). Only one level of undo — prev_* is overwritten by each
// new edit, not a stack.
router.post('/api/resume/copilot/sessions/:sessionId/bullets/:bulletId/revert', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const userId = req.user.id;
    const session = await loadSession(db, userId, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Copilot session not found' });
    if (session.status !== 'editing') return res.status(409).json({ error: `Session is ${session.status}, not editing.` });

    const found = findBullet(session.content_tree, req.params.bulletId);
    if (!found) return res.status(404).json({ error: 'Bullet not found in this session.' });
    if (!found.bullet.prev_variants && found.bullet.prev_picked === undefined) {
      return res.status(422).json({ error: 'This bullet has no previous edit to revert to.', code: 'nothing_to_revert' });
    }

    const { job } = await loadSessionJobAndResume(db, userId, session);
    const mutate = (tree) => {
      const f = findBullet(tree, req.params.bulletId);
      if (f.bullet.prev_variants) f.bullet.variants = f.bullet.prev_variants;
      f.bullet.picked = f.bullet.prev_picked;
      f.bullet.custom_text = f.bullet.prev_custom_text != null ? f.bullet.prev_custom_text : null;
      f.bullet.prev_variants = null;
      f.bullet.prev_picked = undefined;
      f.bullet.prev_custom_text = undefined;
      return tree;
    };
    const { newContentTree, layout, ats } = await applyToBothTrees(db, session, mutate, (job || {}).jd_profile);
    res.json({ content_tree: newContentTree, bullet_id: req.params.bulletId, layout, ats });
  } catch (err) {
    next(err);
  }
});

// POST /api/resume/copilot/sessions/:sessionId/bullets/:bulletId/rewrite
router.post('/api/resume/copilot/sessions/:sessionId/bullets/:bulletId/rewrite', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    if (!geminiAdapter.isConfigured()) return res.status(503).json({ error: 'AI provider not configured' });
    const userId = req.user.id;
    const instruction = (req.body && req.body.instruction || '').trim();
    if (!instruction) return res.status(400).json({ error: 'instruction is required' });

    const ctx = await loadEditContext(db, userId, req.params.sessionId, req.params.bulletId);
    if (ctx.httpError) return res.status(ctx.httpError.status).json({ error: ctx.httpError.error });

    const cosCheck = await cosGuard.checkCosBalance(db, userId, 'copilot_edit');
    if (!cosCheck.ok) return res.status(402).json({ error: cosGuard.paywallMessage(cosCheck.balance, cosCheck.required) });

    const currentText = bulletText(ctx.bullet);
    const preserveKeywords = jdTermsPresentIn(currentText, ctx.jobContext.jdProfile);
    const result = await runBulletRewrite({
      bulletText: currentText, sourceBullet: ctx.sourceBullet, entry: ctx.entry,
      profile: ctx.profile, jobContext: ctx.jobContext,
      confirmedNaked: ctx.confirmedNaked, confirmedContext: ctx.confirmedContext,
      instruction, preserveKeywords, previousPicked: ctx.bullet.picked, credential: ctx.credential,
    });

    const { layout, ats, noOp } = await applyEditAndBill(db, userId, ctx, 'copilot_bullet_rewrite', result, `Copilot bullet rewrite: "${instruction.slice(0, 80)}"`);
    res.json({
      bullet_id: ctx.bullet.bullet_id, variants: result.variants, picked: result.picked, rejected_variants: result.rejected,
      grounded: result.grounded, layout, ats, no_op: noOp, model_reported_changed: result.modelReportedChanged,
    });
  } catch (err) {
    next(err);
  }
});

const MAX_INJECT_KEYWORDS = 5;

// POST /api/resume/copilot/sessions/:sessionId/bullets/:bulletId/inject-keyword
// CHANGED 2026-08-02 (Phase 3 bug fix): accepts `keywords: string[]` — several
// staged keywords woven in through ONE billed call — instead of a single
// `keyword`. Still accepts the legacy singular `keyword` for backward compat.
// Also accepts terms NOT currently in the profile: the confirm-once gate is
// what keeps that truthful (same 422 contract the custom-bullet route uses),
// never a restriction to only what's already vouched.
router.post('/api/resume/copilot/sessions/:sessionId/bullets/:bulletId/inject-keyword', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    if (!geminiAdapter.isConfigured()) return res.status(503).json({ error: 'AI provider not configured' });
    const userId = req.user.id;
    const raw = (req.body && (req.body.keywords || (req.body.keyword ? [req.body.keyword] : []))) || [];
    const keywords = dedupeKeywords(raw).slice(0, MAX_INJECT_KEYWORDS);
    if (!keywords.length) return res.status(400).json({ error: 'keywords is required (array of at least one term)' });

    const ctx = await loadEditContext(db, userId, req.params.sessionId, req.params.bulletId);
    if (ctx.httpError) return res.status(ctx.httpError.status).json({ error: ctx.httpError.error });

    // Confirm-once gate (spec 7.14.6/7.13): EVERY staged keyword must already
    // be something the candidate is confirmed OR scan-vouched to genuinely
    // have. 7.13's own confirm flow is post-generation and can't run
    // mid-session, so this is the mid-session equivalent — 422 (with the
    // plural `keywords` shape the custom-bullet route already uses) drives
    // the client's existing confirm UI, then the caller retries.
    const vouched = vouchedKeywords(ctx.jobContext, ctx.confirmedNaked, ctx.confirmedContext);
    const unconfirmed = keywords.filter((k) => !isVouchedKeyword(k, vouched));
    if (unconfirmed.length) {
      return res.status(422).json({
        error: `"${unconfirmed[0]}" hasn't been confirmed or shown as a skill you have for this job yet.`,
        code: 'needs_confirmation',
        keyword: unconfirmed[0],
        keywords: unconfirmed,
      });
    }

    const cosCheck = await cosGuard.checkCosBalance(db, userId, 'copilot_edit');
    if (!cosCheck.ok) return res.status(402).json({ error: cosGuard.paywallMessage(cosCheck.balance, cosCheck.required) });

    const currentText = bulletText(ctx.bullet);
    // Preserve set computed server-side from the PRE-EDIT text, never trusted
    // from the client — every JD term already present in the bullet must
    // still be present after the injection.
    const preserveKeywords = jdTermsPresentIn(currentText, ctx.jobContext.jdProfile).filter((t) => !keywords.some((k) => k.toLowerCase() === t.toLowerCase()));
    const result = await runBulletKeywordInjection({
      bulletText: currentText, sourceBullet: ctx.sourceBullet, entry: ctx.entry,
      profile: ctx.profile, jobContext: ctx.jobContext,
      confirmedNaked: ctx.confirmedNaked, confirmedContext: ctx.confirmedContext,
      keywords, preserveKeywords, previousPicked: ctx.bullet.picked, credential: ctx.credential,
    });

    const { layout, ats, noOp } = await applyEditAndBill(db, userId, ctx, 'copilot_bullet_inject_keyword', result, `Copilot keyword injection: ${keywords.join(', ')}`);
    res.json({
      bullet_id: ctx.bullet.bullet_id, variants: result.variants, picked: result.picked, rejected_variants: result.rejected,
      grounded: result.grounded, layout, ats, no_op: noOp, model_reported_changed: result.modelReportedChanged,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/resume/copilot/sessions/:sessionId/vault — Resume Vault drawer
// (spec 7.14.11). Every role/project/bullet the Content Director omitted from
// this session's content_tree, diffed against the master profile — no AI, no
// billing. Kept off the hot GET /sessions/:sessionId read (already 2 job
// reads + resume + confirmed_skills per call).
router.get('/api/resume/copilot/sessions/:sessionId/vault', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const userId = req.user.id;
    const session = await loadSession(db, userId, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Copilot session not found' });
    if (session.status !== 'editing') return res.status(409).json({ error: `Session is ${session.status}, not editing.` });

    const { resume } = await loadSessionJobAndResume(db, userId, session);
    const vault = buildVault({ tree: session.content_tree, profile: resume.parsed_profile });
    res.json(vault);
  } catch (err) {
    next(err);
  }
});

// A1 bug fix (2026-08-12, spec change explicitly approved by the maintainer):
// vault/adopt used to insert the master résumé's VERBATIM text — real
// content, but zero AI, so an imported bullet read noticeably differently
// (tense, phrasing, tailoring) from every AI-authored bullet around it. Now
// every adopted bullet is run through the SAME grounded rewrite
// `bullet/rewrite` uses (bulletEdit.js's runBulletRewrite —
// aiRouter.structuredCall / EDIT_SCHEMA / hardValidate, cheap tier), with a
// fixed instruction that permits tailoring/tone but forbids adding any fact
// beyond what the source bullet already states — grounded ONLY in the real
// vault text, never fabricated. Billed exactly like any other Copilot AI
// edit (billAiEdit, A4-aware no-op skip included).
const VAULT_ADOPT_INSTRUCTION = "This bullet is being restored from the candidate's full résumé history — it's real, already-lived experience the Content Director simply didn't select for this particular draft, not new information. Lightly tailor its phrasing and emphasis toward the target job's language so it reads consistently with the rest of this résumé, but do not invent, embellish, or add any fact, tool, metric, or outcome beyond what the source bullet already states.";

// One master bullet -> one AI-rewritten bullet NODE (billed, grounded). Bills
// immediately (each vault-adopted bullet is its own real AI cost) rather than
// batching — matches the AI-new-bullet route's one-bullet-per-call billing
// shape, and keeps a partial entry-adopt (see kind:'entry' below) honestly
// priced per bullet actually produced.
async function adoptBulletViaAi(db, userId, { entryCtx, sourceText, sourceBulletId, bulletId, order, profile, jobContext, confirmedNaked, confirmedContext, credential, session, note }) {
  const result = await runBulletRewrite({
    bulletText: sourceText,
    sourceBullet: { text: sourceText, source_bullet_id: sourceBulletId },
    entry: entryCtx,
    profile, jobContext, confirmedNaked, confirmedContext,
    instruction: VAULT_ADOPT_INSTRUCTION,
    preserveKeywords: [],
    previousPicked: null,
    credential,
  });
  await billAiEdit(db, userId, {
    actionType: 'copilot_bullet_rewrite', usage: result.usage, credential,
    relatedJobId: session.job_id, relatedResumeVersionId: session.resume_version_id,
    note, noOp: false, // a vault import always introduces genuinely new tree content — never a no-op by definition
  });
  return {
    bullet_id: bulletId,
    source_bullet_id: sourceBulletId,
    variants: result.variants,
    picked: result.picked,
    custom_text: null,
    origin: 'vault_restored',
    grounded: result.grounded,
    rejected_variants: result.rejected,
    order,
  };
}

// POST /api/resume/copilot/sessions/:sessionId/vault/adopt — restore an
// omitted bullet or a whole omitted role/project into the active tree (spec
// 7.14.11). Re-derives the vault server-side rather than trusting the
// client's idea of what's adoptable; every restored bullet's TEXT is
// AI-rewritten (see VAULT_ADOPT_INSTRUCTION above) but its content is
// grounded exclusively in the real master résumé — no fabrication beyond
// what's already true.
router.post('/api/resume/copilot/sessions/:sessionId/vault/adopt', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    if (!geminiAdapter.isConfigured()) return res.status(503).json({ error: 'AI provider not configured' });
    const userId = req.user.id;
    const session = await loadSession(db, userId, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Copilot session not found' });
    if (session.status !== 'editing') return res.status(409).json({ error: `Session is ${session.status}, not editing.` });

    const { job, resume } = await loadSessionJobAndResume(db, userId, session);
    const profile = resume.parsed_profile;
    const vault = buildVault({ tree: session.content_tree, profile });

    const jobContext = buildJobContext(job);
    const { confirmedNaked, confirmedContext } = await resolveConfirmedSkills(db, userId, job);
    const credential = await aiRouter.resolveAiCredential(db, userId);

    // One balance check up front (matches every other single-bullet AI edit
    // route) — a kind:'entry' adopt with several bullets makes several
    // billed calls in sequence below; a balance that runs out mid-entry is
    // an accepted edge case here (the calls already made are real, already-
    // spent cost and stay billed), not a new problem this route introduces.
    const cosCheck = await cosGuard.checkCosBalance(db, userId, 'copilot_edit');
    if (!cosCheck.ok) return res.status(402).json({ error: cosGuard.paywallMessage(cosCheck.balance, cosCheck.required) });

    const kind = req.body && req.body.kind;

    if (kind === 'bullet') {
      const sourceBulletId = req.body && req.body.source_bullet_id;
      const item = vault.bullets.find((b) => b.source_bullet_id === sourceBulletId);
      if (!item) return res.status(422).json({ error: 'That bullet is not currently omitted from this session.', code: 'not_omitted' });
      const targetEntry = (session.content_tree.entries || []).find((e) => e.entry_id === item.target_entry_id);
      if (!targetEntry) return res.status(422).json({ error: 'That bullet is not currently omitted from this session.', code: 'not_omitted' });
      const entryCtx = { title: targetEntry.header.title, company: targetEntry.header.company, dates: targetEntry.header.dates };
      const bulletId = `${item.target_entry_id}-vault-${sourceBulletId}`;

      const bulletNode = await adoptBulletViaAi(db, userId, {
        entryCtx, sourceText: item.text, sourceBulletId, bulletId, order: 0, // order corrected inside mutate below
        profile, jobContext, confirmedNaked, confirmedContext, credential, session,
        note: `Vault adopt: bullet from ${item.entry_title}`,
      });

      // `mutate` runs once per tree (content_tree, then origin_tree —
      // applyToBothTrees), each against an independently deep-cloned copy —
      // but `bulletNode` itself was built ONCE above (the AI call can't run
      // twice without double-billing), so it's deep-cloned per push here to
      // keep the two trees' copies genuinely independent objects, matching
      // every other mutate closure's invariant in this file.
      const mutate = (tree) => {
        const entry = (tree.entries || []).find((e) => e.entry_id === item.target_entry_id);
        if (!entry) return tree; // defensive; unreachable given the vault diff was built off this same tree
        const order = (entry.bullets || []).length;
        entry.bullets = [...(entry.bullets || []), { ...JSON.parse(JSON.stringify(bulletNode)), order }];
        return tree;
      };
      const { newContentTree, layout, ats } = await applyToBothTrees(db, session, mutate, job.jd_profile);
      return res.json({ content_tree: newContentTree, layout, ats });
    }

    if (kind === 'entry') {
      const entryKind = req.body && req.body.entry_kind;
      const sourceIndex = req.body && req.body.source_index;
      const item = vault.entries.find((e) => e.kind === entryKind && e.source_index === sourceIndex);
      if (!item) return res.status(422).json({ error: 'That role/project is not currently omitted from this session.', code: 'not_omitted' });

      const order = (session.content_tree.entries || []).filter((e) => e.kind === entryKind).length;
      // Pure header/ongoing/entry_id derivation (no AI, no DB) — its own
      // `bullets` (built via the raw vaultBulletNode) are discarded and
      // replaced below with AI-rewritten ones.
      const baseEntryNode = vaultEntryNode({ profile, kind: entryKind, sourceIndex, order });
      const entryCtx = { title: baseEntryNode.header.title, company: baseEntryNode.header.company, dates: baseEntryNode.header.dates };

      const sourceRoleOrProj = entryKind === 'experience' ? profile.roles[sourceIndex] : profile.projects[sourceIndex];
      const maxBullets = tunables.generation.bulletsPerEntry.max;
      const sourceBullets = ((sourceRoleOrProj && sourceRoleOrProj.bullets) || []).slice(0, maxBullets);

      const bullets = [];
      for (let bi = 0; bi < sourceBullets.length; bi++) {
        const b = sourceBullets[bi];
        // eslint-disable-next-line no-await-in-loop -- each call must land before the next is billed; not parallelizable against one COS balance check
        const bulletNode = await adoptBulletViaAi(db, userId, {
          entryCtx, sourceText: b.text, sourceBulletId: b.id, bulletId: `${baseEntryNode.entry_id}-b${bi}`, order: bi,
          profile, jobContext, confirmedNaked, confirmedContext, credential, session,
          note: `Vault adopt: entry "${entryCtx.title}"`,
        });
        bullets.push(bulletNode);
      }

      const entryNode = { ...baseEntryNode, bullets, bullet_target: bullets.length };
      // Same independent-copy-per-tree reasoning as the kind:'bullet' branch
      // above — entryNode was built once (its bullets are real AI calls).
      const mutate = (tree) => {
        tree.entries = [...(tree.entries || []), JSON.parse(JSON.stringify(entryNode))];
        return tree;
      };
      const { newContentTree, layout, ats } = await applyToBothTrees(db, session, mutate, job.jd_profile);
      return res.json({ content_tree: newContentTree, layout, ats });
    }

    return res.status(400).json({ error: "kind must be 'bullet' or 'entry'" });
  } catch (err) {
    next(err);
  }
});

// Shared confirm-once gate: which of the JD's required/nice-to-have terms
// does `text` demonstrate that AREN'T yet confirmed or scan-vouched. Used by
// the custom-bullet route, the manual bullet-edit route, and (per-item) the
// Skills editor — one implementation so the 422 contract (and the client's
// confirm-retry handling of it) never drifts between them.
function unvouchedTermsIn(text, jobContext, confirmedNaked, confirmedContext) {
  const vouched = vouchedKeywords(jobContext, confirmedNaked, confirmedContext);
  const jdTerms = [...(jobContext.jdProfile.required_skills || []), ...(jobContext.jdProfile.nice_to_have_skills || [])];
  return jdTerms.filter((term) => skillPresent(String(text || '').toLowerCase(), term) && !isVouchedKeyword(term, vouched));
}

// POST /api/resume/copilot/sessions/:sessionId/bullets — Custom Bullet
// Injector (spec 7.14.14): a free-text bullet the user writes directly, on
// any active (non-graveyarded) role/project entry. Zero AI, zero COS — this
// is real user-authored content, exempt from the AI-grounding check but still
// subject to the same mechanical checks (fill-band) every bullet gets, and to
// the same confirm-once gate as bullet/inject-keyword for any JD term it
// introduces that isn't yet confirmed or scan-vouched.
//
// CHANGED 2026-08-02 (Phase 3 bug fix — "no option to write a completely new
// AI bullet"): `{ mode: 'ai', instruction }` runs an AI-authored new bullet
// instead (billed, grounded, three variants) — the "write it for me"
// counterpart to the default user-typed path below, which is unchanged.
router.post('/api/resume/copilot/sessions/:sessionId/bullets', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const userId = req.user.id;
    const entryId = req.body && req.body.entry_id;
    if (!entryId) return res.status(400).json({ error: 'entry_id is required' });

    const session = await loadSession(db, userId, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Copilot session not found' });
    if (session.status !== 'editing') return res.status(409).json({ error: `Session is ${session.status}, not editing.` });

    const entry = (session.content_tree.entries || []).find((e) => e.entry_id === entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found in this session.' });
    if (entry.graveyard) return res.status(422).json({ error: 'Cannot add a bullet to a graveyarded entry.', code: 'entry_graveyarded' });

    const mode = (req.body && req.body.mode) || 'manual';

    if (mode === 'ai') {
      if (!geminiAdapter.isConfigured()) return res.status(503).json({ error: 'AI provider not configured' });
      const instruction = (req.body && req.body.instruction || '').trim();
      if (!instruction) return res.status(400).json({ error: 'instruction is required' });

      const { job, resume } = await loadSessionJobAndResume(db, userId, session);
      const jobContext = buildJobContext(job);
      const { confirmedNaked, confirmedContext } = await resolveConfirmedSkills(db, userId, job);
      const credential = await aiRouter.resolveAiCredential(db, userId);

      const cosCheck = await cosGuard.checkCosBalance(db, userId, 'copilot_edit');
      if (!cosCheck.ok) return res.status(402).json({ error: cosGuard.paywallMessage(cosCheck.balance, cosCheck.required) });

      const entrySourceBullets = entry.source_index != null
        ? ((entry.kind === 'experience' ? resume.parsed_profile.roles : resume.parsed_profile.projects) || [])[entry.source_index]
        : null;
      const result = await runNewBullet({
        entry: { title: entry.header.title, company: entry.header.company, dates: entry.header.dates },
        entryBullets: (entry.bullets || []).map(bulletText),
        sourceBullets: entrySourceBullets ? (entrySourceBullets.bullets || []) : [],
        profile: resume.parsed_profile, jobContext,
        confirmedNaked, confirmedContext, instruction, credential,
      });
      if (!result.picked) {
        return res.status(422).json({ error: "Couldn't produce a bullet that fits within two lines — try a shorter instruction.", code: 'bullet_too_long' });
      }

      const bulletId = `${entryId}-ai-${crypto.randomUUID()}`;
      const mutate = (tree) => {
        const e = (tree.entries || []).find((x) => x.entry_id === entryId);
        const order = (e.bullets || []).length;
        e.bullets = [...(e.bullets || []), {
          bullet_id: bulletId,
          source_bullet_id: result.sourceBulletId || null,
          variants: result.variants,
          picked: result.picked,
          custom_text: null,
          origin: 'ai_new_bullet',
          grounded: result.grounded,
          rejected_variants: result.rejected,
          order,
        }];
        return tree;
      };

      const { newContentTree, layout, ats } = await applyToBothTrees(db, session, mutate, job.jd_profile);
      await billAiEdit(db, userId, {
        actionType: 'copilot_bullet_new', usage: result.usage, credential,
        relatedJobId: session.job_id, relatedResumeVersionId: session.resume_version_id,
        note: `Copilot AI new bullet: "${instruction.slice(0, 80)}"`,
      });

      return res.json({ content_tree: newContentTree, bullet_id: bulletId, variants: result.variants, picked: result.picked, rejected_variants: result.rejected, grounded: result.grounded, layout, ats });
    }

    // Default path: user-typed, zero AI, zero COS (unchanged).
    const text = (req.body && req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });

    // Mechanical checks (spec 7.14.14) — same validator bullet/rewrite and
    // bullet/inject-keyword already use, so a custom bullet is held to the
    // exact same fill-band/length bar as an AI-drafted one.
    const mechanicalError = validateSingleBulletText(text);
    if (mechanicalError) return res.status(422).json({ error: mechanicalError, code: 'bullet_too_long' });

    // Confirm-once gate (spec 7.14.14/7.13/7.14.6's mid-session equivalent):
    // any JD term this sentence demonstrates must already be confirmed or
    // scan-vouched before it counts toward the Missing Keywords pane or the
    // live score — reuses bullet/inject-keyword's exact gate contract so the
    // client's existing needs_confirmation handling applies unchanged.
    const { job } = await loadSessionJobAndResume(db, userId, session);
    const jobContext = buildJobContext(job);
    const { confirmedNaked, confirmedContext } = await resolveConfirmedSkills(db, userId, job);
    const unconfirmed = unvouchedTermsIn(text, jobContext, confirmedNaked, confirmedContext);
    if (unconfirmed.length) {
      return res.status(422).json({
        error: `"${unconfirmed[0]}" hasn't been confirmed or shown as a skill you have for this job yet.`,
        code: 'needs_confirmation',
        keyword: unconfirmed[0],
        keywords: unconfirmed,
      });
    }

    const bulletId = `${entryId}-custom-${crypto.randomUUID()}`;
    const mutate = (tree) => {
      const e = (tree.entries || []).find((x) => x.entry_id === entryId);
      const order = (e.bullets || []).length;
      e.bullets = [...(e.bullets || []), customBulletNode({ bulletId, text, order })];
      return tree;
    };
    const { newContentTree, layout, ats } = await applyToBothTrees(db, session, mutate, job.jd_profile);
    res.json({ content_tree: newContentTree, bullet_id: bulletId, layout, ats });
  } catch (err) {
    next(err);
  }
});

// PUT /api/resume/copilot/sessions/:sessionId/bullets/:bulletId/text — Manual
// bullet edit (Phase 3 bug fix, 2026-08-02): the user types the replacement
// text directly, for an EXISTING bullet. Zero AI, zero COS — same framing as
// the custom-bullet route's user-typed path, same mechanical + confirm-once
// gates. `variants` is deliberately left UNTOUCHED so the VariantCycler can
// still bounce back to the AI/shotgun text — the manual edit becomes a
// fourth ring position (picked:'custom'), not a replacement of the others.
router.put('/api/resume/copilot/sessions/:sessionId/bullets/:bulletId/text', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const userId = req.user.id;
    const text = (req.body && req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });

    const session = await loadSession(db, userId, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Copilot session not found' });
    if (session.status !== 'editing') return res.status(409).json({ error: `Session is ${session.status}, not editing.` });

    const found = findBullet(session.content_tree, req.params.bulletId);
    if (!found) return res.status(404).json({ error: 'Bullet not found in this session.' });

    const mechanicalError = validateSingleBulletText(text);
    if (mechanicalError) return res.status(422).json({ error: mechanicalError, code: 'bullet_too_long' });

    const { job } = await loadSessionJobAndResume(db, userId, session);
    const jobContext = buildJobContext(job);
    const { confirmedNaked, confirmedContext } = await resolveConfirmedSkills(db, userId, job);
    const unconfirmed = unvouchedTermsIn(text, jobContext, confirmedNaked, confirmedContext);
    if (unconfirmed.length) {
      return res.status(422).json({
        error: `"${unconfirmed[0]}" hasn't been confirmed or shown as a skill you have for this job yet.`,
        code: 'needs_confirmation',
        keyword: unconfirmed[0],
        keywords: unconfirmed,
      });
    }

    const mutate = (tree) => {
      const f = findBullet(tree, req.params.bulletId);
      f.bullet.prev_picked = f.bullet.picked;
      f.bullet.prev_custom_text = f.bullet.custom_text;
      f.bullet.picked = 'custom';
      f.bullet.custom_text = text;
      f.bullet.origin = 'user_edit';
      f.bullet.grounded = true; // user-authored: grounding is the user's own claim
      return tree;
    };
    const { newContentTree, layout, ats } = await applyToBothTrees(db, session, mutate, job.jd_profile);
    res.json({ content_tree: newContentTree, bullet_id: req.params.bulletId, layout, ats });
  } catch (err) {
    next(err);
  }
});

// POST /api/resume/copilot/sessions/:sessionId/export — Finalize & Export
// (spec 7.14.3 step 4). Gates run synchronously BEFORE anything is inserted;
// only then does the async render+store dispatch (mirrors generate-resume).
router.post('/api/resume/copilot/sessions/:sessionId/export', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const userId = req.user.id;
    const session = await loadSession(db, userId, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Copilot session not found' });
    if (session.status !== 'editing') return res.status(409).json({ error: `Session is ${session.status}, not editing.` });

    const tree = session.content_tree;
    const check = validateTree(tree, { originTree: session.origin_tree, strict: true });
    if (!check.ok) return res.status(check.status).json({ error: check.message, code: check.code, entryId: check.entryId, bulletId: check.bulletId });

    const asm = assembleFromTree({ tree, contact: tree.contact });
    // Computed once and reused by both rejection branches below — layoutSummary
    // already correlates each measured bullet back to its bullet_id via
    // assembleFromTree's bulletOrder, so bullet_too_long can name the actual
    // offending bullet instead of metrics' internal `path`.
    const layout = layoutSummary(asm);
    if (!asm.meas.onePage) {
      const overflowPt = Number((asm.meas.contentHeightPt - asm.meas.usableHeightPt).toFixed(2));
      let offenders = layout.bullets.filter((b) => b.endPt > asm.meas.usableHeightPt);
      // Confirmed live (2026-07-27): a real overflow can come entirely from the
      // Education/Skills sections' fixed trailing cost — those aren't bullets,
      // so no bullet's own endPt ever crosses usableHeightPt even though the
      // page genuinely doesn't fit. Skills/Education aren't editable in Stage 1
      // (spec 7.14.3's edit verbs are reorder/variant-cycle/graveyard/AI-edit
      // on bullets only), so there's no more specific target to name — fall
      // back to the last bullet in the flow as the most actionable "trim
      // something near the end" signal rather than returning an empty,
      // unhelpful offenders list for a real, reported overflow.
      if (!offenders.length && layout.bullets.length) offenders = [layout.bullets[layout.bullets.length - 1]];
      return res.status(422).json({
        error: `This résumé is over one page by about ${overflowPt}pt. Shorten or remove the flagged bullets to export.`,
        code: 'page_overflow',
        overflowPt,
        offenders,
      });
    }
    const tooLong = layout.bullets.find((b) => b.lineCount > 2);
    if (tooLong) {
      return res.status(422).json({ error: `A bullet is too long (${tooLong.lineCount} lines) to export.`, code: 'bullet_too_long', bulletId: tooLong.bullet_id, path: tooLong.path });
    }

    const { job, resume } = await loadSessionJobAndResume(db, userId, session);

    const { data: doc, error: insErr } = await db
      .from('generated_documents')
      .insert({
        user_id: userId,
        job_id: session.job_id,
        doc_type: 'resume',
        resume_version_id: session.resume_version_id,
        prompt_version: resolvedPromptVersion(),
        status: 'queued',
      })
      .select('id')
      .single();
    if (insErr) return next(Object.assign(new Error(insErr.message), { status: 500 }));

    runGenerationJob('runCopilotExport', () => runCopilotExport(doc.id, session.id, userId, job, resume, tree)).catch((e) => console.error('runCopilotExport dispatch error:', e));

    res.status(202).json({ document_id: doc.id, status: 'queued' });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/resume/copilot/sessions/:sessionId/header — editable
// name/title/contact (Phase 3 bug fix, 2026-08-02: "Copilot for skill
// section... keep a Portfolio, website and LinkedIn space, if it doesn't get
// parsed or person wants to change they must be able to"). Deliberately its
// OWN route, not the debounced PATCH /sessions/:id — that route's 422 branch
// (CopilotContext.jsx's runSave) force-adopts the server tree wholesale on
// any rejection, which would wipe a half-typed field; this one fails
// in-place instead. Zero AI, zero COS (same framing as the manual bullet
// edit / custom-bullet routes — this is the user's own factual claim, not a
// generated one).
// Scalar header fields. Links (7.2) are a separate `links` array field,
// validated element-by-element below — not a fixed set of *_url columns.
const HEADER_FIELDS = ['name', 'professional_title', 'city_state', 'phone', 'email'];
const HEADER_MAX_LEN = { name: 80, professional_title: 100, city_state: 60, phone: 30, email: 100 };
const LINK_URL_MAX_LEN = 300;

function stripControlChars(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}

function validUrl(val) {
  const withProto = /^https?:\/\//i.test(val) ? val : `https://${val}`;
  try {
    const u = new URL(withProto);
    return /^https?:$/.test(u.protocol);
  } catch {
    return false;
  }
}

function validateHeaderPatch(body) {
  // Strict allowlist — reject any unknown key with 400 so this route can
  // never become a general tree/profile write channel.
  const allowed = new Set([...HEADER_FIELDS, 'links']);
  const unknown = Object.keys(body || {}).filter((k) => !allowed.has(k));
  if (unknown.length) return { error: `Unknown field(s): ${unknown.join(', ')}` };

  const clean = {};
  for (const field of HEADER_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === null || raw === '') { clean[field] = null; continue; }
    if (typeof raw !== 'string') return { error: `${field} must be a string` };
    const val = stripControlChars(raw);
    if (val.length > HEADER_MAX_LEN[field]) return { error: `${field} is too long (max ${HEADER_MAX_LEN[field]} chars)` };
    if (field === 'email' && !EMAIL_RE.test(val)) return { error: 'email is not a valid email address' };
    if (field === 'phone' && !PHONE_RE.test(val)) return { error: 'phone is not a valid phone number' };
    clean[field] = val;
  }

  if ('links' in body) {
    const raw = body.links;
    if (!Array.isArray(raw)) return { error: 'links must be an array' };
    if (raw.length > MAX_CONTACT_LINKS) return { error: `too many links (max ${MAX_CONTACT_LINKS})` };
    const links = [];
    const seen = new Set();
    for (const item of raw) {
      if (!item || typeof item !== 'object') return { error: 'each link must be an object' };
      const type = String(item.type || '').trim();
      if (!isKnownLinkType(type)) return { error: `unknown link type: ${type || '(empty)'}` };
      const url = stripControlChars(item.url || '');
      if (!url) continue; // an empty row in the editor — silently dropped
      if (url.length > LINK_URL_MAX_LEN) return { error: `a link URL is too long (max ${LINK_URL_MAX_LEN} chars)` };
      if (!validUrl(url)) return { error: `not a valid URL: ${url}` };
      const key = url.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (seen.has(key)) continue; // de-dupe
      seen.add(key);
      // `label` is only meaningful for `other`; recognised types get theirs
      // from the registry so a client can't relabel "GitHub" as "LinkedIn".
      const label = type === 'other' ? stripControlChars(item.label || '').slice(0, 40) || 'Link' : labelForType(type);
      links.push({ type, url, label });
    }
    clean.links = links;
  }

  return { clean };
}

router.patch('/api/resume/copilot/sessions/:sessionId/header', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const userId = req.user.id;
    const session = await loadSession(db, userId, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Copilot session not found' });
    if (session.status !== 'editing') return res.status(409).json({ error: `Session is ${session.status}, not editing.` });

    const { clean, error } = validateHeaderPatch(req.body || {});
    if (error) return res.status(400).json({ error });

    // Per-field provenance (2026-08-13 root-cause pass, migration
    // 20260813000000_contact_manual_fields) — replaces the single
    // contact_manual boolean, which locked the ENTIRE contact record on any
    // one field edit (a LinkedIn edit here used to also freeze the
    // portfolio/website/phone/etc. against ever being refreshed by a later
    // résumé upload, even though the user never touched those fields). Only
    // the field(s) actually present in THIS patch get added to
    // contact_manual_fields; every other field stays free to re-sync from
    // extractContact() on the next upload or resolveContact() call.
    // The link set is one provenance unit under the single `links` token
    // (migration 20260826000000) — hand-editing it in the editor locks the
    // whole array against a later résumé upload's re-extraction, the same way
    // editing a scalar locks that scalar.
    const editedFields = Object.keys(clean);
    const { data: existingUser } = await db.from('users').select('contact_manual_fields').eq('id', userId).maybeSingle();
    const mergedManualFields = Array.from(new Set([...((existingUser && existingUser.contact_manual_fields) || []), ...editedFields]));

    const columnPatch = { contact_manual_fields: mergedManualFields };
    if ('name' in clean) columnPatch.contact_name = clean.name;
    if ('city_state' in clean) columnPatch.contact_city_state = clean.city_state;
    if ('phone' in clean) columnPatch.contact_phone = clean.phone;
    if ('email' in clean) columnPatch.contact_email = clean.email;
    if ('links' in clean) columnPatch.contact_links = clean.links;
    const { error: updErr } = await db.from('users').update(columnPatch).eq('id', userId);
    if (updErr) return next(Object.assign(new Error(updErr.message), { status: 500 }));

    const { job } = await loadSessionJobAndResume(db, userId, session);
    const mutate = (tree) => {
      tree.contact = {
        ...tree.contact,
        name: 'name' in clean ? clean.name : tree.contact.name,
        cityState: 'city_state' in clean ? clean.city_state : tree.contact.cityState,
        phone: 'phone' in clean ? clean.phone : tree.contact.phone,
        email: 'email' in clean ? clean.email : tree.contact.email,
        links: 'links' in clean ? clean.links : (tree.contact.links || []),
      };
      if ('professional_title' in clean) tree.professional_title = clean.professional_title;
      return tree;
    };
    const { newContentTree, layout, ats } = await applyToBothTrees(db, session, mutate, (job || {}).jd_profile);
    const renderHeader = { name: (newContentTree.contact || {}).name || '', title: newContentTree.professional_title || '', contact_line: fittedContactLine(newContentTree.contact) };
    res.json({ content_tree: newContentTree, render_header: renderHeader, layout, ats });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/resume/copilot/sessions/:sessionId/skills — editable Skills &
// Certifications (Phase 3 bug fix, 2026-08-02: "I can add and edit bullets
// but not Skills and Certification section"). `rows` is the same
// `[{label, items[]}]` shape already in the tree (copilotTree.js's
// contentTreeFromAssembly) — labels constrained to the four the assembler/
// docx renderer assume exist, per-item trimmed/deduped/capped so a pasted JD
// can't silently overflow the page. A newly-added item counts toward the
// live ATS score (a Skills entry is a `skills_only` tier match, see
// copilotAts.js), so it gets the SAME confirm-once gate a custom bullet
// does — reusing unvouchedTermsIn.
const SKILLS_ALLOWED_LABELS = ['Technical', 'Management', 'Business', 'Certifications'];
const SKILLS_MAX_ITEMS_PER_ROW = 40;
const SKILLS_MAX_ITEM_LEN = 60;

router.patch('/api/resume/copilot/sessions/:sessionId/skills', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const userId = req.user.id;
    const session = await loadSession(db, userId, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Copilot session not found' });
    if (session.status !== 'editing') return res.status(409).json({ error: `Session is ${session.status}, not editing.` });

    const rows = req.body && req.body.rows;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });

    const cleanRows = [];
    const seenLabels = new Set();
    for (const row of rows) {
      if (!row || !SKILLS_ALLOWED_LABELS.includes(row.label)) {
        return res.status(400).json({ error: `label must be one of ${SKILLS_ALLOWED_LABELS.join(', ')}` });
      }
      if (seenLabels.has(row.label)) return res.status(400).json({ error: `Duplicate label ${row.label}` });
      seenLabels.add(row.label);
      const items = Array.isArray(row.items) ? row.items : [];
      const seenItems = new Set();
      const cleanItems = [];
      for (const raw of items) {
        const v = stripControlChars(String(raw || ''));
        if (!v) continue;
        const key = v.toLowerCase();
        if (seenItems.has(key)) continue;
        if (v.length > SKILLS_MAX_ITEM_LEN) return res.status(400).json({ error: `"${v.slice(0, 30)}…" is too long (max ${SKILLS_MAX_ITEM_LEN} chars)` });
        seenItems.add(key);
        cleanItems.push(v);
      }
      if (cleanItems.length > SKILLS_MAX_ITEMS_PER_ROW) {
        return res.status(400).json({ error: `${row.label} has too many items (max ${SKILLS_MAX_ITEMS_PER_ROW})` });
      }
      cleanRows.push({ label: row.label, items: cleanItems });
    }

    const { job } = await loadSessionJobAndResume(db, userId, session);
    const jobContext = buildJobContext(job);
    const { confirmedNaked, confirmedContext } = await resolveConfirmedSkills(db, userId, job);

    // Confirm-once gate on NEWLY ADDED items only — an item that survived
    // from the current tree unchanged was already either AI-drafted (already
    // vouched at draft time) or previously confirmed here, so re-gating it
    // every save would be a regression, not a safeguard.
    const currentItems = new Set();
    for (const row of session.content_tree.skills || []) for (const item of row.items || []) currentItems.add(String(item).toLowerCase());
    const addedItems = cleanRows.flatMap((r) => r.items).filter((item) => !currentItems.has(item.toLowerCase()));
    const unconfirmed = [];
    for (const item of addedItems) {
      unconfirmed.push(...unvouchedTermsIn(item, jobContext, confirmedNaked, confirmedContext));
      // An added item that isn't itself a JD term (e.g. a tool the JD never
      // mentioned) has nothing to confirm — unvouchedTermsIn only flags JD
      // required/nice-to-have terms, which is exactly the set that moves the
      // score, matching the custom-bullet route's same scoping.
    }
    const uniqueUnconfirmed = [...new Set(unconfirmed)];
    if (uniqueUnconfirmed.length) {
      return res.status(422).json({
        error: `"${uniqueUnconfirmed[0]}" hasn't been confirmed or shown as a skill you have for this job yet.`,
        code: 'needs_confirmation',
        keyword: uniqueUnconfirmed[0],
        keywords: uniqueUnconfirmed,
      });
    }

    const mutate = (tree) => { tree.skills = cleanRows; return tree; };
    const { newContentTree, layout, ats } = await applyToBothTrees(db, session, mutate, (job || {}).jd_profile);
    res.json({ content_tree: newContentTree, layout, ats });
  } catch (err) {
    next(err);
  }
});

// GET /api/resume/layout-config (spec 7.14.5) — the shared measurement
// constants a Stage-3 client needs to replicate the server's layout math.
// Every value is read live from metrics.js/tunables, never a literal typed
// into this route, so a future tuning change can't silently drift from what
// this endpoint reports.
router.get('/api/resume/layout-config', requireAuth, async (req, res) => {
  const geom = geometry(DEFAULT_RENDER.marginIn);
  res.json({
    version: tunables.generation.promptVersion,
    page: { ptPerIn: PT_PER_IN, widthPt: PAGE_W, heightPt: PAGE_H },
    render: DEFAULT_RENDER,
    pageFit: tunables.generation.pageFit,
    baseLineFactor: BASE_LINE_FACTOR,
    sizes: SIZE,
    spacing: SPACE,
    bulletIndentPt: BULLET_INDENT,
    geometry: geom,
    thresholds: tunables.bulletFill.strict,
    twoLineSafetyCeiling: tunables.generation.twoLineSafetyCeiling,
    bulletsPerEntry: tunables.generation.bulletsPerEntry,
    font: { family: 'Carlito', proxyFor: 'Calibri', regularUrl: '/api/resume/fonts/regular', boldUrl: '/api/resume/fonts/bold' },
  });
});

// GET /api/resume/fonts/:variant — serves the EXACT .woff files metrics.js
// reads via fontkit (never a copy in apps/web/public/), so the Canvas's
// browser-native line-wrap measurement can never drift from a different
// Carlito than the one the server measures with. Unauthenticated: a CSS
// url() request can't carry a Bearer token, and a font file isn't secret.
// `variant` is matched against a fixed allowlist, never interpolated into a
// filesystem path, so there's no traversal surface.
const FONT_FILES = {
  regular: path.join(__dirname, '..', 'generation', 'fonts', 'Carlito-Regular.woff'),
  bold: path.join(__dirname, '..', 'generation', 'fonts', 'Carlito-Bold.woff'),
};
router.get('/api/resume/fonts/:variant', (req, res) => {
  const file = FONT_FILES[req.params.variant];
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('font/woff');
  res.sendFile(file);
});

// Exposed on the router (a plain function — this doesn't change what
// `router.use(copilotRoutes)` sees) purely so the test suite and an offline
// scratch script can exercise the REAL confirm-once gate rather than a
// hand-copied re-implementation of it. unvouchedTermsIn joins them here
// because it is the predicate all three 422 call sites share, and it had
// never been exercised against anything — the Phase 3 bug-fix handoff
// recorded that gap and nothing closed it.
router.vouchedKeywords = vouchedKeywords;
router.isVouchedKeyword = isVouchedKeyword;
router.unvouchedTermsIn = unvouchedTermsIn;

module.exports = router;

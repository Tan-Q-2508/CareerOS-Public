const { getSupabaseAdmin, tunables } = require('@careeros/shared');
const { buildGenerationInputs } = require('./generationInputs');
const { runDraftPhase, runFinishPhase, assemble, ensureLiteralKeywords, resolvedPromptVersion } = require('./generateResume');
const { contentTreeFromAssembly, assembleFromTree } = require('./copilotTree');
const { atsCheck } = require('./atsCheck');
const cosGuard = require('../lib/cosGuard');
const aiRouter = require('../lib/aiRouter');
const { makeProgressLogger } = require('../lib/progress');

const RESUME_BUCKET = 'resumes';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Persistence layer for Copilot Mode's two lifecycle transitions (spec
// 7.14.3) — structural twin of runGenerate.js, reusing the exact same
// generationInputs.buildGenerationInputs() one-click generation uses.

// "Open in Copilot": runDraftPhase (steps 1-6) -> literal-keyword safety net
// applied HERE, at seed time (see generateResume.js's ensureLiteralKeywords
// header comment — applying it at export would rebuild the résumé from the
// raw draft via assemble(), discarding the user's curated content_tree) ->
// seed content_tree/origin_tree -> bill the flat session fee + the real
// Director/shotgun AI cost.
async function runCopilotSeed(sessionId, userId, job, resume) {
  const db = getSupabaseAdmin();
  const mark = (fields) => db.from('resume_edit_sessions').update(fields).eq('id', sessionId);
  // 2026-08-04: Copilot's seed used to be the one long pipeline with no
  // progress column, leaving the frontend a hardcoded "~20-40s" line for
  // what's routinely several minutes — see progress.js's own header comment
  // for the shared contract. runDraftPhase already emits real milestones
  // (director/draft/assemble/ats_check); this just stops throwing them away.
  const logProgress = makeProgressLogger(db, 'resume_edit_sessions', sessionId);

  let usages = [];
  let credential = null;
  let billed = false;

  const logUsageAndBill = async (note) => {
    for (const u of usages) {
      const { error: logErr } = await db.from('ai_usage_log').insert({
        user_id: userId,
        action_type: u.actionType,
        provider: credential.mode === 'cai' ? 'gemini' : credential.provider,
        connection_mode: u.connectionMode,
        model: u.model,
        input_tokens: u.usage.input_tokens,
        output_tokens: u.usage.output_tokens,
        cached_tokens: u.usage.cached_tokens,
        total_tokens: u.usage.total_tokens,
        raw_usage: u.usage.raw,
        cost_usd: u.costUsd,
        related_job_id: job.id,
        related_resume_version_id: resume.id,
      });
      if (logErr) console.error('ai_usage_log insert failed:', logErr.message);
    }
    const aiCostCos = aiRouter.computeAiFeeCos({ credential, usages });
    await cosGuard.debitCos(db, userId, {
      actionType: 'copilot_session',
      flatFee: tunables.flatFees.copilot_session,
      aiCost: aiCostCos,
      relatedJobId: job.id,
      note,
    });
    billed = true;
  };

  try {
    await logProgress('start', 'Preparing your Copilot session');
    const inputs = await buildGenerationInputs(db, userId, job, resume);
    credential = inputs.credential;
    const { contact, jobContext, confirmedNaked, confirmedContext } = inputs;
    const profile = resume.parsed_profile;

    // Pass `usages` itself as the sink (usagesOut) — a throw INSIDE
    // runDraftPhase (e.g. the shotgun draft's validator exhausting its
    // retries) still leaves the Director's/any completed shotgun attempt's
    // real cost in `usages`, so the catch below's billing-on-failure block
    // (see its own comment) actually has something to bill instead of
    // silently eating cost already incurred.
    const a = await runDraftPhase({ profile, contact, jobContext, confirmedNaked, confirmedContext, credential, usagesOut: usages, onProgress: logProgress });

    let draft = a.draft;
    let asm = a.asm;
    const literal = ensureLiteralKeywords({
      draft, ats: a.ats, jobContext,
      reassemble: (d) => assemble({ draft: d, profile, contact }),
    });
    if (literal.added.length) {
      draft = literal.draft;
      asm = literal.asm;
    }

    const tree = contentTreeFromAssembly({
      asm, draft, contact, profile,
      roleTargets: a.roleTargets, projectTargets: a.projectTargets,
      promptVersion: resolvedPromptVersion(),
    });

    await mark({ status: 'editing', content_tree: tree, origin_tree: tree });
    await logProgress('ready', 'Copilot session ready');

    const aiNote = credential.mode === 'cai'
      ? `real AI cost $${usages.reduce((s, u) => s + (u.costUsd || 0), 0).toFixed(6)}`
      : `BYOK (${credential.provider}) AI fee`;
    await logUsageAndBill(`Copilot session start: Content Director + shotgun draft, ${aiNote}`);
  } catch (err) {
    console.error('runCopilotSeed failed:', err);
    await mark({ status: 'failed', error_message: String(err.message || err).slice(0, 500) });
    // No-refund is about ABANDONMENT (7.14.3) — a failure before any AI call
    // completed owes nothing; a failure AFTER the Director/shotgun ran still
    // owes the real cost already incurred.
    if (usages.length && credential && !billed) {
      try {
        await logUsageAndBill('Copilot session start (failed before the session finished seeding) — Director/shotgun draft cost already incurred');
      } catch (billErr) {
        console.error('runCopilotSeed: billing-on-failure also failed:', billErr);
      }
    }
  }
}

// Export (spec 7.14.3 step 4): re-enters the pipeline at step 7's location,
// but with allowRedraft:false + applyLiteralKeywords:false — see the Stage 1
// plan's decision on why: the real step-7 repair pass is a full re-draft that
// would discard the user's edits, and the literal-keyword pass already ran at
// seed. So export makes zero AI calls, costs zero extra COS (matches spec
// 7.14.7's "no separate Copilot export fee"), and only renders + reports.
// The page-fit/floor gates (7.14.4) already ran in the route BEFORE this was
// called — this function assumes the tree it's given is already valid.
async function runCopilotExport(documentId, sessionId, userId, job, resume, tree) {
  const db = getSupabaseAdmin();
  const markDoc = (fields) => db.from('generated_documents').update(fields).eq('id', documentId);

  try {
    await markDoc({ status: 'running' });

    const { contact, jobContext, confirmedNaked, confirmedContext } = await buildGenerationInputs(db, userId, job, resume);
    const profile = resume.parsed_profile;

    const asm = assembleFromTree({ tree, contact });
    // Seed-time ats is stale after edits — recompute against the edited model.
    const ats = atsCheck({
      model: asm.model,
      jdProfile: jobContext.jdProfile,
      profile,
      confirmedSkills: [...confirmedNaked, ...confirmedContext.map((c) => c.term)],
      alreadyDemonstrated: jobContext.tiered.already_demonstrated,
      transferable: jobContext.tiered.transferable,
      hiddenStrengths: jobContext.tiered.hidden_strengths,
    });

    const result = await runFinishPhase({
      draft: null, asm, ats,
      selected: { roleIndices: [], projectIndices: [] }, roleTargets: {}, projectTargets: {},
      confirmedSkills: [...confirmedNaked, ...confirmedContext.map((c) => c.term)],
      directorReasoning: null,
      profile, contact, jobContext,
      credential: { mode: 'cai' }, // never consulted — no AI call runs under these options
      confirmedNaked: [], confirmedContext: [],
      options: { allowRedraft: false, applyLiteralKeywords: false },
    });

    const storagePath = `${userId}/generated/${job.id}.docx`;
    const { error: upErr } = await db.storage
      .from(RESUME_BUCKET)
      .upload(storagePath, result.docxBuffer, { contentType: DOCX_MIME, upsert: true });
    if (upErr) throw upErr;

    await markDoc({
      status: 'completed',
      storage_path: storagePath,
      ats_score: result.atsScore,
      checks_passed: result.checksPassed,
      pending_confirmations: result.pendingConfirmations,
    });
    await db.from('resume_edit_sessions').update({ status: 'exported', generated_document_id: documentId }).eq('id', sessionId);
  } catch (err) {
    console.error('runCopilotExport failed:', err);
    await markDoc({ status: 'failed', error_message: String(err.message || err).slice(0, 500) });
    // Session stays 'editing' — the user can retry export; nothing about
    // their curated tree was lost or charged for.
  }
}

module.exports = { runCopilotSeed, runCopilotExport };

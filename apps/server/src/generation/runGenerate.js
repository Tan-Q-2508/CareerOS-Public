const { getSupabaseAdmin, tunables } = require('@careeros/shared');
const { generateResume } = require('./generateResume');
const { buildGenerationInputs } = require('./generationInputs');
const cosGuard = require('../lib/cosGuard');
const aiRouter = require('../lib/aiRouter');
const { makeProgressLogger } = require('../lib/progress');
const { isCancellation } = require('../lib/cancellation');
const { persistCompletedGenerationTree } = require('./copilotSessions');

const RESUME_BUCKET = 'resumes';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Persistence layer for résumé generation (mirrors scan/runScan.js). Runs the
// pure 7.12 pipeline, stores the .docx (11.1), records the generated_documents
// row, logs each AI call (16.10) and one unbilled resume_generation COS row (13.4).
async function runGenerate(documentId, userId, job, resume) {
  const db = getSupabaseAdmin();
  const mark = (fields) => db.from('generated_documents').update(fields).eq('id', documentId);
  // Two loggers on purpose. `logProgress` is cancellable — it throws the
  // moment the row says the user cancelled, which is how the pipeline stops.
  // `logFinal` is not, because the terminal writes below run when the row is
  // ALREADY 'cancelled', and a cancellable logger there would throw straight
  // back out of the catch that is handling the cancellation.
  const logProgress = makeProgressLogger(db, 'generated_documents', documentId, { cancellable: true });
  const logFinal = makeProgressLogger(db, 'generated_documents', documentId);

  try {
    await mark({ status: 'running' });
    await logProgress('start', 'Loading résumé and job context');

    const { credential, contact, jobContext, confirmedNaked, confirmedContext } = await buildGenerationInputs(db, userId, job, resume);

    const result = await generateResume({
      profile: resume.parsed_profile,
      contact,
      jobContext,
      confirmedNaked,
      confirmedContext,
      credential,
      onProgress: logProgress,
    });

    await logProgress('upload', 'Saving document');
    const storagePath = `${userId}/generated/${job.id}.docx`;
    const { error: upErr } = await db.storage
      .from(RESUME_BUCKET)
      .upload(storagePath, result.docxBuffer, { contentType: DOCX_MIME, upsert: true });
    if (upErr) throw upErr;

    await mark({
      status: 'completed',
      storage_path: storagePath,
      ats_score: result.atsScore,
      checks_passed: result.checksPassed,
      pending_confirmations: result.pendingConfirmations,
    });

    // Persist the completed_generation content_tree (spec 15 #20(f)) — its
    // own try/catch: a résumé the user can actually download must never fail
    // because Copilot-continuation prep failed (same isolation pattern
    // runScan.scoreScanJobs uses for tracker auto-population). No COS charge,
    // no ai_usage_log row — the tree is built from AI calls already billed
    // above; a completed_generation row that's never continued from is inert
    // storage, not a billable session (7.14.8).
    try {
      await persistCompletedGenerationTree({ db, userId, job, resume, documentId, result, contact });
    } catch (treeErr) {
      console.error('persistCompletedGenerationTree failed:', treeErr);
    }

    // Per-call usage logging (16.10).
    for (const u of result.usages) {
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

    // COS ledger row (13.4) — real debit under enforceCosBalance (session 13);
    // BYOK reduces the AI-fee component to 10% of CAI-equivalent (aiRouter.computeAiFeeCos).
    const aiCostCos = aiRouter.computeAiFeeCos({ credential, usages: result.usages });
    const aiNote = credential.mode === 'cai'
      ? `real AI cost $${result.usages.reduce((s, u) => s + (u.costUsd || 0), 0).toFixed(6)}`
      : `BYOK (${credential.provider}) AI fee ${aiCostCos} COS`;
    await cosGuard.debitCos(db, userId, {
      actionType: 'resume_generation',
      flatFee: tunables.flatFees.resume_generation,
      aiCost: aiCostCos,
      relatedJobId: job.id,
      note: `Résumé generation: ${result.checksPassed.repairRounds} repair round(s), ${aiNote}`,
    });
    await logProgress('done', 'Done');
  } catch (err) {
    // A cancellation is not a failure and must not be recorded as one — the
    // user asked for this, and "failed" reads as "the product broke". The row
    // is ALREADY 'cancelled' (that is what the pipeline noticed), so this only
    // writes the explanation; re-marking the status would race a user who
    // cancelled and immediately re-ran.
    if (isCancellation(err)) {
      console.log(`runGenerate cancelled by user (document ${documentId})`);
      await logFinal('cancelled', 'Cancelled — stopped at the last completed step');
      await mark({
        error_message:
          'Cancelled. Any AI calls that had already completed were still charged; the rest were not.',
      });
      return;
    }
    console.error('runGenerate failed:', err);
    await logFinal('failed', String(err.message || err).slice(0, 200));
    await mark({ status: 'failed', error_message: String(err.message || err).slice(0, 500) });
  }
}

module.exports = { runGenerate };

const { getSupabaseAdmin, tunables, jdGroundingText } = require('@careeros/shared');
const { generateCoverLetter } = require('./generateCoverLetter');
const { resolveContact } = require('./extractContact');
const { jobRelevantConfirmedSkills } = require('./atsCheck');
const cosGuard = require('../lib/cosGuard');
const aiRouter = require('../lib/aiRouter');
const { makeProgressLogger } = require('../lib/progress');
const { isCancellation } = require('../lib/cancellation');

const RESUME_BUCKET = 'resumes';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Persistence layer for cover letter generation (mirrors runGenerate.js). Runs
// the 8.5 pipeline, stores the .docx (11.1), records the generated_documents
// row, logs each AI call (16.10) and one unbilled cover_letter_generation COS
// row (13.4).
async function runGenerateCoverLetter(documentId, userId, job, resume) {
  const db = getSupabaseAdmin();
  const mark = (fields) => db.from('generated_documents').update(fields).eq('id', documentId);
  // Cancellable during the run, plain for the terminal writes — see
  // runGenerate.js for why the second one has to exist.
  const logProgress = makeProgressLogger(db, 'generated_documents', documentId, { cancellable: true });
  const logFinal = makeProgressLogger(db, 'generated_documents', documentId);

  try {
    await mark({ status: 'running' });
    await logProgress('start', 'Loading résumé and job context');

    const credential = await aiRouter.resolveAiCredential(db, userId);
    const { data: user } = await db.from('users').select('full_name').eq('id', userId).single();
    const { data: confirmed } = await db.from('confirmed_skills').select('skill_term, context').eq('user_id', userId);
    // Scoped to this job's own required/nice-to-have skills — see atsCheck.js's
    // jobRelevantConfirmedSkills / runGenerate.js's identical fix.
    const relevantConfirmed = jobRelevantConfirmedSkills(confirmed, job.jd_profile || {});
    const confirmedSkills = relevantConfirmed.map((c) => c.skill_term);
    const confirmedContext = relevantConfirmed
      .filter((c) => c.context)
      .map((c) => ({ term: c.skill_term, context: c.context }));

    const contact = await resolveContact(db, userId, db, resume.storage_path, user && user.full_name);

    const jobContext = {
      title: job.title,
      company: job.company_name,
      location: job.location,
      jdProfile: job.jd_profile || {},
      // The posting's own wording, so the humanizer (spec 8.7) never flags a
      // word the JD itself uses as an AI tell.
      jdText: jdGroundingText(job),
      tiered: {
        already_demonstrated: job.already_demonstrated,
        transferable: job.transferable,
        hidden_strengths: job.hidden_strengths,
      },
    };

    const result = await generateCoverLetter({ profile: resume.parsed_profile, contact, jobContext, confirmedSkills, confirmedContext, credential, onProgress: logProgress });

    await logProgress('upload', 'Saving document');
    const storagePath = `${userId}/generated/${job.id}-cover-letter.docx`;
    const { error: upErr } = await db.storage.from(RESUME_BUCKET).upload(storagePath, result.docxBuffer, { contentType: DOCX_MIME, upsert: true });
    if (upErr) throw upErr;

    await mark({ status: 'completed', storage_path: storagePath, checks_passed: result.checksPassed });

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

    const aiCostCos = aiRouter.computeAiFeeCos({ credential, usages: result.usages });
    const aiNote = credential.mode === 'cai'
      ? `real AI cost $${result.usages.reduce((s, u) => s + (u.costUsd || 0), 0).toFixed(6)}`
      : `BYOK (${credential.provider}) AI fee ${aiCostCos} COS`;
    await cosGuard.debitCos(db, userId, {
      actionType: 'cover_letter_generation',
      flatFee: tunables.flatFees.cover_letter_generation,
      aiCost: aiCostCos,
      relatedJobId: job.id,
      note: `Cover letter generation: ${result.wordCount} words, ${aiNote}`,
    });
    await logProgress('done', 'Done');
  } catch (err) {
    if (isCancellation(err)) {
      console.log(`runGenerateCoverLetter cancelled by user (document ${documentId})`);
      await logFinal('cancelled', 'Cancelled — stopped at the last completed step');
      await mark({
        error_message:
          'Cancelled. Any AI calls that had already completed were still charged; the rest were not.',
      });
      return;
    }
    console.error('runGenerateCoverLetter failed:', err);
    await logFinal('failed', String(err.message || err).slice(0, 200));
    await mark({ status: 'failed', error_message: String(err.message || err).slice(0, 500) });
  }
}

module.exports = { runGenerateCoverLetter };

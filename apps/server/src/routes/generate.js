const { Router } = require('express');
const { getSupabaseAdmin, geminiAdapter, tunables, jdGroundingText } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const { runGenerate } = require('../generation/runGenerate');
const { resolvedPromptVersion } = require('../generation/generateResume');
const { runGenerateCoverLetter } = require('../generation/runGenerateCoverLetter');
const { generationGaps } = require('../generation/generationGaps');
const { refreshKeywordCoverage, refreshKeywordCoverageSoon } = require('../generation/refreshKeywordCoverage');
const { loadJobAndResume } = require('../generation/loadJobAndResume');
const { runDraft: draftQuestionAnswer } = require('../generation/draftQuestionAnswer');
const { jobRelevantConfirmedSkills } = require('../generation/atsCheck');
const cosGuard = require('../lib/cosGuard');
const { runGenerationJob } = require('../lib/generationQueue');
const { CANCELLABLE_STATUSES } = require('../lib/cancellation');
const aiRouter = require('../lib/aiRouter');
const googleOAuth = require('../lib/googleOAuth');
const googleDriveClient = require('../lib/googleDriveClient');

const router = Router();

const GENERATED_BUCKET = 'resumes';

// Filesystem-safe filename for a downloaded document (spec 11.2). e.g.
// "Acme-Data-Analyst-resume.docx". Collapses anything non-alphanumeric to a dash.
function downloadFilename(job, docType) {
  const slug = (s) => (s || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const parts = [slug(job && job.company_name), slug(job && job.title)].filter(Boolean);
  const base = parts.join('-') || 'careeros-document';
  const kind = docType === 'cover_letter' ? 'cover-letter' : 'resume';
  return `${base}-${kind}.docx`;
}

// POST /api/jobs/:id/generate-resume — start résumé generation for a scored job.
// Runs async (no worker yet, Session 12); the client polls GET /api/documents/:id.
router.post('/api/jobs/:id/generate-resume', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    if (!geminiAdapter.isConfigured()) return res.status(503).json({ error: 'AI provider not configured' });

    const userId = req.user.id;
    const { job, resume, httpError } = await loadJobAndResume(db, userId, req.params.id, 'ats_match, callback_odds, overall_fit, risk_tags');
    if (httpError) return res.status(httpError.status).json({ error: httpError.error });

    const cosCheck = await cosGuard.checkCosBalance(db, userId, 'resume_generation');
    if (!cosCheck.ok) {
      return res.status(402).json({ error: cosGuard.paywallMessage(cosCheck.balance, cosCheck.required) });
    }

    const { data: doc, error: insErr } = await db
      .from('generated_documents')
      .insert({
        user_id: userId,
        job_id: job.id,
        doc_type: 'resume',
        resume_version_id: resume.id,
        prompt_version: resolvedPromptVersion(),
        status: 'queued',
      })
      .select('id')
      .single();
    if (insErr) return next(Object.assign(new Error(insErr.message), { status: 500 }));

    // Fire and forget — generation continues in the background after we respond.
    runGenerationJob('runGenerate', () => runGenerate(doc.id, userId, job, resume)).catch((e) => console.error('runGenerate dispatch error:', e));

    res.status(202).json({ document_id: doc.id, status: 'queued' });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/generate-cover-letter — start cover letter generation for a
// scored job. Async (mirrors generate-resume); poll GET /api/documents/:id.
router.post('/api/jobs/:id/generate-cover-letter', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    if (!geminiAdapter.isConfigured()) return res.status(503).json({ error: 'AI provider not configured' });

    const userId = req.user.id;
    const { job, resume, httpError } = await loadJobAndResume(db, userId, req.params.id, 'location');
    if (httpError) return res.status(httpError.status).json({ error: httpError.error });

    const cosCheck = await cosGuard.checkCosBalance(db, userId, 'cover_letter_generation');
    if (!cosCheck.ok) {
      return res.status(402).json({ error: cosGuard.paywallMessage(cosCheck.balance, cosCheck.required) });
    }

    const { data: doc, error: insErr } = await db
      .from('generated_documents')
      .insert({
        user_id: userId,
        job_id: job.id,
        doc_type: 'cover_letter',
        resume_version_id: resume.id,
        prompt_version: tunables.coverLetter.promptVersion,
        status: 'queued',
      })
      .select('id')
      .single();
    if (insErr) return next(Object.assign(new Error(insErr.message), { status: 500 }));

    runGenerationJob('runGenerateCoverLetter', () => runGenerateCoverLetter(doc.id, userId, job, resume)).catch((e) => console.error('runGenerateCoverLetter dispatch error:', e));
    res.status(202).json({ document_id: doc.id, status: 'queued' });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/answer-question — custom application Q&A (spec 8.6,
// reported bug #10). Unlike résumé/cover-letter generation there's no
// document to render/store — this is a synchronous request/response: one
// grounded strong-tier AI call, billed, persisted to job_question_answers,
// and returned inline. Same grounding/no-fabrication rules as the cover
// letter (draftQuestionAnswer.js mirrors draftCoverLetter.js's instruction
// pattern) — CLAUDE.md's non-negotiable applies in full here too.
router.post('/api/jobs/:id/answer-question', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    if (!geminiAdapter.isConfigured()) return res.status(503).json({ error: 'AI provider not configured' });

    const question = ((req.body && req.body.question) || '').trim();
    if (!question) return res.status(400).json({ error: 'question is required' });
    if (question.length > 2000) return res.status(400).json({ error: 'question is too long (max 2000 characters)' });

    const userId = req.user.id;
    const { job, resume, httpError } = await loadJobAndResume(db, userId, req.params.id);
    if (httpError) return res.status(httpError.status).json({ error: httpError.error });

    const cosCheck = await cosGuard.checkCosBalance(db, userId, 'application_qa');
    if (!cosCheck.ok) {
      return res.status(402).json({ error: cosGuard.paywallMessage(cosCheck.balance, cosCheck.required) });
    }

    const credential = await aiRouter.resolveAiCredential(db, userId);
    const { data: confirmed } = await db.from('confirmed_skills').select('skill_term, context').eq('user_id', userId);
    // Scoped to this job's own required/nice-to-have skills — see atsCheck.js's
    // jobRelevantConfirmedSkills / runGenerateCoverLetter.js's identical use.
    const relevantConfirmed = jobRelevantConfirmedSkills(confirmed, job.jd_profile || {});
    const confirmedSkills = relevantConfirmed.map((c) => c.skill_term);
    const confirmedContext = relevantConfirmed
      .filter((c) => c.context)
      .map((c) => ({ term: c.skill_term, context: c.context }));

    const jobContext = {
      title: job.title,
      company: job.company_name,
      jdProfile: job.jd_profile || {},
      jdText: jdGroundingText(job),
      tiered: {
        already_demonstrated: job.already_demonstrated,
        transferable: job.transferable,
        hidden_strengths: job.hidden_strengths,
      },
    };

    const result = await draftQuestionAnswer({
      profile: resume.parsed_profile,
      jobContext,
      question,
      confirmedSkills,
      confirmedContext,
      credential,
    });

    const { error: logErr } = await db.from('ai_usage_log').insert({
      user_id: userId,
      action_type: 'application_qa',
      provider: credential.mode === 'cai' ? 'gemini' : credential.provider,
      connection_mode: result.connectionMode,
      model: result.model,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cached_tokens: result.usage.cached_tokens,
      total_tokens: result.usage.total_tokens,
      raw_usage: result.usage.raw,
      cost_usd: result.costUsd,
      related_job_id: job.id,
      related_resume_version_id: resume.id,
    });
    if (logErr) console.error('ai_usage_log insert failed:', logErr.message);

    const aiCostCos = aiRouter.computeAiFeeCos({
      credential,
      usages: [{ usage: result.usage, costUsd: result.costUsd, tier: result.tier }],
    });
    const aiNote = credential.mode === 'cai'
      ? `real AI cost $${(result.costUsd || 0).toFixed(6)}`
      : `BYOK (${credential.provider}) AI fee ${aiCostCos} COS`;
    await cosGuard.debitCos(db, userId, {
      actionType: 'application_qa',
      flatFee: tunables.flatFees.application_qa,
      aiCost: aiCostCos,
      relatedJobId: job.id,
      note: `Application Q&A: ${aiNote}`,
    });

    const { data: saved, error: saveErr } = await db
      .from('job_question_answers')
      .insert({ user_id: userId, job_id: job.id, question, answer: result.answer })
      .select('id, question, answer, created_at')
      .single();
    if (saveErr) return next(Object.assign(new Error(saveErr.message), { status: 500 }));

    res.status(201).json({ qa: saved });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/question-answers — past Q&A pairs for this job (spec
// 8.6), newest first, so a user can build up a bank of several answers per
// application across a session instead of the answer vanishing on navigation.
router.get('/api/jobs/:id/question-answers', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { data, error } = await db
      .from('job_question_answers')
      .select('id, question, answer, created_at')
      .eq('user_id', req.user.id)
      .eq('job_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    res.json({ qa: data || [] });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/generation-gaps — pre-generation gap check (spec 7.12 step 3).
// Deterministic diff of the full JD skill list vs the résumé profile + confirmed
// skills. FREE — no AI, no COS. The client surfaces these for the user to
// confirm/explain/skip (via POST /api/confirmed-skills) before generating.
router.get('/api/jobs/:id/generation-gaps', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const userId = req.user.id;
    const { job, resume, httpError } = await loadJobAndResume(db, userId, req.params.id);
    if (httpError) return res.status(httpError.status).json({ error: httpError.error });

    const { data: confirmed } = await db
      .from('confirmed_skills')
      .select('skill_term')
      .eq('user_id', userId);

    // Same function (keywordState) the job card's "Keywords X/Y" comes from,
    // so the gap count is always total − matched of the fraction shown.
    const gaps = generationGaps({
      job,
      profile: resume.parsed_profile,
      confirmedSkills: confirmed || [],
    });
    // Bring this job's stored X/Y in line with what was just computed, so the
    // card reads the same fraction the modal shows.
    await refreshKeywordCoverage(db, userId, { jobId: job.id });
    res.json({ gaps });
  } catch (err) {
    next(err);
  }
});

// GET /api/documents/:id — generation status + result.
router.get('/api/documents/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('generated_documents')
      .select(
        'id, job_id, doc_type, status, storage_path, ats_score, checks_passed, pending_confirmations, progress, prompt_version, resume_version_id, error_message, created_at, updated_at'
      )
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!data) return res.status(404).json({ error: 'Document not found' });
    res.json({ document: data });
  } catch (err) {
    next(err);
  }
});

// POST /api/documents/:id/cancel — stop an in-flight résumé or cover letter.
//
// Cooperative (see lib/cancellation.js): this only writes the status, and the
// running pipeline notices at its next milestone and stops. So a 200 here means
// "it will stop", not "it has stopped" — which is why the response says which
// status the row is now in rather than claiming the work is over.
//
// Scoped by `user_id` in the WHERE like every other document route: a cancel is
// a write, and a cancel that could reach another user's row would be a way to
// sabotage their generation.
router.post('/api/documents/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { data, error } = await db
      .from('generated_documents')
      .update({ status: 'cancelled' })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .in('status', CANCELLABLE_STATUSES)
      .select('id, status, doc_type')
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));

    // Nothing updated: either it isn't theirs, or it finished first. Those are
    // reported differently — a user who clicked cancel a second too late should
    // be told it already completed, not that it doesn't exist.
    if (!data) {
      const { data: existing } = await db
        .from('generated_documents')
        .select('id, status')
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .maybeSingle();
      if (!existing) return res.status(404).json({ error: 'Document not found' });
      return res.status(409).json({
        error: `This ${existing.status === 'completed' ? 'finished' : `is already ${existing.status}`} — nothing to cancel.`,
        status: existing.status,
      });
    }

    res.json({ document: data, cancelling: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/documents — the latest completed generated document per type
// (résumé, cover letter) for a job. Lets the detail view show a Download button
// for files generated in a PAST session (spec 11.1: storage of record means a
// generated file is downloadable whenever the user next opens the app, not only
// in the session it was generated). Declared before /api/documents/:id routes;
// distinct path from POST /api/jobs/:id/generate-*.
router.get('/api/jobs/:id/documents', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { data, error } = await db
      .from('generated_documents')
      .select('id, doc_type, status, ats_score, checks_passed, pending_confirmations, created_at')
      .eq('user_id', req.user.id)
      .eq('job_id', req.params.id)
      .eq('status', 'completed')
      .order('created_at', { ascending: false });
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));

    // Keep only the most recent completed doc of each type.
    const latest = {};
    for (const d of data || []) if (!latest[d.doc_type]) latest[d.doc_type] = d;
    res.json({ documents: Object.values(latest) });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/generation-status — the latest generated_documents row (ANY
// status) per doc_type for this job. Lets the client detect a still in-flight
// (queued/running) or failed generation on mount/reload and reattach, instead
// of silently looking idle (GET .../documents above only returns completed
// docs, which is right for the Download list but wrong for "is this running").
router.get('/api/jobs/:id/generation-status', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { data, error } = await db
      .from('generated_documents')
      .select('id, doc_type, status, progress, error_message, created_at')
      .eq('user_id', req.user.id)
      .eq('job_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));

    // Keep only the most recent row of each type, regardless of status.
    const latest = {};
    for (const d of data || []) if (!latest[d.doc_type]) latest[d.doc_type] = d;
    res.json({ statuses: { resume: latest.resume || null, cover_letter: latest.cover_letter || null } });
  } catch (err) {
    next(err);
  }
});

// GET /api/documents/:id/download — a signed, time-limited download URL for a
// completed document (spec 11.2). Files live in a PRIVATE bucket; the URL is
// generated on request, expires shortly, and carries a friendly filename via
// Content-Disposition. Free, unconditional — downloading is retrieval, never a
// billable action (11.2). Never a permanent public URL.
router.get('/api/documents/:id/download', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { data: doc, error } = await db
      .from('generated_documents')
      .select('id, job_id, doc_type, status, storage_path')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.status !== 'completed' || !doc.storage_path) {
      return res.status(409).json({ error: 'Document is not ready to download yet' });
    }

    const { data: job } = await db
      .from('jobs')
      .select('title, company_name')
      .eq('id', doc.job_id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    const filename = downloadFilename(job, doc.doc_type);
    const { data: signed, error: signErr } = await db.storage
      .from(GENERATED_BUCKET)
      .createSignedUrl(doc.storage_path, 120, { download: filename });
    if (signErr || !signed) {
      return next(Object.assign(new Error(signErr ? signErr.message : 'Could not sign URL'), { status: 500 }));
    }

    res.json({ url: signed.signedUrl, filename, expires_in: 120 });
  } catch (err) {
    next(err);
  }
});

// POST /api/documents/:id/save-to-drive — upload a completed document to the
// user's Google Drive (spec §11.3). Free, unconditional like download — pure
// delivery of an output already priced at generation time, never a second COS
// charge. Reuses the job's Drive folder and the document's Drive file id across
// repeated saves (persisted on jobs.drive_folder_id / generated_documents.drive_file_id)
// so this never creates duplicates.
router.post('/api/documents/:id/save-to-drive', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    if (!googleOAuth.isConfigured()) {
      return res.status(503).json({ error: 'Google integration is not configured on the server' });
    }

    const { data: doc, error } = await db
      .from('generated_documents')
      .select('id, job_id, doc_type, status, storage_path, drive_file_id')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.status !== 'completed' || !doc.storage_path) {
      return res.status(409).json({ error: 'Document is not ready to save yet' });
    }

    const { data: job, error: jobErr } = await db
      .from('jobs')
      .select('id, title, company_name, drive_folder_id')
      .eq('id', doc.job_id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (jobErr) return next(Object.assign(new Error(jobErr.message), { status: 500 }));
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // getAccessToken throws GmailNotConnectedError (shared grant — see
    // googleDrive.js) when there's no stored Google OAuth grant, or it was
    // revoked/expired. Caught explicitly below (mirrors emailCheck.js) so the
    // client reliably sees { error: 'gmail_not_connected' } and prompts a
    // reconnect, rather than a generic (possibly production-masked) 500.
    let accessToken;
    try {
      accessToken = await googleOAuth.getAccessToken(req.user.id);
    } catch (err) {
      if (err instanceof googleOAuth.GmailNotConnectedError || err.code === 'gmail_not_connected') {
        return res.status(400).json({ error: 'gmail_not_connected', message: err.message });
      }
      throw err;
    }

    // A grant can exist (getAccessToken above succeeded) but predate this
    // feature and only carry gmail.readonly — Drive's API then rejects the
    // token with 403 "insufficient authentication scopes" rather than
    // anything getAccessToken itself can detect (the token mint always
    // succeeds; only the actual Drive call knows it's missing drive.file).
    // Mapped to the same 'gmail_not_connected' code as a real missing grant
    // so the client's existing reconnect prompt (union-scope re-consent)
    // handles this case too, without needing a second error code.
    let rootFolderId, jobFolderId, buffer, filename;
    try {
      rootFolderId = await googleOAuth.getDriveRootFolderId(req.user.id);
      if (!rootFolderId) {
        rootFolderId = await googleDriveClient.findOrCreateRootFolder(accessToken, null);
        await googleOAuth.setDriveRootFolderId(req.user.id, rootFolderId);
      }

      jobFolderId = job.drive_folder_id;
      if (!jobFolderId) {
        const folderName = `${job.company_name || 'Company'}-${job.title || 'Job'}`.replace(/[\\/]+/g, '-');
        jobFolderId = await googleDriveClient.findOrCreateJobFolder(accessToken, rootFolderId, null, folderName);
        const { error: folderUpdateErr } = await db.from('jobs').update({ drive_folder_id: jobFolderId }).eq('id', job.id);
        if (folderUpdateErr) return next(Object.assign(new Error(folderUpdateErr.message), { status: 500 }));
      }
    } catch (err) {
      if (err.status === 403) {
        console.error('save-to-drive 403 (folder step):', err.message);
        return res.status(400).json({ error: 'gmail_not_connected', message: 'Google Drive access needs to be reconnected with Drive permission.' });
      }
      throw err;
    }

    const { data: fileBlob, error: dlErr } = await db.storage.from(GENERATED_BUCKET).download(doc.storage_path);
    if (dlErr || !fileBlob) {
      return next(Object.assign(new Error(dlErr ? dlErr.message : 'Could not read the generated file'), { status: 500 }));
    }
    buffer = Buffer.from(await fileBlob.arrayBuffer());
    filename = downloadFilename(job, doc.doc_type);

    let uploaded;
    try {
      uploaded = await googleDriveClient.uploadDocx(accessToken, {
        fileId: doc.drive_file_id || null,
        folderId: jobFolderId,
        filename,
        buffer,
      });
    } catch (err) {
      if (err.status === 403) {
        console.error('save-to-drive 403 (upload step):', err.message);
        return res.status(400).json({ error: 'gmail_not_connected', message: 'Google Drive access needs to be reconnected with Drive permission.' });
      }
      throw err;
    }

    if (!doc.drive_file_id) {
      const { error: docUpdateErr } = await db.from('generated_documents').update({ drive_file_id: uploaded.fileId }).eq('id', doc.id);
      if (docUpdateErr) return next(Object.assign(new Error(docUpdateErr.message), { status: 500 }));
    }

    res.json({ ok: true, webViewLink: uploaded.webViewLink });
  } catch (err) {
    next(err);
  }
});

// GET /api/confirmed-skills — the user's confirmed skills (7.13).
router.get('/api/confirmed-skills', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('confirmed_skills')
      .select('id, skill_term, context, confirmed_at')
      .eq('user_id', req.user.id)
      .order('confirmed_at', { ascending: false });
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    res.json({ confirmed_skills: data || [] });
  } catch (err) {
    next(err);
  }
});

// POST /api/confirmed-skills — confirm a skill once; reused by later generations
// without re-asking (7.11/7.13). Body: { skill_term, context?, entry_ref? }.
// entry_ref (2026-08-05, bug fix) is an optional "role:<index>"/"project:<index>"
// string the user picks in the Explain UI, pinning which résumé entry an
// explanation belongs to instead of leaving generation to guess it — see
// generationInputs.js/contentDirector.js/draftResume.js.
router.post('/api/confirmed-skills', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const skillTerm = (req.body && req.body.skill_term || '').trim();
    if (!skillTerm) return res.status(400).json({ error: 'skill_term is required' });
    const context = (req.body && req.body.context || '').trim(); // '' not null so the unique key works
    const entryRef = (req.body && req.body.entry_ref || '').trim() || null;

    const { data, error } = await db
      .from('confirmed_skills')
      .upsert(
        { user_id: req.user.id, skill_term: skillTerm, context, entry_ref: entryRef },
        { onConflict: 'user_id,skill_term,context', ignoreDuplicates: false }
      )
      .select('id, skill_term, context, entry_ref, confirmed_at')
      .single();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    // A confirmation can cover a keyword on many jobs at once.
    refreshKeywordCoverageSoon(db, req.user.id);
    res.status(201).json({ confirmed_skill: data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
// Reused by routes/autofill.js so the extension attaches a file with the same
// human-readable name the web app's Download button produces (11.2), not the
// storage UUID.
module.exports.downloadFilename = downloadFilename;

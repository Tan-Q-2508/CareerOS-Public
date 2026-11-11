const { getSupabaseAdmin, geminiAdapter, tunables } = require('@careeros/shared');
const { scoreJob, buildResumeProfileBlock } = require('../scoring/scoreJob');
const { yearsOfExperience: deriveYearsOfExperience } = require('../resume/deriveProfile');
const cosGuard = require('../lib/cosGuard');
const aiRouter = require('../lib/aiRouter');
const { makeProgressLogger } = require('../lib/progress');

// Score a single manually-entered job (spec §6). This is the manual-entry
// counterpart to scan/runScan.js scoreScanJobs: identical scoring pipeline
// (Section 5), same persistence + usage logging + tracker auto-population, but
// for one already-inserted `jobs` row (status 'prefiltered', scan_history_id
// null, sources ['manual']) instead of a scan batch. Billed as `manual_entry`
// (flat fee + the single job's measured AI cost), unbilled in Phase 1 (13.4).
//
// Runs async (fire-and-forget from the route, like runScan/runGenerate); the
// client polls GET /api/jobs/:id until status leaves 'prefiltered'. A failure
// leaves the job 'prefiltered' with an error recorded, mirroring 16.8.
async function scoreManualJob(jobId, userId) {
  const db = getSupabaseAdmin();
  const logProgress = makeProgressLogger(db, 'jobs', jobId);

  try {
    await logProgress('start', 'Loading résumé and job details');
    const credential = await aiRouter.resolveAiCredential(db, userId);
    if (credential.mode === 'cai' && !geminiAdapter.isConfigured()) {
      throw new Error('AI provider not configured');
    }

    const { data: job, error: jErr } = await db
      .from('jobs')
      .select('id, title, location, posted_at, salary_min, salary_max, seniority_level, description_text, resume_version_id')
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();
    if (jErr) throw jErr;

    const { data: user, error: uErr } = await db
      .from('users')
      .select('years_of_experience, domain_keywords, years_of_experience_manual')
      .eq('id', userId)
      .single();
    if (uErr) throw uErr;

    const { data: resume } = await db
      .from('resume_versions')
      .select('id, parsed_profile')
      .eq('id', job.resume_version_id)
      .eq('user_id', userId)
      .maybeSingle();
    if (!resume || !resume.parsed_profile) {
      throw new Error('The résumé version this job is tied to is unavailable');
    }

    const parsedProfile = resume.parsed_profile;
    // C1: live, not a frozen snapshot — see runScan.js's identical logic.
    if (!user.years_of_experience_manual) {
      const derived = deriveYearsOfExperience(parsedProfile);
      if (derived != null) user.years_of_experience = derived;
    }
    const resumeProfileBlock = buildResumeProfileBlock(parsedProfile);
    const { data: confirmedRows } = await db.from('confirmed_skills').select('skill_term').eq('user_id', userId);
    // No universal fallback (spec 4.3, corrected 2026-08-05) — see runScan.js.
    const domainKeywords = user.domain_keywords && user.domain_keywords.length ? user.domain_keywords : [];

    await logProgress('scoring', 'Scoring against your résumé');
    const result = await scoreJob({
      resumeProfile: parsedProfile,
      confirmedSkills: confirmedRows || [],
      resumeProfileBlock,
      job,
      userYears: user.years_of_experience,
      domainKeywords,
      scanLocation: job.location, // manual entries have no scan location; use the job's own
      credential,
      db,
      // See jobScorer.js: the `users` row above is SELECTed without `id`, so
      // `user.id` is undefined. `userId` is this function's own parameter.
      userId,
    });

    const overall = result.scores.overallFit;
    const status = overall >= tunables.storageCutoff ? 'scored' : 'archived';

    await logProgress('save', 'Saving results');
    const { error: upErr } = await db
      .from('jobs')
      .update({
        jd_profile: result.jdProfile,
        prompt_version: tunables.scoring.promptVersion,
        ats_match: result.scores.atsMatch,
        keyword_coverage: result.scores.keywordCoverage,
        callback_odds: result.scores.callbackOdds,
        overall_fit: overall,
        critical_missing: result.tiered.critical_missing,
        important_missing: result.tiered.important_missing,
        nice_to_have_missing: result.tiered.nice_to_have_missing,
        already_demonstrated: result.tiered.already_demonstrated,
        transferable: result.tiered.transferable,
        hidden_strengths: result.tiered.hidden_strengths,
        risk_tags: result.riskTags,
        note: result.note,
        status,
      })
      .eq('id', job.id);
    if (upErr) throw upErr;

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
      });
      if (logErr) console.error('ai_usage_log insert failed:', logErr.message);
    }

    // COS ledger row (13.4). Manual entry = flat fee + this single job's AI
    // fee (same shape as a scan's per-job AI cost, spec §6).
    const aiCostCos = aiRouter.computeAiFeeCos({ credential, usages: result.usages });
    const aiNote = credential.mode === 'cai'
      ? `real AI cost $${result.usages.reduce((s, u) => s + (u.costUsd || 0), 0).toFixed(6)}`
      : `BYOK (${credential.provider}) AI fee ${aiCostCos} COS`;
    await cosGuard.debitCos(db, userId, {
      actionType: 'manual_entry',
      flatFee: tunables.flatFees.manual_entry,
      aiCost: aiCostCos,
      relatedJobId: job.id,
      note: `Manual job entry: scored ${overall}/10, ${aiNote}`,
    });

    // Tracker auto-population (spec §9): every manual job is saved to the
    // tracker at "Saved" (the dashboard-backing bucket), deduped, regardless of
    // fit score. 2026-08-05 fix: this used to be gated on status === 'scored',
    // which meant a manually-entered job scoring below storageCutoff (status
    // 'archived') never got an `applications` row — and since runEmailCheck.js
    // sources its entire candidate pool from `applications`, that job became
    // structurally invisible to the email-based application tracker even
    // though the user had a real confirmation email for it. A manual entry
    // means the user is telling the app "I already applied here" — unlike a
    // scraped job the app is speculatively scoring, it should always be
    // trackable. Free, isolated — never fails the flow.
    try {
      const { data: already } = await db
        .from('applications')
        .select('id')
        .eq('user_id', userId)
        .eq('job_id', job.id)
        .maybeSingle();
      if (!already) {
        const { error: appErr } = await db
          .from('applications')
          .insert({ user_id: userId, job_id: job.id, stage: 'Saved' });
        if (appErr) console.error('tracker auto-populate insert failed:', appErr.message);
      }
    } catch (e) {
      console.error('tracker auto-populate failed:', e.message || e);
    }
    await logProgress('done', 'Done');
  } catch (err) {
    // 16.8: fail loudly (logged) and move the job to a real terminal 'failed'
    // status (2026-07-27 — jobs.status previously had no failure value, so
    // this left the row stuck at 'prefiltered' forever with only `note`
    // recording the reason; the frontend poll worked around it by string-
    // sniffing that note instead of reading a real status).
    console.error(`scoreManualJob ${jobId} failed:`, err.message || err);
    await logProgress('failed', String(err.message || err).slice(0, 200));
    await db
      .from('jobs')
      .update({ status: 'failed', note: `Scoring failed: ${String(err.message || err).slice(0, 300)}` })
      .eq('id', jobId)
      .eq('user_id', userId);
  }
}

module.exports = { scoreManualJob };

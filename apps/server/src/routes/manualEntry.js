const { Router } = require('express');
const { getSupabaseAdmin, geminiAdapter, prefilter, dedup, tunables } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const { scoreManualJob } = require('../scan/scoreManualJob');
const { verdictFor } = require('../scoring/scoreJob');
const cosGuard = require('../lib/cosGuard');
const { resolveCompany, linkJobsToRegistry } = require('../companies/registry');
const { attachSponsors } = require('../visa/sponsorLookup');
const { yearsOfExperience, hasGraduateDegree } = require('../resume/deriveProfile');
const { refreshKeywordCoverage } = require('../generation/refreshKeywordCoverage');

const router = Router();

// Turn a deterministic pre-filter reason code (prefilter.js) into a plain-language
// sentence for the "does not pass criteria" state (spec §6 — specific reason, not
// a generic rejection).
function friendlyReason(reason) {
  if (!reason) return 'This posting did not pass the pre-filter.';
  let m;
  if ((m = reason.match(/^years_gap\(([\d.]+) vs ([\d.]+)\)/))) {
    return `This role asks for ~${m[1]}+ years of experience; your profile is set to ~${m[2]}.`;
  }
  if (reason.startsWith('off_domain_low_overlap')) {
    return 'This looks off-domain for your background — the title reads senior/adjacent and the description shares few of your domain keywords.';
  }
  if ((m = reason.match(/^work_auth:(\w+)/))) {
    return {
      no_sponsorship: 'This posting explicitly states it does not offer visa sponsorship.',
      citizen_only: 'This posting is limited to U.S. citizens / permanent residents.',
      us_person_export: 'This posting requires U.S.-person status for export-control reasons.',
      clearance: 'This posting requires a U.S. security clearance.',
    }[m[1]] || 'This posting restricts work authorization.';
  }
  return 'This posting did not pass the pre-filter criteria.';
}

// First non-empty line of the JD, as a provisional title when the user leaves it
// blank (spec §6: "title/company/link optional — can be inferred from the JD").
// A lightweight heuristic, not an AI call (noted as a Phase-1 deviation).
function inferTitle(text) {
  const line = (text || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.slice(0, 120);
}

// POST /api/jobs/manual — paste-a-JD flow (spec §6). Runs the identical §4.3
// pre-filter on the single job. If it fails and `analyze_anyway` is not set,
// responds 200 with { passed:false, reason } (no job created). If it passes or
// the user overrides, inserts a `manual` job (prefiltered), records the
// manual_entries audit row, and scores it asynchronously (client polls
// GET /api/jobs/:id). Already-in-account is terminal (can't re-add — the
// (user_id, dedup_key) unique key — so we point the user at the existing job).
router.post('/api/jobs/manual', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    if (!geminiAdapter.isConfigured()) return res.status(503).json({ error: 'AI provider not configured' });

    const userId = req.user.id;
    const body = req.body || {};
    const descriptionText = (body.description_text || '').trim();
    if (!descriptionText) return res.status(400).json({ error: 'Paste a job description to analyze' });

    const analyzeAnyway = body.analyze_anyway === true;
    const title = (body.title || '').trim() || inferTitle(descriptionText);
    const company = (body.company || '').trim() || null;
    const link = (body.link || '').trim() || null;
    if (!title) return res.status(400).json({ error: 'Could not determine a job title — add one above' });
    // 2026-08-05 fix: company used to be optional (spec §6's original "can be
    // inferred from the JD" — but unlike title there was no inference for it),
    // so a blank company silently broke the email-check application tracker's
    // Gmail search (buildSearchQuery.js drops empty terms) for that job. Now
    // required — deliberate deviation from the original spec §6 text.
    if (!company) return res.status(400).json({ error: 'Company is required — used to match this job to confirmation/status emails' });

    // Must have an active résumé (scored against it; also required for later generation).
    const { data: resume } = await db
      .from('resume_versions')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    if (!resume) return res.status(400).json({ error: 'Upload a master résumé before analyzing a job' });

    const dedupKey = dedup.dedupKey({ id: null, link, title, companyName: company, location: null });

    // Fetched BEFORE the detection dispatch below (moved up by §15 #25c-1, was
    // previously fetched later for the pre-filter only) — resolveCompany needs
    // the user's auto-track preference (4.6.10), and this is the one point
    // upstream of every exit path this handler has, so the fetch has to happen
    // here regardless of what reads it.
    const { data: user } = await db
      .from('users')
      .select('years_of_experience, years_of_experience_manual, domain_keywords, off_domain_title_keywords, auto_track_scraped_companies')
      .eq('id', userId)
      .single();

    // ATS Direct company detection (spec 4.6.3, entry point 2 — a manually-pasted
    // JD is just another source of a company name/link pair, and its link is
    // often the company's own board since that's a common place to copy a JD
    // from). Dispatched HERE deliberately: this is the one point upstream of ALL
    // of this handler's exit paths — already-in-account below, the
    // prefilter-failed return, and the normal success path all follow it, and a
    // company is worth registering regardless of which one this request takes.
    // Fire-and-forget; detection must never delay or fail the entry. Tracking
    // is opt-in (§15 #25c-1, 4.6.10) — only auto-tracks (into "Scraped
    // Companies") when this user's Settings toggle is on.
    const autoTrackScraped = user.auto_track_scraped_companies ?? tunables.autoTrackScrapedCompanies;
    const detectionPromise = resolveCompany(db, {
      companyName: company,
      link,
      source: 'manual',
      userId,
      autoTrack: autoTrackScraped,
      autoTrackTarget: 'scraped',
    }).catch((e) => console.error('ats-detect: manual entry company detection failed:', e.message || e));

    // Already in this account? Point at the existing job (can't duplicate it).
    const { data: existing } = await db
      .from('jobs')
      .select('id')
      .eq('user_id', userId)
      .eq('dedup_key', dedupKey)
      .maybeSingle();
    if (existing) {
      return res.json({
        passed: false,
        reason: 'already_in_account',
        message: 'You already have this job — open it from your results or tracker.',
        existing_job_id: existing.id,
      });
    }

    const normalized = {
      title,
      companyName: company,
      location: null,
      postedAt: null,
      link,
      descriptionText,
      dedupKey,
    };
    // Same live years + degree the scan path uses (runScan.liveYearsOfExperience).
    const { data: activeResume } = await db
      .from('resume_versions')
      .select('parsed_profile')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    const activeProfile = activeResume && activeResume.parsed_profile;
    const derivedYears = activeProfile && !user.years_of_experience_manual ? yearsOfExperience(activeProfile) : null;
    const { survivors, dropped } = prefilter({
      jobs: [normalized],
      userProfile: {
        yearsOfExperience: derivedYears != null ? derivedYears : user.years_of_experience,
        hasGraduateDegree: activeProfile ? hasGraduateDegree(activeProfile) : false,
        domainKeywords: user.domain_keywords,
        offDomainTitleKeywords: user.off_domain_title_keywords,
      },
      seenDedupKeys: new Set(),
      visaFilterOn: true,
    });

    const passed = survivors.length > 0;
    const rejectReason = passed ? null : (dropped[0] && dropped[0].reason) || 'did_not_pass';

    // Failed the pre-filter and no override → report the specific reason, no job.
    if (!passed && !analyzeAnyway) {
      await db.from('manual_entries').insert({
        user_id: userId,
        raw_jd_text: descriptionText,
        title,
        company_name: company,
        link,
        prefilter_passed: false,
        prefilter_reject_reason: rejectReason,
        override_used: false,
      });
      return res.json({
        passed: false,
        reason: rejectReason,
        message: friendlyReason(rejectReason),
      });
    }

    // COS pre-check (spec 13.6, Phase 2 session 13) — placed here, not before
    // the free pre-filter above, since only this branch (passed or overridden)
    // actually creates a job and dispatches billable scoring.
    const cosCheck = await cosGuard.checkCosBalance(db, userId, 'manual_entry');
    if (!cosCheck.ok) {
      return res.status(402).json({ error: cosGuard.paywallMessage(cosCheck.balance, cosCheck.required) });
    }

    // Passed, or the user chose "Analyze anyway" (spec §6 override): create the
    // job and score it through the identical Section 5 pipeline.
    const overrideUsed = !passed && analyzeAnyway;
    const { data: job, error: insErr } = await db
      .from('jobs')
      .insert({
        user_id: userId,
        sources: ['manual'],
        title,
        company_name: company,
        link,
        dedup_key: dedupKey,
        description_text: descriptionText,
        resume_version_id: resume.id,
        scan_history_id: null,
        status: 'prefiltered',
      })
      .select('id')
      .single();
    if (insErr) return next(Object.assign(new Error(insErr.message), { status: 500 }));

    // Keep job_dedup_seen in sync (mirrors runScan.js's scan-sourced inserts) —
    // otherwise this posting is invisible to a future scan's "already seen"
    // check, which can re-source it and silently fail to insert/score it on a
    // dedup_key conflict with this very row (confirmed live, 2026-07-26).
    const { error: dedupErr } = await db
      .from('job_dedup_seen')
      .upsert({ user_id: userId, dedup_key: dedupKey }, { onConflict: 'user_id,dedup_key', ignoreDuplicates: true });
    if (dedupErr) console.error('manualEntry: job_dedup_seen upsert failed:', dedupErr.message);

    // Link this job to its registry row once detection resolves (§15 #25c-1,
    // 4.6.10's "previously unflagged gap") — chained onto the already-fired
    // detectionPromise rather than a fresh call, so it also covers the case
    // where this company was genuinely new and detection just inserted it.
    // Fire-and-forget, same posture as detection itself.
    detectionPromise
      .then(() => linkJobsToRegistry(db, userId, { jobs: [{ companyName: company, dedupKey }] }))
      .catch((e) => console.error('ats-detect: manual entry job-link failed:', e.message || e));

    const { error: meErr } = await db.from('manual_entries').insert({
      user_id: userId,
      job_id: job.id,
      raw_jd_text: descriptionText,
      title,
      company_name: company,
      link,
      prefilter_passed: passed,
      prefilter_reject_reason: rejectReason,
      override_used: overrideUsed,
    });
    if (meErr) console.error('manual_entries insert failed:', meErr.message);

    // Fire and forget — scoring continues in the background after we respond.
    scoreManualJob(job.id, userId).catch((e) => console.error('scoreManualJob dispatch error:', e));

    res.status(202).json({ passed: true, override_used: overrideUsed, job_id: job.id, status: 'prefiltered' });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/manual — this user's manually-entered jobs, most recent first,
// with the derived verdict stamp. Distinct list so the Manual Entry view can
// surface them (they belong to no scan).
router.get('/api/jobs/manual', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('jobs')
      .select(
        'id, title, company_name, location, posted_at, link, status, ats_match, keyword_coverage, callback_odds, overall_fit, note, resume_version_id, created_at'
      )
      .eq('user_id', req.user.id)
      .contains('sources', ['manual'])
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    const jobs = (data || []).map((j) => ({ ...j, verdict: verdictFor(j.overall_fit) }));
    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id — a single owned job with scores + derived verdict. Used by
// the detail view for jobs that belong to no scan (manual entries), and as a
// general single-job fetch. Must be declared AFTER /api/jobs/manual so the
// literal path wins over the :id param.
router.get('/api/jobs/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    // Keywords X/Y is re-measured against the current résumé + confirmed
    // skills on every detail read (keywordState), so it always matches the gap
    // check this view opens.
    await refreshKeywordCoverage(db, req.user.id, { jobId: req.params.id });
    const { data, error } = await db
      .from('jobs')
      .select(
        'id, title, company_name, company_ats_registry_id, location, posted_at, link, status, sources, seniority_level, employment_type, ' +
          'ats_match, keyword_coverage, callback_odds, overall_fit, note, jd_profile, progress, ' +
          'critical_missing, important_missing, nice_to_have_missing, already_demonstrated, ' +
          'transferable, hidden_strengths, risk_tags, prompt_version, resume_version_id, scan_history_id, created_at, triage, description_text'
      )
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!data) return res.status(404).json({ error: 'Job not found' });
    // 19.5's Visa Sponsor badge data on the detail view.
    // The posting text is only sent for a job not yet scored (spec 4.7) — the
    // detail view shows it in place of the analysis it doesn't have yet.
    if (data.status !== 'sourced' && data.status !== 'scoring') delete data.description_text;
    const [job] = await attachSponsors(db, [{ ...data, verdict: verdictFor(data.overall_fit) }]);
    res.json({ job });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.friendlyReason = friendlyReason;
module.exports.inferTitle = inferTitle;

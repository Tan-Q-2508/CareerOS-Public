const { getSupabaseAdmin, geminiAdapter, jsearchAdapter, tunables, normalizeTitles, locationLabel, constants } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const { runScan, selectAllRows } = require('../scan/runScan');
const { verdictFor } = require('../scoring/scoreJob');
const { isConfigured: cryptoConfigured } = require('../lib/secretCrypto');
const cosGuard = require('../lib/cosGuard');
const { resolveScanSelection } = require('../companies/registry');
const aiRouter = require('../lib/aiRouter');
const { activeResumeVersion } = require('./resume');
const { suggestTitlesFromResume } = require('../resume/suggestTitles');
const { Router } = require('express');
const { attachSponsors } = require('../visa/sponsorLookup');
const { CANCELLABLE_STATUSES } = require('../lib/cancellation');
const { scoreSelectedJobs, claimJobs, parseJobIds } = require('../scan/scoreSelectedJobs');

const router = Router();

function clampCount(v, range) {
  const n = Number(v) || range.default;
  return Math.max(range.min, Math.min(range.max, Math.round(n)));
}

function buildConfig(body) {
  // Multi-title scans (4.6.15, ATS Direct only) — accepts `job_titles`
  // (array, canonical) or the legacy scalar `job_title` (string). Both are
  // normalized (trim, drop empties, dedupe case-insensitively) the same way
  // via normalizeTitles, so `["a", " a "]` and a single `"a"` behave
  // identically. An array on this field used to throw a 500 here
  // (`[].trim` is undefined) before this change — now explicitly handled.
  const titles = normalizeTitles(Array.isArray(body.job_titles) ? body.job_titles : body.job_title).slice(
    0,
    tunables.atsDirect.maxTitlesPerScan
  );
  if (!titles.length) return { error: 'job_title is required' };

  let posted = Number(body.posted_within_days) || tunables.postedWithinDays;
  posted = Math.max(1, Math.min(30, Math.round(posted)));

  // Selected source (A5: exactly one scraper per scan — the UI enforces a
  // single-select, but the server validates it too). Default = Core Scraper.
  let sources = Array.isArray(body.sources)
    ? body.sources.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (!sources.length) sources = ['cs'];
  if (sources.length > 1) return { error: 'Select only one scraper per scan' };

  // A1: user-chosen minimum score to save, replacing the old fixed floor.
  let threshold = Number(body.threshold);
  if (!Number.isFinite(threshold)) threshold = tunables.dashboardDisplayDefault;
  threshold = Math.max(0, Math.min(10, threshold));

  // Registry ids of the tracked companies this scan is scoped to — §15
  // #25c-2 keeps this as the optional narrow-to-specific-companies
  // sub-picker (also the legacy §24 selector, for a client that never sends
  // tracklist_ids at all) rather than the primary selector. Deduped, empty
  // array normalized to null ("no narrowing" — every company the selected
  // tracklists resolve to). Ignored for any other source.
  const trackedCompanyIds = Array.isArray(body.tracked_company_ids)
    ? [...new Set(body.tracked_company_ids.map((id) => String(id).trim()).filter(Boolean))]
    : [];

  // Tracklist/subscription ids (4.6.6, revised §15 #25c-2) — the PRIMARY
  // selector: any combination of the user's own personal tracklists and any
  // system tracklists they're subscribed to (4.6.8/4.6.9). Defaults to
  // nothing pre-selected (4.6.6's explicit "no silent default" decision at
  // 11k+-company scale) — an empty array here is NOT "all tracked companies"
  // the way an empty tracked_company_ids is; resolveScanSelection treats an
  // empty tracklistIds as "fall back to the legacy listScanCompanies path"
  // (registry.js), which IS "all tracked" — so a client sending neither field
  // still gets §24's original default behavior unchanged.
  const tracklistIds = Array.isArray(body.tracklist_ids)
    ? [...new Set(body.tracklist_ids.map((id) => String(id).trim()).filter(Boolean))]
    : [];

  const isAtsDirect = sources.length === 1 && sources[0] === 'ats_direct';

  // Multi-title (4.6.15) is ATS Direct only — free there (every open posting
  // from a selected company's board is fetched regardless of title count),
  // but Core Scraper/BYO Scraper each build ONE PAID search query per title,
  // so N titles there means N× the sourcing cost and N× the job-count
  // ceiling. Rejected here rather than silently truncated to titles[0], so a
  // caller finds out immediately rather than being quietly billed less scope
  // than requested.
  if (!isAtsDirect && titles.length > 1) return { error: 'Select only one job title per scan for this source' };

  // Multi-location (4.6.6) is ATS Direct only, for the same reason: there it
  // is a free filter over postings already fetched, while Core/BYO Scraper
  // send the location to a paid upstream search as a single query.
  const locations = normalizeTitles(Array.isArray(body.locations) ? body.locations : body.location).slice(
    0,
    tunables.atsDirect.maxLocationsPerScan
  );
  if (!isAtsDirect && locations.length > 1) return { error: 'Select only one location per scan for this source' };

  // Single tracklist per ATS Direct scan (4.6.6, revised 4.6.15) — the
  // rotating cursor is keyed by tracklist + titles (scanCursor.js), so one
  // tracklist per scan keeps each tracklist's rotation independent and easy
  // to reason about, rather than one shared cursor across an arbitrary
  // tracklist combination.
  if (isAtsDirect && tracklistIds.length > 1) return { error: 'Select only one tracklist per scan' };

  // ATS Direct's posted-within default is "any time" (2026-08, maintainer
  // decision, §15 #25c-2) — NOT the tunables.postedWithinDays 3-day default
  // every other source uses, so an existing ATS Direct schedule doesn't
  // silently start filtering the moment this ships. An explicit value is
  // still clamped 1-30 same as any other source; only "not sent at all" means
  // no filtering for this source specifically.
  const atsPostedWithinDays = body.posted_within_days
    ? Math.max(1, Math.min(30, Math.round(Number(body.posted_within_days)) || 0)) || null
    : null;

  return {
    config: {
      // job_title stays the FIRST title (4.6.15) — every pre-existing reader
      // (dashboard header, scan-picker option, schedule row, notification
      // strings, the COS transaction label) keeps working unchanged on both
      // new and legacy scan_history rows. job_titles is the canonical list;
      // multi-title-aware readers should go through scanTitles(config)
      // rather than reading either field directly.
      job_title: titles[0],
      job_titles: titles,
      // 4.1's exception was location-only, corrected §15 #25c-2 — ATS Direct
      // now HAS a location field (4.6.6, revised), it's just optional/
      // additional rather than the sole geography input Core/BYO Scraper use.
      // `locations` is canonical; `location` is its display string for
      // legacy readers (scanLocations/locationLabel in shared/scanTitles.js).
      locations,
      location: locationLabel(locations),
      keywords: (body.keywords || '').trim() || null,
      cs_job_count: clampCount(body.cs_job_count, tunables.csJobCount),
      ld_job_count: clampCount(body.ld_job_count, tunables.ldJobCount),
      ats_job_count: clampCount(body.ats_job_count, tunables.atsDirect.jobCount),
      tracklist_ids: tracklistIds.length ? tracklistIds : null,
      tracked_company_ids: trackedCompanyIds.length ? trackedCompanyIds : null,
      posted_within_days: isAtsDirect ? atsPostedWithinDays : posted,
      visa_filter_on: body.visa_filter_on !== false,
      sources,
      threshold,
      // 'on_demand' (spec 4.7): source + pre-filter only; the user picks which
      // survivors to AI-score afterwards.
      score_mode: constants.normalizeScoreMode(body.score_mode),
    },
  };
}

// POST /api/scan — start a BYO Scraper scan. Runs async (no worker yet, Session
// 12); the client polls GET /api/scan/:id for status.
router.post('/api/scan', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const userId = req.user.id;

    const { config, error } = buildConfig(req.body || {});
    if (error) return res.status(400).json({ error });

    // Per-source config gate (spec 4.2): Core Scraper needs the house JSearch key;
    // any BYO actor needs the credential store. A scan is allowed as long as its
    // selected sources are configured. Core Scraper is also temporarily disabled
    // by product decision (tunables.coreScraperEnabled) — server-enforced, not
    // just hidden in the UI, so it can't be reached by hand-crafting a request.
    if (config.sources.includes('cs') && !tunables.coreScraperEnabled) {
      return res.status(503).json({ error: 'Core Scraper is coming soon — use your own scraper for now.' });
    }
    if (config.sources.includes('cs') && !jsearchAdapter.isConfigured()) {
      return res.status(503).json({ error: 'Core Scraper is not configured on the server yet' });
    }
    // ATS Direct needs no BYOK credential store — house-run against tracked
    // companies (4.6.6), so it's excluded from this BYO Scraper-only gate.
    if (config.sources.some((s) => s !== 'cs' && s !== 'ats_direct') && !cryptoConfigured()) {
      return res.status(503).json({ error: 'BYO Scraper key storage is not configured' });
    }
    if (config.sources.includes('ats_direct')) {
      const { companies } = await resolveScanSelection(db, userId, {
        tracklistIds: config.tracklist_ids,
        registryIds: config.tracked_company_ids,
      });
      if (!companies.length) {
        // A scan that can source nothing should never bill its flat fee.
        return res.status(400).json({
          error: 'Select at least one tracklist (or track a company in Settings) before running an ATS Direct scan',
        });
      }
    }

    const { data: resume } = await db
      .from('resume_versions')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    if (!resume) {
      return res.status(400).json({ error: 'Upload a master resume before scanning' });
    }

    // COS pre-check (spec 13.6, Phase 2 session 13) — only enforced once
    // tunables.enforceCosBalance is true; a no-op check otherwise (13.4).
    const cosCheck = await cosGuard.checkCosBalance(db, userId, 'scan', { sources: config.sources });
    if (!cosCheck.ok) {
      return res.status(402).json({ error: cosGuard.paywallMessage(cosCheck.balance, cosCheck.required) });
    }

    const { data: scan, error: insErr } = await db
      .from('scan_history')
      .insert({ user_id: userId, sources: config.sources, config, status: 'queued' })
      .select('id')
      .single();
    if (insErr) return next(Object.assign(new Error(insErr.message), { status: 500 }));

    // Fire and forget — the scan continues in the background after we respond.
    runScan(scan.id, userId, config).catch((e) => console.error('runScan dispatch error:', e));

    res.status(202).json({ scan_id: scan.id, status: 'queued' });
  } catch (err) {
    next(err);
  }
});

// POST /api/scan/suggest-titles — resume-based job-title suggestions for the
// scan form's "Suggest from my resume" button (4.6.15). Button-triggered
// only (never automatic), one cheap-tier AI call, free action — logged to
// ai_usage_log only, no cos_transactions row, same precedent as resume_parse
// (resume.js). BYOK being off (tunables.aiByokEnabled) is not a blocker:
// aiRouter.resolveAiCredential short-circuits to the platform CAI tier, the
// same seam every other AI feature already runs through.
// POST /api/scans/:id/cancel — stop an in-flight scan.
//
// Cooperative, exactly like the document cancel (lib/cancellation.js): this
// writes the status and the scan notices at its next job boundary. Jobs already
// sourced and scored are KEPT and already billed — a cancel stops the work,
// it does not undo it, and pretending otherwise would mean deleting rows the
// user has already been charged for.
router.post('/api/scans/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { data, error } = await db
      .from('scan_history')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .in('status', CANCELLABLE_STATUSES)
      .select('id, status, jobs_scored_count')
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));

    if (!data) {
      const { data: existing } = await db
        .from('scan_history')
        .select('id, status')
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .maybeSingle();
      if (!existing) return res.status(404).json({ error: 'Scan not found' });
      return res.status(409).json({
        error: `This scan is already ${existing.status} — nothing to cancel.`,
        status: existing.status,
      });
    }

    res.json({ scan: data, cancelling: true });
  } catch (err) {
    next(err);
  }
});

router.post('/api/scan/suggest-titles', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const userId = req.user.id;
    const credential = await aiRouter.resolveAiCredential(db, userId);
    if (credential.mode === 'cai' && !geminiAdapter.isConfigured()) {
      return res.status(503).json({ error: 'AI provider not configured' });
    }

    const resumeVersion = await activeResumeVersion(db, userId);
    if (!resumeVersion || !resumeVersion.parsed_profile) {
      return res.status(400).json({ error: 'Upload a master resume before requesting suggestions' });
    }

    const { titles, usage, costUsd, model, connectionMode } = await suggestTitlesFromResume({
      parsedProfile: resumeVersion.parsed_profile,
      credential,
    });

    const { error: usageErr } = await db.from('ai_usage_log').insert({
      user_id: userId,
      action_type: 'scan_title_suggest',
      provider: credential.mode === 'cai' ? 'gemini' : credential.provider,
      connection_mode: connectionMode,
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cached_tokens: usage.cached_tokens,
      total_tokens: usage.total_tokens,
      raw_usage: usage.raw,
      cost_usd: costUsd,
      related_resume_version_id: resumeVersion.id,
    });
    if (usageErr) console.error('ai_usage_log insert failed:', usageErr.message);

    res.json({ titles });
  } catch (err) {
    next(err);
  }
});

// GET /api/scans — the user's recent scans (most recent first). Read-only list
// so the dashboard can browse past scans; no list endpoint existed before.
router.get('/api/scans', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('scan_history')
      .select(
        'id, status, sources, config, jobs_found_count, jobs_survived_prefilter_count, jobs_scored_count, ' +
          'jobs_above_threshold_count, companies_queried_count, companies_total_count, ' +
          'error_message, started_at, completed_at, created_at'
      )
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));

    // jobs_scored_count counts every job SCORING WAS ATTEMPTED on, including
    // ones deleted afterward for falling below the scan's own threshold (A2) —
    // not what's actually still stored/displayable. The dashboard's per-scan
    // job count needs the latter, so compute it here from the real jobs table.
    // status='scored' only — a row can also sit at 'failed' (scoring never
    // completed, e.g. reapStaleScans sweeping a stranded 'prefiltered' row on
    // scan completion per scheduler.js) or 'prefiltered' (still queued); those
    // have no score data and aren't displayable, so counting them inflated
    // "stored" above jobs_above_threshold_count (confirmed live: 15 above
    // threshold + 2 stranded 'failed' rows = 17 shown as "stored").
    // jobs_unscored_count: an on-demand scan's survivors waiting to be picked
    // (spec 4.7) — 'sourced', or 'scoring' while a picked batch runs.
    // Paged: an on-demand ATS Direct scan alone can hold hundreds of unscored
    // rows, which would push the total past PostgREST's 1000-row page.
    const jobRows = [];
    for (let from = 0; ; from += 1000) {
      const { data: page, error: pageErr } = await db
        .from('jobs')
        .select('scan_history_id, status')
        .eq('user_id', req.user.id)
        .in('status', ['scored', 'sourced', 'scoring'])
        .order('id')
        .range(from, from + 999);
      if (pageErr) return next(Object.assign(new Error(pageErr.message), { status: 500 }));
      jobRows.push(...(page || []));
      if (!page || page.length < 1000) break;
    }
    const storedCounts = {};
    const unscoredCounts = {};
    for (const j of jobRows) {
      if (!j.scan_history_id) continue;
      const bucket = j.status === 'scored' ? storedCounts : unscoredCounts;
      bucket[j.scan_history_id] = (bucket[j.scan_history_id] || 0) + 1;
    }
    const scans = (data || []).map((s) => ({
      ...s,
      jobs_stored_count: storedCounts[s.id] || 0,
      jobs_unscored_count: unscoredCounts[s.id] || 0,
    }));
    res.json({ scans });
  } catch (err) {
    next(err);
  }
});

// GET /api/scan/:id — scan status + counts.
router.get('/api/scan/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('scan_history')
      .select(
        'id, status, sources, config, jobs_found_count, jobs_survived_prefilter_count, jobs_scored_count, ' +
          'jobs_above_threshold_count, companies_queried_count, companies_total_count, ' +
          'progress, error_message, started_at, completed_at, created_at'
      )
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!data) return res.status(404).json({ error: 'Scan not found' });

    // jobs_stored_count (same "attempted vs. actually still stored" distinction
    // as the /api/scans list route above) — a cheap head-count scoped to this
    // one scan, not the list route's fetch-all-rows-then-tally approach, so
    // the mid-scan 3s poll (DashboardView.jsx) can show a live, non-stale count
    // instead of only refreshing on mount/terminal via loadScans().
    const { count: storedCount, error: countErr } = await db
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('scan_history_id', req.params.id)
      .eq('status', 'scored');
    if (countErr) console.error('scan.js: jobs_stored_count query failed:', countErr.message);
    const { count: unscoredCount, error: unscoredErr } = await db
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('scan_history_id', req.params.id)
      .in('status', ['sourced', 'scoring']);
    if (unscoredErr) console.error('scan.js: jobs_unscored_count query failed:', unscoredErr.message);

    res.json({ scan: { ...data, jobs_stored_count: storedCount ?? null, jobs_unscored_count: unscoredCount ?? null } });
  } catch (err) {
    next(err);
  }
});

// GET /api/scan/:id/jobs — the jobs from this scan, with scores + verdict.
router.get('/api/scan/:id/jobs', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('jobs')
      .select(
        'id, title, company_name, company_ats_registry_id, location, posted_at, link, status, sources, seniority_level, employment_type, ' +
          'ats_match, keyword_coverage, callback_odds, overall_fit, note, jd_profile, ' +
          'critical_missing, important_missing, nice_to_have_missing, already_demonstrated, ' +
          'transferable, hidden_strengths, risk_tags, prompt_version, resume_version_id, triage'
      )
      .eq('user_id', req.user.id)
      .eq('scan_history_id', req.params.id)
      .order('overall_fit', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: true });
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    // Verdict stamp (5.2) is derived from overall_fit, not stored.
    // 19.5's Visa Sponsor badge data, in two bulk queries for the whole list.
    const jobs = await attachSponsors(db, (data || []).map((j) => ({ ...j, verdict: verdictFor(j.overall_fit) })));
    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs — every job across all scans (+ manual entries excluded, they
// have their own list), scoped to the user. Backs the dashboard's "All" filter.
router.get('/api/jobs', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('jobs')
      .select(
        'id, title, company_name, company_ats_registry_id, location, posted_at, link, status, sources, seniority_level, employment_type, ' +
          'ats_match, keyword_coverage, callback_odds, overall_fit, note, jd_profile, ' +
          'critical_missing, important_missing, nice_to_have_missing, already_demonstrated, ' +
          'transferable, hidden_strengths, risk_tags, prompt_version, resume_version_id, triage'
      )
      .eq('user_id', req.user.id)
      .order('overall_fit', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: true });
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    // 19.5's Visa Sponsor badge data, in two bulk queries for the whole list.
    const jobs = await attachSponsors(db, (data || []).map((j) => ({ ...j, verdict: verdictFor(j.overall_fit) })));
    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/score — AI-score jobs the user picked from an on-demand
// scan's unscored survivors (spec 4.7). Claims them synchronously (only jobs
// still 'sourced' and owned by the caller move to 'scoring'), responds 202,
// then scores in the background; the dashboard polls the scan's jobs until
// none is left at 'scoring'. Billed into each job's originating scan row.
router.post('/api/jobs/score', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const userId = req.user.id;

    const { ids, error } = parseJobIds(req.body && req.body.job_ids);
    if (error) return res.status(400).json({ error });

    const credential = await aiRouter.resolveAiCredential(db, userId);
    if (credential.mode === 'cai' && !geminiAdapter.isConfigured()) {
      return res.status(503).json({ error: 'AI provider not configured' });
    }
    const resumeVersion = await activeResumeVersion(db, userId);
    if (!resumeVersion || !resumeVersion.parsed_profile) {
      return res.status(400).json({ error: 'Upload a master resume before scoring jobs' });
    }
    const cosCheck = await cosGuard.checkCosBalance(db, userId, 'job_score');
    if (!cosCheck.ok) {
      return res.status(402).json({ error: cosGuard.paywallMessage(cosCheck.balance, cosCheck.required) });
    }

    const claimed = await claimJobs(db, userId, ids, resumeVersion.id);
    if (!claimed.length) {
      return res.status(409).json({ error: 'None of these jobs are waiting to be scored — they may already be scored or in progress.' });
    }

    scoreSelectedJobs(userId, claimed, { db }).catch((e) => console.error('scoreSelectedJobs dispatch error:', e));

    const claimedIds = new Set(claimed.map((j) => j.id));
    res.status(202).json({ scoring: [...claimedIds], skipped: ids.filter((id) => !claimedIds.has(id)) });
  } catch (err) {
    next(err);
  }
});

// Shared delete-one-scan body (2026-08-15: extracted so bulk-delete below can
// call it per id without duplicating the logic) — delete a scan and its
// NOT-YET-ACTED-ON jobs (cascades applications via the jobs FK, but only for
// jobs still deleted). cos_transactions rows survive (pricing calibration,
// spec 13.4) with related_scan_id nulled first — jobs.scan_history_id is ON
// DELETE SET NULL, not cascade, so cleanup must be explicit here (A3).
//
// Bug fix 2026-07-28: this used to delete EVERY job belonging to the scan,
// unconditionally — and applications.job_id is ON DELETE CASCADE, so deleting a
// scan silently wiped the tracker card for any job from it, at ANY stage
// (Applied/Interviewing/Offer included), plus that job's generated_documents
// (also cascade). A user who deleted an old scan to tidy up the dashboard lost
// real applications they'd acted on with zero warning. Fix: only delete jobs
// still sitting at 'Saved' (untouched — exactly what "delete this scan" means
// on the dashboard, a Saved-only triage queue) AND with no generated document.
// Anything the user applied to, moved in the tracker, or generated a résumé/
// cover letter for is kept; scan_history_id on those rows falls back to NULL
// via the existing ON DELETE SET NULL, and they keep showing up in the tracker
// and in "All scans" (GET /api/jobs has no scan_history_id filter).
//
// Returns { notFound: true } for an unowned/missing scan (caller maps that to
// a 404 or a per-item failure entry); otherwise { ok, id, deleted, kept }.
// Throws on a real DB error — the single-scan route below maps that straight
// to a 500, while bulk-delete catches it per item so one failure doesn't sink
// the whole batch.
const DELETE_ID_CHUNK = 150;
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function deleteOneScan(db, userId, scanId) {
  const { data: scan } = await db
    .from('scan_history')
    .select('id')
    .eq('id', scanId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!scan) return { notFound: true };

  // Paged: an on-demand scan (4.7) can hold more rows than one PostgREST page.
  const scanJobs = await selectAllRows(() =>
    db.from('jobs').select('id').eq('scan_history_id', scanId).eq('user_id', userId).order('id', { ascending: true })
  );
  const jobIds = scanJobs.map((j) => j.id);

  let keptCount = 0;
  let deletedCount = jobIds.length;
  if (jobIds.length) {
    // Every id list goes out in chunks. An `.in()` filter travels in the URL,
    // and 769 uuids made a ~28 KB query string the gateway refused, so
    // deleting a large on-demand scan 500'd.
    const keepIds = new Set();
    for (const ids of chunk(jobIds, DELETE_ID_CHUNK)) {
      const [{ data: nonSaved, error: appsErr }, { data: withDocs, error: docsErr }] = await Promise.all([
        db.from('applications').select('job_id').eq('user_id', userId).in('job_id', ids).neq('stage', 'Saved'),
        db.from('generated_documents').select('job_id').eq('user_id', userId).in('job_id', ids),
      ]);
      if (appsErr) throw new Error(appsErr.message);
      if (docsErr) throw new Error(docsErr.message);
      for (const r of [...(nonSaved || []), ...(withDocs || [])]) keepIds.add(r.job_id);
    }
    const deleteIds = jobIds.filter((id) => !keepIds.has(id));
    keptCount = keepIds.size;
    deletedCount = deleteIds.length;

    for (const ids of chunk(deleteIds, DELETE_ID_CHUNK)) {
      const { error: jobsErr } = await db.from('jobs').delete().eq('user_id', userId).in('id', ids);
      if (jobsErr) throw new Error(jobsErr.message);
    }
  }

  const { error: cosErr } = await db
    .from('cos_transactions')
    .update({ related_scan_id: null })
    .eq('related_scan_id', scanId)
    .eq('user_id', userId);
  if (cosErr) throw new Error(cosErr.message);

  const { error: scanErr } = await db.from('scan_history').delete().eq('id', scanId).eq('user_id', userId);
  if (scanErr) throw new Error(scanErr.message);

  return { ok: true, id: scanId, deleted: deletedCount, kept: keptCount };
}

router.delete('/api/scan/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const result = await deleteOneScan(db, req.user.id, req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Scan not found' });
    res.json(result);
  } catch (err) {
    next(Object.assign(err, { status: 500 }));
  }
});

// POST /api/scans/bulk-delete — multi-select delete (2026-08-15 UX pass;
// previously the only way to remove old scans was one two-click button per
// scan). Same per-scan safety rule as the single-delete route above, just
// applied to a list; one scan's DB error doesn't stop the rest of the batch.
const BULK_DELETE_MAX = 100;
router.post('/api/scans/bulk-delete', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map((id) => String(id).trim()).filter(Boolean))] : [];
    if (!ids.length) return res.status(400).json({ error: 'ids is required' });
    if (ids.length > BULK_DELETE_MAX) {
      return res.status(400).json({ error: `Select at most ${BULK_DELETE_MAX} scans at a time` });
    }

    const results = [];
    const failed = [];
    for (const id of ids) {
      try {
        const result = await deleteOneScan(db, req.user.id, id);
        if (result.notFound) failed.push({ id, error: 'Scan not found' });
        else results.push(result);
      } catch (e) {
        failed.push({ id, error: e.message });
      }
    }
    res.json({ results, failed });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.buildConfig = buildConfig;

const { Router } = require('express');
const { getSupabaseAdmin, constants, tunables, normalizeTitles, scanLocations, locationLabel } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const { computeNextRunAt } = require('../scan/scheduler');

// Recurring scan management (spec §12.6): "Repeat this scan" on the New Scan
// modal creates a row here; a simple list under Settings views/pauses/edits/
// deletes them. The scheduler (runDueScans.js, triggered by the GitHub Actions
// cron via POST /api/internal/run-due-scans) is what actually re-runs them.

const router = Router();

const COLS =
  'id, job_title, job_titles, location, locations, keywords, visa_filter_on, sources, threshold, cs_job_count, ld_job_count, ats_job_count, posted_within_days, tracked_company_ids, tracklist_ids, score_mode, frequency, run_at_time, timezone, next_run_at, last_run_at, active, consecutive_skips, created_at';

// A 30-minute slot ("HH:00" or "HH:30") — matches the scheduler's own
// every-30-min claim cron (.github/workflows/scheduler.yml), so a chosen
// time is never finer-grained than what the infra can actually honor.
const RUN_AT_TIME_RE = /^([01]\d|2[0-3]):(00|30)$/;

// A small module-level cache — Intl.supportedValuesOf('timeZone') allocates
// a few hundred strings; no need to redo that on every request.
let VALID_TIMEZONES = null;
function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  if (!VALID_TIMEZONES) VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));
  return VALID_TIMEZONES.has(tz);
}

// Registry/tracklist ids — deduped, empty array normalized to null.
// tracked_company_ids (§15 #24): "all currently tracked" when null, now the
// narrow-to-specific-companies sub-picker under the tracklist selector rather
// than the sole selector. tracklist_ids (§15 #25c-2, 12.3 option (b)): the
// LIVE selection a schedule re-resolves at every run — not a frozen id
// snapshot, so a company added to a subscribed sector after the schedule was
// created is picked up automatically (runDueScans.js's runOneSchedule).
function normalizeIdArray(v) {
  if (!Array.isArray(v)) return null;
  const ids = [...new Set(v.map((id) => String(id).trim()).filter(Boolean))];
  return ids.length ? ids : null;
}

function clampCount(v, range) {
  const n = Number(v) || range.default;
  return Math.max(range.min, Math.min(range.max, Math.round(n)));
}

function clampPostedDays(v) {
  const n = Number(v) || tunables.postedWithinDays;
  return Math.max(1, Math.min(30, Math.round(n)));
}

router.get('/api/scan-schedules', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('scan_schedules')
      .select(COLS)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    res.json({ schedules: data || [] });
  } catch (err) {
    next(err);
  }
});

// POST /api/scan-schedules — create from a New Scan config + frequency. Body:
// { job_title, location?, keywords?, visa_filter_on?, sources[], frequency }.
router.post('/api/scan-schedules', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const b = req.body || {};
    // Multi-title (4.6.15) — same normalizeTitles pass as POST /api/scan's
    // buildConfig, accepting job_titles (array) or the legacy job_title
    // (string).
    const titles = normalizeTitles(Array.isArray(b.job_titles) ? b.job_titles : b.job_title).slice(
      0,
      tunables.atsDirect.maxTitlesPerScan
    );
    if (!titles.length) return res.status(400).json({ error: 'job_title is required' });
    if (!constants.SCAN_FREQUENCIES.includes(b.frequency)) {
      return res.status(400).json({ error: `frequency must be one of: ${constants.SCAN_FREQUENCIES.join(', ')}` });
    }
    const runAtTime = b.run_at_time !== undefined ? b.run_at_time : '09:00';
    if (!RUN_AT_TIME_RE.test(runAtTime)) {
      return res.status(400).json({ error: 'run_at_time must be a 30-minute slot, e.g. "09:00" or "09:30"' });
    }
    const timezone = b.timezone !== undefined ? b.timezone : 'UTC';
    if (!isValidTimezone(timezone)) {
      return res.status(400).json({ error: `timezone "${timezone}" is not a recognized IANA time zone` });
    }
    const sources = Array.isArray(b.sources) ? b.sources.map((s) => String(s).trim()).filter(Boolean) : [];
    if (!sources.length) return res.status(400).json({ error: 'sources is required' });
    if (sources.length > 1) return res.status(400).json({ error: 'Select only one scraper per scan' });

    let threshold = Number(b.threshold);
    if (!Number.isFinite(threshold)) threshold = tunables.dashboardDisplayDefault;
    threshold = Math.max(0, Math.min(10, threshold));

    const isAtsDirect = sources.length === 1 && sources[0] === 'ats_direct';
    // Multi-title is ATS Direct only (see buildConfig's identical check) —
    // Core/BYO Scraper would bill N× per title.
    if (!isAtsDirect && titles.length > 1) {
      return res.status(400).json({ error: 'Select only one job title per scan for this source' });
    }
    // Multi-location (4.6.6) — ATS Direct only, same as buildConfig.
    const locations = normalizeTitles(Array.isArray(b.locations) ? b.locations : b.location).slice(
      0,
      tunables.atsDirect.maxLocationsPerScan
    );
    if (!isAtsDirect && locations.length > 1) {
      return res.status(400).json({ error: 'Select only one location per scan for this source' });
    }
    const tracklistIds = normalizeIdArray(b.tracklist_ids);
    // Single tracklist per ATS Direct scan (4.6.6, revised 4.6.15).
    if (isAtsDirect && tracklistIds && tracklistIds.length > 1) {
      return res.status(400).json({ error: 'Select only one tracklist per scan' });
    }
    // ATS Direct's posted-within default is "any time" (§15 #25c-2, matching
    // POST /api/scan's buildConfig) — only an explicit value gets clamped;
    // absent/0 stays null (no filtering) rather than falling to the 3-day
    // tunable every other source uses.
    const postedWithinDays = isAtsDirect
      ? (b.posted_within_days ? clampPostedDays(b.posted_within_days) : null)
      : clampPostedDays(b.posted_within_days);
    const nextRunAt = computeNextRunAt(b.frequency, new Date(), { runAtTime, timezone }).toISOString();
    const { data, error } = await db
      .from('scan_schedules')
      .insert({
        user_id: req.user.id,
        // job_title stays the first title (legacy readers), job_titles is
        // canonical — same "scalar kept in sync" contract as scan_history's
        // jsonb config (see packages/shared/src/scanTitles.js).
        job_title: titles[0],
        job_titles: titles,
        // 4.1's exception was location-only, corrected §15 #25c-2 (4.6.6,
        // revised) — ATS Direct now has a real location field too.
        // locations is canonical; location is its display string.
        locations: locations.length ? locations : null,
        location: locationLabel(locations),
        keywords: (b.keywords || '').trim() || null,
        visa_filter_on: b.visa_filter_on !== false,
        sources,
        threshold,
        cs_job_count: clampCount(b.cs_job_count, tunables.csJobCount),
        ld_job_count: clampCount(b.ld_job_count, tunables.ldJobCount),
        ats_job_count: clampCount(b.ats_job_count, tunables.atsDirect.jobCount),
        posted_within_days: postedWithinDays,
        tracked_company_ids: normalizeIdArray(b.tracked_company_ids),
        tracklist_ids: tracklistIds,
        score_mode: constants.normalizeScoreMode(b.score_mode),
        frequency: b.frequency,
        run_at_time: runAtTime,
        timezone,
        next_run_at: nextRunAt,
        active: true,
      })
      .select(COLS)
      .single();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    res.status(201).json({ schedule: data });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/scan-schedules/:id — pause/resume (active), or edit frequency
// (recomputes next_run_at from now) / job_title / location / keywords / visa.
router.patch('/api/scan-schedules/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const b = req.body || {};
    const patch = {};

    if (b.active !== undefined) patch.active = Boolean(b.active);
    if (b.frequency !== undefined) {
      if (!constants.SCAN_FREQUENCIES.includes(b.frequency)) {
        return res.status(400).json({ error: `frequency must be one of: ${constants.SCAN_FREQUENCIES.join(', ')}` });
      }
      patch.frequency = b.frequency;
    }
    if (b.run_at_time !== undefined) {
      if (!RUN_AT_TIME_RE.test(b.run_at_time)) {
        return res.status(400).json({ error: 'run_at_time must be a 30-minute slot, e.g. "09:00" or "09:30"' });
      }
      patch.run_at_time = b.run_at_time;
    }
    if (b.timezone !== undefined) {
      if (!isValidTimezone(b.timezone)) {
        return res.status(400).json({ error: `timezone "${b.timezone}" is not a recognized IANA time zone` });
      }
      patch.timezone = b.timezone;
    }
    // Any of frequency/run_at_time/timezone changing needs next_run_at
    // recomputed from the EFFECTIVE post-patch values, not just whichever
    // one field this request happened to touch — same "merge current row +
    // this patch" pattern as the titles/tracklist cross-field check below.
    if (patch.frequency !== undefined || patch.run_at_time !== undefined || patch.timezone !== undefined) {
      const { data: curSchedule, error: curSchedErr } = await db
        .from('scan_schedules')
        .select('frequency, run_at_time, timezone')
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .maybeSingle();
      if (curSchedErr) return next(Object.assign(new Error(curSchedErr.message), { status: 500 }));
      if (!curSchedule) return res.status(404).json({ error: 'Schedule not found' });
      const effFrequency = patch.frequency !== undefined ? patch.frequency : curSchedule.frequency;
      const effRunAtTime = patch.run_at_time !== undefined ? patch.run_at_time : curSchedule.run_at_time;
      const effTimezone = patch.timezone !== undefined ? patch.timezone : curSchedule.timezone;
      patch.next_run_at = computeNextRunAt(effFrequency, new Date(), { runAtTime: effRunAtTime, timezone: effTimezone }).toISOString();
    }
    // Multi-title (4.6.15) — job_titles (array) takes precedence over the
    // legacy job_title (string) if a caller somehow sends both.
    if (b.job_titles !== undefined || b.job_title !== undefined) {
      const titles = normalizeTitles(b.job_titles !== undefined ? b.job_titles : b.job_title).slice(
        0,
        tunables.atsDirect.maxTitlesPerScan
      );
      if (!titles.length) return res.status(400).json({ error: 'job_title is required' });
      patch.job_title = titles[0];
      patch.job_titles = titles;
    }
    if (b.locations !== undefined || b.location !== undefined) {
      const locations = normalizeTitles(b.locations !== undefined ? b.locations : b.location).slice(
        0,
        tunables.atsDirect.maxLocationsPerScan
      );
      patch.locations = locations.length ? locations : null;
      patch.location = locationLabel(locations);
    }
    if (b.keywords !== undefined) patch.keywords = String(b.keywords).trim() || null;
    if (b.visa_filter_on !== undefined) patch.visa_filter_on = b.visa_filter_on !== false;
    if (b.score_mode !== undefined) patch.score_mode = constants.normalizeScoreMode(b.score_mode);
    if (b.sources !== undefined) {
      const sources = Array.isArray(b.sources) ? b.sources.map((s) => String(s).trim()).filter(Boolean) : [];
      if (!sources.length) return res.status(400).json({ error: 'sources cannot be empty' });
      if (sources.length > 1) return res.status(400).json({ error: 'Select only one scraper per scan' });
      patch.sources = sources;
      // 4.1's location exception was ATS-Direct-only and is gone as of §15
      // #25c-2 (4.6.6, revised) — ATS Direct now has a real location field,
      // so switching sources no longer needs to clear it.
    }
    if (b.tracked_company_ids !== undefined) patch.tracked_company_ids = normalizeIdArray(b.tracked_company_ids);
    if (b.tracklist_ids !== undefined) patch.tracklist_ids = normalizeIdArray(b.tracklist_ids);

    // Cross-field validation (4.6.15): multi-title is ATS-Direct-only and a
    // scan may only select one tracklist. A PATCH can change titles/
    // tracklist_ids/sources independently of each other, so when any of them
    // is touched, fetch the row's other current fields to validate the
    // EFFECTIVE post-patch state rather than just this one request body.
    if (patch.job_titles !== undefined || patch.locations !== undefined || patch.tracklist_ids !== undefined || patch.sources !== undefined) {
      const { data: cur, error: curErr } = await db
        .from('scan_schedules')
        .select('sources, job_titles, job_title, locations, location, tracklist_ids')
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .maybeSingle();
      if (curErr) return next(Object.assign(new Error(curErr.message), { status: 500 }));
      if (!cur) return res.status(404).json({ error: 'Schedule not found' });
      const effSources = patch.sources !== undefined ? patch.sources : cur.sources || [];
      const effIsAtsDirect = effSources.length === 1 && effSources[0] === 'ats_direct';
      const effTitles =
        patch.job_titles !== undefined
          ? patch.job_titles
          : cur.job_titles && cur.job_titles.length
          ? cur.job_titles
          : cur.job_title
          ? [cur.job_title]
          : [];
      const effTracklistIds = patch.tracklist_ids !== undefined ? patch.tracklist_ids : cur.tracklist_ids;
      if (!effIsAtsDirect && effTitles.length > 1) {
        return res.status(400).json({ error: 'Select only one job title per scan for this source' });
      }
      const effLocations = patch.locations !== undefined ? patch.locations || [] : scanLocations(cur);
      if (!effIsAtsDirect && effLocations.length > 1) {
        return res.status(400).json({ error: 'Select only one location per scan for this source' });
      }
      if (effIsAtsDirect && effTracklistIds && effTracklistIds.length > 1) {
        return res.status(400).json({ error: 'Select only one tracklist per scan' });
      }
    }

    if (b.threshold !== undefined) {
      const threshold = Number(b.threshold);
      if (!Number.isFinite(threshold)) return res.status(400).json({ error: 'threshold must be a number' });
      patch.threshold = Math.max(0, Math.min(10, threshold));
    }
    if (b.cs_job_count !== undefined) patch.cs_job_count = clampCount(b.cs_job_count, tunables.csJobCount);
    if (b.ld_job_count !== undefined) patch.ld_job_count = clampCount(b.ld_job_count, tunables.ldJobCount);
    if (b.ats_job_count !== undefined) patch.ats_job_count = clampCount(b.ats_job_count, tunables.atsDirect.jobCount);
    // Explicitly clearing (falsy/0) means "any time" — the ATS Direct default
    // (§15 #25c-2); every other source's adapter already falls back to
    // tunables.postedWithinDays on a null/0 value (jsearchAdapter/apifyAdapter's
    // `postedWithinDays || tunables.postedWithinDays`), so this is safe to set
    // uniformly rather than branching on the schedule's source here.
    if (b.posted_within_days !== undefined) {
      patch.posted_within_days = b.posted_within_days ? clampPostedDays(b.posted_within_days) : null;
    }
    // Resuming a paused schedule: also push next_run_at to the future so it
    // doesn't immediately fire for however long it sat paused.
    if (patch.active === true && !patch.next_run_at) {
      const { data: cur } = await db
        .from('scan_schedules')
        .select('frequency, run_at_time, timezone')
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .maybeSingle();
      if (cur) patch.next_run_at = computeNextRunAt(cur.frequency, new Date(), { runAtTime: cur.run_at_time, timezone: cur.timezone }).toISOString();
    }
    if (patch.active === true) patch.consecutive_skips = 0; // resuming clears the skip counter

    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });

    const { data, error } = await db
      .from('scan_schedules')
      .update(patch)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select(COLS)
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!data) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ schedule: data });
  } catch (err) {
    next(err);
  }
});

router.delete('/api/scan-schedules/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('scan_schedules')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select('id')
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!data) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ ok: true, id: data.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

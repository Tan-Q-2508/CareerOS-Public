const { getSupabaseAdmin, tunables, scanTitles, scanLocations, constants } = require('@careeros/shared');
const { runScan } = require('./runScan');
const { claimDueSchedules, checkCosBalance, reapStaleScans, reapStaleOnDemandScoring } = require('./scheduler');
const { insertNotification } = require('../lib/notify');
const { resolveScanSelection } = require('../companies/registry');

// Orchestrates one scheduler pass (spec §12): reap orphaned scans, claim every
// due schedule, then run them SEQUENTIALLY — one scan fully finishes before the
// next starts (§12.7; the domain logic doesn't change if this later moves to a
// real queue, only the execution mechanism would). Never fails a whole pass
// because one schedule/scan had a problem (12.4) — every step is isolated.
//
// Called fire-and-forget from the internal route (the route has already
// responded 202 by the time this runs), so nothing here blocks an HTTP caller.

const AUTO_PAUSE_AFTER_SKIPS = 3;

// Multi-title (4.6.15) display helper for notification strings — a
// scan_schedules row, not a scan_history config, hence the separate small
// helper rather than reusing scanTitles() directly here.
function displayTitle(row) {
  return row.job_titles && row.job_titles.length ? row.job_titles.join(', ') : row.job_title;
}

// Build the same config shape POST /api/scan's buildConfig produces, from a
// saved schedule row (spec §12.1 — identical pipeline, just timer-triggered).
function configFromSchedule(row) {
  const isAtsDirect = Array.isArray(row.sources) && row.sources.length === 1 && row.sources[0] === 'ats_direct';
  // 4.6.15: job_titles is canonical, job_title stays the first title for
  // legacy readers — scanTitles() covers a pre-4.6.15 row that only ever set
  // job_title.
  const titles = scanTitles({ job_title: row.job_title, job_titles: row.job_titles });
  return {
    job_title: titles[0] || row.job_title,
    job_titles: titles,
    // Multi-location (4.6.6): locations is canonical; a pre-multi-location
    // row only has location.
    locations: scanLocations({ locations: row.locations, location: row.location }),
    location: row.location,
    keywords: row.keywords,
    cs_job_count: row.cs_job_count || tunables.csJobCount.default,
    ld_job_count: row.ld_job_count || tunables.ldJobCount.default,
    // §15 #25c-2: scan_schedules.ats_job_count now carries a real per-schedule
    // TARGET (4.6.6's target-with-backfill) — falls back to the tunable
    // default only for a pre-25c-2 row that never set it.
    ats_job_count: row.ats_job_count || tunables.atsDirect.jobCount.default,
    tracked_company_ids: row.tracked_company_ids || null,
    tracklist_ids: row.tracklist_ids || null,
    // ATS Direct's "any time" default (this session) is a real null, not the
    // 3-day tunable every other source falls back to — a schedule row with no
    // posted_within_days set must stay unfiltered for ATS Direct, matching
    // POST /api/scan's buildConfig.
    posted_within_days: row.posted_within_days || (isAtsDirect ? null : tunables.postedWithinDays),
    visa_filter_on: row.visa_filter_on !== false,
    sources: row.sources,
    threshold: row.threshold,
    score_mode: constants.normalizeScoreMode(row.score_mode),
  };
}

// §15 #25c-2 / 12.3's decided option (b): a schedule stores the tracklist/
// subscription SELECTION itself, re-resolved to a live company set at every
// run — not a frozen snapshot. Before dispatching an ATS Direct schedule,
// re-check that its saved tracklist_ids still resolve. Three outcomes:
//   - everything still resolves: run unchanged.
//   - SOME tracklists vanished (deleted, or a subscribed system list the
//     user later unsubscribed from) but at least one selection input still
//     resolves something: narrow tracklist_ids down to what's left, PERSIST
//     that narrowing (so this doesn't re-notify every single run), notify,
//     and continue running against the narrowed set this same pass.
//   - NOTHING resolves at all (every saved tracklist gone, and no narrow
//     registry-id sub-picker to fall back on): pause the schedule and notify
//     — never a silent zero-company run (12.3).
// A schedule with no tracklist_ids at all (every pre-25c-2 row, or one that
// only ever used the narrow tracked_company_ids sub-picker) is untouched —
// resolveScanSelection's own no-tracklistIds branch already falls back to the
// legacy listScanCompanies path unchanged, so there's nothing to narrow.
async function reresolveAtsSelection(db, row) {
  if (!row.tracklist_ids || !row.tracklist_ids.length) return { proceed: true };

  const { resolvedTracklistIds, missingTracklistIds, companies } = await resolveScanSelection(db, row.user_id, {
    tracklistIds: row.tracklist_ids,
    registryIds: row.tracked_company_ids,
  });

  if (!missingTracklistIds.length) return { proceed: true };

  if (!companies.length) {
    await db.from('scan_schedules').update({ active: false }).eq('id', row.id);
    await insertNotification(
      db,
      row.user_id,
      'schedule_auto_paused',
      `Scheduled scan "${displayTitle(row)}" was paused — every tracklist it was scanning has been deleted or unsubscribed. Pick new tracklists in Settings to resume it.`
    );
    return { proceed: false };
  }

  await db.from('scan_schedules').update({ tracklist_ids: resolvedTracklistIds }).eq('id', row.id);
  await insertNotification(
    db,
    row.user_id,
    'schedule_selection_narrowed',
    `Scheduled scan "${displayTitle(row)}" now scans fewer tracklists — ${missingTracklistIds.length} were deleted or unsubscribed since it was created.`
  );
  return { proceed: true, tracklistIds: resolvedTracklistIds };
}

async function runOneSchedule(db, row) {
  // Phase 1 (testing): scheduled scans always run regardless of COS balance —
  // still measured and logged (billed:false) via runScan's normal cos_transactions
  // write, just never gated. tunables.enforceCosBalance flips this back on for
  // Phase 2 without re-plumbing the skip/notification/auto-pause logic below.
  const { ok, balance, required } = tunables.enforceCosBalance
    ? await checkCosBalance(db, row.user_id, row.sources)
    : { ok: true };
  if (!ok) {
    const skips = (row.consecutive_skips || 0) + 1;
    await db.from('scan_schedules').update({ consecutive_skips: skips }).eq('id', row.id);
    await insertNotification(
      db,
      row.user_id,
      'scan_skipped_low_cos',
      `Scheduled scan "${displayTitle(row)}" was skipped — COS balance ${balance} is below the ${required} needed.`
    );
    if (skips >= AUTO_PAUSE_AFTER_SKIPS) {
      await db.from('scan_schedules').update({ active: false }).eq('id', row.id);
      await insertNotification(
        db,
        row.user_id,
        'schedule_auto_paused',
        `Scheduled scan "${displayTitle(row)}" was paused after ${skips} skipped runs — top up COS and resume it in Settings.`
      );
    }
    return { status: 'skipped' };
  }

  if (row.consecutive_skips) {
    await db.from('scan_schedules').update({ consecutive_skips: 0 }).eq('id', row.id);
  }

  // 12.3's live re-resolve, ATS Direct only — narrow+notify or pause+notify
  // BEFORE dispatching, so a deleted tracklist never reaches runScan as a
  // silent zero-company run.
  const isAtsDirect = Array.isArray(row.sources) && row.sources.length === 1 && row.sources[0] === 'ats_direct';
  let effectiveRow = row;
  if (isAtsDirect) {
    const { proceed, tracklistIds } = await reresolveAtsSelection(db, row);
    if (!proceed) return { status: 'paused' };
    if (tracklistIds) effectiveRow = { ...row, tracklist_ids: tracklistIds };
  }

  const config = configFromSchedule(effectiveRow);
  const { data: scan, error: insErr } = await db
    .from('scan_history')
    .insert({ user_id: row.user_id, sources: config.sources, config, status: 'queued' })
    .select('id')
    .single();
  if (insErr) {
    console.error(`runDueScans: could not create scan_history for schedule ${row.id}:`, insErr.message);
    return { status: 'error', error: insErr.message };
  }

  await runScan(scan.id, row.user_id, config); // awaited: sequential per §12.7

  // Best-effort failure notification (12.4's "failed sourcing path is logged and
  // notified"). runScan already isolates per-actor sourcing failures internally
  // (a partial failure doesn't fail the whole scan); this only fires when the
  // scan itself ended failed (e.g. no résumé, total sourcing failure).
  const { data: finished } = await db.from('scan_history').select('status, error_message').eq('id', scan.id).maybeSingle();
  if (finished && finished.status === 'failed') {
    const usedAtsDirect = Array.isArray(row.sources) && row.sources.includes('ats_direct');
    const usedByo = Array.isArray(row.sources) && row.sources.some((s) => s !== 'cs' && s !== 'ats_direct');
    // ats_direct_company_failed is a slight stretch here (its per-company variant
    // fires from inside runScan for individual unreachable boards) but it's the
    // closer fit than byo_actor_failed, which would misreport the source as a
    // BYO Scraper actor when the schedule ran ATS Direct.
    const type = usedAtsDirect ? 'ats_direct_company_failed' : usedByo ? 'byo_actor_failed' : 'scan_skipped_low_cos';
    await insertNotification(
      db,
      row.user_id,
      type,
      `Scheduled scan "${displayTitle(row)}" failed: ${(finished.error_message || 'unknown error').slice(0, 200)}`
    );
  }

  return { status: 'ran', scanId: scan.id };
}

async function runDueScans() {
  const db = getSupabaseAdmin();
  const reaped = await reapStaleScans(db).catch((e) => {
    console.error('runDueScans: reapStaleScans failed:', e.message);
    return 0;
  });
  if (reaped) console.log(`runDueScans: reaped ${reaped} stale running scan(s)`);
  const released = await reapStaleOnDemandScoring(db).catch((e) => {
    console.error('runDueScans: reapStaleOnDemandScoring failed:', e.message);
    return 0;
  });
  if (released) console.log(`runDueScans: released ${released} stale on-demand scoring claim(s)`);

  const claimed = await claimDueSchedules(db);
  console.log(`runDueScans: claimed ${claimed.length} due schedule(s)`);

  const results = [];
  for (const row of claimed) {
    try {
      results.push(await runOneSchedule(db, row));
    } catch (e) {
      console.error(`runDueScans: schedule ${row.id} failed unexpectedly:`, e.message || e);
      results.push({ status: 'error', error: e.message || String(e) });
    }
  }
  return { reaped, claimed: claimed.length, results };
}

module.exports = { runDueScans, runOneSchedule, configFromSchedule, reresolveAtsSelection, AUTO_PAUSE_AFTER_SKIPS };

const { scanTitles, tunables } = require('@careeros/shared');
const cosGuard = require('../lib/cosGuard');

// Pure/DB helpers for the recurring-scan scheduler (spec §12). Kept separate
// from runDueScans.js (the orchestrator) so the date math and the claim/reap
// queries are independently unit-testable without a live scan run.

// --- time-of-day support (2026-08-15) --------------------------------------
// scan_schedules gained run_at_time + timezone so a recurring scan runs at a
// wall-clock time the user actually picked, instead of accidentally
// inheriting whatever moment the schedule was created/last claimed at. No tz
// library dependency — these are the standard two-function technique for
// converting between a local wall clock and a UTC instant using only Intl.

// The UTC-vs-`timeZone` offset (ms) AT a given instant — reads back how that
// instant is displayed in the target zone and diffs it against the instant
// itself. Needed because a fixed IANA zone's offset isn't constant (DST).
function getTzOffsetMs(instantMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(instantMs))) if (p.type !== 'literal') map[p.type] = p.value;
  const asUtc = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return asUtc - instantMs;
}

// Converts a local wall-clock date+time in `timeZone` to the real UTC instant
// it represents. Two-pass: a first guess (treating the wall-clock numbers as
// if they were already UTC) gives an instant close enough to read the zone's
// actual offset near that moment; a second pass re-reads the offset at the
// corrected instant, which resolves the rare case where the first guess
// landed on the wrong side of a DST transition.
function zonedWallClockToUtc(year, month, day, hour, minute, timeZone) {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = getTzOffsetMs(naiveUtc, timeZone);
  let instant = naiveUtc - offset1;
  const offset2 = getTzOffsetMs(instant, timeZone);
  if (offset2 !== offset1) instant = naiveUtc - offset2;
  return new Date(instant);
}

// {year, month, day} of `instant` AS OBSERVED in `timeZone` — "today" in the
// user's own calendar, not UTC's (e.g. 11pm PT on a Monday is already
// Tuesday in UTC, but a "daily at 9am PT" schedule should still treat that
// instant as Monday's occurrence).
function localCalendarDate(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const map = {};
  for (const p of dtf.formatToParts(instant)) if (p.type !== 'literal') map[p.type] = p.value;
  return { year: +map.year, month: +map.month, day: +map.day };
}

// Parses the `time` column's string form ("09:00:00" or "09:00") into
// {hour, minute}. Falls back to 09:00 (the column default) on anything
// unparseable rather than throwing — this only ever pins a wall clock, never
// gates whether a schedule runs at all.
function parseRunAtTime(runAtTime) {
  const m = String(runAtTime || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return { hour: 9, minute: 0 };
  return { hour: Math.max(0, Math.min(23, parseInt(m[1], 10))), minute: Math.max(0, Math.min(59, parseInt(m[2], 10))) };
}

// Plain calendar-digit arithmetic (no timezone attached) — safe to do via
// Date.UTC because there's no DST/offset involved until zonedWallClockToUtc
// pins an actual hour:minute to a zone.
function addLocalDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + n);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function localWeekday({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun..6=Sat
}

// daily -> +1 local day; weekdays -> the next Mon-Fri (skips Sat/Sun, so
// Fri -> Mon); weekly -> +7 local days. Operates on the LOCAL calendar date
// (see localCalendarDate above), not UTC's.
function advanceByFrequency(localDate, frequency) {
  if (frequency === 'daily') return addLocalDays(localDate, 1);
  if (frequency === 'weekdays') {
    let next = addLocalDays(localDate, 1);
    const day = localWeekday(next);
    if (day === 6) next = addLocalDays(next, 2); // Sat -> Mon
    else if (day === 0) next = addLocalDays(next, 1); // Sun -> Mon
    return next;
  }
  if (frequency === 'weekly') return addLocalDays(localDate, 7);
  throw new Error(`computeNextRunAt: unknown frequency "${frequency}"`);
}

// Compute the next occurrence for a schedule's frequency + chosen wall-clock
// time, from a given instant (default now). Always at least one full period
// ahead of `from`'s LOCAL calendar date — a daily schedule created today
// always first fires tomorrow at the chosen time, never later today, which
// matches the pre-2026-08-15 day-granularity contract this replaces (this
// was a deliberate simplicity choice, not a limitation worth complicating
// the function for). `runAtTime`/`timezone` default to the scan_schedules
// column defaults ('09:00'/'UTC') so an old row missing them (pre-migration
// backfill covers real rows, but a caller could still omit the option
// object) degrades to a sane fixed time rather than throwing.
function computeNextRunAt(frequency, from = new Date(), { runAtTime = '09:00', timezone = 'UTC' } = {}) {
  const { hour, minute } = parseRunAtTime(runAtTime);
  const localDate = localCalendarDate(from, timezone);
  let candidate = advanceByFrequency(localDate, frequency);
  let instant = zonedWallClockToUtc(candidate.year, candidate.month, candidate.day, hour, minute, timezone);
  // Guarantee strictly-future relative to `from`, so a schedule never
  // re-claims itself instantly — the one case this can trip is a DST fold
  // landing the pinned wall clock right at/before `from`.
  if (instant.getTime() <= from.getTime()) {
    candidate = advanceByFrequency(candidate, frequency);
    instant = zonedWallClockToUtc(candidate.year, candidate.month, candidate.day, hour, minute, timezone);
  }
  return instant;
}

// Atomically claim every currently-due, active schedule (spec §12.2/§12.7).
// "Claiming" = advancing next_run_at/last_run_at to the NEXT occurrence via a
// conditional UPDATE ... WHERE next_run_at <= now() AND active = true RETURNING
// * — the same predicate used to find due rows, reused as the atomicity guard.
// A row that's already been claimed by an overlapping call no longer matches
// next_run_at <= now() (it was just advanced), so it can't be claimed twice.
// Processed as individual per-row UPDATEs (not a single bulk statement) so a
// row claimed by a concurrent call between selection and update is simply
// skipped here, rather than the whole batch retrying.
async function claimDueSchedules(db) {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await db
    .from('scan_schedules')
    .select(
      'id, user_id, job_title, job_titles, location, locations, keywords, visa_filter_on, sources, threshold, cs_job_count, ld_job_count, ats_job_count, posted_within_days, tracked_company_ids, tracklist_ids, score_mode, frequency, run_at_time, timezone, next_run_at, consecutive_skips'
    )
    .lte('next_run_at', nowIso)
    .eq('active', true);
  if (error) throw error;
  if (!due || !due.length) return [];

  const claimed = [];
  for (const row of due) {
    const nextRunAt = computeNextRunAt(row.frequency, new Date(), { runAtTime: row.run_at_time, timezone: row.timezone }).toISOString();
    const { data: updated, error: upErr } = await db
      .from('scan_schedules')
      .update({ last_run_at: nowIso, next_run_at: nextRunAt })
      .eq('id', row.id)
      .lte('next_run_at', nowIso) // re-checked here: the actual claim guard
      .eq('active', true)
      .select(
        'id, user_id, job_title, job_titles, location, locations, keywords, visa_filter_on, sources, threshold, cs_job_count, ld_job_count, ats_job_count, posted_within_days, tracked_company_ids, tracklist_ids, score_mode, frequency, run_at_time, timezone, consecutive_skips'
      )
      .maybeSingle();
    if (upErr) {
      console.error(`claimDueSchedules: claim failed for ${row.id}:`, upErr.message);
      continue;
    }
    if (updated) claimed.push(updated);
  }
  return claimed;
}

// Minimum COS a run needs to be worth attempting (spec §12.4) — mirrors runScan's
// actual billing branch: a schedule whose sources include Core Scraper bills as
// cs_scan (flat 1); a BYO-only schedule bills as byo_scan (flat 5). This is a
// floor check, not an exact pre-charge — the real cost is metered by runScan.
// Thin wrappers over the shared cosGuard module (session 13 — generalizes this
// exact check to every manually-triggered billable action too, not just
// scheduled scans) — kept as named exports here so runDueScans.js's call sites
// (`checkCosBalance(db, row.user_id, row.sources)`) don't need to change.
function minRequiredCos(sources) {
  return cosGuard.requiredCosFor('scan', { sources });
}

async function checkCosBalance(db, userId, sources) {
  return cosGuard.checkCosBalance(db, userId, 'scan', { sources });
}

// Crash recovery (spec §16): a `running` scan_history row that's gone quiet is
// orphaned (the process restarted/crashed mid-run on Render's free tier) and is
// marked failed rather than left stuck forever, blocking nothing else but no
// longer misleading `GET /api/scan/:id`.
//
// Reaps on `heartbeat_at`, NOT `started_at` (fixed session #26, spec §4.6.12).
// The old `started_at`-based check assumed total scan wall-clock stayed well
// under 30 minutes — true before the concurrent ATS Direct pipeline, but ATS
// Direct's own sourcing budget (tunables.atsDirect.maxRunWallClockMs) is
// ALSO 30 minutes, and scoring runs on top of that. A real, healthy ~43-minute
// run was being falsely marked failed (with a user-facing "scan_orphaned"
// notification) while it was still actively scoring, then flipped back to
// 'completed' moments later by runScan.js's own final mark() — confirmed live
// 2026-08-07/08. scanHeartbeat.js now touches heartbeat_at periodically for the
// FULL duration of a scan (both stages), so a genuinely wedged/crashed scan
// (heartbeat stopped) is distinguishable from a long but healthy one
// (heartbeat still ticking) regardless of total run length.
const STALE_RUNNING_MINUTES = 30;

// F3 follow-up (pre-Phase-5 cleanup, live-verified 2026-08-12): a job can
// also fail per-job scoring (16.8's isolation catch, jobScorer.js) during an
// otherwise-healthy scan that goes on to complete normally — reapStaleScans
// below only ever swept rows under a scan it just reaped, so that row sat at
// 'prefiltered' forever once the scan itself reached 'completed' with nothing
// left to score it. Shared here so both the reap path and runScan.js's normal
// completion path sweep with identical semantics — 'failed' is already a
// valid `jobs.status` value, so no migration is needed. Keyed off a single
// scanId, always called AFTER that scan's own status has already reached a
// terminal state, never on an independent age check.
async function sweepOrphanedPrefilteredJobs(db, scanId) {
  const { error } = await db.from('jobs').update({ status: 'failed' }).eq('scan_history_id', scanId).eq('status', 'prefiltered');
  if (error) console.error(`sweepOrphanedPrefilteredJobs: sweep for scan ${scanId} failed:`, error.message);
}

// On-demand scoring (spec 4.7): POST /api/jobs/score claims jobs by moving
// them 'sourced' -> 'scoring', then scores them in the background. A restart
// mid-batch leaves the unfinished ones at 'scoring' with nothing left to
// finish them — put them back to 'sourced' so the user can pick them again.
// Nothing was billed for a job that never finished (billing happens per job,
// after its score is written). A healthy batch touches each row's updated_at
// only at claim time, so the cutoff sits well above a full batch's run time.
async function reapStaleOnDemandScoring(db) {
  const minutes = tunables.onDemandScoring.staleScoringMinutes;
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('jobs')
    .update({ status: 'sourced' })
    .eq('status', 'scoring')
    .lt('updated_at', cutoff)
    .select('id');
  if (error) throw error;
  return (data || []).length;
}

async function reapStaleScans(db) {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('scan_history')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: 'Orphaned: the process restarted mid-run (no heartbeat for >' + STALE_RUNNING_MINUTES + 'm)',
    })
    .eq('status', 'running')
    .lt('heartbeat_at', cutoff)
    .select('id, user_id, config, jobs_scored_count');
  if (error) throw error;
  const rows = data || [];

  // Surface the crash to the user (2026-07-26) — this reap path runs outside
  // runOneSchedule's normal post-completion check, so without this a silently
  // killed scan would otherwise generate no notification at all. Billing is
  // now incremental (runScan.js), so a reaped scan may well have already been
  // charged for the jobs it got through before it died — say so rather than
  // implying it was free.
  for (const row of rows) {
    const titles = scanTitles(row.config);
    const jobTitle = titles.length ? titles.join(', ') : 'Untitled scan';
    const scoredSoFar = row.jobs_scored_count || 0;
    const billingNote = scoredSoFar > 0
      ? ` You were charged for the ${scoredSoFar} job(s) it scored before it stopped, but not for the rest.`
      : ' No AI scoring had completed yet, but the flat scan fee was already charged.';
    const { error: nErr } = await db.from('notifications').insert({
      user_id: row.user_id,
      type: 'scan_orphaned',
      message: `Scan "${jobTitle}" was interrupted mid-run (the server restarted before it finished) and marked failed.${billingNote}`,
    });
    if (nErr) console.error('reapStaleScans: notification insert failed:', nErr.message);

    // F3 (§16.9 known gap): a scan that dies mid-run can leave `jobs` rows
    // stranded at status='prefiltered' under it forever — reaping the
    // scan_history row above never touched them. Swept here, keyed off THIS
    // specific scan_history id just reaped (never an independent age
    // threshold) — a slow-but-genuinely-still-running scan's prefiltered rows
    // must never be touched, only ones under a scan this same pass just
    // confirmed orphaned via the heartbeat check above.
    await sweepOrphanedPrefilteredJobs(db, row.id);
  }

  return rows.length;
}

// D3 (pre-Phase-5 cleanup batch): old scraped `jobs` rows accumulate forever
// otherwise. Protected = anything the user has actually acted on — an
// `applications` row at any stage OTHER than 'Saved' (every above-threshold
// scored job is auto-inserted at 'Saved', spec's dashboard/tracker
// unification, so 'Saved' alone means "never triaged," not "tracked") — or a
// manual JD entry (spec §4.4 exempts manual entries outright). Keyed on
// `jobs.created_at` (scrape time), not `posted_at` (nullable, the posting's
// own date, not when we found it). `job_dedup_seen` survives independently of
// the `jobs` row it came from, so deleting old rows here can never cause a
// future scan to re-score the same posting and re-spend AI cost on it.
//
// Batched in both directions (candidate lookup AND delete) — this runs across
// every user, so a single unbounded query isn't safe to assume forever, even
// though today's real volume is small. Paged by `id` (not offset) so a page
// that's entirely protected — and therefore never shrinks the candidate set —
// still advances instead of re-fetching the same rows forever.
//
// `dryRun` walks every page exactly like a real run but skips the DELETE,
// returning the full count plus a small sample — a real preview, not a
// one-page guess, since a stale-jobs backlog can easily span many pages.
const CANDIDATE_BATCH_SIZE = 500;
const DRY_RUN_SAMPLE_SIZE = 20;

async function reapExpiredJobs(db, { dryRun = false } = {}) {
  const retentionDays = tunables.jobRetentionDays || 30;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  let totalDeleted = 0;
  const sample = [];
  let afterId = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let query = db.from('jobs').select('id').lt('created_at', cutoff).order('id').limit(CANDIDATE_BATCH_SIZE);
    if (afterId) query = query.gt('id', afterId);
    const { data: candidates, error: candErr } = await query;
    if (candErr) throw candErr;
    if (!candidates || candidates.length === 0) break;

    const candidateIds = candidates.map((c) => c.id);
    afterId = candidateIds[candidateIds.length - 1];

    const [{ data: protectedApps, error: appErr }, { data: manualLinked, error: manualErr }] = await Promise.all([
      db.from('applications').select('job_id').in('job_id', candidateIds).neq('stage', 'Saved'),
      db.from('manual_entries').select('job_id').in('job_id', candidateIds).not('job_id', 'is', null),
    ]);
    if (appErr) throw appErr;
    if (manualErr) throw manualErr;

    const protectedIds = new Set([
      ...(protectedApps || []).map((r) => r.job_id),
      ...(manualLinked || []).map((r) => r.job_id),
    ]);
    const deletableIds = candidateIds.filter((id) => !protectedIds.has(id));

    if (deletableIds.length > 0) {
      if (dryRun) {
        if (sample.length < DRY_RUN_SAMPLE_SIZE) {
          sample.push(...deletableIds.slice(0, DRY_RUN_SAMPLE_SIZE - sample.length));
        }
      } else {
        const { error: delErr } = await db.from('jobs').delete().in('id', deletableIds);
        if (delErr) throw delErr;
      }
      totalDeleted += deletableIds.length;
    }

    if (candidates.length < CANDIDATE_BATCH_SIZE) break;
  }

  return dryRun ? { wouldDelete: totalDeleted, sample } : totalDeleted;
}

// The same reap, for résumé and cover-letter generation.
//
// This exists because of a real incident (2026-09-12): two résumés sat at
// `status: 'running'` for over four hours. Nothing was wrong with them — a
// deploy restarted the server mid-generation and the in-process work died with
// it, exactly the failure reapStaleScans was written for, on a table it did not
// cover. Without this the row is stuck forever: the user sees a spinner that
// will never resolve, and cannot even re-run because the UI believes one is
// already in flight.
//
// `updated_at` is the heartbeat here — no dedicated column needed, because the
// progress logger touches the row at every milestone and the table's
// set_updated_at trigger stamps it. A generation that has not written progress
// in STALE_RUNNING_MINUTES is not slow; it is gone.
//
// Marked 'failed' rather than 'cancelled' on purpose: the user did not ask for
// this, and calling it cancelled would hide a real fault behind a word that
// means "as intended". The message says what happened rather than just that it
// broke.
async function reapStaleGenerations(db) {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('generated_documents')
    .update({
      status: 'failed',
      error_message:
        'Stopped unexpectedly: the server restarted while this was generating. Nothing was charged for the part that did not finish — you can run it again.',
    })
    .in('status', ['queued', 'running'])
    .lt('updated_at', cutoff)
    .select('id, user_id, doc_type');
  if (error) throw error;
  const rows = data || [];
  if (rows.length) {
    console.warn(`reapStaleGenerations: reaped ${rows.length} orphaned generation(s)`);
  }
  return { reaped: rows.length, rows };
}

module.exports = {
  reapStaleOnDemandScoring,
  computeNextRunAt,
  claimDueSchedules,
  checkCosBalance,
  minRequiredCos,
  reapStaleScans,
  reapStaleGenerations,
  reapExpiredJobs,
  sweepOrphanedPrefilteredJobs,
  STALE_RUNNING_MINUTES,
};

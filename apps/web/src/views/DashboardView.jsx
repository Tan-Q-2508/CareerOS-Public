import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useMe } from '../context/MeContext';
import NewScanModal from '../components/NewScanModal';
import ManageScansModal from '../components/ManageScansModal';
import VerdictStamp from '../components/VerdictStamp';
import Spinner from '../components/Spinner';
import ProgressConsole from '../components/ProgressConsole';
import { fmtScore, verdictClass, timeAgo, scanTitleLabel } from '../lib/display';
import VisaSponsorBadge from '../components/VisaSponsorBadge';
import { QuickReadChip, QuickReadSignals } from '../components/QuickRead';

const ACTIVE = new Set(['queued', 'running']);

// A virtual "source" in the selector for manually-entered jobs — they belong to
// no scan but are scored the same way and live in the same Saved queue, so they
// show on the dashboard rather than a separate list (2026-07-21).
const MANUAL = 'manual';

// A virtual "source" combining every scan's jobs into one view (A3).
const ALL = 'all';

// A manual job is done scoring once it leaves 'prefiltered' — 'scored' or
// 'archived' both display; manual entries are exempt from the scan-threshold
// hide/delete behavior entirely (A6).
const MANUAL_DONE = (j) => j.status !== 'prefiltered';

// On-demand scoring (spec 4.7): a job left unscored by choice ('sourced'), or
// one the user picked that is being scored right now ('scoring').
const isUnscored = (j) => j.status === 'sourced' || j.status === 'scoring';
// Mirrors tunables.onDemandScoring.maxJobsPerRequest — the server enforces it.
const MAX_SCORE_BATCH = 25;

// A terminal scan with zero visible jobs can mean several genuinely different
// things — give the real reason instead of always blaming the threshold.
// (Previously always said "scored no jobs at or above threshold," even when
// nothing was ever scored at all — e.g. every posting found was already
// known, or scoring itself never completed for what survived the pre-filter.)
function emptyScanMessage(scan) {
  const threshold = scan?.config?.threshold ?? 6.0;
  const found = scan?.jobs_found_count ?? 0;
  const survived = scan?.jobs_survived_prefilter_count ?? 0;
  const scored = scan?.jobs_scored_count ?? 0;
  const above = scan?.jobs_above_threshold_count ?? 0;
  const locationFiltered = scan?.jobs_location_filtered_count ?? 0;
  const locationUnsure = scan?.jobs_location_unsure_count ?? 0;
  if (found === 0) {
    if (locationFiltered > 0) {
      return `${locationFiltered} posting${locationFiltered === 1 ? '' : 's'} matching your title were excluded by your location filter (${scan?.config?.location || 'set'}) before scoring. Try widening it — a broader city, state, or country.${locationUnsure ? ` (${locationUnsure} more were kept as unsure and still found nothing else to add.)` : ''}`;
    }
    return 'This scan found no postings for this search. Try a different title, location, or a broader posted-within window.';
  }
  if (survived === 0) {
    const locationNote = locationFiltered > 0 ? ` ${locationFiltered} posting${locationFiltered === 1 ? '' : 's'} were also excluded by your location filter before reaching this stage.` : '';
    return `Found ${found} posting${found === 1 ? '' : 's'}, but none were new — every one was already in your history (previously scored or seen) or was filtered out by the pre-filter (visa, seniority, or domain check). Nothing left to score this time.${locationNote}`;
  }
  if (scored === 0 && scan?.config?.score_mode === 'on_demand') {
    return `${survived} posting${survived === 1 ? '' : 's'} passed the pre-filter, but none are waiting to be scored — they have all been scored or set aside already.`;
  }
  if (scored === 0) {
    return `${survived} posting${survived === 1 ? '' : 's'} passed the pre-filter, but none were successfully scored — this can happen after a temporary scoring error. Try running the scan again.`;
  }
  // Distinguish "scored, but all landed below this scan's own threshold" (the
  // expected, common case — nothing went wrong) from a genuine scoring
  // failure, which the branch above already covers. Previously this case fell
  // through to the same "temporary scoring error" copy as scored===0, which
  // misattributed an ordinary low-fit result to a bug (§26 fix).
  if (scan?.jobs_above_threshold_count != null && above === 0) {
    return `This scan scored ${scored} job${scored === 1 ? '' : 's'}; all ${scored === 1 ? 'of it fell' : 'of them fell'} below its ${threshold} threshold, so none were kept.`;
  }
  return `This scan scored ${scored} job${scored === 1 ? '' : 's'}, but none met its ${threshold} threshold. Try a lower minimum score on your next scan, or a different search.`;
}

// The funnel line shared by the running-scan console and the persistent
// summary strip below it — companies queried/total (ATS Direct only, null for
// CS/BYO), found, survived pre-filter, scored, and above-threshold. Renders
// "—" for any counter this scan predates (nullable columns, no backfill) or
// that source never populates.
function scanFunnelText(scan) {
  const n = (v) => (v == null ? '—' : v.toLocaleString());
  const parts = [];
  if (scan.companies_total_count != null) {
    parts.push(`Companies ${n(scan.companies_queried_count)} / ${n(scan.companies_total_count)}`);
  }
  parts.push(`found ${n(scan.jobs_found_count)}`);
  parts.push(`survived pre-filter ${n(scan.jobs_survived_prefilter_count)}`);
  if (scan?.config?.score_mode === 'on_demand') {
    // Scoring happens later, job by job, so the scan's own counters stop at
    // the pre-filter; what is left to pick is the live count.
    if (scan.jobs_unscored_count != null) parts.push(`not scored yet ${n(scan.jobs_unscored_count)}`);
    if (scan.jobs_stored_count != null) parts.push(`scored ${n(scan.jobs_stored_count)}`);
    return parts.join(' · ');
  }
  parts.push(`scored ${n(scan.jobs_scored_count)}`);
  const threshold = scan?.config?.threshold;
  parts.push(`above ${threshold != null ? threshold : '—'} → ${n(scan.jobs_above_threshold_count)}`);
  return parts.join(' · ');
}

// Console lines for a running scan: the server's milestone log (sourcing ->
// prefilter -> scoring), plus a trailing live funnel line. Previously gated
// on `jobs_found_count != null`, which meant an ATS Direct run — whose
// jobs_found_count doesn't land until the entire run is over — showed no
// counter line at all for its full 30-45 minute duration even though
// companies/found/survived/scored were all updating live in the DB the whole
// time (§26 regression, fixed here: always show the funnel, not just once a
// value happens to be non-null).
function scanProgressLines(scan) {
  const entries = (scan.progress || []).map((e) => ({ text: e.label }));
  if (!entries.length) entries.push({ text: 'Starting…' });
  entries.push({ text: scanFunnelText(scan) });
  return entries;
}

// Persistent funnel summary — same numbers as scanProgressLines' trailing
// line, but rendered independent of ProgressConsole so they survive past the
// scan going terminal (the console hides itself once a scan is done, and
// before this fix nothing replaced it — a finished scan's counts were simply
// gone). Shown for any selected real scan, running or terminal.
function ScanSummaryStrip({ scan }) {
  if (scan?.config?.score_mode === 'on_demand') {
    return (
      <div className="filter-row" style={{ marginTop: -6, fontSize: 12, color: 'var(--text-dim)' }}>
        <span>{scanFunnelText(scan)}</span>
      </div>
    );
  }
  const scored = scan.jobs_scored_count ?? 0;
  const above = scan.jobs_above_threshold_count;
  const below = above != null ? Math.max(0, scored - above) : null;
  const stored = scan.jobs_stored_count;
  return (
    <div className="filter-row" style={{ marginTop: -6, fontSize: 12, color: 'var(--text-dim)' }}>
      <span>
        {scanFunnelText(scan)}
        {below != null ? ` · below threshold ${below.toLocaleString()} (not stored)` : ''}
        {stored != null ? ` · stored ${stored.toLocaleString()}` : ''}
      </span>
    </div>
  );
}

// Card badge from the job's source: cs → CS, byo → BYO, manual → MANUAL,
// ats_direct → ATS. C4 (bug #11): this used to fall through to 'BYO' for any
// unrecognized source, including 'ats_direct' — the backend already writes
// that value correctly (atsDirectPipeline.js), the label here just never
// handled it.
function sourceBadge(job, isManual) {
  const s = Array.isArray(job.sources) ? job.sources[0] : null;
  if (s === 'cs') return 'CS';
  if (s === 'manual' || isManual) return 'MANUAL';
  if (s === 'ats_direct') return 'ATS';
  if (s === 'byo') return 'BYO';
  return '—';
}

// C5 (bug #12): resolve a scan's config.tracklist_ids (already persisted and
// already returned by the scan endpoints — no backend change needed) to the
// tracklist name(s) it ran from, via the id->name map built from
// listTracklists()/listSystemTracklists() below. Returns null for a scan with
// no tracklist_ids (every non-ATS-Direct source, or an ATS Direct scan that
// ran against individually-picked companies rather than a tracklist).
function tracklistLabelFor(scan, namesById) {
  const ids = scan && scan.config && scan.config.tracklist_ids;
  if (!Array.isArray(ids) || !ids.length) return null;
  const names = ids.map((id) => namesById[id]).filter(Boolean);
  if (!names.length) return null;
  return `from ${names.join(', ')}`;
}

export default function DashboardView() {
  const navigate = useNavigate();
  const { refresh: refreshMe } = useMe();
  const [searchParams, setSearchParams] = useSearchParams();

  const [scans, setScans] = useState(null);
  // Selected scan lives in the URL (?scan=<id>|all|manual), not just component
  // state — a job card opened from an older scan used to reset to the newest
  // scan on `navigate(-1)` back, since DashboardView remounted fresh and
  // re-picked scans[0] (2026-07-27 fix). selectScan below is the only writer;
  // it updates the URL with `replace` so browsing scans doesn't pile up
  // history entries, while still persisting across the mount/unmount that
  // visiting a job causes.
  const [selectedId, setSelectedIdRaw] = useState(() => searchParams.get('scan') || null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selectScan = useCallback(
    (id) => {
      setSelectedIdRaw(id);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set('scan', id);
          else next.delete('scan');
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );
  const [selectedScan, setSelectedScan] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [error, setError] = useState(null);
  const [cancellingScan, setCancellingScan] = useState(false);
  const [activeResumeId, setActiveResumeId] = useState(null);
  // job_id -> application stage. The dashboard is the "Saved" triage queue, so a
  // job is shown only while its application is still 'Saved'; acting on it
  // (Not for me / forward move / email-detected apply) drops it from here.
  const [stageByJob, setStageByJob] = useState({});
  const [hasManual, setHasManual] = useState(false);
  const [showManageScans, setShowManageScans] = useState(false);
  // On-demand scoring (spec 4.7): which unscored jobs are ticked, which subset
  // of the list is shown, and whether a Score request is in flight.
  const [pickedIds, setPickedIds] = useState(() => new Set());
  const [scoreFilter, setScoreFilter] = useState('all');
  const [startingScore, setStartingScore] = useState(false);
  const pollRef = useRef(null);
  // C5: id -> name map, covering both personal/subscribed tracklists and every
  // system tracklist (even ones the user isn't currently subscribed to, so a
  // past scan's tracklist still resolves a name after unsubscribing).
  const [tracklistNames, setTracklistNames] = useState({});

  const isManual = selectedId === MANUAL;
  const isAll = selectedId === ALL;

  const loadStages = useCallback(async () => {
    try {
      const { applications } = await api.listApplications();
      setStageByJob(Object.fromEntries(applications.map((a) => [a.job_id, a.stage])));
    } catch {
      /* non-fatal: fall back to showing all scored jobs */
    }
  }, []);

  const loadScans = useCallback(async () => {
    const { scans } = await api.listScans();
    setScans(scans);
    return scans;
  }, []);

  useEffect(() => {
    loadScans()
      .then((list) => {
        // Only default to the newest scan if nothing is already selected — a
        // ?scan= param from the URL (initial state above) wins.
        if (list.length && !selectedIdRef.current) selectScan(list[0].id);
      })
      .catch((e) => setError(e.message));
    // Active résumé version — used to flag jobs scored against an older one (4.5).
    api
      .getResume()
      .then(({ resume_version }) => setActiveResumeId(resume_version?.id || null))
      .catch(() => {});
    // Whether the "Manually entered" source should appear in the selector.
    api
      .listManualJobs()
      .then(({ jobs }) => setHasManual(jobs.some(MANUAL_DONE)))
      .catch(() => {});
    // C5: build the tracklist id->name map once — cheap, small lists.
    Promise.all([api.listTracklists(), api.listSystemTracklists()])
      .then(([personal, system]) => {
        const map = {};
        for (const t of personal.tracklists || []) map[t.id] = t.name;
        for (const t of system.tracklists || []) map[t.id] = t.name;
        setTracklistNames(map);
      })
      .catch(() => {});
  }, [loadScans]);

  // Load the selected scan's status + jobs; poll while it's still running.
  useEffect(() => {
    if (!selectedId) {
      setSelectedScan(null);
      setJobs([]);
      return;
    }
    let cancelled = false;
    setPickedIds(new Set());
    setScoreFilter('all');
    // Clear the previous selection's jobs before loading the new one, so a
    // briefly-stale job list never renders under the newly selected scan's
    // status banner (A7).
    setJobs([]);

    // Manually-entered jobs: no scan, no polling — just load the finished ones
    // (any status but 'prefiltered' — manual entries skip the threshold hide,
    // A6).
    if (selectedId === MANUAL) {
      setSelectedScan(null);
      setLoadingJobs(true);
      api
        .listManualJobs()
        .then(({ jobs }) => {
          if (cancelled) return;
          setJobs(jobs.filter(MANUAL_DONE));
          setLoadingJobs(false);
          loadStages();
        })
        .catch((e) => {
          if (!cancelled) {
            setError(e.message);
            setLoadingJobs(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }

    // Combined view across every scan (A3).
    if (selectedId === ALL) {
      setSelectedScan(null);
      setLoadingJobs(true);
      api
        .listAllJobs()
        .then(({ jobs }) => {
          if (cancelled) return;
          setJobs(jobs);
          setLoadingJobs(false);
          loadStages();
        })
        .catch((e) => {
          if (!cancelled) {
            setError(e.message);
            setLoadingJobs(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }

    async function tick() {
      try {
        const { scan } = await api.getScan(selectedId);
        if (cancelled) return;
        setSelectedScan(scan);

        if (ACTIVE.has(scan.status)) {
          // Still sourcing/scoring — pull the jobs table anyway so already-scored
          // jobs show up immediately, instead of waiting for the whole scan to
          // finish. GET /api/scan/:id/jobs returns every job for the scan
          // regardless of status; unscored ones have overall_fit=null and are
          // naturally excluded by the threshold filter below.
          try {
            const { jobs } = await api.getScanJobs(selectedId);
            if (!cancelled) {
              setJobs(jobs);
              loadStages();
            }
          } catch {
            /* non-fatal mid-scan — next poll tick will retry */
          }
          pollRef.current = setTimeout(tick, 3000);
          return;
        }
        // Terminal: load the final job list, refresh sidebar balance + scan counts.
        setLoadingJobs(true);
        const { jobs } = await api.getScanJobs(selectedId);
        if (cancelled) return;
        setJobs(jobs);
        setLoadingJobs(false);
        loadStages();
        refreshMe().catch(() => {});
        loadScans().catch(() => {});
      } catch (e) {
        if (!cancelled) {
          setError(e.message);
          setLoadingJobs(false);
        }
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Re-fetch the current view's jobs (not the scan row) — used while picked
  // jobs are being scored after the scan itself has finished.
  const reloadJobs = useCallback(async () => {
    const id = selectedIdRef.current;
    if (!id || id === MANUAL) return;
    try {
      const { jobs: fresh } = id === ALL ? await api.listAllJobs() : await api.getScanJobs(id);
      if (selectedIdRef.current !== id) return;
      setJobs(fresh);
      loadStages();
      if (!fresh.some((j) => j.status === 'scoring')) {
        refreshMe().catch(() => {});
        loadScans().catch(() => {});
        if (id !== ALL) {
          api
            .getScan(id)
            .then(({ scan }) => selectedIdRef.current === id && setSelectedScan(scan))
            .catch(() => {});
        }
      }
    } catch {
      /* next tick retries */
    }
  }, [loadStages, loadScans, refreshMe]);

  // Poll while any picked job is still being scored. The running-scan tick
  // above already polls during a scan; this covers the usual case of scoring
  // picks from a scan that has finished.
  const anyScoring = jobs.some((j) => j.status === 'scoring');
  const scanStillRunning = !!(selectedScan && ACTIVE.has(selectedScan.status));
  useEffect(() => {
    if (!anyScoring || scanStillRunning) return undefined;
    const t = setTimeout(reloadJobs, 3000);
    return () => clearTimeout(t);
  }, [anyScoring, scanStillRunning, jobs, reloadJobs]);

  function togglePick(jobId) {
    setPickedIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  async function scorePicked() {
    const ids = jobs.filter((j) => pickedIds.has(j.id) && j.status === 'sourced').map((j) => j.id);
    if (!ids.length || startingScore) return;
    setStartingScore(true);
    setError(null);
    try {
      const { scoring } = await api.scoreJobs(ids);
      const claimed = new Set(scoring || []);
      setJobs((list) => list.map((j) => (claimed.has(j.id) ? { ...j, status: 'scoring' } : j)));
      setPickedIds(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setStartingScore(false);
    }
  }

  function onScanStarted(scanId) {
    setShowModal(false);
    setError(null);
    setJobs([]);
    loadScans().catch(() => {});
    selectScan(scanId);
  }

  // Multi-select scan deletion (2026-08-15, replaces the old one-at-a-time
  // "Delete this scan" button) — reload the scan list after the modal
  // finishes, and if the currently-viewed scan was among the deleted ones,
  // fall back to a scan that still exists rather than pointing at nothing.
  async function handleScansDeleted() {
    const list = await loadScans().catch(() => []);
    if (selectedId && !(list || []).some((s) => s.id === selectedId)) {
      selectScan(list && list.length ? ALL : null);
    }
  }

  const cfg = selectedScan?.config || {};
  const scanBusy = selectedScan && ACTIVE.has(selectedScan.status);
  const scanFailed = selectedScan?.status === 'failed';

  // Cooperative cancel (server: lib/cancellation.js). This writes the status;
  // the scan's own polling already running in this view is what reports the
  // real end state, so nothing here fakes a stopped scan.
  async function cancelSelectedScan() {
    if (!selectedScan || cancellingScan) return;
    setCancellingScan(true);
    try {
      await api.cancelScan(selectedScan.id);
    } catch (e) {
      setCancellingScan(false);
      // A 409 means it finished on its own a moment ago; the poll is about to
      // say so, and an error banner for that would be noise.
      if (!/already|nothing to cancel/i.test(e.message || '')) setError(e.message);
    }
  }
  // A7: "N scored" must count only jobs that actually have a score, never raw
  // jobs.length (which, mid-scan, also includes not-yet-scored prefiltered
  // rows). Deriving straight from the fetched jobs — rather than falling back
  // to selectedScan.jobs_scored_count ?? jobs.length — avoids a real
  // regression: jobs_scored_count is null (not 0) before the first job
  // finishes scoring, so `??` fell through to jobs.length and re-created the
  // exact "N scored" conflation this was meant to fix, in the early-scan case.
  const scoredCount = jobs.filter((j) => j.overall_fit != null).length;
  // Job counts shown in the scan selector — jobs_stored_count (from GET
  // /api/scans) is the actual current row count for that scan, not
  // jobs_scored_count (every job scoring was ATTEMPTED on, including ones
  // deleted afterward for falling below the scan's threshold, A2). Using the
  // attempted count here previously showed e.g. "3 jobs" for a scan that
  // displays zero, since all 3 scored below its own threshold and got deleted.
  const totalStoredAcrossScans = (scans || []).reduce((sum, s) => sum + (s.jobs_stored_count || 0), 0);

  // Show a job only while it's still in the Saved bucket (or not yet tracked —
  // e.g. auto-populate momentarily lagging). Triaged jobs drop off.
  //
  // Bug fix (2026-07-28): a not-yet-scored job has overall_fit=null, and
  // Number(null) is 0 — so at threshold 0 it used to slip through the score
  // check below and count toward "visible", producing a nonsensical "Showing
  // 28 of 1 scored so far…" (28 unscored + scored jobs vs. scoredCount's 1
  // real score). While a scan is still running, unscored jobs are hidden
  // outright — the ProgressConsole above is the only in-flight signal, this
  // list should only ever show real results. Once the scan is terminal, an
  // unscored row (there shouldn't normally be one) falls back to the old
  // behavior of only showing at threshold 0.
  //
  // On-demand scans (spec 4.7) are the exception: their 'sourced' rows ARE
  // the result, so they show while the scan runs, sorted by Quick read rank
  // after every scored job.
  const inQueue = jobs.filter((j) => {
    const scored = j.overall_fit != null;
    if (!scored && !isUnscored(j) && scanBusy) return false;
    const stage = stageByJob[j.id];
    return stage === undefined || stage === 'Saved';
  });
  const queueUnscored = inQueue.filter(isUnscored);
  const visible = inQueue
    .filter((j) => (scoreFilter === 'scored' ? !isUnscored(j) : scoreFilter === 'unscored' ? isUnscored(j) : true))
    .sort((a, b) => {
      const ua = isUnscored(a);
      const ub = isUnscored(b);
      if (ua !== ub) return ua ? 1 : -1;
      return ua ? (b.triage?.rank ?? -1) - (a.triage?.rank ?? -1) : 0;
    });
  const visibleScoredCount = visible.filter((j) => j.overall_fit != null).length;
  const visibleUnscoredCount = visible.filter((j) => j.overall_fit == null).length;
  const pickable = queueUnscored.filter((j) => j.status === 'sourced');
  const pickedCount = pickable.filter((j) => pickedIds.has(j.id)).length;
  const strongIds = pickable.filter((j) => j.triage?.band === 'strong').map((j) => j.id);

  // "Not for me": move the job to Deemed Not Suitable → it leaves the dashboard.
  const notForMe = useCallback(async (jobId) => {
    setStageByJob((m) => ({ ...m, [jobId]: 'Deemed Not Suitable' }));
    try {
      await api.markNotForMe(jobId);
    } catch (e) {
      setError(e.message);
      loadStages();
    }
  }, [loadStages]);

  // A user with only manual jobs (no scans) defaults to the manual view.
  useEffect(() => {
    if (!selectedId && hasManual && scans && scans.length === 0) selectScan(MANUAL);
  }, [selectedId, hasManual, scans, selectScan]);

  return (
    <div>
      {/* C2 (bug #8): a stable toolbar region — title, sub-line, and every
          scan action live in fixed positions here. */}
      <div className="view-header">
        <div>
          <div className="view-title">
            {isManual ? 'Manually entered' : isAll ? 'All scans' : selectedScan ? scanTitleLabel(cfg) : 'Dashboard'}
          </div>
          <div className="view-sub">
            {isManual
              ? 'Jobs you pasted in — scored the same way and triaged here.'
              : isAll
              ? 'Every scored job across all your scans, combined.'
              : selectedScan
              ? [cfg.location, timeAgo(selectedScan.created_at), tracklistLabelFor(selectedScan, tracklistNames)]
                  .filter(Boolean)
                  .join(' · ')
              : 'Run a scan to see scored jobs.'}
          </div>
        </div>
        <div className="view-toolbar-actions">
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>
            Run New Scan
          </button>
          {/* Only while a scan is actually in flight — a permanently-disabled
              Cancel next to Run New Scan would read as an option that never
              works. Cooperative: the scan stops at its next job boundary, and
              everything it already found and scored is kept. */}
          {scanBusy && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={cancelSelectedScan}
              disabled={cancellingScan}
              title="Stop this scan. Jobs it has already found and scored are kept."
            >
              {cancellingScan ? 'Cancelling…' : 'Cancel scan'}
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setShowManageScans(true)}
            disabled={!scans || !scans.length}
            title="View, select, and delete scans"
          >
            Manage scans
          </button>
        </div>
      </div>

      {((scans && scans.length > 0) || hasManual) && (
        <div className="filter-row">
          <span>View:</span>
          <select value={selectedId || ''} onChange={(e) => selectScan(e.target.value)}>
            {scans && scans.length > 0 && <option value={ALL}>◆ All scans · {totalStoredAcrossScans} jobs</option>}
            {(scans || []).map((s) => {
              // The list (`scans`) only refreshes on mount/terminal via
              // loadScans() — for the currently selected scan, prefer the
              // live polled value on `selectedScan` so a running scan's
              // count in this dropdown isn't stuck at "0 jobs" for its whole
              // duration (§26 fix).
              const stored = s.id === selectedId && selectedScan ? selectedScan.jobs_stored_count : s.jobs_stored_count;
              return (
                <option key={s.id} value={s.id}>
                  {scanTitleLabel(s.config)} · {timeAgo(s.created_at)} · {stored ?? 0} jobs
                  {(() => {
                    const unscored = s.id === selectedId && selectedScan ? selectedScan.jobs_unscored_count : s.jobs_unscored_count;
                    return unscored ? ` · ${unscored} to score` : '';
                  })()}
                  {ACTIVE.has(s.status) ? ' (running)' : ''}
                </option>
              );
            })}
            {hasManual && <option value={MANUAL}>✎ Manually entered</option>}
          </select>
        </div>
      )}

      {/* Persistent funnel summary — unlike ProgressConsole below, this stays
          visible once the scan is terminal, so the numbers a finished scan
          produced aren't simply gone the moment the console hides itself
          (§26 fix). C2 (bug #8): gated to terminal-status scans only — while
          ProgressConsole is showing (scanBusy||scanFailed) it already renders
          this exact same funnel line as its trailing console line, so both
          used to render simultaneously during a running scan. */}
      {!isManual && !isAll && selectedScan && !scanBusy && !scanFailed && <ScanSummaryStrip scan={selectedScan} />}

      {error && <div className="error-text">{error}</div>}

      {/* Empty: no scans ever */}
      {scans && scans.length === 0 && !error && !isManual && !isAll && (
        <div className="empty-state">
          No scans yet. Click <strong>Run New Scan</strong> to source and score jobs against
          your résumé{hasManual ? ', or pick "Manually entered" above' : ''}.
        </div>
      )}

      {/* Running/failed scan progress — results stream in as job cards below as
          each one finishes, so this is a status console, not a full-screen
          blocker. Hidden once the scan is simply done; the job list is the result. */}
      {(scanBusy || scanFailed) && (
        <ProgressConsole
          sections={[
            scanFailed
              ? { id: 'scan', title: 'Scan', tone: 'err', lines: [{ text: selectedScan.error_message || 'Scan failed.' }] }
              : { id: 'scan', title: 'Scan', tone: 'running', lines: scanProgressLines(selectedScan) },
          ]}
        />
      )}

      {/* Loading jobs (first load only — not the mid-scan poll, which fetches
          silently so the banner above doesn't flicker to a spinner every 3s). */}
      {loadingJobs && !scanBusy && (
        <div className="empty-state">
          <Spinner /> &nbsp;Loading results…
        </div>
      )}

      {/* Results — shown as soon as ANY job has a score, whether the scan is
          still running or already finished. */}
      {!scanFailed && !loadingJobs && (selectedScan || isManual || isAll) && jobs.length > 0 && (
        <>
          {queueUnscored.length > 0 && (
            <div className="selection-bar">
              <span>
                {pickedCount} of {pickable.length} unscored picked
                {pickedCount > MAX_SCORE_BATCH ? ` — score up to ${MAX_SCORE_BATCH} at a time` : ''}
              </span>
              <button
                type="button"
                className="btn btn-primary"
                onClick={scorePicked}
                disabled={!pickedCount || pickedCount > MAX_SCORE_BATCH || startingScore}
                title="AI-score the picked jobs against your résumé. Each one is kept whatever it scores."
              >
                {startingScore ? 'Starting…' : pickedCount ? `Score ${pickedCount} selected` : 'Score selected'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setPickedIds(new Set(strongIds.slice(0, MAX_SCORE_BATCH)))}
                disabled={!strongIds.length}
              >
                Pick strong matches{strongIds.length ? ` (${Math.min(strongIds.length, MAX_SCORE_BATCH)})` : ''}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setPickedIds(new Set())} disabled={!pickedCount}>
                Clear
              </button>
              <span className="spacer" />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                Show
                <select
                  value={scoreFilter}
                  onChange={(e) => setScoreFilter(e.target.value)}
                  style={{ width: 'auto', margin: 0, padding: '4px 8px' }}
                >
                  <option value="all">All</option>
                  <option value="unscored">Not scored yet</option>
                  <option value="scored">Scored</option>
                </select>
              </label>
            </div>
          )}
          {visible.length === 0 && scoreFilter !== 'all' ? (
            <div className="empty-state">Nothing to show for this filter.</div>
          ) : visible.length === 0 ? (
            <div className="empty-state">
              {scoredCount} job{scoredCount === 1 ? '' : 's'} scored{scanBusy ? ' so far' : ''}, but
              none are left in the Saved queue — they've already been triaged elsewhere.
            </div>
          ) : (
            <>
              <div className="filter-row" style={{ marginTop: -6 }}>
                <span>
                  Showing {visibleScoredCount} of {scoredCount} scored{scanBusy ? ' so far…' : ''}
                  {visibleUnscoredCount > 0 ? ` · ${visibleUnscoredCount} not yet scored` : ''}
                </span>
              </div>
              {visible.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  source={sourceBadge(job, isManual)}
                  stale={activeResumeId && job.resume_version_id && job.resume_version_id !== activeResumeId}
                  onOpen={() =>
                    isManual
                      ? navigate(`/job/${job.id}`)
                      : navigate(`/scan/${selectedId}/job/${job.id}`, { state: { job } })
                  }
                  onNotForMe={() => notForMe(job.id)}
                  picked={pickedIds.has(job.id)}
                  onTogglePick={() => togglePick(job.id)}
                />
              ))}
            </>
          )}
        </>
      )}

      {/* Terminal "nothing scored at all" — only once the scan is actually done. */}
      {!scanBusy && !scanFailed && !loadingJobs && (selectedScan || isManual || isAll) && jobs.length === 0 && (
        <div className="empty-state">
          {isManual
            ? 'No manually-entered jobs yet. Use Manual Entry to paste a job description.'
            : isAll
            ? 'No scored jobs yet across any scan.'
            : emptyScanMessage(selectedScan)}
        </div>
      )}

      {showModal && (
        <NewScanModal onClose={() => setShowModal(false)} onStarted={onScanStarted} />
      )}
      {showManageScans && (
        <ManageScansModal scans={scans} onClose={() => setShowManageScans(false)} onDeleted={handleScansDeleted} />
      )}
    </div>
  );
}

// Deterministic US-only/citizenship risk tag (scoreJob.js's applyUsOnlySignal
// always forces one to `visa`/`high` when the JD matches — see prefilter.js's
// detectUsOnlySignal) — surfaced as a loud badge right on the card rather than
// only inside the job detail's RiskTags, since this is exactly the "don't make
// me open every job to find out" signal the bug report asked for.
function usOnlyTag(riskTags) {
  const list = Array.isArray(riskTags) ? riskTags : [];
  return list.find((t) => t && t.type === 'visa' && t.severity === 'high') || null;
}

// C4 (bug #11): default was 'BYO', which silently mislabeled any future
// source that forgot to pass one — every real card gets an explicit source
// from sourceBadge() above, so the fallback should read as "unknown," not
// confidently wrong.
function JobCard({ job, onOpen, onNotForMe, stale, source = '—', picked = false, onTogglePick }) {
  const unscored = isUnscored(job);
  const cls = unscored ? 'unscored' : verdictClass(job.verdict);
  const [busy, setBusy] = useState(false);
  const visaTag = usOnlyTag(job.risk_tags);

  async function handleNotForMe(e) {
    e.stopPropagation();
    setBusy(true);
    await onNotForMe();
    // The card unmounts when it leaves the Saved set; no need to reset busy.
  }

  // A div (not a button) so it can contain the real "Not for me" button —
  // nested buttons are invalid HTML. The main region stays keyboard-openable.
  return (
    <div
      className={`job-card ${cls}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
    >
      <div className="job-main">
        {job.status === 'sourced' && (
          <input
            type="checkbox"
            className="job-select"
            checked={picked}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={onTogglePick}
            aria-label={`Pick ${job.title} to score`}
          />
        )}
        <span className="job-source">{source}</span>
        <span className="job-title">{job.title}</span>
        <div className="job-meta">
          {[job.company_name, job.location].filter(Boolean).join(' · ')}
          {job.posted_at ? ` · ${timeAgo(job.posted_at)}` : ''}
        </div>
        {stale && !unscored && <div className="stale-flag">Scored against an earlier résumé version</div>}
        {unscored && <QuickReadSignals triage={job.triage} />}
        <div className="job-card-actions">
          <button className="job-card-not-for-me" onClick={handleNotForMe} disabled={busy}>
            {busy ? 'Removing…' : 'Not for me'}
          </button>
          {visaTag && (
            <span className="risk-tag" title={visaTag.reason} style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
              <span className="dot high" />
              US-ONLY
            </span>
          )}
          {/* 19.5: the employer's real DOL filing history, next to the
              posting's own US-ONLY signal. They are different claims and can
              legitimately both show — a company that sponsors heavily can
              still post one role it won't sponsor. Renders nothing when there
              is no matched record. Vintage lives in the tooltip here to keep
              the card scannable; the detail view shows it as text. */}
          <VisaSponsorBadge sponsor={job.visa_sponsor} />
        </div>
      </div>
      {unscored ? (
        <div className="quick-read">
          {job.status === 'scoring' ? (
            <span>
              <Spinner /> Scoring…
            </span>
          ) : (
            <>
              <QuickReadChip triage={job.triage} />
              <span>Not scored yet</span>
            </>
          )}
        </div>
      ) : (
        <div className="job-scores">
          <div className="score-mini" title={`${job.keyword_coverage?.matched ?? 0}/${job.keyword_coverage?.total ?? 0} keywords matched (small keyword lists are scored toward 5.0)`}>
            <div className="num">{fmtScore(job.ats_match)}</div>
            <div className="lbl">Keywords {job.keyword_coverage?.matched ?? 0}/{job.keyword_coverage?.total ?? 0}</div>
          </div>
          <div className="score-mini">
            <div className="num">{fmtScore(job.callback_odds)}</div>
            <div className="lbl">Callback</div>
          </div>
          <div className="score-mini">
            <div className="num">{fmtScore(job.overall_fit)}</div>
            <div className="lbl">Overall</div>
          </div>
        </div>
      )}
      {!unscored && <VerdictStamp verdict={job.verdict} />}
    </div>
  );
}

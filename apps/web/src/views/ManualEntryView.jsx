import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useMe } from '../context/MeContext';
import Spinner from '../components/Spinner';
import ProgressConsole from '../components/ProgressConsole';
import { COS_ESTIMATE } from '../lib/display';

// Manual job entry (spec §6): paste a JD → identical §4.3 pre-filter → if it
// fails, a specific reason + an "Analyze anyway" override → identical Section 5
// scoring, same UI treatment as a scanned job (opens the shared JobDetailView).
const SCORING_DONE = new Set(['scored', 'archived']);

export default function ManualEntryView() {
  const navigate = useNavigate();
  const { refresh: refreshMe } = useMe();

  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [link, setLink] = useState('');
  const [jd, setJd] = useState('');

  // idle | checking | rejected | scoring | error
  const [phase, setPhase] = useState('idle');
  const [reject, setReject] = useState(null); // { message } from a failed pre-filter
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState([]);

  const pollRef = useRef(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  // Poll a freshly-created manual job until scoring finishes, then open it.
  const pollJob = useCallback(
    (jobId) => {
      api
        .getJob(jobId)
        .then(({ job }) => {
          setProgress(job.progress || []);
          if (SCORING_DONE.has(job.status)) {
            refreshMe().catch(() => {});
            navigate(`/job/${jobId}`, { state: { job } });
            return;
          }
          // 'failed' is the real terminal status (2026-07-27); the note-prefix
          // check is a fallback for any row scored before that migration.
          if (job.status === 'failed' || (job.note && job.note.startsWith('Scoring failed'))) {
            setPhase('error');
            setError(job.note || 'Scoring failed.');
            return;
          }
          pollRef.current = setTimeout(() => pollJob(jobId), 3000);
        })
        .catch((e) => {
          setPhase('error');
          setError(e.message);
        });
    },
    [navigate, refreshMe]
  );

  async function submit(analyzeAnyway) {
    setError(null);
    setReject(null);
    setProgress([]);
    setPhase('checking');
    try {
      const res = await api.enterManualJob({
        description_text: jd,
        title: title.trim() || undefined,
        company: company.trim() || undefined,
        link: link.trim() || undefined,
        analyze_anyway: analyzeAnyway === true,
      });

      if (res.passed === false) {
        // Already saved elsewhere — point at the existing job.
        if (res.reason === 'already_in_account' && res.existing_job_id) {
          setPhase('rejected');
          setReject({ message: res.message, existingJobId: res.existing_job_id });
          return;
        }
        // Failed the pre-filter criteria — show the reason + an override.
        setPhase('rejected');
        setReject({ message: res.message });
        return;
      }

      // Passed (or overridden) → scoring started; poll to completion.
      setPhase('scoring');
      pollJob(res.job_id);
    } catch (e) {
      setPhase('error');
      setError(e.message);
    }
  }

  const busy = phase === 'checking' || phase === 'scoring';
  const consoleSections =
    phase === 'scoring' || phase === 'error'
      ? [
          phase === 'error'
            ? { id: 'manual', title: 'Manual Entry', tone: 'err', lines: [{ text: error || 'Scoring failed.' }] }
            : {
                id: 'manual',
                title: 'Manual Entry',
                tone: 'running',
                lines: progress.length ? progress.map((e) => ({ text: e.label })) : [{ text: 'Scoring against your résumé…' }],
              },
        ]
      : [];

  return (
    <div>
      <div className="view-header">
        <div>
          <div className="view-title">Manual Job Entry</div>
          <div className="view-sub">
            Paste a job description to score it against your résumé — same pipeline as a scan. Scored
            jobs appear on your Dashboard under “Manually entered”.
          </div>
        </div>
      </div>

      <div className="detail-card" style={{ marginBottom: 24 }}>
        <label className="field-label">Job title (optional — inferred from the JD if blank)</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Senior Data Analyst"
          disabled={busy}
        />

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label className="field-label">Company (required)</label>
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="e.g. Acme Corp"
              disabled={busy}
            />
            <div className="disabled-note" style={{ margin: '4px 0 0' }}>
              Used to match this application to confirmation/status emails later.
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <label className="field-label">Posting link (optional)</label>
            <input
              type="text"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://…"
              disabled={busy}
            />
          </div>
        </div>

        <label className="field-label">Job description</label>
        <textarea
          value={jd}
          onChange={(e) => setJd(e.target.value)}
          placeholder="Paste the full job description here…"
          style={{ minHeight: 220 }}
          disabled={busy}
        />

        {/* Pre-submit errors (before any job/console exists) surface here; once
            scoring has started, the console below is the single place errors
            and progress show. */}
        {error && phase !== 'error' && <div className="error-text">{error}</div>}

        {/* Pre-filter rejection (spec §6): specific reason + "Analyze anyway". */}
        {phase === 'rejected' && reject && (
          <div className="empty-state" style={{ textAlign: 'left', marginTop: 8, marginBottom: 12 }}>
            <div style={{ marginBottom: 10 }}>
              <strong>Does not pass criteria.</strong> {reject.message}
            </div>
            {reject.existingJobId ? (
              <button className="btn btn-primary" onClick={() => navigate(`/job/${reject.existingJobId}`)}>
                Open the existing job →
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button className="btn btn-primary" onClick={() => submit(true)}>
                  Analyze anyway
                </button>
                <span className="disabled-note" style={{ margin: 0 }}>
                  Scores it regardless — for a referral or context the filter can&apos;t see.
                </span>
              </div>
            )}
          </div>
        )}

        {phase !== 'rejected' && (
          <button
            className="btn btn-primary"
            onClick={() => submit(false)}
            disabled={busy || !jd.trim() || !company.trim()}
            style={{ marginTop: 6 }}
          >
            {busy ? (
              <>
                <Spinner /> &nbsp;
                {phase === 'checking' ? 'Checking criteria…' : 'Scoring against your résumé…'}
              </>
            ) : (
              <>Analyze Job — {COS_ESTIMATE.manual} COS + AI</>
            )}
          </button>
        )}

        {consoleSections.length > 0 && <ProgressConsole sections={consoleSections} />}
      </div>
    </div>
  );
}

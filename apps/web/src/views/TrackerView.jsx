import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../lib/api';
import Spinner from '../components/Spinner';
import VerdictStamp from '../components/VerdictStamp';
import EmailCheckModal from '../components/EmailCheckModal';
import ProgressConsole from '../components/ProgressConsole';
import { useAuth } from '../context/AuthContext';
import { useMe } from '../context/MeContext';
import { fmtScore } from '../lib/display';

// Email-check runs (bug batch 2026-07-28): POST /api/email-check now dispatches
// async (same shape as a scan) instead of blocking on the whole Gmail-search +
// AI-classify round trip — the button used to be just a spinner for several
// seconds with no real sense of progress, unlike scans/generation which already
// got a real ProgressConsole (2026-07-27). This mirrors DashboardView's scan
// poll: fire the check, then poll GET /api/email-check/:id every 3s.
const ACTIVE_RUN = new Set(['queued', 'running']);

function emailCheckProgressLines(run) {
  const entries = (run.progress || []).map((e) => ({ text: e.label }));
  if (!entries.length) entries.push({ text: 'Starting…' });
  return entries;
}

// The tracker board columns (2026-07-21). 'Saved' is NOT a column — it's the
// dashboard/triage queue; the board starts at Applied. 'Deemed Not Suitable' is
// the terminal "Not for me" bucket (last). Capitalized to match the DB CHECK.
const STAGES = ['Applied', 'Interviewing', 'Offer', 'Accepted', 'Rejected', 'Deemed Not Suitable'];
// The positive pipeline the ◄ ► arrows walk. Rejected / Deemed Not Suitable are
// off-pipeline (reached via a button, left via Reopen).
const PIPE = ['Applied', 'Interviewing', 'Offer', 'Accepted'];

function moves(stage) {
  // Rejected reopens back into the pipeline; Not-suitable reopens to Saved
  // (i.e. back onto the dashboard).
  if (stage === 'Rejected') return { reopen: 'Applied' };
  if (stage === 'Deemed Not Suitable') return { reopen: 'Saved' };
  const i = PIPE.indexOf(stage);
  return {
    back: i > 0 ? PIPE[i - 1] : null,
    forward: i >= 0 && i < PIPE.length - 1 ? PIPE[i + 1] : null,
    canReject: stage !== 'Accepted',
  };
}

export default function TrackerView() {
  const { connectGmail } = useAuth();
  const { refresh: refreshMe } = useMe();
  const [apps, setApps] = useState(null);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [gmail, setGmail] = useState(null); // { connected, configured, google_email }
  // The in-flight/failed email-check run being polled, or null. `checking`
  // (passed to the button) is derived from this rather than a separate flag.
  const [checkRun, setCheckRun] = useState(null);
  const [checkResult, setCheckResult] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    api
      .listApplications()
      .then(({ applications }) => setApps(applications))
      .catch((e) => setError(e.message));
    api.gmailStatus().then(setGmail).catch(() => setGmail({ connected: false, configured: false }));
  }, []);

  const runCheck = useCallback(async () => {
    setError(null);
    try {
      const { run_id, status } = await api.emailCheck();
      setCheckRun({ id: run_id, status, progress: [] });
    } catch (e) {
      if (e.body?.error === 'gmail_not_connected') {
        // Token was revoked/expired — send them back through connect.
        setGmail({ connected: false, configured: true });
        connectGmail();
      } else {
        setError(e.message);
      }
    }
  }, [connectGmail]);

  // Poll the run until it's terminal. Depends only on the run's id (not its
  // status) so an in-tick setCheckRun(run) update never restarts this effect —
  // it just keeps recursing via its own setTimeout until completed/failed.
  useEffect(() => {
    if (!checkRun || !ACTIVE_RUN.has(checkRun.status)) return;
    let cancelled = false;
    async function tick() {
      try {
        const { run } = await api.emailCheckStatus(checkRun.id);
        if (cancelled) return;
        if (ACTIVE_RUN.has(run.status)) {
          setCheckRun(run);
          pollRef.current = setTimeout(tick, 3000);
          return;
        }
        if (run.status === 'completed') {
          setCheckRun(run);
          setCheckResult(run.result);
          refreshMe().catch(() => {});
        } else if (run.error_code === 'gmail_not_connected') {
          // Token was revoked/expired mid-run — send them back through connect.
          setCheckRun(null);
          setGmail({ connected: false, configured: true });
          connectGmail();
        } else {
          setCheckRun(run);
          setError(run.error_message || 'Email check failed.');
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkRun?.id]);

  const patchApp = useCallback(async (id, patch) => {
    // optimistic: apply, then reconcile with the server's row.
    setApps((cur) => cur.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    try {
      const { application } = await api.updateApplication(id, patch);
      setApps((cur) => cur.map((a) => (a.id === id ? application : a)));
    } catch (e) {
      setError(e.message);
      api.listApplications().then(({ applications }) => setApps(applications)).catch(() => {});
    }
  }, []);

  if (error && !apps) {
    return (
      <div>
        <div className="view-header">
          <div className="view-title">Application Tracker</div>
        </div>
        <div className="error-text">{error}</div>
      </div>
    );
  }
  if (!apps) {
    return (
      <div>
        <div className="view-header">
          <div className="view-title">Application Tracker</div>
        </div>
        <div className="empty-state">
          <Spinner /> &nbsp;Loading tracker…
        </div>
      </div>
    );
  }

  // Only board-stage applications appear here; 'Saved' ones live on the Dashboard.
  const boardApps = apps.filter((a) => STAGES.includes(a.stage));
  const byStage = Object.fromEntries(STAGES.map((s) => [s, boardApps.filter((a) => a.stage === s)]));

  return (
    <div>
      <div className="view-header">
        <div>
          <div className="view-title">Application Tracker</div>
          <div className="view-sub">
            Jobs live on the Dashboard until you act on them — applying, or an email update, moves
            them onto this board.
          </div>
        </div>
        <EmailCheckButton
          gmail={gmail}
          checking={Boolean(checkRun && ACTIVE_RUN.has(checkRun.status))}
          onConnect={() => connectGmail()}
          onCheck={runCheck}
        />
      </div>

      {checkRun && (ACTIVE_RUN.has(checkRun.status) || checkRun.status === 'failed') && (
        <ProgressConsole
          sections={[
            checkRun.status === 'failed'
              ? { id: 'email-check', title: 'Email check', tone: 'err', lines: [{ text: checkRun.error_message || 'Email check failed.' }] }
              : { id: 'email-check', title: 'Email check', tone: 'running', lines: emailCheckProgressLines(checkRun) },
          ]}
        />
      )}

      {error && <div className="error-text">{error}</div>}

      {boardApps.length === 0 ? (
        <div className="empty-state">
          Nothing on the board yet. Jobs start on the <strong>Dashboard</strong>; once you apply (or
          an email update moves one here), it appears in these columns.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div className="tracker-board" style={{ minWidth: 900 }}>
            {STAGES.map((stage) => (
              <div className="tracker-col" key={stage}>
                <h4>
                  {stage} <span style={{ color: 'var(--text-dim)' }}>· {byStage[stage].length}</span>
                </h4>
                {byStage[stage].map((app) => (
                  <TrackerCard
                    key={app.id}
                    app={app}
                    editing={editingId === app.id}
                    onToggleEdit={() => setEditingId(editingId === app.id ? null : app.id)}
                    onPatch={patchApp}
                  />
                ))}
                {byStage[stage].length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', opacity: 0.6 }}>—</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {checkResult && (
        <EmailCheckModal
          result={checkResult}
          onApplied={(application) =>
            setApps((cur) => cur.map((a) => (a.id === application.id ? application : a)))
          }
          onClose={() => {
            setCheckResult(null);
            setCheckRun(null);
          }}
        />
      )}
    </div>
  );
}

function EmailCheckButton({ gmail, checking, onConnect, onCheck }) {
  // Server hasn't been configured for Gmail (no client creds / master key).
  if (gmail && gmail.configured === false) {
    return (
      <button className="btn btn-ghost disabled" disabled title="Gmail integration isn't configured on the server">
        Check Email for Updates
      </button>
    );
  }
  if (!gmail || !gmail.connected) {
    return (
      <button className="btn btn-ghost" onClick={onConnect} title="Connect Gmail to check for application updates">
        Connect Gmail
      </button>
    );
  }
  return (
    <button className="btn btn-ghost" onClick={onCheck} disabled={checking}>
      {checking ? <Spinner /> : 'Check Email for Updates'}
    </button>
  );
}

function TrackerCard({ app, editing, onToggleEdit, onPatch }) {
  const job = app.job || {};
  const m = moves(app.stage);
  const [notes, setNotes] = useState(app.notes || '');
  const [interview, setInterview] = useState(app.interview_date ? app.interview_date.slice(0, 10) : '');
  const [round, setRound] = useState(app.interview_round || '');
  const [prep, setPrep] = useState(app.prep_link || '');
  const [saving, setSaving] = useState(false);

  async function saveFields() {
    setSaving(true);
    await onPatch(app.id, {
      notes,
      prep_link: prep,
      interview_round: round,
      interview_date: interview ? new Date(interview).toISOString() : null,
    });
    setSaving(false);
    onToggleEdit();
  }

  return (
    <div className="tcard">
      <div className="t">{job.title || 'Job'}</div>
      <div className="c">{[job.company_name, job.location].filter(Boolean).join(' · ')}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0 4px' }}>
        {job.overall_fit != null && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)' }}>
            {fmtScore(job.overall_fit)}
          </span>
        )}
        {job.verdict && (
          <span style={{ transform: 'scale(0.75)', transformOrigin: 'left center' }}>
            <VerdictStamp verdict={job.verdict} />
          </span>
        )}
      </div>
      {(app.interview_date || app.interview_round) && !editing && (
        <div style={{ fontSize: 10.5, color: 'var(--caution)' }}>
          {/* Stored as UTC midnight of the picked date; render in UTC so it
              doesn't shift a day back for viewers behind UTC. */}
          {app.interview_round ? app.interview_round : 'Interview'}
          {app.interview_date && `: ${new Date(app.interview_date).toLocaleDateString(undefined, { timeZone: 'UTC' })}`}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
        {m.reopen ? (
          <MiniBtn onClick={() => onPatch(app.id, { stage: m.reopen })}>Reopen</MiniBtn>
        ) : (
          <>
            {m.back && <MiniBtn onClick={() => onPatch(app.id, { stage: m.back })}>◄</MiniBtn>}
            {m.forward && <MiniBtn onClick={() => onPatch(app.id, { stage: m.forward })}>►</MiniBtn>}
            {m.canReject && (
              <MiniBtn onClick={() => onPatch(app.id, { stage: 'Rejected' })} danger>
                Reject
              </MiniBtn>
            )}
            <MiniBtn onClick={() => onPatch(app.id, { stage: 'Deemed Not Suitable' })}>
              Not for me
            </MiniBtn>
          </>
        )}
        <MiniBtn onClick={onToggleEdit}>{editing ? 'Close' : 'Edit'}</MiniBtn>
      </div>

      {editing && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="field-label" style={{ margin: 0 }}>
            Notes
          </label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ minHeight: 44, marginBottom: 0 }} />
          <label className="field-label" style={{ margin: 0 }}>
            Interview date
          </label>
          <input type="date" value={interview} onChange={(e) => setInterview(e.target.value)} style={{ marginBottom: 0 }} />
          <label className="field-label" style={{ margin: 0 }}>
            Interview round <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>(optional)</span>
          </label>
          <input type="text" value={round} onChange={(e) => setRound(e.target.value)} placeholder="e.g. Round 2, Final, Technical" style={{ marginBottom: 0 }} />
          <label className="field-label" style={{ margin: 0 }}>
            Prep link
          </label>
          <input type="text" value={prep} onChange={(e) => setPrep(e.target.value)} placeholder="https://…" style={{ marginBottom: 0 }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <MiniBtn onClick={saveFields}>{saving ? '…' : 'Save'}</MiniBtn>
            {job.link && (
              <a className="link-btn" href={job.link} target="_blank" rel="noreferrer" style={{ fontSize: 11, alignSelf: 'center' }}>
                Posting ↗
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MiniBtn({ children, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        all: 'unset',
        cursor: 'pointer',
        fontSize: 11,
        fontWeight: 600,
        padding: '3px 8px',
        borderRadius: 2,
        border: '1px solid var(--line)',
        color: danger ? 'var(--danger)' : 'var(--text)',
      }}
    >
      {children}
    </button>
  );
}

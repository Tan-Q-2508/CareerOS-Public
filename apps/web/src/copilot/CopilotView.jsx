import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { CopilotProvider, useCopilot } from './CopilotContext';
import Workbench from './Workbench';
import ResumeCanvas from './ResumeCanvas';
import Spinner from '../components/Spinner';
import ProgressConsole from '../components/ProgressConsole';
import { DownloadDoc, SaveToDrive } from '../components/DocumentActions';
import { api } from '../lib/api';
import { useMe } from '../context/MeContext';
import { COS_ESTIMATE } from '../lib/display';

// Copilot Mode's own route (spec 7.14) — mounted OUTSIDE <Layout> in App.jsx
// (the split-screen Workbench+Canvas needs full viewport width; the shared
// shell's main.main caps at 1180px). Carries its own slim chrome instead.

// The finished state (spec 7.14.3 step 4) — reached both by a fresh export
// completing (CopilotContext's exportSession already has the completed
// generated_documents row in state.exportDoc) and by revisiting an
// already-exported session's URL directly (exportDoc is empty in that case;
// fetched here from the session's own generated_document_id instead).
function ExportedPanel() {
  const { state } = useCopilot();
  const navigate = useNavigate();
  const [doc, setDoc] = useState(state.exportDoc);
  const [loading, setLoading] = useState(!state.exportDoc);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (state.exportDoc) {
      setDoc(state.exportDoc);
      setLoading(false);
      return undefined;
    }
    const docId = state.session && state.session.generated_document_id;
    if (!docId) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    api
      .getDocument(docId)
      .then(({ document }) => {
        if (!cancelled) setDoc(document);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state.exportDoc, state.session]);

  const backToJob = () => navigate(-1);

  if (loading) {
    return (
      <div className="empty-state">
        <Spinner /> &nbsp;Loading your exported résumé…
      </div>
    );
  }

  return (
    <div className="empty-state" style={{ maxWidth: 420, margin: '40px auto', textAlign: 'left' }}>
      <div className="view-title" style={{ marginBottom: 4 }}>
        Exported ✓
      </div>
      {error && (
        <div className="error-text" style={{ marginBottom: 8 }}>
          {error}
        </div>
      )}
      {doc && doc.ats_score != null && (
        <div className="gen-status ok" style={{ marginBottom: 10 }}>
          ATS keyword match {doc.ats_score}%
        </div>
      )}
      {doc && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 18 }}>
          <DownloadDoc docId={doc.id} />
          <SaveToDrive docId={doc.id} />
        </div>
      )}
      <button className="btn btn-ghost" onClick={backToJob}>
        ← Back to job
      </button>
    </div>
  );
}

// Session 21 Stage 1: the real "Continue in Copilot" gate (spec 7.14.2). No
// polling — the backend endpoint is synchronous (zero AI calls, just a
// status flip + a cheaper flat-fee debit), so a click either lands directly
// in the editing split-screen or surfaces an error inline.
function CompletedGenerationPanel() {
  const { state, refresh } = useCopilot();
  const { refresh: refreshMe } = useMe();
  const navigate = useNavigate();
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState(null);

  async function doContinue() {
    setError(null);
    setContinuing(true);
    try {
      await api.continueCopilotSession(state.session.job_id);
      await refresh(true);
      refreshMe().catch(() => {});
    } catch (e) {
      setError(e.message);
      setContinuing(false);
    }
  }

  return (
    <div className="empty-state" style={{ maxWidth: 420, margin: '40px auto', textAlign: 'left' }}>
      <div className="view-title" style={{ marginBottom: 4 }}>
        This résumé hasn't been continued into Copilot yet.
      </div>
      <div style={{ marginBottom: 18, color: 'var(--text-muted)' }}>
        Continue to keep editing the exact content this résumé was generated from — no
        re-drafting, so it costs less than starting a fresh Copilot session.
      </div>
      {error && (
        <div className="error-text" style={{ marginBottom: 8 }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 18 }}>
        <button className="btn btn-primary" onClick={doContinue} disabled={continuing}>
          {continuing ? (
            <>
              <Spinner /> &nbsp;Continuing…
            </>
          ) : (
            `Continue — ${COS_ESTIMATE.copilot_continue} COS`
          )}
        </button>
      </div>
      <button className="btn btn-ghost" onClick={() => navigate(-1)}>
        ← Back to job
      </button>
    </div>
  );
}

function CopilotShell() {
  const { state } = useCopilot();
  const navigate = useNavigate();

  if (state.status === 'loading') {
    return (
      <div className="empty-state">
        <Spinner /> &nbsp;Loading Copilot session…
      </div>
    );
  }
  if (state.status === 'error') {
    return <div className="error-text">{state.error || 'Could not load this Copilot session.'}</div>;
  }
  if (state.status === 'seeding') {
    // Fallback for a direct URL / bookmark / second tab landing here mid-seed
    // — the normal path (CopilotButton on the job page) now seeds in place
    // and only navigates here once the session is ready. Same live console as
    // the job page, driven by the session's own `progress` (2026-08-04),
    // which CopilotContext's seeding poll already refetches every 3s.
    return (
      <div className="empty-state" style={{ maxWidth: 480, margin: '40px auto' }}>
        <ProgressConsole
          sections={[
            {
              id: 'seed',
              title: 'Copilot',
              tone: 'running',
              lines: (state.session && state.session.progress && state.session.progress.length
                ? state.session.progress
                : [{ label: 'Preparing your Copilot session' }]
              ).map((e) => ({ text: e.label })),
            },
          ]}
        />
        <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => navigate(-1)}>
          ← Back to job
        </button>
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <div className="empty-state">
        <div className="error-text">{state.error || 'This Copilot session failed to seed.'}</div>
        <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => navigate(-1)}>
          ← Back to job
        </button>
      </div>
    );
  }
  // Checked before `status === 'exported'` so a fresh export completing
  // (exportState flips to 'done' before the next session poll necessarily
  // lands session.status:'exported') shows the success panel immediately.
  if (state.exportState === 'done' || state.status === 'exported') {
    return <ExportedPanel />;
  }
  if (state.status === 'abandoned') {
    return (
      <div className="empty-state">
        <div>This session is abandoned.</div>
        <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => navigate(-1)}>
          ← Back to job
        </button>
      </div>
    );
  }
  // A completed_generation row (spec 15 #20(f)/7.14.2) holds a one-click
  // generation's content_tree so "Continue in Copilot" can re-open it — but
  // it isn't an active edit session yet (every PATCH/AI-edit/export endpoint
  // hard-requires status==='editing'). Session 21 Stage 1's real "Continue —
  // 3 COS" gate lives here now, replacing the earlier dead-end placeholder
  // (Session 20c) that only handled a stray direct navigation.
  if (state.status === 'completed_generation') {
    return <CompletedGenerationPanel />;
  }

  return (
    <div className="copilot-split">
      <Workbench />
      <ResumeCanvas />
    </div>
  );
}

export default function CopilotView() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { me } = useMe();

  return (
    <CopilotProvider sessionId={sessionId}>
      <div className="copilot-shell">
        <div className="copilot-topbar">
          <button className="btn btn-ghost" onClick={() => navigate(-1)}>
            ← Back
          </button>
          <div className="copilot-topbar-title">Copilot Mode</div>
          <div className="copilot-topbar-cos">{me?.user ? `${Math.round(me.user.cos_balance || 0)} COS` : ''}</div>
        </div>
        <CopilotShell />
      </div>
    </CopilotProvider>
  );
}

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useMe } from '../context/MeContext';
import VerdictStamp from '../components/VerdictStamp';
import RiskTags from '../components/RiskTags';
import Spinner from '../components/Spinner';
import GapCheckModal from '../components/GapCheckModal';
import { DownloadDoc, SaveToDrive } from '../components/DocumentActions';
import ProgressConsole from '../components/ProgressConsole';
import AddToTracklistModal from '../components/AddToTracklistModal';
import { fmtScore, timeAgo, COS_ESTIMATE } from '../lib/display';
import VisaSponsorBadge from '../components/VisaSponsorBadge';
import { QuickReadChip, QuickReadSignals } from '../components/QuickRead';

function KwCol({ title, items, variant }) {
  const list = Array.isArray(items) ? items : [];
  return (
    <div className={`kw-col ${variant || ''}`}>
      <h4>{title}</h4>
      {list.length === 0 ? (
        <div className="kw-empty">None flagged.</div>
      ) : (
        <ul>
          {list.map((it, i) => (
            <li key={i}>{renderItem(it)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Tiered analysis items (5.3) are strings (missing/demonstrated) or objects.
// The backend shapes (see scoring/fitCall.js FIT_SCHEMA):
//   transferable:     { have, reword_to, bullet_id }  → "have → reword_to"
//   hidden_strengths: { skill, implied_by, bullet_id } → the skill
function renderItem(it) {
  if (typeof it === 'string') return it;
  if (it && typeof it === 'object') {
    if (it.have || it.reword_to) return `${it.have || '?'} → ${it.reword_to || '?'}`;
    if (it.skill) return it.skill;
    return it.term || it.keyword || it.text || it.note || JSON.stringify(it);
  }
  return String(it);
}

// Plain "N of M" JD keywords literally present IN THIS GENERATED RÉSUMÉ
// (checksPassed.keywordCoverage, generateResume.js). Deliberately labelled
// apart from the card's "Keywords X/Y", which counts what the CANDIDATE holds
// (résumé + confirmed skills) — a held skill the page budget couldn't fit is
// covered there but not here.
function KeywordCount({ coverage }) {
  if (!coverage || coverage.total == null) return null;
  return <> · {coverage.matched}/{coverage.total} keywords in this résumé</>;
}

// A job still in this status hasn't finished scoring — no scores/tiered
// analysis exist yet (mirrors ManualEntryView's SCORING_DONE).
const SCORE_DONE = new Set(['scored', 'archived']);
// Statuses a score is actively being produced in — polled. 'sourced' (an
// on-demand job nobody has picked yet, spec 4.7) is not: nothing will change
// until the user asks.
const SCORE_IN_FLIGHT = new Set(['prefiltered', 'scoring']);

// C4 (bug #11): this used to hardcode 'via BYO Scraper' for anything that
// wasn't 'manual' — so an ATS Direct or Core Scraper job displayed a flatly
// wrong source. Branch on the job's actual first source value instead;
// returns null (and is filtered out of the meta line) for anything
// unrecognized rather than guessing.
function sourceLabel(job) {
  const s = Array.isArray(job.sources) ? job.sources[0] : null;
  if (s === 'manual') return 'manually entered';
  if (s === 'cs') return 'via Core Scraper';
  if (s === 'ats_direct') return 'via ATS Direct';
  if (s === 'byo') return 'via BYO Scraper';
  return null;
}

export default function JobDetailView() {
  const { scanId, jobId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { refresh: refreshMe } = useMe();

  const [job, setJob] = useState(location.state?.job || null);
  const [loading, setLoading] = useState(!location.state?.job);
  const [error, setError] = useState(null);

  // If we arrived without router state (refresh / direct link), fetch the job.
  // A scan-scoped route refetches the scan; a manual/scan-less job (/job/:jobId)
  // fetches the single job directly.
  useEffect(() => {
    if (job) return;
    const fetcher = scanId
      ? api.getScanJobs(scanId).then(({ jobs }) => jobs.find((j) => j.id === jobId))
      : api.getJob(jobId).then(({ job: j }) => j);
    fetcher
      .then((found) => {
        if (found) setJob(found);
        else setError('Job not found.');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [job, scanId, jobId]);

  // Keywords X/Y (and the ATS/overall numbers it feeds) are re-measured by the
  // server on every single-job read against the current résumé + confirmed
  // skills. Router state from the dashboard can be older than that, so pull
  // the fresh numbers once on open and again after the gap check.
  const refreshKeywordNumbers = useCallback(() => {
    if (!jobId) return;
    api
      .getJob(jobId)
      .then(({ job: fresh }) => {
        if (!fresh) return;
        setJob((prev) =>
          prev
            ? {
                ...prev,
                ats_match: fresh.ats_match,
                keyword_coverage: fresh.keyword_coverage,
                overall_fit: fresh.overall_fit,
                verdict: fresh.verdict,
              }
            : prev
        );
      })
      .catch(() => {});
  }, [jobId]);
  useEffect(() => {
    refreshKeywordNumbers();
  }, [refreshKeywordNumbers]);

  // If scoring is still in flight (status 'prefiltered' — manual entry or a
  // scan opened before scoring finished), keep polling until it lands on
  // scored/archived, so navigating away and back (or reloading) doesn't leave
  // a permanently blank, score-less page. Declared unconditionally (Rules of
  // Hooks) — it's a no-op once job is done or absent.
  const scorePollRef = useRef(null);
  useEffect(() => {
    if (!job || !SCORE_IN_FLIGHT.has(job.status)) return;
    scorePollRef.current = setTimeout(() => {
      api
        .getJob(job.id)
        .then(({ job: updated }) => setJob(updated))
        .catch(() => {});
    }, 3000);
    return () => clearTimeout(scorePollRef.current);
  }, [job]);

  // An unscored on-demand job (spec 4.7): the dashboard's copy carries no
  // posting text, so fetch the single job once for it.
  const needsPostingText = !!job && job.status === 'sourced' && job.description_text === undefined;
  useEffect(() => {
    if (!needsPostingText) return;
    api
      .getJob(job.id)
      .then(({ job: fresh }) => fresh && setJob((prev) => ({ ...prev, ...fresh })))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPostingText]);

  const [scoreStarting, setScoreStarting] = useState(false);
  const [scoreError, setScoreError] = useState(null);
  async function scoreThisJob() {
    setScoreStarting(true);
    setScoreError(null);
    try {
      await api.scoreJobs([job.id]);
      setJob((prev) => ({ ...prev, status: 'scoring' }));
    } catch (e) {
      setScoreError(e.message);
    } finally {
      setScoreStarting(false);
    }
  }

  if (loading) {
    return (
      <div className="empty-state">
        <Spinner /> &nbsp;Loading job…
      </div>
    );
  }
  if (error || !job) {
    return (
      <div>
        <button className="btn btn-ghost" onClick={() => navigate('/')}>
          ← Back
        </button>
        <div className="error-text" style={{ marginTop: 16 }}>
          {error || 'Job not found.'}
        </div>
      </div>
    );
  }
  if (job.status === 'sourced') {
    return (
      <div>
        <button className="btn btn-ghost" onClick={() => navigate(-1)} style={{ marginBottom: 16 }}>
          ← Back
        </button>
        <div className="detail-card">
          <div className="detail-top">
            <div>
              <div className="detail-title">{job.title}</div>
              <div className="detail-meta">
                {[job.company_name, job.location, sourceLabel(job)].filter(Boolean).join(' · ')}
                {job.posted_at ? ` · ${timeAgo(job.posted_at)}` : ''}
              </div>
            </div>
            <QuickReadChip triage={job.triage} />
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12.5 }}>
              Not scored yet. The quick read below comes from your résumé and the posting&apos;s own text — no AI.
            </div>
            <QuickReadSignals triage={job.triage} max={6} />
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 16 }}>
            <button type="button" className="btn btn-primary" onClick={scoreThisJob} disabled={scoreStarting}>
              {scoreStarting ? 'Starting…' : 'Score this job'}
            </button>
            {job.link && (
              <a href={job.link} target="_blank" rel="noreferrer" style={{ fontSize: 12.5 }}>
                Open the posting ↗
              </a>
            )}
            <VisaSponsorBadge sponsor={job.visa_sponsor} />
          </div>
          {scoreError && <div className="error-text" style={{ marginTop: 10 }}>{scoreError}</div>}
          {job.description_text ? (
            <div
              style={{
                marginTop: 20,
                whiteSpace: 'pre-wrap',
                fontSize: 13,
                lineHeight: 1.55,
                maxHeight: 520,
                overflowY: 'auto',
                borderTop: '1px solid var(--line)',
                paddingTop: 14,
              }}
            >
              {job.description_text}
            </div>
          ) : (
            needsPostingText && (
              <div className="empty-state" style={{ marginTop: 16 }}>
                <Spinner /> &nbsp;Loading the posting…
              </div>
            )
          )}
        </div>
      </div>
    );
  }
  if (!SCORE_DONE.has(job.status)) {
    return (
      <div>
        <button className="btn btn-ghost" onClick={() => navigate(-1)} style={{ marginBottom: 16 }}>
          ← Back
        </button>
        <div className="detail-card">
          <div className="detail-title">{job.title}</div>
          <div className="detail-meta">{[job.company_name, job.location].filter(Boolean).join(' · ')}</div>
          <div className="empty-state" style={{ marginTop: 16 }}>
            <Spinner /> &nbsp;Still scoring against your résumé…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button className="btn btn-ghost" onClick={() => navigate(-1)} style={{ marginBottom: 16 }}>
        ← Back to results
      </button>

      <div className="detail-card">
        <div className="detail-top">
          <div>
            <div className="detail-title">{job.title}</div>
            <div className="detail-meta">
              {[job.company_name, job.location, sourceLabel(job)]
                .filter(Boolean)
                .join(' · ')}
              {job.posted_at ? ` · ${timeAgo(job.posted_at)}` : ''}
            </div>
          </div>
          <VerdictStamp verdict={job.verdict} />
        </div>

        <div className="score-row">
          <div className="score-block">
            <div className="num">{fmtScore(job.ats_match)}</div>
            {/* Always the keyword fraction — the same matched/total the gap
                check lists its gaps from (server keywordState). */}
            <div className="lbl">
              Keywords · {job.keyword_coverage?.matched ?? 0}/{job.keyword_coverage?.total ?? 0}
            </div>
          </div>
          <div className="score-block">
            <div className="num">{fmtScore(job.callback_odds)}</div>
            <div className="lbl">Callback Odds</div>
          </div>
          <div className="score-block">
            <div className="num">{fmtScore(job.overall_fit)}</div>
            <div className="lbl">Overall Fit</div>
          </div>
        </div>

        {job.note && <p className="note">&ldquo;{job.note}&rdquo;</p>}

        <RiskTags tags={job.risk_tags} />

        {/* 19.3: on the detail view the vintage renders as visible text, not
            just a tooltip — this is the surface someone reads before making a
            decision. */}
        <VisaSponsorBadge sponsor={job.visa_sponsor} detailed />

        <div className="kw-grid">
          <KwCol title="Critical Missing" items={job.critical_missing} variant="crit" />
          <KwCol title="Already Demonstrated" items={job.already_demonstrated} variant="have" />
          <KwCol title="Transferable" items={job.transferable} />
          <KwCol title="Hidden Strengths" items={job.hidden_strengths} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          {job.link && (
            <a className="link-btn" href={job.link} target="_blank" rel="noreferrer" style={{ fontSize: 12.5 }}>
              View original posting ↗
            </a>
          )}
          {job.company_ats_registry_id && <TrackCompanyButton registryId={job.company_ats_registry_id} companyName={job.company_name} />}
          <NotForMe jobId={job.id} />
        </div>

        <GenerationPanel jobId={job.id} refreshMe={refreshMe} onKeywordsChanged={refreshKeywordNumbers} />
        <QuestionAnswerPanel jobId={job.id} refreshMe={refreshMe} />
      </div>
    </div>
  );
}

// Custom application Q&A (spec 8.6, reported bug/feature #10) — paste an
// arbitrary application question and get an answer grounded only in the real
// master résumé/confirmed skills (same no-fabrication rule as the cover
// letter, 8.4). Synchronous (no 202/poll pattern — see draftQuestionAnswer.js
// on the server) and much simpler than the document pipeline: no rendering,
// no storage, just an inline answer persisted to job_question_answers so a
// user can build up a bank of several answers per application across a
// session instead of it vanishing on navigation.
const QA_COS_ESTIMATE = 2; // mirrors tunables.flatFees.application_qa

function QuestionAnswerPanel({ jobId, refreshMe }) {
  const [qas, setQas] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .listQuestionAnswers(jobId)
      .then(({ qa }) => setQas(qa || []))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [jobId]);

  async function submit() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { qa } = await api.answerQuestion(jobId, q);
      setQas((prev) => [qa, ...prev]);
      setQuestion('');
      refreshMe().catch(() => {});
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gen-panel">
      <h4>Answer a Custom Application Question</h4>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>
        Paste a question from the application form — the answer is grounded in your real résumé,
        never invented.
      </p>
      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="e.g. Why do you want to join this company?"
        rows={3}
        disabled={busy}
      />
      <div className="btn-row" style={{ marginTop: 4 }}>
        <button className="btn btn-primary" onClick={submit} disabled={busy || !question.trim()}>
          {busy ? (
            <>
              <Spinner /> &nbsp;Answering…
            </>
          ) : (
            <>Get Answer — {QA_COS_ESTIMATE} COS</>
          )}
        </button>
      </div>
      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}

      {loaded && qas.length === 0 && !error && (
        <div className="gen-status" style={{ marginTop: 10 }}>
          No questions answered yet for this job.
        </div>
      )}

      {qas.length > 0 && (
        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {qas.map((qa) => (
            <div key={qa.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{qa.question}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>{qa.answer}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// "Track this company" (§15 #25c-1, spec 4.6.10) — the opt-in replacement for
// the always-on auto-track this job's scan/manual-entry used to do silently.
// Only rendered when the job's company already resolved into the registry
// (company_ats_registry_id, written by the server's linkJobsToRegistry pass);
// opens the same tracklist picker the bulk multiselect uses (AddToTracklistModal).
function TrackCompanyButton({ registryId, companyName }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);

  if (done) {
    return <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>Tracking {companyName || 'this company'} ✓</span>;
  }

  return (
    <>
      <button className="link-btn" style={{ fontSize: 12.5 }} onClick={() => setOpen(true)}>
        Track this company
      </button>
      {open && (
        <AddToTracklistModal
          registryIds={[registryId]}
          companyLabel={companyName}
          onDone={() => {
            setOpen(false);
            setDone(true);
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}

// "Not for me" (2026-07-21): every scored job is already Saved (it's on the
// dashboard); this moves it to the terminal "Deemed Not Suitable" bucket, taking
// it off the dashboard. Upserts server-side, so a re-click just re-confirms.
function NotForMe({ jobId }) {
  const navigate = useNavigate();
  const [state, setState] = useState('idle'); // idle | saving | done | error
  const [msg, setMsg] = useState(null);

  async function mark() {
    setState('saving');
    setMsg(null);
    try {
      await api.markNotForMe(jobId);
      setState('done');
    } catch (e) {
      setState('error');
      setMsg(e.message);
    }
  }

  if (state === 'done') {
    return (
      <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
        Marked not suitable ✓{' '}
        <button className="link-btn" style={{ fontSize: 12.5 }} onClick={() => navigate('/tracker')}>
          View tracker →
        </button>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button className="btn btn-ghost" onClick={mark} disabled={state === 'saving'} style={{ padding: '6px 12px' }}>
        {state === 'saving' ? 'Removing…' : 'Not for me'}
      </button>
      {state === 'error' && <span className="error-text" style={{ margin: 0 }}>{msg}</span>}
    </span>
  );
}

// Terminal states — nothing polls past these. 'cancelled' joins them because
// a cancelled run is finished, just not by finishing.
const DONE = new Set(['completed', 'failed', 'cancelled']);

const DOC_LABEL = { resume: 'Résumé', cover_letter: 'Cover Letter' };

function busyLabel(status) {
  return status === 'checking' ? 'Checking skills…' : status === 'queued' ? 'Starting…' : 'Generating…';
}

// Console lines for an in-flight run: each entry in the server's `progress`
// array is one milestone reached (Director -> draft -> assemble -> ...);
// ProgressConsole itself marks the last one active/blinking while running.
// Deliberately just the label — see ProgressConsole's header comment on why
// this doesn't try to mirror the pipeline's internals.
function progressLines(run) {
  const entries = run.progress || [];
  if (!entries.length) {
    return [{ text: run.status === 'checking' ? 'Checking your résumé for skill gaps…' : 'Starting…' }];
  }
  return entries.map((e) => ({ text: e.label }));
}

// Console lines for a finished, downloadable document — the single place
// this result now renders (previously duplicated across the persistent
// "ready" row, the per-button success line, and the pending-skill chips).
function readyLines(d) {
  const lines = [
    {
      tone: 'ok',
      node: (
        <>
          {DOC_LABEL[d.doc_type] || 'Document'} ready
          {/* ats_score is a keyword-coverage PERCENTAGE (0-100), only on résumés —
             distinct from the 0-10 ATS Match on the job card. */}
          {d.ats_score != null && <> · ATS keyword match {d.ats_score}%</>}
          <KeywordCount coverage={d.checks_passed?.keywordCoverage} />
          {d.checks_passed?.unresolved?.length ? <> · shipped closest-fit</> : null}
          <DownloadDoc docId={d.id} />
          <SaveToDrive docId={d.id} />
        </>
      ),
    },
  ];
  // What's actually holding the score back (2026-08-05) — mirrors the same two
  // gap categories AtsPanel's chips show inside Copilot (Copilot itself already
  // reads this from the live `ats` state; this reads the one-click document's
  // persisted checks_passed the same way). missingRequired/missingNice are
  // fully-missing JD terms; atsSectionBreakdown.skillsOnly are terms present
  // but only in Skills — not woven into a bullet, so only partial credit.
  // Older documents (generated before this field was persisted) simply have
  // no missingRequired/missingNice and just show nothing here.
  if (d.doc_type === 'resume') {
    const missing = [...(d.checks_passed?.missingRequired || []), ...(d.checks_passed?.missingNice || [])];
    const skillsOnly = d.checks_passed?.atsSectionBreakdown?.skillsOnly || [];
    if (missing.length > 0 || skillsOnly.length > 0) {
      lines.push({
        node: (
          <>
            {missing.length > 0 && <>Not in this résumé yet: {missing.join(', ')}. </>}
            {skillsOnly.length > 0 && (
              <>Only in Skills, not a bullet (partial credit only): {skillsOnly.join(', ')}. </>
            )}
            Refine in Copilot to close the gap.
          </>
        ),
      });
    }
  }
  if (d.pending_confirmations?.length > 0) {
    lines.push({
      node: (
        <>
          Confirm these skills to strengthen the next draft:{' '}
          {d.pending_confirmations.map((p, i) => (
            <PendingSkill key={i} pending={p} />
          ))}
        </>
      ),
    });
  }
  // Data-driven, same pattern as KeywordCount above (Phase 3 #20 Stage 2):
  // checks_passed.confirmedSkillCheck only exists on documents generated
  // under the unified ATS engine flag, so an older document simply renders
  // nothing here. A skill you confirmed with an explanation is supposed to
  // land in a real bullet, not just get listed — surface it when it didn't.
  const csc = d.checks_passed?.confirmedSkillCheck;
  const confirmedIssues = csc ? [...(csc.missing || []), ...(csc.missingFromCore || [])] : [];
  if (confirmedIssues.length > 0) {
    lines.push({
      node: <>A confirmed skill didn't make it into this draft: {confirmedIssues.join(', ')}</>,
    });
  }
  return lines;
}

// Drives one generate-résumé or generate-cover-letter action: preflight gap
// check -> start -> poll generated_documents until done, reattaching to an
// already in-flight (or previously failed) run on mount/reload. Pure state —
// GenerationPanel below turns the result into console sections + fixed
// buttons rather than this hook rendering anything itself, so Résumé and
// Cover Letter can share one ProgressConsole.
function useGenerationRun({ docLabel, preflight, start, refreshMe, onGenerated, resumeFrom }) {
  const [status, setStatus] = useState(null); // null | checking | queued | running | completed | failed
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState([]);
  const [cancelling, setCancelling] = useState(false);
  const attachedRef = useRef(false);
  // The document being polled, for both entry points — a fresh run and a
  // re-attach on mount. Cancel needs an id, and `status` alone doesn't carry one.
  const docIdRef = useRef(null);

  const poll = useCallback(
    async (docId) => {
      try {
        const { document } = await api.getDocument(docId);
        setStatus(document.status);
        setProgress(document.progress || []);
        if (DONE.has(document.status)) {
          refreshMe().catch(() => {});
          if (document.status === 'completed' && onGenerated) onGenerated();
          if (document.status === 'failed') setError(document.error_message || null);
          return;
        }
        setTimeout(() => poll(docId), 3000);
      } catch (e) {
        setError(e.message);
        setStatus('failed');
      }
    },
    [refreshMe, onGenerated]
  );

  // Reattach to a generation that was already in flight (or surface a past
  // failure) on mount — e.g. the user navigated away and back, or reloaded,
  // while it was still queued/running. Fires at most once per mount.
  useEffect(() => {
    if (attachedRef.current || status !== null || !resumeFrom) return;
    attachedRef.current = true;
    if (resumeFrom.status === 'queued' || resumeFrom.status === 'running') {
      setStatus(resumeFrom.status);
      setProgress(resumeFrom.progress || []);
      docIdRef.current = resumeFrom.id;
      poll(resumeFrom.id);
    } else if (resumeFrom.status === 'failed') {
      setStatus('failed');
      setProgress(resumeFrom.progress || []);
      setError(resumeFrom.error_message || null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeFrom]);

  async function run() {
    setError(null);
    setProgress([]);
    // Pre-generation gap check (7.12 step 3) — may open the confirm/explain/skip modal.
    setStatus('checking');
    const ok = await preflight(docLabel);
    if (!ok) {
      setStatus(null);
      return;
    }
    setStatus('queued');
    try {
      const { document_id } = await start();
      docIdRef.current = document_id;
      poll(document_id);
    } catch (e) {
      setError(e.message);
      setStatus('failed');
    }
  }

  // Cancel is COOPERATIVE (server-side lib/cancellation.js): this marks the row
  // and the running pipeline stops at its next milestone. So the button shows
  // "Cancelling…" and the poll already running reports the real end state,
  // rather than this pretending the work has already stopped.
  async function cancel() {
    const id = docIdRef.current;
    if (!id || cancelling) return;
    setCancelling(true);
    try {
      await api.cancelDocument(id);
    } catch (e) {
      setCancelling(false);
      // A 409 means it finished first. The poll is about to report that
      // anyway, so it isn't worth an error banner.
      if (!/already|finished|nothing to cancel/i.test(e.message || '')) setError(e.message);
    }
  }

  const busy = status !== null && !DONE.has(status);
  return {
    status,
    error,
    progress,
    busy,
    run,
    cancel,
    cancelling,
    // Not while 'checking': nothing has been created yet, so there is no row
    // to cancel — the gap-check modal is closed by dismissing it.
    canCancel: busy && status !== 'checking',
  };
}

// Console lines for an in-flight/just-ready Copilot seed — same shape as
// progressLines() above, driven by the session's own `progress` (2026-08-04)
// instead of a hardcoded "~20-40s" string.
function copilotProgressLines(seedSession) {
  const entries = (seedSession && seedSession.progress) || [];
  if (!entries.length) return [{ text: 'Preparing your Copilot session' }];
  return entries.map((e) => ({ text: e.label }));
}

// Drives "Open in Copilot" end-to-end WITHOUT navigating away while it seeds
// (2026-08-04 fix — it used to jump straight to /copilot/:id, where the whole
// pane was one static "~20-40s" line for what's often several minutes with
// no way to tell anything was happening). Structurally a sibling of
// useGenerationRun above: same poll cadence, same reattach-on-mount idea, but
// against listCopilotSessionsForJob (Copilot has no single-document status
// endpoint) and with three affordances instead of one, since a job can have a
// pre-existing editing session, a completed_generation row to continue from,
// or nothing yet.
function useCopilotRun({ jobId, preflight, refreshMe }) {
  const navigate = useNavigate();
  // undefined = still checking on mount; null = none found.
  const [existingEditing, setExistingEditing] = useState(undefined);
  const [completedGen, setCompletedGen] = useState(null);
  // The session this pageview is actively tracking, from either a fresh
  // start() or reattaching to one already 'seeding' on mount — its status
  // flipping to 'editing' IS the "ready" moment ("Copilot ready →").
  const [seedSession, setSeedSession] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const poll = useCallback(
    (sessionId) => {
      api
        .listCopilotSessionsForJob(jobId)
        .then(({ sessions }) => {
          if (!mountedRef.current) return;
          const row = (sessions || []).find((s) => s.id === sessionId);
          if (!row) return;
          if (row.status === 'seeding') {
            setSeedSession(row);
            setTimeout(() => poll(sessionId), 3000);
            return;
          }
          if (row.status === 'editing') {
            setSeedSession(row);
            refreshMe().catch(() => {});
            return;
          }
          // failed — surface the error and drop back to a plain "Open in
          // Copilot" affordance so the user can retry (a fresh start() call
          // won't 409 against a 'failed' row, only seeding/editing ones).
          setSeedSession(null);
          setError(row.error_message || 'This Copilot session failed to seed.');
        })
        .catch((e) => {
          if (mountedRef.current) setError(e.message);
        });
    },
    [jobId, refreshMe]
  );

  // Extracted so a freshly-completed one-click generation (same pageview) can
  // re-check for its just-persisted completed_generation row without a full
  // reload — otherwise the unified résumé button would still show the
  // expensive "Open in Copilot" state right after "Generate Résumé" finishes,
  // since this only ran once on mount before.
  const checkExisting = useCallback(() => {
    let cancelled = false;
    api
      .listCopilotSessionsForJob(jobId)
      .then(({ sessions }) => {
        if (cancelled) return;
        const open = (sessions || []).find((s) => s.status === 'seeding' || s.status === 'editing');
        setCompletedGen((sessions || []).find((s) => s.status === 'completed_generation') || null);
        if (open && open.status === 'seeding') {
          setSeedSession(open);
          poll(open.id);
        } else {
          setExistingEditing(open || null);
        }
      })
      .catch(() => {
        if (!cancelled) setExistingEditing(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  useEffect(() => checkExisting(), [checkExisting]);

  async function start() {
    setError(null);
    setStarting(true);
    const ok = await preflight('résumé (Copilot)');
    if (!ok) {
      setStarting(false);
      return;
    }
    try {
      const { session_id } = await api.startCopilotSession(jobId);
      setStarting(false);
      setSeedSession({ id: session_id, status: 'seeding', progress: [] });
      poll(session_id);
    } catch (e) {
      if (e.status === 409 && e.body && e.body.session_id) {
        setSeedSession({ id: e.body.session_id, status: e.body.status || 'seeding', progress: [] });
        poll(e.body.session_id);
        setStarting(false);
        return;
      }
      setError(e.message);
      setStarting(false);
    }
  }

  // Unlike start(), this is fully synchronous server-side (spec 7.14.2's
  // "Continue" — zero AI calls), so it still navigates immediately rather
  // than tracking a seedSession.
  async function doContinue() {
    setError(null);
    setStarting(true);
    try {
      const { session_id } = await api.continueCopilotSession(jobId);
      navigate(`/copilot/${session_id}`);
    } catch (e) {
      if (e.status === 409 && e.body && e.body.session_id) {
        navigate(`/copilot/${e.body.session_id}`);
        return;
      }
      if (e.status === 404) setCompletedGen(null);
      setError(e.message);
      setStarting(false);
    }
  }

  return {
    loading: existingEditing === undefined,
    existingEditing,
    completedGen,
    seedSession,
    starting,
    error,
    start,
    doContinue,
    refreshCompletedGen: checkExisting,
    resumeExisting: () => navigate(`/copilot/${existingEditing.id}`),
    enterReady: () => navigate(`/copilot/${seedSession.id}`),
  };
}

function GenerationPanel({ jobId, refreshMe, onKeywordsChanged }) {
  const [gapModal, setGapModal] = useState(null);
  // Résumé roles/projects, fetched once for GapCheckModal's Explain entry-picker
  // (2026-08-05 fix — lets the user pin an explanation to a specific résumé
  // entry instead of leaving generation to guess which one it belongs to).
  const [profile, setProfile] = useState(null);
  useEffect(() => {
    api.getResume().then(({ resume_version }) => setProfile(resume_version?.parsed_profile || null)).catch(() => {});
  }, []);
  // Documents already generated for this job (in a prior session too), so the
  // Download button is available on revisit, not only right after generating
  // (spec 11.1). Keyed by doc_type = the latest completed doc of that type.
  const [existingDocs, setExistingDocs] = useState([]);
  // Once the user has reviewed gaps for this job (this session), don't re-prompt
  // on the second document — their confirmations are already saved.
  const reviewedRef = useRef(false);

  const loadDocs = useCallback(() => {
    api
      .listJobDocuments(jobId)
      .then(({ documents }) => setExistingDocs(documents || []))
      .catch(() => {});
  }, [jobId]);

  // In-flight/failed generation, if any — lets a "Generate" button reattach to
  // a still-running generation (or surface a past failure) after navigating
  // away and back, or a reload, instead of silently looking idle.
  const [statuses, setStatuses] = useState({ resume: null, cover_letter: null });
  useEffect(() => {
    loadDocs();
    api
      .generationStatus(jobId)
      .then(({ statuses }) => setStatuses(statuses || { resume: null, cover_letter: null }))
      .catch(() => {});
  }, [jobId, loadDocs]);

  // Pre-generation gap check (spec 7.12 step 3). Resolves true to proceed with
  // generation, false if the user cancels. Non-blocking if the check itself errors.
  const preflight = useCallback(
    async (docLabel) => {
      if (reviewedRef.current) return true;
      let gaps;
      try {
        ({ gaps } = await api.generationGaps(jobId));
      } catch {
        return true;
      }
      if (!gaps || !(gaps.gaps || []).length) {
        reviewedRef.current = true;
        return true;
      }
      return new Promise((resolve) => {
        setGapModal({
          docLabel,
          gaps,
          // Confirmations made in the modal can change the card's
          // Keywords X/Y; re-read it either way.
          proceed: () => {
            reviewedRef.current = true;
            setGapModal(null);
            if (onKeywordsChanged) onKeywordsChanged();
            resolve(true);
          },
          close: () => {
            setGapModal(null);
            if (onKeywordsChanged) onKeywordsChanged();
            resolve(false);
          },
        });
      });
    },
    [jobId, onKeywordsChanged]
  );

  const copilotRun = useCopilotRun({ jobId, preflight, refreshMe });
  const resumeRun = useGenerationRun({
    docLabel: 'résumé',
    preflight,
    start: () => api.generateResume(jobId),
    refreshMe,
    onGenerated: () => {
      loadDocs();
      copilotRun.refreshCompletedGen();
    },
    resumeFrom: statuses.resume,
  });
  const letterRun = useGenerationRun({
    docLabel: 'cover letter',
    preflight,
    start: () => api.generateCoverLetter(jobId),
    refreshMe,
    onGenerated: loadDocs,
    resumeFrom: statuses.cover_letter,
  });

  const existingByType = {};
  for (const d of existingDocs) existingByType[d.doc_type] = d;

  // One console for both actions — a section only appears once there's
  // something to show (running, failed, or a ready document), so a document
  // never generated this session or in the past just isn't in the list.
  const sections = [];
  const pushSection = (docType, title, run) => {
    if (run.busy) {
      sections.push({ id: docType, title, tone: 'running', lines: progressLines(run) });
      return;
    }
    if (run.status === 'failed') {
      sections.push({ id: docType, title, tone: 'err', lines: [{ text: run.error || 'Generation failed. Try again.' }] });
      return;
    }
    const d = existingByType[docType];
    if (d) sections.push({ id: docType, title, tone: 'ok', lines: readyLines(d) });
  };
  pushSection('resume', 'Résumé', resumeRun);
  pushSection('cover_letter', 'Cover Letter', letterRun);

  // Copilot's own section — only appears once a seed is in flight, ready, or
  // failed this pageview; a pre-existing editing/completed_generation
  // affordance is fully carried by the button itself (2026-08-04).
  if (copilotRun.seedSession) {
    if (copilotRun.seedSession.status === 'seeding') {
      sections.push({ id: 'copilot', title: 'Copilot', tone: 'running', lines: copilotProgressLines(copilotRun.seedSession) });
    } else if (copilotRun.seedSession.status === 'editing') {
      sections.push({
        id: 'copilot',
        title: 'Copilot',
        tone: 'ok',
        lines: [
          {
            node: (
              <>
                Copilot session ready ·{' '}
                <button
                  type="button"
                  onClick={copilotRun.enterReady}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent, #6b8afd)', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}
                >
                  Open it →
                </button>
              </>
            ),
          },
        ],
      });
    }
  } else if (copilotRun.error) {
    sections.push({ id: 'copilot', title: 'Copilot', tone: 'err', lines: [{ text: copilotRun.error }] });
  }

  return (
    <div className="gen-panel">
      <h4>Tailored Documents</h4>

      <div className="btn-row">
        <ResumeActionButton resumeRun={resumeRun} copilotRun={copilotRun} hasResumeDoc={!!existingByType.resume} />
        <button className="btn btn-primary" onClick={letterRun.run} disabled={letterRun.busy}>
          {letterRun.busy ? (
            <>
              <Spinner /> &nbsp;{busyLabel(letterRun.status)}
            </>
          ) : (
            <>Generate Cover Letter — {COS_ESTIMATE.cover_letter} COS</>
          )}
        </button>
        {/* One cancel per in-flight run, next to the button that started it.
            Only rendered while something is actually cancellable, so it never
            sits there greyed out as decoration. */}
        <CancelRunButton run={resumeRun} label="résumé" />
        <CancelRunButton run={letterRun} label="cover letter" />
      </div>

      <ProgressConsole sections={sections} emptyHint="Generate a résumé, cover letter, or Copilot session to see progress here." />

      {gapModal && (
        <GapCheckModal
          jobId={jobId}
          docLabel={gapModal.docLabel}
          gaps={gapModal.gaps}
          profile={profile}
          onProceed={gapModal.proceed}
          onClose={gapModal.close}
        />
      )}
    </div>
  );
}

// Single résumé entry point (one-click generation and Copilot collapsed into
// one button, 2026-08-05 — Copilot has proven itself, so a separate always-
// visible "Open in Copilot" choice alongside "Generate Résumé" is no longer
// wanted). First press runs the same one-click draft pipeline as before
// (unchanged: preflight -> generate -> poll) and shows its ATS score +
// Download inline (readyLines below); once that completes, THIS SAME button
// flips to the cheap "Refine in Copilot" continue path, reusing the exact
// content_tree/bullet variants runGenerate.js already persists — never a
// second, more expensive fresh draft. Priority mirrors the old CopilotButton
// (existingEditing > seeding > ready > completedGen) with the one-click
// "Generate"/busy states folded in above it, and "Open in Copilot" demoted to
// a defensive fallback for the rare case persistCompletedGenerationTree
// silently failed to persist a completed_generation row.
// Stops a generation that is already under way. Renders nothing unless there
// is something to stop, so the button row doesn't carry a permanently-disabled
// control. "Cancelling…" is honest about the cooperative handoff: the request
// has landed and the pipeline stops at its next milestone, usually seconds.
function CancelRunButton({ run, label }) {
  if (!run.canCancel) return null;
  return (
    <button
      className="btn btn-ghost"
      onClick={run.cancel}
      disabled={run.cancelling}
      title={`Stop generating the ${label}. Steps already completed are still charged.`}
    >
      {run.cancelling ? 'Cancelling…' : `Cancel ${label}`}
    </button>
  );
}

function ResumeActionButton({ resumeRun, copilotRun, hasResumeDoc }) {
  if (copilotRun.existingEditing) {
    return (
      <button className="btn btn-primary" onClick={copilotRun.resumeExisting}>
        Resume Copilot session →
      </button>
    );
  }

  if (copilotRun.seedSession) {
    if (copilotRun.seedSession.status === 'seeding') {
      return (
        <button className="btn btn-primary" disabled>
          <Spinner /> &nbsp;Preparing Copilot…
        </button>
      );
    }
    // status === 'editing' — seeded during this pageview, ready to enter.
    return (
      <button className="btn btn-primary" onClick={copilotRun.enterReady}>
        Copilot ready →
      </button>
    );
  }

  if (copilotRun.completedGen) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button className="btn btn-primary" onClick={copilotRun.doContinue} disabled={copilotRun.starting}>
          {copilotRun.starting ? (
            <>
              <Spinner /> &nbsp;Continuing…
            </>
          ) : (
            `Refine in Copilot — ${COS_ESTIMATE.copilot_continue} COS`
          )}
        </button>
        {copilotRun.error && <div className="gen-status err">{copilotRun.error}</div>}
      </div>
    );
  }

  if (resumeRun.busy) {
    return (
      <button className="btn btn-primary" disabled>
        <Spinner /> &nbsp;{busyLabel(resumeRun.status)}
      </button>
    );
  }

  // Defensive fallback only: a completed résumé exists but no
  // completed_generation row was found for it (persistCompletedGenerationTree
  // failed silently) — fall back to a fresh (billed) Copilot seed rather than
  // re-running one-click generation again.
  if (hasResumeDoc) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button className="btn btn-primary" onClick={copilotRun.start} disabled={copilotRun.starting || copilotRun.loading}>
          {copilotRun.starting ? (
            <>
              <Spinner /> &nbsp;Starting…
            </>
          ) : (
            `Open in Copilot — ${COS_ESTIMATE.copilot} COS`
          )}
        </button>
        {copilotRun.error && <div className="gen-status err">{copilotRun.error}</div>}
      </div>
    );
  }

  return (
    <button className="btn btn-primary" onClick={resumeRun.run} disabled={resumeRun.busy}>
      Generate Résumé — {COS_ESTIMATE.resume} COS
    </button>
  );
}

function PendingSkill({ pending }) {
  const term = typeof pending === 'string' ? pending : pending.skill_term || pending.term || '';
  const context = typeof pending === 'string' ? '' : pending.context || '';
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!term) return null;

  async function confirm() {
    setBusy(true);
    try {
      await api.confirmSkill(term, context);
      setConfirmed(true);
    } catch {
      /* non-fatal */
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="badge-pending">
      {term}
      {confirmed ? ' ✓' : (
        <>
          {' '}
          <button className="link-btn" style={{ fontSize: 10.5 }} onClick={confirm} disabled={busy}>
            confirm
          </button>
        </>
      )}
    </span>
  );
}

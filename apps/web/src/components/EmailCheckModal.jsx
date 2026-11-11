import { useState } from 'react';
import { api } from '../lib/api';
import Spinner from './Spinner';

// Review list for the Gmail status check (spec §9.1.4). The server classified the
// user's recent mail and returned suggestions. These are applied on **Done** —
// everything the check found is applied UNLESS the user dismisses it first. Apply
// is a normal PATCH /api/applications/:id, the same path the board uses.
//
// Two suggestion shapes come back from runEmailCheck.js (bug fix 2026-07-28):
// `kind: 'match'` — the original shape, one specific application, applied unless
// dismissed (default ON, same as before); `kind: 'clarify'` — a company sent a
// generic email naming no specific role (e.g. "Thanks for applying to Google"),
// so the server lists every application at that company the signal COULD apply
// to and lets the user pick. Nothing is checked by default here — an unanswered
// clarification must change nothing, since guessing is exactly the bug this fixes.

const SIGNAL_LABEL = {
  application_confirmation: 'Application confirmed',
  rejection: 'Rejection',
  interview_scheduling: 'Interview',
  offer: 'Offer',
  recruiter_followup: 'Recruiter follow-up',
  ambiguous: 'Needs a look',
};

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

function patchForMatch(s) {
  const patch = {};
  if (s.suggested_stage) patch.stage = s.suggested_stage;
  if (s.interview_date) patch.interview_date = new Date(s.interview_date).toISOString();
  if (s.interview_round) patch.interview_round = s.interview_round;
  return patch;
}

// A clarify row's interview_date/round is shared across every candidate (same
// email); only the resulting stage differs per candidate (e.g. one is already
// Applied so only the interview fields change, another is still Saved).
function patchForClarifyCandidate(row, candidate) {
  const patch = {};
  if (candidate.suggested_stage) patch.stage = candidate.suggested_stage;
  if (row.interview_date) patch.interview_date = new Date(row.interview_date).toISOString();
  if (row.interview_round) patch.interview_round = row.interview_round;
  return patch;
}

export default function EmailCheckModal({ result, onApplied, onClose }) {
  const suggestions = result?.suggestions || [];
  const [rows, setRows] = useState(() =>
    suggestions.map((s) =>
      s.kind === 'clarify' ? { kind: 'clarify', s, checked: new Set() } : { kind: 'match', s, dismissed: false }
    )
  );
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState(null);

  const toggleDismiss = (i) =>
    setRows((rs) => rs.map((row, j) => (j === i ? { ...row, dismissed: !row.dismissed } : row)));

  const toggleCandidate = (i, appId) =>
    setRows((rs) =>
      rs.map((row, j) => {
        if (j !== i) return row;
        const next = new Set(row.checked);
        if (next.has(appId)) next.delete(appId);
        else next.add(appId);
        return { ...row, checked: next };
      })
    );

  const toggleSelectAll = (i) =>
    setRows((rs) =>
      rs.map((row, j) => {
        if (j !== i) return row;
        const allChecked = row.checked.size === row.s.candidates.length;
        return { ...row, checked: allChecked ? new Set() : new Set(row.s.candidates.map((c) => c.application_id)) };
      })
    );

  const applyCount = rows.reduce((n, row) => (row.kind === 'match' ? (row.dismissed ? n : n + 1) : n + row.checked.size), 0);

  // Done: apply every match that wasn't dismissed, and every checked clarify
  // candidate, then close.
  async function done() {
    if (applyCount === 0) return onClose();
    setApplying(true);
    setError(null);
    let failed = 0;
    for (const row of rows) {
      if (row.kind === 'match') {
        if (row.dismissed) continue;
        const patch = patchForMatch(row.s);
        if (!Object.keys(patch).length) continue;
        try {
          const { application } = await api.updateApplication(row.s.application_id, patch);
          onApplied && onApplied(application);
        } catch {
          failed += 1;
        }
        continue;
      }
      for (const c of row.s.candidates) {
        if (!row.checked.has(c.application_id)) continue;
        const patch = patchForClarifyCandidate(row.s, c);
        if (!Object.keys(patch).length) continue;
        try {
          const { application } = await api.updateApplication(c.application_id, patch);
          onApplied && onApplied(application);
        } catch {
          failed += 1;
        }
      }
    }
    setApplying(false);
    if (failed) {
      setError(`${failed} update${failed === 1 ? '' : 's'} could not be applied. Try again.`);
      return;
    }
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={applying ? undefined : onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h2>Email check</h2>
        <div className="sub">
          Searched your recent mail across {result?.checked_count || 0} active application
          {result?.checked_count === 1 ? '' : 's'}
          {result?.candidate_count ? ` and reviewed ${result.candidate_count} message${result.candidate_count === 1 ? '' : 's'}` : ''}.
          {suggestions.length > 0 && ' These are applied when you click Done — dismiss any you don’t want.'}
        </div>

        {suggestions.length === 0 ? (
          <div className="empty-state" style={{ margin: '16px 0' }}>
            No status updates found in your recent email.
          </div>
        ) : (
          <div style={{ maxHeight: '48vh', overflowY: 'auto', margin: '4px -4px 0' }}>
            {rows.map((row, i) =>
              row.kind === 'clarify' ? (
                <ClarifyRow
                  key={`clarify-${row.s.company}-${row.s.signal_type}-${i}`}
                  row={row}
                  onToggleCandidate={(appId) => toggleCandidate(i, appId)}
                  onSelectAll={() => toggleSelectAll(i)}
                />
              ) : (
                <MatchRow key={row.s.application_id + i} row={row} disabled={applying} onToggleDismiss={() => toggleDismiss(i)} />
              )
            )}
          </div>
        )}

        {error && <div className="error-text" style={{ marginTop: 12 }}>{error}</div>}

        <div className="btn-row" style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 16, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={done} disabled={applying}>
            {applying ? <Spinner /> : 'Done'}
          </button>
          {suggestions.length > 0 && !applying && (
            <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
              {applyCount === 0 ? 'Nothing selected — nothing will change' : `${applyCount} update${applyCount === 1 ? '' : 's'} will be applied`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function MatchRow({ row, disabled, onToggleDismiss }) {
  const s = row.s;
  return (
    <div
      style={{
        borderTop: '1px solid var(--line)',
        padding: '12px 4px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        opacity: row.dismissed ? 0.5 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{s.job_title || 'Application'}</span>
        {s.company && <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>· {s.company}</span>}
        <span className="nav-soon" style={{ margin: 0 }}>{SIGNAL_LABEL[s.signal_type] || s.signal_type}</span>
        <span style={{ flex: 1 }} />
        <button className="link-btn" style={{ fontSize: 12 }} disabled={disabled} onClick={onToggleDismiss}>
          {row.dismissed ? 'Undo' : 'Dismiss'}
        </button>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
        {s.suggested_stage ? (
          <>Will move <strong style={{ color: 'var(--text)' }}>{s.current_stage} → {s.suggested_stage}</strong></>
        ) : (
          <>Will update <strong style={{ color: 'var(--text)' }}>{s.current_stage}</strong></>
        )}
        {s.interview_round && <> · {s.interview_round}</>}
        {s.interview_date && <> · interview {fmtDate(s.interview_date)}</>}
      </div>
      {s.detail && <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>“{s.detail}”</div>}
    </div>
  );
}

// A company sent a generic email (no specific role named) — let the user pick
// which of their open applications at that company it's actually about.
// Nothing pre-checked: an unanswered clarification must change nothing.
function ClarifyRow({ row, onToggleCandidate, onSelectAll }) {
  const s = row.s;
  const allChecked = row.checked.size === s.candidates.length;
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '12px 4px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{s.company || 'A company'}</span>
        <span className="nav-soon" style={{ margin: 0 }}>{SIGNAL_LABEL[s.signal_type] || s.signal_type}</span>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
        This email named no specific role — which of these did you apply to?
        {s.interview_round && <> · {s.interview_round}</>}
        {s.interview_date && <> · interview {fmtDate(s.interview_date)}</>}
      </div>
      {s.detail && <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>“{s.detail}”</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginLeft: 2 }}>
        {s.candidates.map((c) => (
          <label key={c.application_id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={row.checked.has(c.application_id)}
              onChange={() => onToggleCandidate(c.application_id)}
            />
            <span>{c.job_title || 'Application'}</span>
            <span style={{ color: 'var(--text-dim)' }}>
              ({c.current_stage}{c.suggested_stage ? ` → ${c.suggested_stage}` : ''})
            </span>
          </label>
        ))}
      </div>
      <button className="link-btn" style={{ fontSize: 12, alignSelf: 'flex-start' }} onClick={onSelectAll}>
        {allChecked ? 'Clear all' : 'Select all'}
      </button>
    </div>
  );
}

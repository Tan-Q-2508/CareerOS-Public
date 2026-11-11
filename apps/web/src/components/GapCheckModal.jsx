import { useState } from 'react';
import { api } from '../lib/api';
import Spinner from './Spinner';

// Pre-generation gap check (spec 7.12 step 3). Surfaces every JD skill the résumé
// doesn't yet cover; the user confirms (they have it), explains (how they used it,
// stored as context and fed to the draft), or skips (genuinely lacks it). Nothing
// here is fabricated — skipped skills stay gaps and are flagged after generation.
// Entry options for the Explain picker (2026-08-05 fix): "role:<index>" /
// "project:<index>", matching the same index scheme contentDirector.js and
// draftResume.js already use internally, so a picked entry can be honored
// directly at generation time instead of guessed.
function entryOptions(profile) {
  const roles = (profile?.roles || []).map((r, i) => ({
    value: `role:${i}`,
    label: `${r.title || 'Role'}${r.company ? ` @ ${r.company}` : ''}`,
  }));
  const projects = (profile?.projects || []).map((p, i) => ({
    value: `project:${i}`,
    label: p.title || 'Project',
  }));
  return [...roles, ...projects];
}

export default function GapCheckModal({ jobId, docLabel, gaps, profile, onProceed, onClose }) {
  const list = gaps?.gaps || [];
  const [rows, setRows] = useState(() =>
    list.map((g) => ({
      skill: g.skill,
      tier: g.tier,
      context: g.context,
      status: 'pending',
      note: '',
      entryRef: '',
      explaining: false,
      busy: false,
    }))
  );
  const options = entryOptions(profile);

  const setRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function confirm(i, withNote) {
    const r = rows[i];
    const context = withNote ? (r.note || '').trim() : '';
    if (withNote && !context) return; // explain needs text
    if (withNote && options.length && !r.entryRef) return; // explain needs a picked entry, when we have any to pick
    setRow(i, { busy: true });
    try {
      await api.confirmSkill(r.skill, context, withNote ? r.entryRef || undefined : undefined);
      setRow(i, { status: 'confirmed', explaining: false, busy: false });
    } catch {
      setRow(i, { busy: false });
    }
  }

  const remaining = rows.filter((r) => r.status === 'pending').length;
  const confirmedCount = rows.filter((r) => r.status === 'confirmed').length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h2>Before generating your {docLabel}</h2>
        <div className="sub">
          The job asks for these skills that aren&apos;t clearly in your résumé yet. Confirm the ones
          you genuinely have (we&apos;ll use them truthfully), explain how you used one, or skip it.
          We never invent skills you don&apos;t have.
        </div>

        <div className="filter-row" style={{ margin: '0 0 14px' }}>
          {/* Same matched/total as the job card's "Keywords X/Y" — both come
              from the server's keywordState, so gaps listed = total − matched. */}
          <span>
            Keywords <strong>{gaps?.matched ?? 0}/{gaps?.total ?? 0}</strong> ·{' '}
            {rows.length} gap{rows.length === 1 ? '' : 's'} to review → up to{' '}
            <strong style={{ color: 'var(--positive)' }}>{gaps?.total ?? 0}/{gaps?.total ?? 0}</strong>{' '}
            if you confirm all
          </span>
        </div>

        <div style={{ maxHeight: '46vh', overflowY: 'auto', margin: '0 -4px' }}>
          {rows.map((r, i) => (
            <div
              key={r.skill}
              style={{
                borderTop: '1px solid var(--line)',
                padding: '10px 4px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600 }}>{r.skill}</span>
                <span className="nav-soon" style={{ margin: 0 }}>{r.tier === 'required' ? 'Required' : 'Nice to have'}</span>
                <span style={{ flex: 1 }} />
                {r.status === 'confirmed' && <span className="ok-text" style={{ margin: 0 }}>Confirmed ✓</span>}
                {r.status === 'skipped' && <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Skipped</span>}
              </div>

              {r.context && (
                <div style={{ fontSize: 11.5, color: 'var(--text-dim)', fontStyle: 'italic' }}>
                  {r.context}
                </div>
              )}

              {r.status === 'pending' && !r.explaining && (
                <div className="btn-row">
                  <button className="btn btn-primary" disabled={r.busy} onClick={() => confirm(i, false)}>
                    {r.busy ? <Spinner /> : 'I have this'}
                  </button>
                  <button className="btn btn-ghost" onClick={() => setRow(i, { explaining: true })}>
                    Explain
                  </button>
                  <button className="btn btn-ghost" onClick={() => setRow(i, { status: 'skipped' })}>
                    Skip
                  </button>
                </div>
              )}

              {r.status === 'pending' && r.explaining && (
                <div>
                  {options.length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <select
                        value={r.entryRef}
                        onChange={(e) => setRow(i, { entryRef: e.target.value })}
                        style={{ width: '100%' }}
                      >
                        <option value="">Which job/project did you demonstrate this in?</option>
                        {options.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <textarea
                    placeholder={`How have you used "${r.skill}"? (e.g. tool, project, or the term you know it by)`}
                    value={r.note}
                    onChange={(e) => setRow(i, { note: e.target.value })}
                    style={{ minHeight: 54 }}
                  />
                  <div className="btn-row">
                    <button
                      className="btn btn-primary"
                      disabled={r.busy || !r.note.trim() || (options.length > 0 && !r.entryRef)}
                      onClick={() => confirm(i, true)}
                    >
                      {r.busy ? <Spinner /> : 'Save & confirm'}
                    </button>
                    <button className="btn btn-ghost" onClick={() => setRow(i, { explaining: false, note: '', entryRef: '' })}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="btn-row" style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
          <button className="btn btn-primary" onClick={onProceed}>
            Generate {docLabel}
            {confirmedCount > 0 ? ` (${confirmedCount} confirmed)` : ''}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {remaining > 0 && (
            <span style={{ alignSelf: 'center', fontSize: 11.5, color: 'var(--text-dim)' }}>
              {remaining} unreviewed — you can generate anyway
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

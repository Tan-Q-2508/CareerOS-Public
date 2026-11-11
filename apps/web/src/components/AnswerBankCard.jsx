import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import Spinner from '../components/Spinner';

// Saved application answers (spec §17.3).
//
// The answer bank has been written to since the Greenhouse session and has held
// self-identification answers — gender, race, veteran and disability status,
// pronouns — since the EEO work. Until now there was no way to see or remove
// any of it: the only surface was a form asking the same question again. The
// handoff that introduced demographic storage said a settings screen "is worth
// building before this feature has many users — it is the obvious gap this
// change opens," and the next session re-flagged it unchanged.
//
// §17.3's promise is that these values are only ever stored because the user
// gave them. That promise needs a way to take them back, which is this.

// Question text that indicates a voluntary self-identification answer. Used
// ONLY to sort those rows to the top and mark them — never to filter, hide, or
// treat them differently on the server. They are ordinary answers by design
// (§0.1: "asked once, answered by the user from the form's own options, then
// reused like any other saved answer"); they are just the ones a person is most
// likely to have come here to find.
const SENSITIVE = /gender|race|ethnic|hispanic|latino|veteran|disab|pronoun|sexual orientation|transgender/i;

function isSensitive(row) {
  return SENSITIVE.test(row.question_original || '') || SENSITIVE.test(row.question_normalized || '');
}

export default function AnswerBankCard() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);

  async function load() {
    setErr('');
    try {
      const { answers } = await api.listApplicationAnswers();
      // Self-identification answers first, then by most recently used — the
      // server's own ordering is preserved within each group.
      const sorted = [...(answers || [])].sort((a, b) => Number(isSensitive(b)) - Number(isSensitive(a)));
      setRows(sorted);
    } catch (e) {
      setErr(e.message || 'Could not load saved answers');
      setRows([]);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function removeOne(row) {
    setBusy(row.id);
    setErr('');
    try {
      await api.deleteApplicationAnswer(row.id);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (e) {
      setErr(e.message || 'Could not delete that answer');
    } finally {
      setBusy(null);
    }
  }

  async function clearAll() {
    setBusy('all');
    setErr('');
    try {
      await api.clearApplicationAnswers();
      setRows([]);
      setConfirmClear(false);
    } catch (e) {
      setErr(e.message || 'Could not clear the answer bank');
    } finally {
      setBusy(null);
    }
  }

  const sensitiveCount = (rows || []).filter(isSensitive).length;

  return (
    <div className="setting-card">
      <h3>Saved Application Answers</h3>
      <p>
        Answers you&apos;ve given on application forms, reused by the extension when a later form asks the same
        question. Nothing here was inferred or generated — every value is one you typed or picked yourself.
      </p>

      {rows === null ? (
        <div className="gen-status">
          <Spinner /> &nbsp;Loading saved answers…
        </div>
      ) : rows.length === 0 ? (
        <div className="disabled-note" style={{ textAlign: 'left' }}>
          No saved answers yet. The extension asks once per question, then reuses your answer.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
            {rows.length} saved
            {sensitiveCount > 0 && ` · ${sensitiveCount} self-identification`}
          </div>

          <div>
            {rows.map((r) => (
              <div
                key={r.id}
                style={{
                  borderTop: '1px solid var(--line)',
                  padding: '9px 0',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  flexWrap: 'wrap',
                  opacity: busy === r.id ? 0.5 : 1,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {/* question_original, not the normalized key — the column
                        exists for exactly this, per its own schema comment. */}
                    {r.question_original}
                    {isSensitive(r) && (
                      <span className="nav-soon" style={{ margin: '0 0 0 6px' }}>
                        Self-identification
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, marginTop: 2, wordBreak: 'break-word' }}>{r.answer_text}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                    {[
                      r.first_seen_platform && `first seen on ${r.first_seen_platform}`,
                      r.times_used > 1 && `used ${r.times_used}×`,
                      r.last_used_at && `last used ${new Date(r.last_used_at).toLocaleDateString()}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <button
                  className="link-btn"
                  style={{ fontSize: 11.5, color: 'var(--danger)' }}
                  disabled={busy != null}
                  onClick={() => removeOne(r)}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 10 }}>
            {confirmClear ? (
              <>
                <button className="btn btn-danger" disabled={busy != null} onClick={clearAll}>
                  {busy === 'all' ? 'Deleting…' : `Delete all ${rows.length}`}
                </button>
                <button className="btn btn-ghost" style={{ marginLeft: 8 }} disabled={busy != null} onClick={() => setConfirmClear(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="link-btn" style={{ color: 'var(--danger)' }} onClick={() => setConfirmClear(true)}>
                Delete all saved answers
              </button>
            )}
          </div>
        </>
      )}

      {err && <span className="error-text">{err}</span>}
    </div>
  );
}

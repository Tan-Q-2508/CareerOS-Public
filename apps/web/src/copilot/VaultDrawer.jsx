import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useCopilot } from './CopilotContext';

// Resume Vault drawer (spec 7.14.11) — every role, project, and bullet the
// Content Director omitted from this session, fetched fresh each time the
// drawer opens (it's a read-only diff, no reason to keep it in
// CopilotContext's reducer state). Rendered as an overlay over .wb-pane
// (maintainer decision, this session) rather than a third screen column —
// same reasoning AtsPanel.jsx already documents for its own placement.
//
// Deliberately BUTTON-driven ("+ Add"), not wired into Workbench's dnd-kit
// DndContext for pixel drag-and-drop — per Session 19's finding, real
// mouse/keyboard drag is unverifiable from inside an agent session, and the
// button is the load-bearing interaction either way (spec 7.14.11 describes
// dragging, but doesn't require it be the ONLY path). Noted as a scope trim
// in this session's handoff.
export default function VaultDrawer({ open, onClose, filterTerm }) {
  const { state, adoptFromVault } = useCopilot();
  const sessionId = state.session && state.session.id;
  const [vault, setVault] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);

  const load = () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    api
      .getCopilotVault(sessionId)
      .then((data) => setVault(data))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const filterLc = filterTerm ? filterTerm.toLowerCase() : null;
  const entries = vault ? vault.entries : [];
  const bullets = vault ? vault.bullets.filter((b) => !filterLc || b.text.toLowerCase().includes(filterLc)) : [];
  const filteredEntries = filterLc ? [] : entries; // a term filter is about bullet content, not whole omitted roles

  async function adoptBullet(item) {
    setBusyKey(item.source_bullet_id);
    setError(null);
    try {
      await adoptFromVault({ kind: 'bullet', source_bullet_id: item.source_bullet_id });
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyKey(null);
    }
  }

  async function adoptEntry(item) {
    const key = `${item.kind}-${item.source_index}`;
    setBusyKey(key);
    setError(null);
    try {
      await adoptFromVault({ kind: 'entry', entry_kind: item.kind, source_index: item.source_index });
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyKey(null);
    }
  }

  const empty = !loading && vault && filteredEntries.length === 0 && bullets.length === 0;

  return (
    <div className="wb-vault-drawer" role="dialog" aria-label="Resume Vault">
      <div className="wb-vault-head">
        <span className="wb-card-title">Resume Vault{filterTerm ? ` — matching "${filterTerm}"` : ''}</span>
        <button type="button" className="wb-icon-btn" aria-label="Close vault" onClick={onClose}>
          ✕
        </button>
      </div>
      {loading && <div className="wb-vault-empty">Loading…</div>}
      {error && <div className="wb-ai-error">{error}</div>}
      {empty && (
        <div className="wb-vault-empty">
          {filterTerm
            ? `No omitted bullet demonstrates "${filterTerm}" — try "+ Add Bullet" on an active entry instead.`
            : 'Nothing omitted — every role, project, and bullet from your résumé is already in this session.'}
        </div>
      )}
      {filteredEntries.length > 0 && (
        <div className="wb-vault-section">
          <div className="wb-vault-section-title">Omitted roles &amp; projects</div>
          <ul className="wb-vault-list">
            {filteredEntries.map((e) => {
              const key = `${e.kind}-${e.source_index}`;
              return (
                <li key={key} className="wb-vault-item">
                  <div className="wb-vault-item-text">
                    <strong>{e.title}</strong>
                    {e.company ? ` — ${e.company}` : ''}
                    <span className="wb-vault-item-dates">{e.dates}</span>
                    <div className="wb-vault-item-preview">{e.preview}</div>
                  </div>
                  <button type="button" className="btn btn-ghost wb-vault-add" disabled={busyKey === key} onClick={() => adoptEntry(e)}>
                    {busyKey === key ? 'Adding…' : '+ Add'}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {bullets.length > 0 && (
        <div className="wb-vault-section">
          <div className="wb-vault-section-title">Omitted bullets</div>
          <ul className="wb-vault-list">
            {bullets.map((b) => (
              <li key={b.source_bullet_id} className="wb-vault-item">
                <div className="wb-vault-item-text">
                  {b.text}
                  <span className="wb-vault-item-dates">{b.entry_title}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost wb-vault-add"
                  disabled={busyKey === b.source_bullet_id}
                  onClick={() => adoptBullet(b)}
                >
                  {busyKey === b.source_bullet_id ? 'Adding…' : '+ Add'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

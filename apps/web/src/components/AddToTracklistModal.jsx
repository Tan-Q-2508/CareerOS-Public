import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import Spinner from './Spinner';

// Extracted from TracklistsCard's bulk-add modal (spec 4.6.8; §15 #25a) so the
// per-job "Track this company" action (§15 #25c-1, spec 4.6.10) can reuse the
// same tracklist-picker UI instead of duplicating it. Self-contained: owns its
// own tracklist fetch, target-selection, and new-list-name state — the caller
// only needs to say which registry ids to add and what to do when it's done.

export default function AddToTracklistModal({ registryIds, companyLabel, onDone, onCancel }) {
  const [lists, setLists] = useState(null);
  const [targetIds, setTargetIds] = useState(() => new Set());
  const [newListName, setNewListName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listTracklists()
      .then(({ tracklists }) => {
        if (!cancelled) setLists(tracklists || []);
      })
      .catch((e) => {
        if (!cancelled) {
          setLists([]);
          setError(e.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleTarget(id) {
    setTargetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!targetIds.size && !newListName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addCompaniesToTracklists(registryIds, [...targetIds], newListName.trim() || undefined);
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const count = registryIds.length;

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <h2>Add {companyLabel || `${count} compan${count === 1 ? 'y' : 'ies'}`}</h2>
        <div className="sub">Choose one or more of your tracklists, or create a new one.</div>

        {/* System (sector) tracklists aren't a valid bulk-add target — the
            server 403s them (addCompaniesToTracklists rejects is_system), so
            don't even offer them here (§15 #25b). */}
        {lists === null ? (
          <div className="gen-status" style={{ marginTop: 10 }}>
            <Spinner /> &nbsp;Loading…
          </div>
        ) : (
          lists
            .filter((l) => !l.is_system)
            .map((l) => (
              <label key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                <input type="checkbox" checked={targetIds.has(l.id)} onChange={() => toggleTarget(l.id)} />
                <span style={{ fontSize: 13 }}>
                  {l.name} ({l.company_count})
                </span>
              </label>
            ))
        )}

        <label className="field-label" style={{ marginTop: 10 }}>
          New tracklist…
        </label>
        <input
          type="text"
          value={newListName}
          onChange={(e) => setNewListName(e.target.value)}
          placeholder="Optional — creates and adds to it"
        />

        {error && (
          <div className="error-text" style={{ marginTop: 8 }}>
            {error}
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || (!targetIds.size && !newListName.trim())}
          >
            {busy ? <Spinner /> : 'Add'}
          </button>
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

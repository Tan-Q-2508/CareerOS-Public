import { useState } from 'react';
import { api } from '../lib/api';
import Spinner from './Spinner';
import { scanTitleLabel, timeAgo } from '../lib/display';

// Multi-select scan deletion (2026-08-15 UX pass) — the dashboard used to
// only offer "Delete this scan" for whichever scan happened to be currently
// selected, one two-click confirm at a time. This lists every scan with a
// checkbox and deletes the selected batch in one request
// (POST /api/scans/bulk-delete), reusing the exact same per-scan safety rule
// as the single-scan route: only jobs still at 'Saved' with no generated
// document are actually removed, everything else is kept.
const ACTIVE = new Set(['queued', 'running']);

export default function ManageScansModal({ scans, onClose, onDeleted }) {
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(false);

  const selectable = (scans || []).filter((s) => !ACTIVE.has(s.status));
  const allSelected = selectable.length > 0 && selectable.every((s) => selected.has(s.id));

  function toggle(id) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirm(false);
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectable.map((s) => s.id)));
    setConfirm(false);
  }

  async function handleDelete() {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { failed } = await api.bulkDeleteScans([...selected]);
      onDeleted();
      if (failed && failed.length) {
        setError(`${failed.length} scan(s) could not be deleted: ${failed.map((f) => f.error).join('; ')}`);
        setSelected(new Set(failed.map((f) => f.id)));
      } else {
        onClose();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Manage Scans</h2>
        <div className="sub">
          Select scans to delete. Jobs you&apos;ve already acted on (moved past Saved, or generated a document for) are
          always kept.
        </div>

        {!scans || !scans.length ? (
          <div className="disabled-note" style={{ textAlign: 'left' }}>
            No scans yet.
          </div>
        ) : (
          <>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12.5,
                padding: '6px 0',
                borderBottom: '1px solid var(--line)',
                marginBottom: 4,
                cursor: selectable.length ? 'pointer' : 'default',
              }}
            >
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                disabled={!selectable.length}
                style={{ width: 'auto', margin: 0 }}
              />
              Select all ({selectable.length} deletable{selectable.length !== scans.length ? `, ${scans.length - selectable.length} running` : ''})
            </label>
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              {scans.map((s) => {
                const running = ACTIVE.has(s.status);
                return (
                  <label
                    key={s.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 12.5,
                      padding: '6px 0',
                      borderBottom: '1px solid var(--line)',
                      opacity: running ? 0.5 : 1,
                      cursor: running ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(s.id)}
                      disabled={running}
                      onChange={() => toggle(s.id)}
                      style={{ width: 'auto', margin: 0 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>
                        {scanTitleLabel(s.config)}
                        {running ? ' (running)' : ''}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                        {timeAgo(s.created_at)} · {s.jobs_stored_count ?? 0} jobs
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}

        {error && <div className="error-text">{error}</div>}

        <div className="btn-row" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost btn-danger" disabled={busy || selected.size === 0} onClick={handleDelete}>
            {busy ? (
              <>
                <Spinner /> &nbsp;Deleting…
              </>
            ) : confirm ? (
              `Click again to confirm (${selected.size})`
            ) : (
              `Delete selected (${selected.size})`
            )}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

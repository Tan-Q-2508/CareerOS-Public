import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  useSensor,
  useSensors,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useDroppable,
  DragOverlay,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useCopilot } from './CopilotContext';
import linkTypes from '@careeros/shared/src/contact/linkTypes.js';
import { useLayoutConfig, measureBulletL, geometryFor } from '../lib/resumeLayout';

const SELECTABLE_LINK_TYPES = linkTypes.selectableLinkTypes();
import { variantRing } from './treeOps';
import Spinner from '../components/Spinner';
import AtsPanel from './AtsPanel';
import VaultDrawer from './VaultDrawer';
import { ConfirmTermsRows, handleSubmitError } from './ConfirmTermsRows';

// The left-hand editing pane (spec 7.14.3 step 2). Stage 3a (16c) wired up
// the local mutation verbs — drag-and-drop reorder (bullets within an entry
// AND across entries, entries within their own kind), variant cycling, and
// graveyard/restore — against CopilotContext's reducer. This stage (16d)
// adds the two billed AI-edit panels (rewrite / inject-keyword) and the
// export flow, including surfacing the export gate's rejection reasons by
// highlighting the actual offending bullet/entry in both panes.

const ORIGIN_LABEL = {
  shotgun: null, // the common case — no badge needed
  assembler_truncated: 'truncated to fit',
  ai_rewrite: 'AI rewrite',
  ai_inject_keyword: 'AI keyword edit',
  ai_new_bullet: 'AI-written',
  user_edit: 'your edit',
};

const VARIANT_LABEL = { short: 'short', one_line: 'one line', two_line: 'two line', custom: 'custom' };

function activeSorted(entries) {
  return (entries || []).filter((e) => !e.graveyard).slice().sort((a, b) => a.order - b.order);
}

function sortedBullets(list) {
  return (list || []).slice().sort((a, b) => a.order - b.order);
}

function bulletText(b) {
  return b.picked === 'custom' ? b.custom_text : b.variants && b.variants[b.picked];
}

function fmtSavedAt(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
}

function SaveStatus({ state }) {
  if (state.saveState === 'saving') return <span className="wb-save-status">Saving…</span>;
  if (state.saveState === 'error') {
    return (
      <span className="wb-save-status wb-save-status-err" title={state.saveError && state.saveError.message}>
        Couldn&apos;t save — will retry on your next edit
      </span>
    );
  }
  if (state.saveState === 'pending') return <span className="wb-save-status">Unsaved changes…</span>;
  const at = fmtSavedAt(state.savedAt);
  return <span className="wb-save-status wb-save-status-ok">{at ? `Saved · ${at}` : 'Saved'}</span>;
}

function VariantCycler({ bullet, dispatch }) {
  const ring = variantRing(bullet);
  if (ring.length < 2) {
    return <span className="wb-variant-pill wb-variant-pill-static">{VARIANT_LABEL[bullet.picked] || bullet.picked}</span>;
  }
  return (
    <span className="wb-variant-chips">
      {ring.map((key) => (
        <button
          key={key}
          type="button"
          className={`wb-variant-chip${bullet.picked === key ? ' active' : ''}`}
          onClick={() => dispatch({ type: 'CYCLE_VARIANT', bulletId: bullet.bullet_id, picked: key })}
          aria-pressed={bullet.picked === key}
        >
          {VARIANT_LABEL[key] || key}
        </button>
      ))}
    </span>
  );
}

function FillDot({ text, cfg, geom }) {
  const status = useMemo(() => {
    if (!cfg || !geom || !text) return null;
    return measureBulletL(text, cfg.sizes.bullet, geom.bulletAvailW, false, cfg.thresholds);
  }, [text, cfg, geom]);
  if (!status) return null;
  const dotClass = status.inBand ? 'ok' : status.lineCount > (cfg.thresholds.maxLines || 2) ? 'over' : 'stub';
  return <span className={`wb-fill-dot ${dotClass}`} title={status.want || 'Fills the line well'} />;
}

// The two billed AI-edit panels (spec 7.14.6), one open at a time per-bullet
// (Workbench tracks WHICH bullet via aiPanelBulletId, not per-row state, so
// the pane never fills with several open forms at once). Both submit through
// CopilotContext's `aiEdit`, which flushes any pending local edit first (both
// routes rebuild from what the server already has stored) and applies the
// server's committed result on success — this panel only needs to know
// busy/error, not the tree itself.
//
// CHANGED 2026-08-02 (Phase 3 bug fix): "Add keyword" is now MULTI-SELECT —
// chips/free-text STAGE into a list, one confirm button weaves them all in
// through ONE billed call, instead of each chip click being its own billed
// round trip that silently dropped whatever was already in the bullet. The
// free-text stage input also accepts a term NOT in the user's profile — the
// confirm-once gate (below) is what keeps that truthful, exactly like
// AddBulletRow already does for a typed bullet. `preStagedKeyword` lets a
// missing-ATS-chip click (AtsPanel) open this panel with a term pre-staged.
function AiEditPanel({ bulletId, currentText, injectableKeywords, preStagedKeyword, onClose }) {
  const { aiEdit, revertBulletEdit } = useCopilot();
  const [tab, setTab] = useState(preStagedKeyword ? 'keyword' : 'rewrite');
  const [instruction, setInstruction] = useState('');
  const [staged, setStaged] = useState(preStagedKeyword ? [preStagedKeyword] : []);
  const [freeText, setFreeText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pendingTerms, setPendingTerms] = useState(null);
  const [reviewResult, setReviewResult] = useState(null); // { variants, picked, rejected } post-edit

  // Chips only for terms not already present in the bullet's own text — same
  // case-insensitive substring check the Canvas's own keyword highlighter
  // uses (ResumeCanvas.jsx's highlightKeywords), so "already there" reads the
  // same way in both panes.
  const missingKeywords = useMemo(() => {
    const textLc = (currentText || '').toLowerCase();
    return (injectableKeywords || []).filter((k) => k && !textLc.includes(String(k).toLowerCase()) && !staged.some((s) => s.toLowerCase() === String(k).toLowerCase()));
  }, [injectableKeywords, currentText, staged]);

  function toggleStaged(term) {
    setStaged((cur) => (cur.includes(term) ? cur.filter((t) => t !== term) : [...cur, term]));
  }

  function stageFreeText() {
    const t = freeText.trim();
    if (!t || staged.some((s) => s.toLowerCase() === t.toLowerCase())) return;
    setStaged((cur) => [...cur, t]);
    setFreeText('');
  }

  async function runRewrite() {
    if (busy || !instruction.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await aiEdit({ bulletId, kind: 'rewrite', instruction: instruction.trim() });
      setReviewResult(result);
    } catch (e) {
      handleSubmitError(e, setPendingTerms, setError);
    } finally {
      setBusy(false);
    }
  }

  async function runInject() {
    if (busy || !staged.length) return;
    setBusy(true);
    setError(null);
    try {
      const result = await aiEdit({ bulletId, kind: 'inject-keyword', keywords: staged });
      setReviewResult(result);
      setStaged([]);
    } catch (e) {
      handleSubmitError(e, setPendingTerms, setError);
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo() {
    setBusy(true);
    try {
      await revertBulletEdit(bulletId);
      setReviewResult(null);
      onClose();
    } catch (e) {
      setError({ message: e.message });
    } finally {
      setBusy(false);
    }
  }

  if (reviewResult) {
    // A4 bug fix (2026-08-12): a deterministic no-op (the AI's rewrite
    // normalized-matched the pre-edit text) no longer bills COS server-side
    // (routes/copilot.js's applyEditAndBill) — this branch is the matching
    // frontend half: a distinct message instead of the normal "Applied —
    // picked the X variant" copy, which would otherwise silently imply a
    // real change happened. No Undo control here — applyEditAndBill still
    // snapshots prev_variants even for a no-op (harmless, since reverting
    // would restore functionally-identical text), but surfacing Undo for
    // "nothing changed" would be confusing, not useful.
    if (reviewResult.no_op) {
      return (
        <div className="wb-ai-panel wb-ai-review">
          <div className="wb-ai-review-text">No change suggested — the AI&apos;s rewrite matched your current text. No COS was charged for this edit.</div>
          <div className="wb-ai-inline">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Done
            </button>
          </div>
        </div>
      );
    }
    const rejectedKeys = Object.keys(reviewResult.rejected_variants || {});
    return (
      <div className="wb-ai-panel wb-ai-review">
        <div className="wb-ai-review-text">Applied — picked the <strong>{VARIANT_LABEL[reviewResult.picked] || reviewResult.picked}</strong> variant. Use the length chips on the bullet to switch.</div>
        {rejectedKeys.length > 0 && (
          <div className="wb-ai-review-note">
            The {rejectedKeys.map((k) => VARIANT_LABEL[k] || k).join(' / ')} chip{rejectedKeys.length > 1 ? 's read' : ' reads'} a bit off-target this
            time — still there to pick, may just look shorter/stubbier than usual.
          </div>
        )}
        <div className="wb-ai-inline">
          <button type="button" className="btn btn-ghost" onClick={handleUndo} disabled={busy}>
            Undo this edit
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wb-ai-panel">
      <div className="wb-ai-tabs">
        <button type="button" className={`wb-ai-tab${tab === 'rewrite' ? ' active' : ''}`} onClick={() => setTab('rewrite')} disabled={busy}>
          Rewrite
        </button>
        <button type="button" className={`wb-ai-tab${tab === 'keyword' ? ' active' : ''}`} onClick={() => setTab('keyword')} disabled={busy}>
          Add keyword
        </button>
        <button type="button" className="wb-icon-btn wb-ai-close" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      {tab === 'rewrite' ? (
        <form
          className="wb-ai-form"
          onSubmit={(e) => {
            e.preventDefault();
            runRewrite();
          }}
        >
          <textarea
            className="wb-ai-input"
            rows={2}
            placeholder="How should this bullet change? e.g. lead with the impact, make it punchier"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            disabled={busy}
          />
          <button type="submit" className="btn btn-ghost wb-ai-submit" disabled={busy || !instruction.trim()}>
            {busy ? 'Rewriting…' : 'Rewrite — billed per edit'}
          </button>
        </form>
      ) : (
        <div className="wb-ai-form">
          {missingKeywords.length > 0 && (
            <div className="wb-kw-chips">
              {missingKeywords.map((k) => (
                <button key={k} type="button" className="wb-kw-chip" disabled={busy} onClick={() => toggleStaged(k)}>
                  + {k}
                </button>
              ))}
            </div>
          )}
          {staged.length > 0 && (
            <div className="wb-kw-chips wb-kw-chips-staged">
              {staged.map((k) => (
                <button key={k} type="button" className="wb-kw-chip active" disabled={busy} onClick={() => toggleStaged(k)} title="Click to remove">
                  {k} ✕
                </button>
              ))}
            </div>
          )}
          <div className="wb-ai-inline">
            <input
              type="text"
              className="wb-ai-input"
              placeholder="Type a keyword to stage — even one not yet in your profile"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); stageFreeText(); } }}
              disabled={busy}
            />
            <button type="button" className="wb-icon-btn" disabled={busy || !freeText.trim()} onClick={stageFreeText}>
              Stage
            </button>
          </div>
          <button type="button" className="btn btn-ghost wb-ai-submit" disabled={busy || !staged.length} onClick={runInject}>
            {busy ? 'Weaving in…' : `Weave in ${staged.length || ''} keyword${staged.length === 1 ? '' : 's'} — billed once`}
          </button>
        </div>
      )}

      <ConfirmTermsRows
        pendingTerms={pendingTerms}
        busy={busy}
        setBusy={setBusy}
        setPendingTerms={setPendingTerms}
        setError={setError}
        retry={tab === 'rewrite' ? runRewrite : runInject}
      />

      {error && !pendingTerms && (
        <div className="wb-ai-error">
          {error.message || 'That edit failed. Try again.'}
        </div>
      )}
    </div>
  );
}

// Custom Bullet Injector (spec 7.14.14) — a free-text bullet the user writes
// directly, on any active role/project entry. Zero AI, zero COS (routes/
// copilot.js's POST .../bullets). A 422 needs_confirmation (any JD term this
// sentence demonstrates that isn't yet confirmed or scan-vouched) surfaces
// inline, matching AiEditPanel's own needs_confirmation handling above — not
// a modal over the split-screen — with a per-term "confirm" button that
// re-attempts the same insert once confirmed.
//
// CHANGED 2026-08-02 (Phase 3 bug fix — "no option to write a completely new
// AI bullet"): a "Write it for me" toggle switches this row into an
// instruction field that calls addAiBullet (billed, grounded, three
// variants) instead of addCustomBullet — same confirm-once handling isn't
// needed there (the AI route already only weaves genuinely vouched skills).
function AddBulletRow({ entryId, cfg, geom }) {
  const { addCustomBullet, addAiBullet } = useCopilot();
  const [open, setOpen] = useState(false);
  const [aiMode, setAiMode] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pendingTerms, setPendingTerms] = useState(null);

  async function attemptSubmit() {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (aiMode) await addAiBullet(entryId, value);
      else await addCustomBullet(entryId, value);
      setText('');
      setOpen(false);
      setPendingTerms(null);
    } catch (e) {
      handleSubmitError(e, setPendingTerms, setError);
    } finally {
      setBusy(false);
    }
  }

  const closeAndReset = () => {
    setOpen(false);
    setAiMode(false);
    setText('');
    setError(null);
    setPendingTerms(null);
  };

  if (!open) {
    return (
      <li className="wb-add-bullet-row">
        <button type="button" className="wb-add-bullet-toggle" onClick={() => setOpen(true)}>
          + Add bullet
        </button>
      </li>
    );
  }

  return (
    <li className="wb-add-bullet-row wb-add-bullet-open">
      <div className="wb-ai-form">
        <div className="wb-ai-tabs">
          <button type="button" className={`wb-ai-tab${!aiMode ? ' active' : ''}`} onClick={() => setAiMode(false)} disabled={busy}>
            Write it myself
          </button>
          <button type="button" className={`wb-ai-tab${aiMode ? ' active' : ''}`} onClick={() => setAiMode(true)} disabled={busy}>
            Write it for me
          </button>
        </div>
        <div className="wb-add-bullet-input-row">
          <textarea
            className="wb-ai-input"
            rows={2}
            placeholder={aiMode ? 'Tell the AI what this bullet should cover…' : 'Write a bullet in your own words…'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
          />
          {!aiMode && <FillDot text={text.trim()} cfg={cfg} geom={geom} />}
        </div>
        <div className="wb-ai-inline">
          <button type="button" className="btn btn-ghost wb-ai-submit" disabled={busy || !text.trim()} onClick={attemptSubmit}>
            {busy ? (aiMode ? 'Writing…' : 'Adding…') : (aiMode ? 'Write bullet — billed per edit' : 'Add bullet')}
          </button>
          <button type="button" className="wb-icon-btn" onClick={closeAndReset}>
            Cancel
          </button>
        </div>
        <ConfirmTermsRows
          pendingTerms={pendingTerms}
          busy={busy}
          setBusy={setBusy}
          setPendingTerms={setPendingTerms}
          setError={setError}
          retry={attemptSubmit}
        />
        {error && !pendingTerms && <div className="wb-ai-error">{error.message}</div>}
      </div>
    </li>
  );
}

function BulletRow({
  bullet,
  containerId,
  index,
  count,
  cfg,
  geom,
  dispatch,
  onRemove,
  onMoveBullet,
  injectableKeywords,
  isAiPanelOpen,
  onToggleAiPanel,
  isOffender,
  isPinned,
  hint,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: bullet.bullet_id,
    data: { type: 'bullet', containerId },
  });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const originLabel = ORIGIN_LABEL[bullet.origin];
  const text = bulletText(bullet);

  // Missing-ATS-chip -> bullet staging (Phase 3 bug fix, 2026-08-02): read
  // directly from context rather than threading stagedKeyword/stageKeyword
  // through BulletList/EntryCard's already-long prop lists. When a term is
  // staged, ANY bullet's ✦ opens the AI panel on the keyword tab with that
  // term pre-loaded, then clears the staging.
  const { state: copilotState, stageKeyword, editBulletText, revertBulletEdit } = useCopilot();
  const stagedKeyword = copilotState.stagedKeyword;
  const [manualEditOpen, setManualEditOpen] = useState(false);
  const [manualText, setManualText] = useState(text);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState(null);
  const [manualPendingTerms, setManualPendingTerms] = useState(null);
  const [rowUndoBusy, setRowUndoBusy] = useState(false);

  // A2 bug fix: undo used to be reachable ONLY inside AiEditPanel's transient
  // reviewResult state, which resets to null the moment the panel closes or
  // reopens — even though the server still holds prev_variants/prev_picked
  // (routes/copilot.js's /revert, zero AI/COS) and that data is already
  // sitting right here on the bullet node (content_tree is returned wholesale
  // by the session-load route, prev_* fields included). No backend change
  // needed: this is the exact same truthiness check the server's own /revert
  // route uses to decide "is there anything to revert to."
  const hasPrevious = !!bullet.prev_variants || bullet.prev_picked !== undefined;

  async function handleRowUndo(e) {
    e.stopPropagation();
    if (rowUndoBusy) return;
    setRowUndoBusy(true);
    try {
      await revertBulletEdit(bullet.bullet_id);
      if (isAiPanelOpen) onToggleAiPanel(null);
    } catch (err) {
      // Best-effort — matches the row's other quick actions (▲▼, ✕), which
      // have no dedicated inline error UI either; a failed revert leaves the
      // bullet exactly as it was, so silently retrying on next click is safe.
      // eslint-disable-next-line no-console
      console.error('Undo failed:', err.message);
    } finally {
      setRowUndoBusy(false);
    }
  }
  // Captured at the moment ✦ is clicked (not read reactively from
  // copilotState.stagedKeyword by AiEditPanel) — stageKeyword(null) below
  // clears the staged term right after, and by the time isAiPanelOpen makes
  // AiEditPanel mount, the context value would already be null.
  const [openedWithKeyword, setOpenedWithKeyword] = useState(null);

  function openAiPanel() {
    setOpenedWithKeyword(stagedKeyword || null);
    onToggleAiPanel(bullet.bullet_id);
    if (stagedKeyword) stageKeyword(null); // consumed
  }

  async function submitManualEdit() {
    const value = manualText.trim();
    if (!value || manualBusy) return;
    setManualBusy(true);
    setManualError(null);
    try {
      await editBulletText(bullet.bullet_id, value);
      setManualEditOpen(false);
      setManualPendingTerms(null);
    } catch (e) {
      handleSubmitError(e, setManualPendingTerms, setManualError);
    } finally {
      setManualBusy(false);
    }
  }

  // Alt+Arrow reorders via the button verbs below, coexisting with dnd-kit's
  // own Space/Enter+Arrow keyboard-drag activation on this same handle
  // (KeyboardSensor's own onKeyDown, preserved by delegating anything that
  // isn't an Alt+Arrow to it) — see spec 7.14.3, Session 19.
  const dndKeyDown = listeners && listeners.onKeyDown;
  const handleKeyDown = (e) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      onMoveBullet(containerId, bullet.bullet_id, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (dndKeyDown) dndKeyDown(e);
  };

  return (
    <>
      <li
        id={`wb-b-${bullet.bullet_id}`}
        ref={setNodeRef}
        style={style}
        className={`wb-bullet${isOffender ? ' is-offender' : ''}${isPinned ? ' is-pinned' : ''}`}
        onMouseEnter={() => dispatch({ type: 'HOVER_BULLET', bulletId: bullet.bullet_id })}
        onMouseLeave={() => dispatch({ type: 'HOVER_BULLET', bulletId: null })}
      >
        <button
          type="button"
          className="wb-drag"
          aria-label="Reorder this bullet"
          {...attributes}
          {...listeners}
          onKeyDown={handleKeyDown}
        >
          ⠿
        </button>
        <span className="wb-move-group">
          <button
            type="button"
            className="wb-icon-btn wb-move"
            aria-label="Move bullet up"
            disabled={index === 0}
            onClick={() => onMoveBullet(containerId, bullet.bullet_id, -1)}
          >
            ▲
          </button>
          <button
            type="button"
            className="wb-icon-btn wb-move"
            aria-label="Move bullet down"
            disabled={index === count - 1}
            onClick={() => onMoveBullet(containerId, bullet.bullet_id, 1)}
          >
            ▼
          </button>
        </span>
        <FillDot text={text} cfg={cfg} geom={geom} />
        <span className="wb-bullet-text">{text}</span>
        <span className="wb-bullet-meta">
          <VariantCycler bullet={bullet} dispatch={dispatch} />
          {originLabel && <span className="wb-tag wb-tag-origin">{originLabel}</span>}
          {bullet.grounded === false && (
            <span className="wb-tag wb-tag-warn" title="This edit's source couldn't be verified against your résumé — review before exporting.">
              ungrounded
            </span>
          )}
          {hint && (
            <span
              className="wb-tag wb-tag-hint"
              title={`This edit added ${hint.terms.map((t) => `"${t}"`).join(', ')} without changing much else — make sure the bullet still reads naturally.`}
            >
              reads naturally?
              <button
                type="button"
                className="wb-tag-hint-dismiss"
                aria-label="Dismiss hint"
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: 'DISMISS_HINT', bulletId: bullet.bullet_id });
                }}
              >
                ×
              </button>
            </span>
          )}
          {hasPrevious && (
            <button
              type="button"
              className="wb-icon-btn"
              title="Undo the last AI edit on this bullet"
              disabled={rowUndoBusy}
              onClick={handleRowUndo}
            >
              ↺
            </button>
          )}
          <button
            type="button"
            className={`wb-icon-btn${manualEditOpen ? ' active' : ''}`}
            title="Edit this bullet's text yourself"
            onClick={() => { setManualText(text); setManualEditOpen((v) => !v); if (isAiPanelOpen) onToggleAiPanel(null); }}
          >
            ✎
          </button>
          <button
            type="button"
            className={`wb-icon-btn wb-icon-btn-ai${isAiPanelOpen ? ' active' : ''}${stagedKeyword ? ' wb-icon-btn-staging' : ''}`}
            title={stagedKeyword ? `Weave "${stagedKeyword}" into this bullet` : 'Edit this bullet with AI'}
            onClick={() => { openAiPanel(); if (manualEditOpen) setManualEditOpen(false); }}
          >
            ✦
          </button>
          <button type="button" className="wb-icon-btn" title="Remove this bullet" onClick={() => onRemove(bullet.bullet_id)}>
            ✕
          </button>
        </span>
      </li>
      {manualEditOpen && (
        <li className="wb-ai-panel-row">
          <div className="wb-ai-panel">
            <div className="wb-add-bullet-input-row">
              <textarea
                className="wb-ai-input"
                rows={2}
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                disabled={manualBusy}
              />
              <FillDot text={manualText.trim()} cfg={cfg} geom={geom} />
            </div>
            <div className="wb-ai-inline">
              <button type="button" className="btn btn-ghost wb-ai-submit" disabled={manualBusy || !manualText.trim()} onClick={submitManualEdit}>
                {manualBusy ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="wb-icon-btn" onClick={() => { setManualEditOpen(false); setManualError(null); setManualPendingTerms(null); }}>
                Cancel
              </button>
            </div>
            <ConfirmTermsRows
              pendingTerms={manualPendingTerms}
              busy={manualBusy}
              setBusy={setManualBusy}
              setPendingTerms={setManualPendingTerms}
              setError={setManualError}
              retry={submitManualEdit}
            />
            {manualError && !manualPendingTerms && <div className="wb-ai-error">{manualError.message}</div>}
          </div>
        </li>
      )}
      {isAiPanelOpen && (
        <li className="wb-ai-panel-row">
          <AiEditPanel
            bulletId={bullet.bullet_id}
            currentText={text}
            injectableKeywords={injectableKeywords}
            preStagedKeyword={openedWithKeyword}
            onClose={() => onToggleAiPanel(null)}
          />
        </li>
      )}
    </>
  );
}

function BulletList({
  containerId,
  bullets,
  cfg,
  geom,
  dispatch,
  onRemove,
  onMoveBullet,
  injectableKeywords,
  aiPanelBulletId,
  onToggleAiPanel,
  offenderBulletIds,
  pinnedBulletId,
  naturalnessHints,
  allowAddBullet,
}) {
  const { setNodeRef } = useDroppable({ id: `bcontainer:${containerId}`, data: { type: 'bullet-container', containerId } });
  const ids = bullets.map((b) => b.bullet_id);
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <ul ref={setNodeRef} className="wb-bullet-list">
        {bullets.map((b, i) => (
          <BulletRow
            key={b.bullet_id}
            bullet={b}
            containerId={containerId}
            index={i}
            count={bullets.length}
            cfg={cfg}
            geom={geom}
            dispatch={dispatch}
            onRemove={onRemove}
            onMoveBullet={onMoveBullet}
            injectableKeywords={injectableKeywords}
            isAiPanelOpen={aiPanelBulletId === b.bullet_id}
            onToggleAiPanel={onToggleAiPanel}
            isOffender={!!(offenderBulletIds && offenderBulletIds.has(b.bullet_id))}
            isPinned={pinnedBulletId === b.bullet_id}
            hint={naturalnessHints && naturalnessHints[b.bullet_id]}
          />
        ))}
        {/* Outside the tracked `ids` above so dnd-kit's SortableContext never
            treats it as a sortable item — spec 7.14.14, entry containers only. */}
        {allowAddBullet && <AddBulletRow entryId={containerId} cfg={cfg} geom={geom} />}
      </ul>
    </SortableContext>
  );
}

function EntryCard({
  entry,
  cfg,
  geom,
  dispatch,
  onRemoveBullet,
  onMoveBullet,
  onMoveEntry,
  index,
  count,
  floorMin,
  injectableKeywords,
  aiPanelBulletId,
  onToggleAiPanel,
  offenderBulletIds,
  serverBelowFloor,
  isOffenderEntry,
  pinnedBulletId,
  naturalnessHints,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.entry_id,
    data: { type: 'entry', containerId: entry.kind },
  });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const bullets = sortedBullets(entry.bullets);
  // Same Alt+Arrow-vs-KeyboardSensor coexistence as BulletRow, see there.
  const dndKeyDown = listeners && listeners.onKeyDown;
  const handleKeyDown = (e) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      onMoveEntry(entry.kind, entry.entry_id, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (dndKeyDown) dndKeyDown(e);
  };
  // Zero-latency local check plus the server's own authoritative warning
  // (validateTree's non-strict `warnings`, spec 7.14.4/16d) — the server one
  // catches anything the local floorMin computation might miss (e.g. before
  // layout-config has loaded) rather than replacing it.
  const belowFloor = (floorMin && bullets.length < floorMin) || serverBelowFloor;
  const ongoingLocked = entry.kind === 'experience' && entry.ongoing;

  return (
    <div ref={setNodeRef} style={style} className={`wb-card${isOffenderEntry ? ' is-offender' : ''}`}>
      <div className="wb-card-head">
        <button
          type="button"
          className="wb-drag"
          aria-label={`Reorder ${entry.header.title}`}
          {...attributes}
          {...listeners}
          onKeyDown={handleKeyDown}
        >
          ⠿
        </button>
        <span className="wb-move-group">
          <button
            type="button"
            className="wb-icon-btn wb-move"
            aria-label={`Move ${entry.header.title} up`}
            disabled={index === 0}
            onClick={() => onMoveEntry(entry.kind, entry.entry_id, -1)}
          >
            ▲
          </button>
          <button
            type="button"
            className="wb-icon-btn wb-move"
            aria-label={`Move ${entry.header.title} down`}
            disabled={index === count - 1}
            onClick={() => onMoveEntry(entry.kind, entry.entry_id, 1)}
          >
            ▼
          </button>
        </span>
        <div>
          <div className="wb-card-title">
            {entry.header.title}
            {entry.header.company ? ` — ${entry.header.company}` : ''}
          </div>
          <div className="wb-card-dates">
            {entry.header.dates}
            {entry.ongoing && <span className="wb-tag wb-tag-ongoing">current role</span>}
          </div>
        </div>
        <button
          type="button"
          className="wb-icon-btn wb-icon-btn-remove"
          disabled={ongoingLocked}
          title={ongoingLocked ? "Your current role can't be removed" : 'Remove this entry'}
          onClick={() => dispatch({ type: 'TOGGLE_ENTRY_GRAVEYARD', entryId: entry.entry_id })}
        >
          Remove
        </button>
      </div>
      {belowFloor && (
        <div className="wb-floor-warning">Only {bullets.length} bullet{bullets.length === 1 ? '' : 's'} — needs at least {floorMin} to export.</div>
      )}
      <BulletList
        containerId={entry.entry_id}
        bullets={bullets}
        cfg={cfg}
        geom={geom}
        dispatch={dispatch}
        onRemove={onRemoveBullet}
        onMoveBullet={onMoveBullet}
        injectableKeywords={injectableKeywords}
        aiPanelBulletId={aiPanelBulletId}
        onToggleAiPanel={onToggleAiPanel}
        offenderBulletIds={offenderBulletIds}
        pinnedBulletId={pinnedBulletId}
        naturalnessHints={naturalnessHints}
        allowAddBullet
      />
    </div>
  );
}

// Header editor (Phase 3 bug fix, 2026-08-02): name/title/contact. The three
// fixed link inputs (LinkedIn/Portfolio/Website) became a dynamic list
// (2026-08-26) backed by users.contact_links (7.2) — add/remove any of the
// recognised platforms. A dedicated collapsed-by-default card since most
// sessions never need it (the parsed/extracted values are usually right);
// PATCH .../header, not the debounced session PATCH (see CopilotContext's
// updateHeader).
function HeaderEditor({ tree, renderHeader }) {
  const { updateHeader } = useCopilot();
  const [open, setOpen] = useState(false);
  const contact = tree.contact || {};
  const [fields, setFields] = useState({
    name: contact.name || '',
    professional_title: tree.professional_title || '',
    city_state: contact.cityState || '',
    phone: contact.phone || '',
    email: contact.email || '',
  });
  const [links, setLinks] = useState(
    (Array.isArray(contact.links) ? contact.links : []).map((l) => ({ type: l.type, url: l.url || '' }))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  function set(field, value) {
    setFields((f) => ({ ...f, [field]: value }));
    setSaved(false);
  }
  function setLink(i, key, value) {
    setLinks((ls) => ls.map((l, j) => (j === i ? { ...l, [key]: value } : l)));
    setSaved(false);
  }
  function addLink() {
    setLinks((ls) => [...ls, { type: 'website', url: '' }]);
    setSaved(false);
  }
  function removeLink(i) {
    setLinks((ls) => ls.filter((_, j) => j !== i));
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await updateHeader({
        ...fields,
        links: links
          .filter((l) => l.url.trim())
          .map((l) => ({ type: l.type, url: l.url.trim() })),
      });
      setSaved(true);
    } catch (e) {
      setError({ message: e.message });
    } finally {
      setBusy(false);
    }
  }

  const atMax = links.length >= (linkTypes.MAX_LINKS || 16);

  return (
    <section className="wb-header-editor">
      <button type="button" className="wb-section-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Name & contact{renderHeader ? ` — ${renderHeader.name || ''}` : ''}
      </button>
      {open && (
        <div className="wb-header-form">
          <label>Name<input type="text" value={fields.name} onChange={(e) => set('name', e.target.value)} disabled={busy} /></label>
          <label>Title<input type="text" value={fields.professional_title} onChange={(e) => set('professional_title', e.target.value)} disabled={busy} /></label>
          <label>City, State<input type="text" value={fields.city_state} onChange={(e) => set('city_state', e.target.value)} disabled={busy} /></label>
          <label>Phone<input type="text" value={fields.phone} onChange={(e) => set('phone', e.target.value)} disabled={busy} /></label>
          <label>Email<input type="text" value={fields.email} onChange={(e) => set('email', e.target.value)} disabled={busy} /></label>

          <div className="wb-header-links">
            <span className="wb-header-links-title">Links</span>
            {links.map((l, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div className="wb-header-link-row" key={i}>
                <select value={l.type} onChange={(e) => setLink(i, 'type', e.target.value)} disabled={busy}>
                  {SELECTABLE_LINK_TYPES.map((t) => (
                    <option key={t.type} value={t.type}>{t.label}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={l.url}
                  onChange={(e) => setLink(i, 'url', e.target.value)}
                  placeholder={l.type === 'linkedin' ? 'linkedin.com/in/…' : 'yourdomain.com/…'}
                  disabled={busy}
                />
                <button type="button" className="btn btn-ghost" onClick={() => removeLink(i)} disabled={busy} aria-label="Remove link">×</button>
              </div>
            ))}
            <button type="button" className="btn btn-ghost" onClick={addLink} disabled={busy || atMax}>
              + Add link
            </button>
          </div>

          <div className="wb-ai-inline">
            <button type="button" className="btn btn-ghost" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : saved ? 'Saved' : 'Save'}
            </button>
          </div>
          {error && <div className="wb-ai-error">{error.message}</div>}
        </div>
      )}
    </section>
  );
}

// Skills & Certifications editor (Phase 3 bug fix, 2026-08-02: "I can add
// and edit bullets but not Skills and Certification section"). One
// editable chip-list per the four fixed rows the assembler/docx renderer
// assume exist (Technical/Management/Business/Certifications) — labels
// themselves aren't editable, only membership. A newly-added JD term can
// 422 needs_confirmation, same as a custom bullet.
const SKILLS_ROW_LABELS = ['Technical', 'Management', 'Business', 'Certifications'];
function SkillsEditor({ tree }) {
  const { updateSkills } = useCopilot();
  const [open, setOpen] = useState(false);
  const rowsByLabel = useMemo(() => {
    const m = new Map((tree.skills || []).map((r) => [r.label, r.items || []]));
    return SKILLS_ROW_LABELS.map((label) => ({ label, items: m.get(label) || [] }));
  }, [tree.skills]);
  const [draft, setDraft] = useState(() => Object.fromEntries(rowsByLabel.map((r) => [r.label, r.items.join(', ')])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pendingTerms, setPendingTerms] = useState(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const rows = SKILLS_ROW_LABELS.map((label) => ({
        label,
        items: (draft[label] || '').split(',').map((s) => s.trim()).filter(Boolean),
      }));
      await updateSkills(rows);
      setPendingTerms(null);
    } catch (e) {
      handleSubmitError(e, setPendingTerms, setError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wb-skills-editor">
      <button type="button" className="wb-section-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Skills & Certifications
      </button>
      {open && (
        <div className="wb-header-form">
          {SKILLS_ROW_LABELS.map((label) => (
            <label key={label}>
              {label}
              <input
                type="text"
                value={draft[label] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [label]: e.target.value }))}
                placeholder="comma-separated"
                disabled={busy}
              />
            </label>
          ))}
          <div className="wb-ai-inline">
            <button type="button" className="btn btn-ghost" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
          <ConfirmTermsRows pendingTerms={pendingTerms} busy={busy} setBusy={setBusy} setPendingTerms={setPendingTerms} setError={setError} retry={save} />
          {error && !pendingTerms && <div className="wb-ai-error">{error.message}</div>}
        </div>
      )}
    </section>
  );
}

function GraveyardSection({ tree, dispatch }) {
  const graveyardEntries = (tree.entries || []).filter((e) => e.graveyard);
  const graveyardBullets = tree.graveyard_bullets || [];
  const [open, setOpen] = useState(false);
  const count = graveyardEntries.length + graveyardBullets.length;
  if (!count) return null;

  const labelFor = (containerId) => {
    if (containerId === 'summary') return 'Summary';
    const e = (tree.entries || []).find((x) => x.entry_id === containerId);
    return e ? e.header.title : 'Removed section';
  };

  return (
    <section className="wb-graveyard">
      <button type="button" className="wb-graveyard-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Removed ({count})
      </button>
      {open && (
        <ul className="wb-graveyard-list">
          {graveyardEntries.map((e) => (
            <li key={e.entry_id} className="wb-graveyard-item">
              <span>
                {e.header.title}
                {e.header.company ? ` — ${e.header.company}` : ''}
              </span>
              <button type="button" className="wb-icon-btn" onClick={() => dispatch({ type: 'TOGGLE_ENTRY_GRAVEYARD', entryId: e.entry_id })}>
                Restore
              </button>
            </li>
          ))}
          {graveyardBullets.map((b) => (
            <li key={b.bullet_id} className="wb-graveyard-item">
              <span>
                {bulletText(b)} <span className="wb-tag wb-tag-origin">from {labelFor(b.graveyard_from_entry_id)}</span>
              </span>
              <button type="button" className="wb-icon-btn" onClick={() => dispatch({ type: 'RESTORE_BULLET', bulletId: b.bullet_id })}>
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function bulletsInContainer(tree, containerId) {
  if (containerId === 'summary') return sortedBullets(tree.summary);
  const entry = (tree.entries || []).find((e) => e.entry_id === containerId);
  return entry ? sortedBullets(entry.bullets) : [];
}

function findBulletText(tree, bulletId) {
  for (const b of tree.summary || []) if (b.bullet_id === bulletId) return bulletText(b);
  for (const e of tree.entries || []) {
    for (const b of e.bullets || []) if (b.bullet_id === bulletId) return bulletText(b);
  }
  return '';
}

const EXPORT_BUSY_LABEL = {
  flushing: 'Saving edits…',
  submitting: 'Starting export…',
  rendering: 'Rendering…',
};

// Finalize & Export (spec 7.14.3 step 4). The server gates page-fit/floor/
// ongoing-role synchronously before ever inserting a generated_documents row
// (7.14.4), so a rejection here always means nothing was created — the error
// display below just needs to point at the actual offender.
function ExportButton() {
  const { state, exportSession } = useCopilot();
  const busy = state.exportState === 'flushing' || state.exportState === 'submitting' || state.exportState === 'rendering';
  return (
    <button
      type="button"
      className="btn btn-primary wb-export-btn"
      disabled={busy || state.saveState === 'saving'}
      onClick={() => exportSession()}
    >
      {busy && <Spinner />} {busy ? EXPORT_BUSY_LABEL[state.exportState] : 'Export résumé'}
    </button>
  );
}

function ExportError({ error }) {
  if (!error) return null;
  return (
    <div className="wb-export-error">
      {error.message}
      {error.code === 'page_overflow' && typeof error.overflowPt === 'number' && <> — trim the highlighted bullet(s) and try again.</>}
    </div>
  );
}

export default function Workbench() {
  const { state, dispatch } = useCopilot();
  const [aiPanelBulletId, setAiPanelBulletId] = useState(null);
  const handleToggleAiPanel = useCallback((bulletId) => setAiPanelBulletId((cur) => (cur === bulletId ? null : bulletId)), []);

  // Resume Vault drawer (spec 7.14.11) — toggled from the toolbar, or opened
  // pre-filtered by a red Missing-Keywords chip (AtsPanel's onOpenVault).
  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultFilterTerm, setVaultFilterTerm] = useState(null);
  const openVaultForTerm = useCallback((term) => {
    setVaultFilterTerm(term);
    setVaultOpen(true);
  }, []);
  const toggleVault = useCallback(() => {
    setVaultOpen((o) => {
      if (o) setVaultFilterTerm(null);
      return !o;
    });
  }, []);

  // Export-gate rejection reasons (spec 7.14.4), turned into highlight
  // targets: page_overflow's offenders[], bullet_too_long's bulletId,
  // below_bullet_floor's entryId (see the export route's 422 shapes).
  const offenderBulletIds = useMemo(() => {
    const err = state.exportError;
    if (!err) return null;
    const ids = new Set();
    if (Array.isArray(err.offenders)) err.offenders.forEach((o) => o && o.bullet_id && ids.add(o.bullet_id));
    if (err.bulletId) ids.add(err.bulletId);
    return ids.size ? ids : null;
  }, [state.exportError]);
  const offenderEntryId = state.exportError && state.exportError.entryId;

  // Feed the first offending id into the same hoveredBulletId connective
  // tissue BulletRow's mouse-hover already uses — so a rejected export
  // highlights the offending line in the Canvas too, not just the Workbench.
  useEffect(() => {
    if (!offenderBulletIds || !offenderBulletIds.size) return;
    dispatch({ type: 'HOVER_BULLET', bulletId: [...offenderBulletIds][0] });
  }, [offenderBulletIds, dispatch]);

  // Escape clears a Missing Keywords chip's pin (spec 7.14.12) — the other
  // way to clear it is clicking the same chip again (AtsPanel.jsx).
  useEffect(() => {
    if (!state.pinnedBulletId) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') dispatch({ type: 'PIN_BULLET', bulletId: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.pinnedBulletId, dispatch]);

  // Escape also cancels a missing-keyword "pick a bullet" staging (Phase 3
  // bug fix, 2026-08-02) — the other way to clear it is re-clicking the same
  // red chip (AtsPanel.jsx) or clicking any bullet's ✦ (BulletRow, consumes it).
  useEffect(() => {
    if (!state.stagedKeyword) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') dispatch({ type: 'STAGE_KEYWORD', term: state.stagedKeyword });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.stagedKeyword, dispatch]);

  // The server's own authoritative floor warning (validateTree's non-strict
  // `warnings`, spec 7.14.4/16d) — the Workbench's own floorMin check below
  // stays the zero-latency signal; this is the confirming one once a PATCH
  // has actually landed.
  const floorWarningEntryIds = useMemo(
    () => new Set((state.warnings || []).filter((w) => w.code === 'below_bullet_floor').map((w) => w.entryId)),
    [state.warnings]
  );
  const { config: cfg } = useLayoutConfig();
  const tree = state.tree;
  const [activeDrag, setActiveDrag] = useState(null); // { type, id }

  // Same convention as ResumeCanvas: measure against the session's own
  // solved render opts (fitToPage's chosen margin/lineSpacing for THIS
  // résumé) once the server has returned one, falling back to the config's
  // static default before the first PATCH response — never a separately
  // re-tuned set of geometry constants (spec 7.14.5/7.14.10).
  const opts = (state.layout && state.layout.opts) || (cfg && cfg.render) || null;
  const geom = cfg && opts ? geometryFor(cfg, opts) : null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Entries never cross kind (experience <-> project) — that's a verb no
  // spec section defines. Bullets, by contrast, are meant to move between
  // entries (spec 7.14.3), so their collision candidates are never
  // container-filtered; only entries are.
  const collisionDetection = useCallback((args) => {
    const a = args.active.data.current || {};
    const filtered = args.droppableContainers.filter((c) => {
      const d = c.data.current || {};
      if (d.type !== a.type && !(a.type === 'bullet' && d.type === 'bullet-container')) return false;
      if (a.type === 'entry') return d.containerId === a.containerId;
      return true;
    });
    return closestCenter({ ...args, droppableContainers: filtered });
  }, []);

  const handleDragStart = useCallback((event) => {
    setActiveDrag({ ...(event.active.data.current || {}), id: event.active.id });
  }, []);

  // Cancelling a drag (Escape, or the sensor otherwise aborting) previously
  // left `activeDrag` set — since only handleDragEnd cleared it — so the
  // DragOverlay's ghost card stayed rendered with nothing left to drop.
  const handleDragCancel = useCallback(() => setActiveDrag(null), []);

  // Shared reorder primitives — id-based (by entry_id/bullet_id, not index),
  // so both the drag gesture (handleDragEnd) and the click/keyboard buttons
  // below (BulletRow/EntryCard's ▲▼) compute the same ordered id list from
  // the current tree and dispatch the identical REORDER_ENTRIES/
  // REORDER_BULLETS actions treeOps.js already defines — one reorder path,
  // not two that could silently disagree (Session 19, spec 7.14.3).
  const reorderEntry = useCallback(
    (kind, fromId, toId) => {
      if (!tree || fromId === toId) return;
      const ids = activeSorted(tree.entries.filter((e) => e.kind === kind)).map((e) => e.entry_id);
      const oldIndex = ids.indexOf(fromId);
      const newIndex = ids.indexOf(toId);
      if (oldIndex < 0 || newIndex < 0) return;
      dispatch({ type: 'REORDER_ENTRIES', kind, orderedEntryIds: arrayMove(ids, oldIndex, newIndex) });
    },
    [tree, dispatch]
  );

  const reorderBullet = useCallback(
    (containerId, fromId, toId) => {
      if (!tree || fromId === toId) return;
      const ids = bulletsInContainer(tree, containerId).map((b) => b.bullet_id);
      const oldIndex = ids.indexOf(fromId);
      const newIndex = ids.indexOf(toId);
      if (oldIndex < 0 || newIndex < 0) return;
      dispatch({ type: 'REORDER_BULLETS', containerId, orderedBulletIds: arrayMove(ids, oldIndex, newIndex) });
    },
    [tree, dispatch]
  );

  // Step-by-one movers for the ▲▼ buttons and Alt+Arrow keyboard path. Out-
  // of-range steps (already first/last) are a no-op — this is also what
  // keeps a disabled-button click (which shouldn't fire at all) and a
  // boundary keyboard press from ever dispatching a needless PATCH, since
  // reorderEntries/reorderBullets always clone() and would otherwise look
  // like a real edit to afterMutation even for an unchanged order.
  const moveEntryStep = useCallback(
    (kind, entryId, dir) => {
      if (!tree) return;
      const ids = activeSorted(tree.entries.filter((e) => e.kind === kind)).map((e) => e.entry_id);
      const idx = ids.indexOf(entryId);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= ids.length) return;
      reorderEntry(kind, entryId, ids[target]);
    },
    [tree, reorderEntry]
  );

  const moveBulletStep = useCallback(
    (containerId, bulletId, dir) => {
      if (!tree) return;
      const ids = bulletsInContainer(tree, containerId).map((b) => b.bullet_id);
      const idx = ids.indexOf(bulletId);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= ids.length) return;
      reorderBullet(containerId, bulletId, ids[target]);
    },
    [tree, reorderBullet]
  );

  const handleDragEnd = useCallback(
    (event) => {
      setActiveDrag(null);
      const { active, over } = event;
      if (!over || !tree) return;
      const a = active.data.current;
      const o = over.data.current;
      if (!a || !o) return;

      if (a.type === 'entry') {
        if (o.type !== 'entry' || o.containerId !== a.containerId || active.id === over.id) return;
        reorderEntry(a.containerId, active.id, over.id);
        return;
      }

      // Bullet drag — reorder-in-place if dropped within its own container,
      // otherwise a cross-entry move (spec 7.14.3's reorder verb covers both:
      // "reorder bullets within an entry" plus the drag surface naturally
      // allowing a bullet to land in a different one). Resolved only on drop
      // (no onDragOver live-preview) — simpler, and sufficient since nothing
      // downstream needs a mid-drag intermediate tree.
      const destContainerId = o.containerId;
      if (!destContainerId) return;
      if (destContainerId === a.containerId) {
        if (o.type === 'bullet-container') {
          // Dropped into this container's own empty droppable area — e.g.
          // below the last bullet — rather than onto another bullet.
          // Previously a silent no-op (`over.id` was the container's own
          // droppable id, so indexOf returned -1 and the branch just
          // returned): treat it as "move to the end" instead (Session 19
          // fix, spec 7.14.3).
          const ids = bulletsInContainer(tree, a.containerId).map((b) => b.bullet_id);
          const lastId = ids[ids.length - 1];
          if (lastId !== undefined) reorderBullet(a.containerId, active.id, lastId);
          return;
        }
        if (active.id === over.id) return;
        reorderBullet(a.containerId, active.id, over.id);
      } else {
        const destBullets = bulletsInContainer(tree, destContainerId);
        const toIndex = o.type === 'bullet' ? destBullets.findIndex((b) => b.bullet_id === over.id) : destBullets.length;
        dispatch({
          type: 'MOVE_BULLET',
          bulletId: active.id,
          fromContainerId: a.containerId,
          toContainerId: destContainerId,
          toIndex: toIndex < 0 ? destBullets.length : toIndex,
        });
      }
    },
    [tree, dispatch, reorderEntry, reorderBullet]
  );

  const handleRemoveBullet = useCallback((bulletId) => dispatch({ type: 'GRAVEYARD_BULLET', bulletId }), [dispatch]);

  if (!tree) return null;

  const experience = activeSorted(tree.entries.filter((e) => e.kind === 'experience'));
  const projects = activeSorted(tree.entries.filter((e) => e.kind === 'project'));
  const summary = sortedBullets(tree.summary);
  const floorMin = cfg && cfg.bulletsPerEntry && cfg.bulletsPerEntry.min;

  const dragOverlayContent = () => {
    if (!activeDrag || !tree) return null;
    if (activeDrag.type === 'entry') {
      const entry = (tree.entries || []).find((e) => e.entry_id === activeDrag.id);
      return entry ? <div className="wb-card wb-drag-overlay">{entry.header.title}</div> : null;
    }
    const text = findBulletText(tree, activeDrag.id);
    return text ? <div className="wb-bullet wb-drag-overlay">{text}</div> : null;
  };

  return (
    <div className="wb-pane">
      {state.isStale && (
        <div className="wb-stale-notice">
          Drafted against an earlier résumé version — export or abandon this session to start a fresh one against your
          current résumé.
        </div>
      )}

      {state.stagedKeyword && (
        <div className="wb-stage-banner">
          Weaving &quot;{state.stagedKeyword}&quot; — click a bullet&apos;s ✦ to pick where, or{' '}
          <button type="button" className="wb-stage-banner-link" onClick={() => openVaultForTerm(state.stagedKeyword)}>
            search the Vault instead
          </button>
          . <button type="button" className="wb-stage-banner-cancel" onClick={() => dispatch({ type: 'STAGE_KEYWORD', term: state.stagedKeyword })}>Esc to cancel</button>
        </div>
      )}

      <div className="wb-toolbar">
        <SaveStatus state={state} />
        <button type="button" className={`btn btn-ghost wb-vault-toggle${vaultOpen ? ' active' : ''}`} onClick={toggleVault}>
          Vault
        </button>
        <ExportButton />
      </div>
      <ExportError error={state.exportState === 'error' ? state.exportError : null} />
      <HeaderEditor tree={tree} renderHeader={state.renderHeader} />
      <SkillsEditor tree={tree} />
      <AtsPanel />
      <VaultDrawer
        open={vaultOpen}
        filterTerm={vaultFilterTerm}
        onClose={() => {
          setVaultOpen(false);
          setVaultFilterTerm(null);
        }}
      />

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {summary.length > 0 && (
          <section>
            <h4 className="wb-section-title">Professional Summary</h4>
            <div className="wb-card">
              <BulletList
                containerId="summary"
                bullets={summary}
                cfg={cfg}
                geom={geom}
                dispatch={dispatch}
                onRemove={handleRemoveBullet}
                onMoveBullet={moveBulletStep}
                injectableKeywords={state.injectableKeywords}
                aiPanelBulletId={aiPanelBulletId}
                onToggleAiPanel={handleToggleAiPanel}
                offenderBulletIds={offenderBulletIds}
                pinnedBulletId={state.pinnedBulletId}
                naturalnessHints={state.naturalnessHints}
              />
            </div>
          </section>
        )}

        <section>
          <h4 className="wb-section-title">Work Experience</h4>
          <SortableContext items={experience.map((e) => e.entry_id)} strategy={verticalListSortingStrategy}>
            {experience.map((e, i) => (
              <EntryCard
                key={e.entry_id}
                entry={e}
                index={i}
                count={experience.length}
                cfg={cfg}
                geom={geom}
                dispatch={dispatch}
                onRemoveBullet={handleRemoveBullet}
                onMoveBullet={moveBulletStep}
                onMoveEntry={moveEntryStep}
                floorMin={floorMin}
                injectableKeywords={state.injectableKeywords}
                aiPanelBulletId={aiPanelBulletId}
                onToggleAiPanel={handleToggleAiPanel}
                offenderBulletIds={offenderBulletIds}
                serverBelowFloor={floorWarningEntryIds.has(e.entry_id)}
                isOffenderEntry={offenderEntryId === e.entry_id}
                pinnedBulletId={state.pinnedBulletId}
                naturalnessHints={state.naturalnessHints}
              />
            ))}
          </SortableContext>
        </section>

        {projects.length > 0 && (
          <section>
            <h4 className="wb-section-title">Relevant Projects</h4>
            <SortableContext items={projects.map((e) => e.entry_id)} strategy={verticalListSortingStrategy}>
              {projects.map((e, i) => (
                <EntryCard
                  key={e.entry_id}
                  entry={e}
                  index={i}
                  count={projects.length}
                  cfg={cfg}
                  geom={geom}
                  dispatch={dispatch}
                  onRemoveBullet={handleRemoveBullet}
                  onMoveBullet={moveBulletStep}
                  onMoveEntry={moveEntryStep}
                  floorMin={floorMin}
                  injectableKeywords={state.injectableKeywords}
                  aiPanelBulletId={aiPanelBulletId}
                  onToggleAiPanel={handleToggleAiPanel}
                  offenderBulletIds={offenderBulletIds}
                  serverBelowFloor={floorWarningEntryIds.has(e.entry_id)}
                  isOffenderEntry={offenderEntryId === e.entry_id}
                  pinnedBulletId={state.pinnedBulletId}
                  naturalnessHints={state.naturalnessHints}
                />
              ))}
            </SortableContext>
          </section>
        )}

        <DragOverlay>{dragOverlayContent()}</DragOverlay>
      </DndContext>

      <GraveyardSection tree={tree} dispatch={dispatch} />
    </div>
  );
}

import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import { useMe } from '../context/MeContext';
import { computeLocalAts, naturalnessHint } from '../lib/atsEngine';
import { NATURALNESS_HINT } from '../lib/display';
import {
  reorderEntries,
  reorderBullets,
  moveBullet,
  setVariant,
  graveyardEntry,
  restoreEntry,
  removeBullet,
  restoreBullet,
  applyAiEdit,
  findBulletIn,
} from './treeOps';

function firstVariantText(variants, picked) {
  return variants && picked ? variants[picked] : '';
}

function bulletTextOf(b) {
  return b && (b.picked === 'custom' ? b.custom_text : b.variants && b.variants[b.picked]);
}

// Extracted from ResumeCanvas's own inline expression (spec 7.14.5's
// reconciliation rule for layout, now reused verbatim for 7.14.13's ats
// reconciliation) so both panes derive "is this still dirty, waiting on the
// next debounced PATCH" from ONE place rather than two copies that could
// silently diverge.
export const isReconciling = (s) => s.revision !== s.savedRevision || s.saveState === 'saving';

// Copilot Mode's state container (spec 7.14.10): useReducer + a Context
// provider scoped to the /copilot/:sessionId route — no Zustand, no app-wide
// state library for a single-screen, single-session editable tree. Stage 2
// only read; Stage 3a (16c) added the local mutation verbs (reorder, variant
// cycling, graveyard/restore) plus the optimistic-local + debounced-PATCH
// write loop against them. This stage (16d) adds the async action layer for
// the two billed AI-edit calls and export — both of which rebuild from what
// the server already has stored, so they flush the pending debounced write
// first (see flushSave below) rather than adding a second persistence path.

const CopilotContext = createContext(null);

const initialState = {
  status: 'loading', // loading | seeding | editing | exported | abandoned | failed | error
  session: null,
  tree: null,
  layout: null,
  warnings: [],
  matchedKeywords: [],
  injectableKeywords: [],
  // Tiered missing-skill severity (A5, spec 7.14.12) — echoed from the job
  // row's own scan-time analysis (5.3), never recomputed client-side.
  criticalMissing: [],
  importantMissing: [],
  niceToHaveMissing: [],
  isStale: false,
  renderHeader: null,
  error: null,

  // Server-authoritative ATS summary (spec 7.14.12/7.14.13) — null until the
  // first GET lands. The OPTIMISTIC local number is deliberately never
  // stored here; it's derived (see CopilotProvider's `localAts` memo) so
  // there is exactly one source of truth for the server's own verdict, the
  // same shape `layout` already uses.
  ats: null,

  // Cheap cross-pane connective tissue: hovering a Workbench bullet outlines
  // its counterpart in the Canvas. Not persisted, not part of the tree.
  hoveredBulletId: null,
  // A chip click "points at" a bullet past the next mouse move, unlike hover
  // (BulletRow clears hoveredBulletId on mouseleave) — cleared by the next
  // chip click or Escape, not by the mouse.
  pinnedBulletId: null,

  // A MISSING (red) ATS chip click stages that term for injection into
  // whichever bullet the user picks next (Phase 3 bug fix, 2026-08-02) — a
  // missing term has no demonstrating bullet to pin, so this drives a
  // "pick a bullet" banner in Workbench instead. Cleared by picking a
  // bullet, Escape, or re-clicking the same chip.
  stagedKeyword: null,

  // Transient, non-persisted gaming-guardrail hints (spec 7.14.13 ¶2) keyed
  // by bullet_id — NEVER written into the tree (runSave always PATCHes
  // stateRef.current.tree, which this never touches) and therefore never
  // sent to the server. Cleared on a tree-adopting SESSION_UPDATE, a later
  // edit to the same bullet, or an explicit dismiss.
  naturalnessHints: {},

  // Local-edit / save-engine state (16c). `revision` bumps on every accepted
  // local mutation; `savedRevision` is the highest revision the server has
  // confirmed via a successful PATCH. `revision !== savedRevision` is this
  // session's definition of "dirty" — the Canvas/Workbench derive it rather
  // than storing a separate boolean that could drift out of sync.
  revision: 0,
  savedRevision: 0,
  saveState: 'idle', // idle | pending | saving | saved | error
  saveError: null, // { message, code, entryId, bulletId }
  savedAt: null,

  // Export flow state (16d / spec 7.14.3 step 4). `exportState` is idle until
  // the user hits Export; `exportDoc` is the completed generated_documents
  // row once export lands; `exportError` carries the export gate's rejection
  // shape (page_overflow's overflowPt/offenders, bullet_too_long's bulletId,
  // below_bullet_floor's entryId) so the Workbench can highlight the actual
  // offender rather than showing a generic failure.
  exportState: 'idle', // idle | flushing | submitting | rendering | done | error
  exportDoc: null,
  exportError: null,
};

// Wraps a treeOps result: every treeOps function returns the SAME tree
// reference (not a clone) when it rejects a mutation (unknown id, ongoing
// role, absent variant, ...), so `nextTree === state.tree` is how a no-op is
// detected here without each call site re-deriving "did anything change."
function afterMutation(state, nextTree) {
  if (nextTree === state.tree) return state;
  return {
    ...state,
    tree: nextTree,
    revision: state.revision + 1,
    saveState: 'pending',
    saveError: null,
  };
}

function reducer(state, action) {
  switch (action.type) {
    case 'SESSION_UPDATE': {
      const {
        session, is_stale_resume_version, matched_keywords, injectable_keywords,
        critical_missing, important_missing, nice_to_have_missing, layout, ats, render_header,
      } = action.payload;
      const dirty = isReconciling(state);
      const base = {
        ...state,
        status: session.status,
        session,
        matchedKeywords: matched_keywords || [],
        injectableKeywords: injectable_keywords || [],
        criticalMissing: critical_missing || [],
        importantMissing: important_missing || [],
        niceToHaveMissing: nice_to_have_missing || [],
        isStale: !!is_stale_resume_version,
        renderHeader: render_header,
        error: session.error_message || null,
      };
      // A locally-edited, not-yet-confirmed tree is never clobbered by a
      // background fetch (e.g. the seeding poll's own tick) — only a
      // deliberate `force` (used to resync after an unrecoverable save
      // error) adopts the server's tree wholesale.
      if (dirty && !action.force) return base;
      return {
        ...base,
        tree: session.content_tree,
        layout,
        // `ats` goes in the SAME tree-adopting branch as `layout`, not
        // `base` — it describes THIS tree, so adopting a server score for
        // a tree we're deliberately not adopting (the dirty guard above)
        // would render chip states for content that isn't on screen.
        ats: ats || state.ats,
        naturalnessHints: {}, // a freshly-adopted tree invalidates any hint keyed to the old bullet text
        revision: 0,
        savedRevision: 0,
        saveState: 'idle',
        saveError: null,
        savedAt: session.updated_at || null,
      };
    }
    case 'FETCH_ERROR':
      return { ...state, status: 'error', error: action.error };

    case 'HOVER_BULLET':
      return state.hoveredBulletId === action.bulletId ? state : { ...state, hoveredBulletId: action.bulletId };

    // Set by a Missing Keywords chip click; survives past the next mouse
    // move (unlike hoveredBulletId, which BulletRow clears on mouseleave —
    // see the state comment above). Cleared by the next chip click
    // (including re-clicking the same chip, action.bulletId === null) or Escape.
    case 'PIN_BULLET':
      return state.pinnedBulletId === action.bulletId ? state : { ...state, pinnedBulletId: action.bulletId };

    // Missing-keyword chip -> "pick a bullet" staging (Phase 3 bug fix,
    // 2026-08-02). Re-clicking the same term clears it, matching PIN_BULLET's
    // toggle behavior.
    case 'STAGE_KEYWORD':
      return state.stagedKeyword === action.term ? { ...state, stagedKeyword: null } : { ...state, stagedKeyword: action.term };

    case 'DISMISS_HINT': {
      if (!state.naturalnessHints[action.bulletId]) return state;
      const next = { ...state.naturalnessHints };
      delete next[action.bulletId];
      return { ...state, naturalnessHints: next };
    }

    case 'REORDER_ENTRIES':
      return afterMutation(state, reorderEntries(state.tree, action.kind, action.orderedEntryIds));
    case 'REORDER_BULLETS':
      return afterMutation(state, reorderBullets(state.tree, action.containerId, action.orderedBulletIds));
    case 'MOVE_BULLET':
      return afterMutation(
        state,
        moveBullet(state.tree, action.bulletId, action.fromContainerId, action.toContainerId, action.toIndex)
      );
    case 'CYCLE_VARIANT': {
      // Variant cycling swaps between pre-authored short/one_line/two_line
      // text, not something the user wrote — deliberately excluded from the
      // naturalness guardrail (spec 7.14.13 ¶2), but it DOES change the
      // bullet's displayed text, so any hint keyed to the old text is stale.
      const next = afterMutation(state, setVariant(state.tree, action.bulletId, action.picked));
      if (next === state || !next.naturalnessHints[action.bulletId]) return next;
      const hints = { ...next.naturalnessHints };
      delete hints[action.bulletId];
      return { ...next, naturalnessHints: hints };
    }
    case 'TOGGLE_ENTRY_GRAVEYARD': {
      const entry = (state.tree.entries || []).find((e) => e.entry_id === action.entryId);
      if (!entry) return state;
      if (entry.graveyard) return afterMutation(state, restoreEntry(state.tree, action.entryId));
      // Client-side mirror of the server's ongoing_role_protected gate — the
      // server re-checks this against origin_tree regardless of what the UI
      // already prevented (spec 7.14.4/7.14.10).
      if (entry.kind === 'experience' && entry.ongoing) return state;
      return afterMutation(state, graveyardEntry(state.tree, action.entryId));
    }
    case 'GRAVEYARD_BULLET':
      return afterMutation(state, removeBullet(state.tree, action.bulletId));
    case 'RESTORE_BULLET':
      return afterMutation(state, restoreBullet(state.tree, action.bulletId));

    case 'SAVE_START':
      return { ...state, saveState: 'saving' };
    case 'SAVE_SUCCESS': {
      const savedRevision = Math.max(state.savedRevision, action.revision);
      const stillDirty = state.revision !== savedRevision;
      return {
        ...state,
        savedRevision,
        layout: action.layout || state.layout,
        ats: action.ats || state.ats,
        warnings: action.warnings || [],
        savedAt: action.updated_at || state.savedAt,
        saveState: stillDirty ? 'pending' : 'saved',
        saveError: null,
      };
    }
    case 'SAVE_ERROR':
      return { ...state, saveState: 'error', saveError: action.error };

    // Applies a server-committed AI edit (rewrite/inject-keyword, spec
    // 7.14.6) to the local tree. Deliberately does NOT touch revision/
    // savedRevision/saveState at all — the caller (CopilotProvider's aiEdit)
    // always flushSave()s first, so revision===savedRevision is already true
    // going in, and the server has already written this exact text to BOTH
    // content_tree and origin_tree (copilot.js's applyEditAndBill), so there
    // is nothing new for the debounced PATCH to send. Leaving the counters
    // alone (rather than bumping them to some new "already saved" value) also
    // sidesteps a real race: React state updates from a dispatch made inside
    // an async function aren't guaranteed to have landed in stateRef.current
    // by the time flushSave's next check runs, so a revision-matching scheme
    // here could make flushSave observe a false "still dirty" gap and fire a
    // stale PATCH that overwrites this very edit with the pre-edit tree —
    // exactly the class of stale-read bug 16c hit and fixed once already.
    // If a newer LOCAL mutation is made concurrently with an in-flight AI
    // call, it lands in state.tree first and this clone-and-patch layers the
    // AI edit on top of it correctly; that local mutation's own revision bump
    // (already dirty independent of this action) still drives the next PATCH.
    case 'AI_EDIT_SUCCESS': {
      const nextTree = applyAiEdit(state.tree, action.bulletId, { variants: action.variants, picked: action.picked, rejected: action.rejected, origin: action.origin, grounded: action.grounded });
      if (nextTree === state.tree) return state;
      // Naturalness guardrail (spec 7.14.13 ¶2): a soft, non-blocking,
      // non-scoring hint, keyed by bullet_id, never written into the tree.
      const naturalnessHints = { ...state.naturalnessHints };
      if (action.hint) naturalnessHints[action.bulletId] = action.hint;
      else delete naturalnessHints[action.bulletId];
      return { ...state, tree: nextTree, layout: action.layout || state.layout, ats: action.ats || state.ats, naturalnessHints };
    }

    // Adopts a tree the SERVER just built (Vault adopt / Custom Bullet
    // Injector, spec 7.14.11/7.14.14) — both endpoints insert into
    // content_tree AND origin_tree server-side (the same applyToBothTrees
    // path AI edits use) and hand back the resulting tree wholesale, so this
    // is a full adoption like SESSION_UPDATE's tree-adopting branch, not an
    // incremental local mutation. Safe to reset revision/savedRevision to 0
    // because both callers (adoptFromVault/addCustomBullet) flushSave() any
    // pending local edit first, so nothing local is discarded.
    case 'SERVER_TREE_UPDATE':
      return {
        ...state,
        tree: action.tree,
        layout: action.layout || state.layout,
        ats: action.ats || state.ats,
        renderHeader: action.renderHeader || state.renderHeader,
        revision: 0,
        savedRevision: 0,
        saveState: 'idle',
        saveError: null,
      };

    case 'EXPORT_START':
      return { ...state, exportState: 'flushing', exportError: null };
    case 'EXPORT_SUBMIT':
      return { ...state, exportState: 'submitting' };
    case 'EXPORT_RENDERING':
      return { ...state, exportState: 'rendering' };
    case 'EXPORT_DONE':
      return { ...state, exportState: 'done', exportDoc: action.doc, exportError: null };
    case 'EXPORT_ERROR':
      return { ...state, exportState: 'error', exportError: action.error };

    default:
      return state;
  }
}

// Session start takes 20-40s (Director + shotgun draft, spec 7.14.3 step 1) —
// same polling cadence as JobDetailView's generate-resume flow.
const SEEDING_POLL_MS = 3000;

// The debounced write cadence (spec 7.14.3 step 2 / tunables.copilot.debounceHintMs
// server-side) — matches SEEDING_POLL_MS's existing hardcoded-constant
// precedent rather than adding a round trip to read it.
const SAVE_DEBOUNCE_MS = 3000;

export function CopilotProvider({ sessionId, children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const pollRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const fetchOnce = useCallback(
    async (force = false) => {
      try {
        const data = await api.getCopilotSession(sessionId);
        dispatch({ type: 'SESSION_UPDATE', payload: data, force });
        return data;
      } catch (e) {
        dispatch({ type: 'FETCH_ERROR', error: e.message });
        return null;
      }
    },
    [sessionId]
  );

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      const data = await fetchOnce();
      if (cancelled || !data) return;
      if (data.session.status === 'seeding') {
        pollRef.current = setTimeout(tick, SEEDING_POLL_MS);
      }
    }
    tick();
    return () => {
      cancelled = true;
      clearTimeout(pollRef.current);
    };
  }, [fetchOnce]);

  // --- Debounced save engine -----------------------------------------
  // Single in-flight PATCH at a time; a mutation that lands mid-flight is
  // picked up as one more save the instant the current one finishes (no
  // extra debounce wait — the user already paid one). The server replaces
  // content_tree wholesale, so a later snapshot always wins; nothing here
  // needs to diff against what the server had.
  const saveTimerRef = useRef(null);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  // Mirrors state.savedRevision, but updated SYNCHRONOUSLY the instant a PATCH
  // resolves — state.savedRevision only lands after React re-renders, which
  // may not have happened yet by the time the code just below checks "did
  // anything change while I was saving." Without this, that check reads a
  // stale savedRevision and fires a redundant duplicate PATCH every time.
  const persistedRevisionRef = useRef(0);

  // Returns { structural } — true when this call hit a 422/409 and force-
  // resynced from the server (flushSave, below, uses this to know it should
  // STOP rather than keep treating the now-intentionally-discarded local
  // divergence as something still to flush).
  const runSave = useCallback(async () => {
    if (inFlightRef.current) {
      queuedRef.current = true;
      return { structural: false };
    }
    const { revision, tree } = stateRef.current;
    if (revision === persistedRevisionRef.current) return { structural: false };

    inFlightRef.current = true;
    dispatch({ type: 'SAVE_START', revision });
    let structural = false;
    try {
      const res = await api.patchCopilotSession(sessionId, tree);
      persistedRevisionRef.current = revision;
      dispatch({ type: 'SAVE_SUCCESS', revision, updated_at: res.updated_at, layout: res.layout, ats: res.ats, warnings: res.warnings });
    } catch (e) {
      const code = e.body && e.body.code;
      dispatch({
        type: 'SAVE_ERROR',
        revision,
        error: { message: e.message, code, entryId: e.body && e.body.entryId, bulletId: e.body && e.body.bulletId },
      });
      if (e.status === 422 || e.status === 409) {
        // The local tree diverged from what the server will accept (a
        // structural gate fired, or the session left `editing` under us) —
        // resync from the server rather than retrying the same rejected
        // tree on a loop.
        structural = true;
        persistedRevisionRef.current = 0;
        await fetchOnce(true);
      }
    } finally {
      inFlightRef.current = false;
    }
    if (!structural && (queuedRef.current || stateRef.current.revision !== persistedRevisionRef.current)) {
      queuedRef.current = false;
      runSave();
    } else {
      queuedRef.current = false;
    }
    return { structural };
  }, [sessionId, fetchOnce]);

  useEffect(() => {
    if (state.revision === state.savedRevision) return undefined;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(runSave, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(saveTimerRef.current);
  }, [state.revision, state.savedRevision, runSave]);

  // Promise-returning flush of the debounced save engine above — used before
  // the AI-edit and export calls, both of which rebuild content_tree/render
  // from what the server ALREADY has stored, so any not-yet-persisted local
  // edit must land first (16c's save engine exists specifically for this).
  // runSave's own end-of-body continuation (queuedRef, for an edit that lands
  // mid-PATCH) is a fire-and-forget tail call, not awaitable across the
  // recursion, so this polls briefly while genuinely in-flight rather than
  // hot-looping a promise that can resolve instantly without the network
  // round trip actually finishing.
  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    while (stateRef.current.revision !== persistedRevisionRef.current) {
      if (inFlightRef.current) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const { structural } = await runSave();
      if (structural) break; // resynced from the server — any remaining
      // local/persisted mismatch was an intentionally discarded edit, not
      // something left to flush.
    }
  }, [runSave]);

  const { refresh: refreshMe } = useMe();

  // POST /bullets/:id/rewrite or /inject-keyword (spec 7.14.6). Flushes any
  // pending local edit first (both AI-edit routes rebuild their context from
  // what the server has already stored), then applies the server's committed
  // result locally via AI_EDIT_SUCCESS — see that reducer case for why it
  // deliberately leaves revision/savedRevision untouched.
  //
  // CHANGED 2026-08-02 (Phase 3 bug fix): `keyword` (singular) is now
  // `keywords` (array, multi-select staging) and the server returns THREE
  // variants + a `picked` key instead of one string — the naturalness hint
  // compares against `variants[picked]`, not `text`.
  const aiEdit = useCallback(
    async ({ bulletId, kind, instruction, keywords }) => {
      // Captured BEFORE flushSave/the network call, for the naturalness
      // guardrail's before/after word-count comparison (spec 7.14.13 ¶2) —
      // treeOps' own findBulletIn, so this is the exact same bullet lookup
      // every local mutation already uses.
      const before = bulletTextOf((findBulletIn(stateRef.current.tree, bulletId) || {}).bullet);
      await flushSave();
      const result = kind === 'rewrite'
        ? await api.copilotRewriteBullet(sessionId, bulletId, instruction)
        : await api.copilotInjectKeyword(sessionId, bulletId, keywords);
      const jdTerms = (stateRef.current.ats && stateRef.current.ats.terms || []).map((t) => t.term);
      const after = firstVariantText(result.variants, result.picked);
      const hint = naturalnessHint({ before, after, jdTerms, wordsPerAddedTerm: NATURALNESS_HINT.wordsPerAddedTerm });
      dispatch({
        type: 'AI_EDIT_SUCCESS',
        bulletId,
        variants: result.variants,
        picked: result.picked,
        rejected: result.rejected_variants,
        origin: kind === 'rewrite' ? 'ai_rewrite' : 'ai_inject_keyword',
        grounded: result.grounded,
        layout: result.layout,
        ats: result.ats,
        hint,
      });
      refreshMe().catch(() => {});
      return result;
    },
    [sessionId, flushSave, refreshMe]
  );

  // POST /bullets/:id/revert (Phase 3 bug fix, 2026-08-02) — undo the last AI
  // edit on this bullet. Zero AI, zero COS; adopts the server's tree wholesale
  // like Vault-adopt/addCustomBullet, since the server is what actually holds
  // the prev_* snapshot.
  const revertBulletEdit = useCallback(
    async (bulletId) => {
      await flushSave();
      const result = await api.revertBulletEdit(sessionId, bulletId);
      dispatch({ type: 'SERVER_TREE_UPDATE', tree: result.content_tree, layout: result.layout, ats: result.ats });
      refreshMe().catch(() => {});
      return result;
    },
    [sessionId, flushSave, refreshMe]
  );

  // PUT /bullets/:id/text (Phase 3 bug fix, 2026-08-02) — manual, user-typed
  // replacement text for an EXISTING bullet. Zero AI, zero COS.
  const editBulletText = useCallback(
    async (bulletId, text) => {
      await flushSave();
      const result = await api.editBulletText(sessionId, bulletId, text);
      dispatch({ type: 'SERVER_TREE_UPDATE', tree: result.content_tree, layout: result.layout, ats: result.ats });
      refreshMe().catch(() => {});
      return result;
    },
    [sessionId, flushSave, refreshMe]
  );

  // POST /bullets { mode: 'ai' } (Phase 3 bug fix, 2026-08-02) — AI-authored
  // new bullet, billed, three variants. Shares addCustomBullet's zero-AI
  // sibling route so both go through the same SERVER_TREE_UPDATE adoption.
  const addAiBullet = useCallback(
    async (entryId, instruction) => {
      await flushSave();
      const result = await api.addAiBullet(sessionId, entryId, instruction);
      dispatch({ type: 'SERVER_TREE_UPDATE', tree: result.content_tree, layout: result.layout, ats: result.ats });
      refreshMe().catch(() => {});
      return result;
    },
    [sessionId, flushSave, refreshMe]
  );

  const stageKeyword = useCallback((term) => dispatch({ type: 'STAGE_KEYWORD', term }), []);

  // PATCH .../header and .../skills (Phase 3 bug fix, 2026-08-02) — own
  // dedicated routes, not the debounced session PATCH (whose 422 branch
  // force-adopts the server tree and would wipe a half-typed field). Both
  // adopt the server's tree wholesale on success, same as addCustomBullet.
  const updateHeader = useCallback(
    async (fields) => {
      await flushSave();
      const result = await api.patchCopilotHeader(sessionId, fields);
      dispatch({ type: 'SERVER_TREE_UPDATE', tree: result.content_tree, layout: result.layout, ats: result.ats, renderHeader: result.render_header });
      return result;
    },
    [sessionId, flushSave]
  );

  const updateSkills = useCallback(
    async (rows) => {
      await flushSave();
      const result = await api.patchCopilotSkills(sessionId, rows);
      dispatch({ type: 'SERVER_TREE_UPDATE', tree: result.content_tree, layout: result.layout, ats: result.ats });
      return result;
    },
    [sessionId, flushSave]
  );

  // Vault adopt (spec 7.14.11) and Custom Bullet Injector (spec 7.14.14) —
  // both zero-AI, zero-COS server writes that insert real content into
  // origin_tree, so (like aiEdit) any pending local edit must land first.
  // Errors (422 not_omitted / needs_confirmation / bullet_too_long) are left
  // to propagate to the caller, same as api.copilotInjectKeyword's contract —
  // the Workbench UI branches on e.body.code itself.
  const adoptFromVault = useCallback(
    async (payload) => {
      await flushSave();
      const result = await api.adoptVaultItem(sessionId, payload);
      dispatch({ type: 'SERVER_TREE_UPDATE', tree: result.content_tree, layout: result.layout, ats: result.ats });
      refreshMe().catch(() => {});
      return result;
    },
    [sessionId, flushSave, refreshMe]
  );

  const addCustomBullet = useCallback(
    async (entryId, text) => {
      await flushSave();
      const result = await api.addCustomBullet(sessionId, entryId, text);
      dispatch({ type: 'SERVER_TREE_UPDATE', tree: result.content_tree, layout: result.layout, ats: result.ats });
      refreshMe().catch(() => {});
      return result;
    },
    [sessionId, flushSave, refreshMe]
  );

  // POST /export (spec 7.14.3 step 4) → poll the resulting generated_documents
  // row on the same cadence as the seeding poll. The server itself gates
  // page-fit/floor/ongoing-role (7.14.4) synchronously before ever inserting
  // a row, so a rejection here always means nothing was created.
  const pollExportDoc = useCallback(
    async (docId) => {
      try {
        const { document } = await api.getDocument(docId);
        if (document.status === 'completed') {
          dispatch({ type: 'EXPORT_DONE', doc: document });
          refreshMe().catch(() => {});
          fetchOnce(true); // session flips to 'exported' server-side once this lands
          return;
        }
        if (document.status === 'failed') {
          dispatch({ type: 'EXPORT_ERROR', error: { message: document.error_message || 'Export failed.' } });
          return;
        }
        setTimeout(() => pollExportDoc(docId), SEEDING_POLL_MS);
      } catch (e) {
        dispatch({ type: 'EXPORT_ERROR', error: { message: e.message } });
      }
    },
    [refreshMe, fetchOnce]
  );

  const exportSession = useCallback(async () => {
    dispatch({ type: 'EXPORT_START' });
    await flushSave();
    dispatch({ type: 'EXPORT_SUBMIT' });
    try {
      const { document_id } = await api.exportCopilotSession(sessionId);
      dispatch({ type: 'EXPORT_RENDERING' });
      await pollExportDoc(document_id);
    } catch (e) {
      dispatch({
        type: 'EXPORT_ERROR',
        error: {
          message: e.message,
          code: e.body && e.body.code,
          overflowPt: e.body && e.body.overflowPt,
          offenders: e.body && e.body.offenders,
          bulletId: e.body && e.body.bulletId,
          entryId: e.body && e.body.entryId,
        },
      });
    }
  }, [sessionId, flushSave, pollExportDoc]);

  // Best-effort flush on unmount/navigation-away so a quick edit-then-leave
  // doesn't silently drop the last few seconds of work. No localStorage
  // fallback (spec 7.14.3) — the debounced Supabase write is the only
  // persistence layer, so this is a real (if best-effort) network call.
  useEffect(() => {
    const flush = () => {
      if (stateRef.current.revision !== stateRef.current.savedRevision) {
        api.patchCopilotSession(sessionId, stateRef.current.tree).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [sessionId]);

  // The optimistic local score for spec 7.14.13's live scoreboard — a full-
  // document text scan, so this is a useMemo (not reducer state; the reducer
  // must stay cheap and pure). treeOps returns the SAME tree reference on a
  // rejected mutation, so this recomputes exactly once per accepted edit,
  // not on every render. Reads server-echoed weights/target off state.ats so
  // it never needs tunables.json in the browser (see atsEngine.js).
  const localAts = useMemo(() => computeLocalAts(state.tree, state.ats), [state.tree, state.ats]);

  const reconciling = isReconciling(state);
  const resolvedAts = useMemo(() => {
    const src = reconciling && localAts ? localAts : state.ats;
    if (!src) return { score: null, target: null, terms: [], counts: { core: 0, skills_only: 0, missing: 0 }, source: 'server', reconciling };
    return { ...src, source: reconciling && localAts ? 'local' : 'server', reconciling };
  }, [reconciling, localAts, state.ats]);

  // Measurement-parity self-check (spec 7.14.13): the local and server
  // computations run the identical shared summarizeAts, so once reconciled
  // they should be a visual no-op. Dev-only, once per drift, never surfaced
  // to the user — this is what makes the parity claim falsifiable in normal
  // use rather than just a design-doc assertion.
  const warnedDriftRef = useRef(false);
  useEffect(() => {
    if (!import.meta.env.DEV || reconciling || !localAts || !state.ats) return;
    const scoreDrift = Math.abs(localAts.score - state.ats.score) > 0.05;
    const tiersDiffer = JSON.stringify(localAts.terms.map((t) => t.tier)) !== JSON.stringify(state.ats.terms.map((t) => t.tier));
    if ((scoreDrift || tiersDiffer) && !warnedDriftRef.current) {
      warnedDriftRef.current = true;
      // eslint-disable-next-line no-console
      console.warn('[ats parity] local/server ats diverged after reconciliation', { local: localAts, server: state.ats });
    } else if (!scoreDrift && !tiersDiffer) {
      warnedDriftRef.current = false;
    }
  }, [reconciling, localAts, state.ats]);

  return (
    <CopilotContext.Provider value={{ state, dispatch, refresh: fetchOnce, aiEdit, revertBulletEdit, editBulletText, exportSession, adoptFromVault, addCustomBullet, addAiBullet, stageKeyword, updateHeader, updateSkills, ats: resolvedAts }}>
      {children}
    </CopilotContext.Provider>
  );
}

export function useCopilot() {
  const ctx = useContext(CopilotContext);
  if (!ctx) throw new Error('useCopilot must be used within CopilotProvider');
  return ctx;
}

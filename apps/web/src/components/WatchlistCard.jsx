import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import Spinner from './Spinner';
import ProgressConsole from './ProgressConsole';

// AI-curated watchlist (spec 20; §15 #50). Sibling to TracklistsCard.jsx and
// SectorTracklistsCard.jsx in the same Settings section.
//
// STAGED, NEVER AUTO-SAVED (spec 20 step 3). "Build my watchlist" writes
// nothing to any tracklist — it stages pending suggestions. Adding is always
// an explicit click: one row's "Add", or "Add all N" for a run's suggestions
// (still the user's decision, just made once for the batch).
//
// A build is a tracked run (watchlist_runs): the POST returns at once and this
// card polls its progress, the same console the scan and résumé generation
// use, so a 30-90 s build is never a silent spinner and a failed one says
// where it stopped.
//
// Every row shows its rationale, which always cites a real data point — the
// server's validator drops any candidate that cites nothing checkable
// (CLAUDE.md's never-fabricate rule).

const EVIDENCE_LABEL = {
  visa_sponsor: 'H-1B filings',
  sector: 'Sector match',
  resume_match: 'Résumé match',
};

const DEFAULT_LIST_NAME = 'My Watchlist';
const POLL_MS = 3000;

// Suggestions grouped by the steer that produced them, newest run first
// (the server orders by created_at desc; re-staging moves a row to the
// latest run).
function groupByRun(suggestions) {
  const groups = [];
  const byKey = new Map();
  for (const s of suggestions) {
    const key = s.run_input || '';
    if (!byKey.has(key)) {
      const g = { key, input: s.run_input, createdAt: s.created_at, items: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    byKey.get(key).items.push(s);
  }
  return groups;
}

function runSection(run) {
  const lines = (run.progress || []).map((p) => ({ text: p.label }));
  if (!lines.length) lines.push({ text: 'Starting…' });
  if (run.status === 'completed') {
    lines.push({
      text:
        run.result_count > 0
          ? `Done — ${run.result_count} suggestion${run.result_count === 1 ? '' : 's'} below.`
          : run.candidates_considered
            ? `Done — none of the ${run.candidates_considered} shortlisted companies was a strong enough fit. Try a broader steer.`
            : 'Done — no untracked companies matched that target. Try a broader steer, or clear it to go off your résumé alone.',
      tone: run.result_count > 0 ? 'ok' : 'dim',
    });
  }
  if (run.status === 'failed') lines.push({ text: run.error_message || 'The build failed.', tone: 'err' });
  return {
    id: run.id,
    title: run.input ? `Build my watchlist — “${run.input}”` : 'Build my watchlist — from your résumé',
    tone: run.status === 'failed' ? 'err' : run.status === 'completed' ? 'ok' : 'running',
    lines,
  };
}

export default function WatchlistCard() {
  const [suggestions, setSuggestions] = useState(null); // null=loading, []=none
  const [lists, setLists] = useState([]);
  const [input, setInput] = useState('');
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(null); // suggestion id, or a group key for "Add all"
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [targetListId, setTargetListId] = useState('');
  const pollRef = useRef(null);

  const building = !!run && (run.status === 'queued' || run.status === 'running');

  const load = useCallback(async () => {
    try {
      const [{ suggestions: s }, { tracklists }] = await Promise.all([
        api.listWatchlistSuggestions('pending'),
        api.listTracklists(),
      ]);
      setSuggestions(s || []);
      setLists(tracklists || []);
    } catch (e) {
      setSuggestions([]);
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll the active run until it settles, then reload the suggestion list.
  useEffect(() => {
    if (!run || !building) return undefined;
    pollRef.current = setTimeout(async () => {
      try {
        const { run: fresh } = await api.getWatchlistRun(run.id);
        setRun(fresh);
        if (fresh.status === 'completed' || fresh.status === 'failed') await load();
      } catch (e) {
        setError(e.message);
      }
    }, POLL_MS);
    return () => clearTimeout(pollRef.current);
  }, [run, building, load]);

  async function build() {
    setError(null);
    setNotice(null);
    try {
      // Empty input is valid (spec 20) — the AI then infers targets from the
      // master résumé alone. Deliberately not validated as required.
      const { run_id: runId } = await api.curateWatchlist(input);
      setRun({ id: runId, status: 'queued', input: input.trim() || null, progress: [] });
    } catch (e) {
      setError(e.message);
    }
  }

  // Adds to the picked list, or to "My Watchlist" (created on first use,
  // reused after — the server finds it by name). After the first add the
  // picker switches to that list so later adds say where they're going.
  async function add(ids, busyKey) {
    setBusy(busyKey);
    setError(null);
    setNotice(null);
    try {
      const res = targetListId
        ? await api.acceptWatchlistSuggestions(ids, [targetListId])
        : await api.acceptWatchlistSuggestions(ids, null, DEFAULT_LIST_NAME);
      const listId = res.tracklistIds && res.tracklistIds[0];
      if (listId && !targetListId) setTargetListId(listId);
      const listName = (lists.find((l) => l.id === (targetListId || listId)) || {}).name || DEFAULT_LIST_NAME;
      setNotice(`Added ${res.accepted} compan${res.accepted === 1 ? 'y' : 'ies'} to “${listName}”.`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function reject(s) {
    setBusy(s.id);
    setError(null);
    try {
      await api.rejectWatchlistSuggestion(s.id);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const groups = groupByRun(suggestions || []);

  return (
    <div className="setting-card">
      <h3>Build my watchlist</h3>
      <p className="disabled-note" style={{ margin: '0 0 10px', textAlign: 'left' }}>
        Suggests companies from the tracked-company registry based on your résumé, each one citing the
        specific data point behind it — an H-1B filing record, a sector tag, or a match to your own
        experience. Nothing is added until you say so.
      </p>

      <textarea
        className="wl-input"
        rows={2}
        placeholder="Optional: target roles, sponsorship needs, exclusions — e.g. &ldquo;manufacturing-adjacent, not big tech&rdquo;. Leave empty to go purely off your résumé."
        value={input}
        onChange={(e) => setInput(e.target.value)}
        disabled={building}
      />

      <div className="wl-actions">
        <button className="btn btn-primary" onClick={build} disabled={building}>
          {building ? <Spinner /> : null}
          {building ? ' Building…' : 'Build my watchlist'}
        </button>
        <label className="wl-target">
          <span>Add to</span>
          <select value={targetListId} onChange={(e) => setTargetListId(e.target.value)}>
            <option value="">{`“${DEFAULT_LIST_NAME}”${lists.some((l) => l.name === DEFAULT_LIST_NAME) ? '' : ' (new)'}`}</option>
            {lists
              .filter((l) => l.name !== DEFAULT_LIST_NAME)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
          </select>
        </label>
      </div>

      {run ? (
        <div style={{ marginTop: 10 }}>
          <ProgressConsole sections={[runSection(run)]} />
        </div>
      ) : null}

      {error ? <div className="error-text" style={{ marginTop: 8 }}>{error}</div> : null}
      {notice ? <div className="ok-text" style={{ marginTop: 8 }}>{notice}</div> : null}

      {suggestions === null ? (
        <Spinner />
      ) : suggestions.length === 0 ? (
        <div className="disabled-note" style={{ margin: '10px 0 0' }}>
          No pending suggestions. Build a watchlist to get some.
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.key} className="wl-group">
            <div className="wl-group-head">
              <span>
                {g.input ? <>From “{g.input}”</> : 'From your résumé'} · {g.items.length} suggestion
                {g.items.length === 1 ? '' : 's'}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                disabled={!!busy}
                onClick={() => add(g.items.map((s) => s.id), g.key)}
              >
                {busy === g.key ? <Spinner /> : `Add all ${g.items.length}`}
              </button>
            </div>
            {g.items.map((s) => (
              <div key={s.id} className="wl-row">
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {s.company_ats_registry ? s.company_ats_registry.company_name_display : 'Unknown company'}
                    <span className="risk-tag" style={{ marginLeft: 8 }}>
                      {EVIDENCE_LABEL[s.evidence_type] || s.evidence_type}
                    </span>
                  </div>
                  <div className="wl-rationale">{s.rationale}</div>
                </div>
                <button className="link-btn" onClick={() => add([s.id], s.id)} disabled={!!busy}>
                  {busy === s.id ? <Spinner /> : 'Add'}
                </button>
                <button className="link-btn" onClick={() => reject(s)} disabled={!!busy}>
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import Spinner from './Spinner';
import AddToTracklistModal from './AddToTracklistModal';
import { PLATFORM_LABEL } from '../lib/platformLabels';

// Tracked Companies (spec 4.6.8; §15 #25a) — replaces the old flat
// TrackedCompaniesCard (user_tracked_companies, §23) with the Spotify-
// playlist-style tracklist model: any number of named personal lists, a bulk
// multiselect add flow, and rename/delete. The "Request a company" block
// (4.6.3's third entry point) and the browse-known-companies list are carried
// over from the old card near-verbatim — same pipeline, same UX — just
// re-parented under the tracklist selector and given bulk-add checkboxes.


export default function TracklistsCard() {
  const [lists, setLists] = useState(null);
  const [selectedListId, setSelectedListId] = useState(null);
  const [listCompanies, setListCompanies] = useState(null);
  const [newListName, setNewListName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [company, setCompany] = useState('');
  const [link, setLink] = useState('');
  // idle | detecting | resolved | unresolved | error
  const [phase, setPhase] = useState('idle');
  const [verdict, setVerdict] = useState(null);

  const [browseOpen, setBrowseOpen] = useState(false);
  const [known, setKnown] = useState(null);
  const [query, setQuery] = useState('');
  const [selectedCompanyIds, setSelectedCompanyIds] = useState(() => new Set());
  const [addPickerOpen, setAddPickerOpen] = useState(false);

  const loadLists = useCallback(async () => {
    try {
      const { tracklists } = await api.listTracklists();
      setLists(tracklists || []);
      setSelectedListId((prev) => {
        if (prev && (tracklists || []).some((l) => l.id === prev)) return prev;
        return tracklists && tracklists.length ? tracklists[0].id : null;
      });
    } catch (e) {
      setLists([]);
      setError(e.message);
    }
  }, []);

  const loadListCompanies = useCallback(async (listId) => {
    if (!listId) {
      setListCompanies([]);
      return;
    }
    setListCompanies(null);
    try {
      const { companies } = await api.listTracklistCompanies(listId);
      setListCompanies(companies || []);
    } catch (e) {
      setListCompanies([]);
      setError(e.message);
    }
  }, []);

  const loadKnown = useCallback(async (q) => {
    setKnown(null);
    try {
      const { companies } = await api.listKnownCompanies(q);
      setKnown(companies || []);
    } catch (e) {
      setKnown([]);
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    loadLists();
  }, [loadLists]);

  useEffect(() => {
    loadListCompanies(selectedListId);
  }, [selectedListId, loadListCompanies]);

  const selectedList = (lists || []).find((l) => l.id === selectedListId) || null;

  async function submitRequest() {
    setPhase('detecting');
    setError(null);
    setVerdict(null);
    try {
      const res = await api.requestCompany(company.trim(), link.trim() || undefined);
      setVerdict(res);
      setPhase(res.status === 'resolved' ? 'resolved' : 'unresolved');
      if (res.status === 'resolved') {
        setCompany('');
        setLink('');
        await loadLists();
        if (selectedListId) await loadListCompanies(selectedListId);
        if (browseOpen) await loadKnown(query);
      }
    } catch (e) {
      setError(e.message);
      setPhase('error');
    }
  }

  async function createList() {
    const name = newListName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const { tracklist } = await api.createTracklist(name);
      setNewListName('');
      await loadLists();
      setSelectedListId(tracklist.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitRename() {
    const name = renameValue.trim();
    if (!name || !selectedList) return;
    setBusy(true);
    try {
      await api.renameTracklist(selectedList.id, name);
      setRenaming(false);
      await loadLists();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteList() {
    if (!selectedList) return;
    if (!window.confirm(`Delete "${selectedList.name}"? This only un-groups its companies — nothing is removed from the global registry.`)) return;
    setBusy(true);
    try {
      await api.deleteTracklist(selectedList.id);
      setSelectedListId(null);
      await loadLists();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeFromList(registryId) {
    if (!selectedList) return;
    setBusy(true);
    try {
      await api.removeCompanyFromTracklist(selectedList.id, registryId);
      await Promise.all([loadListCompanies(selectedList.id), loadLists()]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function toggleCompanySelected(id) {
    setSelectedCompanyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkAddDone() {
    setAddPickerOpen(false);
    setSelectedCompanyIds(new Set());
    await loadLists();
    if (selectedListId) await loadListCompanies(selectedListId);
  }

  const detecting = phase === 'detecting';

  return (
    <div className="setting-card">
      <h3>Tracked Companies</h3>
      <p>
        Company job boards CareerOS can pull from directly — often same-day, before a posting
        reaches the big job boards. Organize companies into any number of named lists.
      </p>

      {/* --- Tracklist selector --- */}
      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Your tracklists</div>
        {lists === null ? (
          <div className="gen-status">
            <Spinner /> &nbsp;Loading…
          </div>
        ) : lists.length === 0 ? (
          <div className="disabled-note" style={{ margin: 0 }}>
            No tracklists yet — create one below.
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {lists.map((l) => (
              <button
                key={l.id}
                className={l.id === selectedListId ? 'btn btn-primary' : 'btn btn-ghost'}
                style={{ fontSize: 12, padding: '5px 10px' }}
                onClick={() => setSelectedListId(l.id)}
              >
                {l.name} ({l.company_count})
                {/* §15 #25b: a subscribed sector tracklist (4.6.9) now shows up
                    here via listTracklists' union — badge it so it doesn't
                    read as one of the user's own lists. */}
                {l.is_system && (
                  <span className="nav-soon" style={{ margin: '0 0 0 6px' }}>
                    Sector
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder="New tracklist name…"
            style={{ flex: 1 }}
            disabled={busy}
          />
          <button className="btn btn-ghost" onClick={createList} disabled={busy || !newListName.trim()}>
            Create
          </button>
        </div>

        {selectedList && selectedList.is_system ? (
          // System (sector) tracklists aren't user-editable (spec 4.6.9) —
          // membership is maintained by the classification pipeline, not by
          // the subscriber. The server already 403s rename/delete against a
          // system list; this just doesn't offer the controls in the first place.
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-dim)' }}>
            Viewing <strong>{selectedList.name}</strong> — a built-in list. Manage your subscription below.
          </div>
        ) : selectedList ? (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {renaming ? (
              <>
                <input
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  style={{ flex: 1, minWidth: 120 }}
                  disabled={busy}
                />
                <button className="link-btn" onClick={submitRename} disabled={busy || !renameValue.trim()}>
                  Save
                </button>
                <button className="link-btn" onClick={() => setRenaming(false)} disabled={busy}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  Viewing <strong>{selectedList.name}</strong>
                </span>
                <button
                  className="link-btn"
                  onClick={() => {
                    setRenameValue(selectedList.name);
                    setRenaming(true);
                  }}
                  disabled={busy}
                >
                  Rename
                </button>
                <button className="link-btn" style={{ color: 'var(--danger)' }} onClick={deleteList} disabled={busy}>
                  Delete list
                </button>
              </>
            )}
          </div>
        ) : null}

        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </div>

      {/* --- Selected list's companies --- */}
      <div style={{ borderTop: '1px solid var(--line)', marginTop: 14, paddingTop: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
          Companies {listCompanies ? `(${listCompanies.length})` : ''}
        </div>
        {!selectedList ? (
          <div className="disabled-note" style={{ margin: 0 }}>Select or create a tracklist above.</div>
        ) : listCompanies === null ? (
          <div className="gen-status">
            <Spinner /> &nbsp;Loading…
          </div>
        ) : listCompanies.length === 0 ? (
          <div className="disabled-note" style={{ margin: 0 }}>
            Nothing here yet — request a company below, or add some from the browse list.
          </div>
        ) : (
          listCompanies.map((c) => (
            <CompanyRow
              key={c.id}
              company={c}
              busy={busy}
              onRemove={selectedList.is_system ? null : () => removeFromList(c.id)}
            />
          ))
        )}
      </div>

      {/* --- Request a company (4.6.3's manual entry point) --- */}
      <div style={{ borderTop: '1px solid var(--line)', marginTop: 14, paddingTop: 12 }}>
        <label className="field-label" htmlFor="tc-company">Request a company</label>
        <input
          id="tc-company"
          type="text"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="e.g. Linear"
          disabled={detecting}
        />
        <label className="field-label" htmlFor="tc-link" style={{ marginTop: 8 }}>
          Careers page URL <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>— optional, but makes the match exact</span>
        </label>
        <input
          id="tc-link"
          type="text"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://jobs.ashbyhq.com/linear"
          disabled={detecting}
        />

        <button
          className="btn btn-primary"
          onClick={submitRequest}
          disabled={detecting || !company.trim()}
          style={{ marginTop: 10 }}
        >
          {detecting ? (
            <>
              <Spinner /> &nbsp;Looking up their job board…
            </>
          ) : (
            <>Request Company</>
          )}
        </button>

        {phase === 'resolved' && verdict?.company && (
          <div className="ok-text" style={{ marginTop: 8 }}>
            Found <strong>{verdict.company.company_name_display}</strong> on{' '}
            {PLATFORM_LABEL[verdict.company.platform] || verdict.company.platform} — added to{' '}
            {selectedList ? selectedList.name : 'your tracklist'}.
          </div>
        )}

        {phase === 'unresolved' && (
          <div className="empty-state" style={{ textAlign: 'left', marginTop: 8 }}>
            <strong>No job board found.</strong>{' '}
            {verdict?.match_attempt_type === 'url_no_match'
              ? "That URL doesn't match a job board we support yet."
              : "We couldn't find a job board for them under that name. If you have their careers page URL, add it above and try again."}
            <div className="disabled-note" style={{ margin: '8px 0 0' }}>
              Saved to our review list — we retry these automatically every couple of days.
            </div>
          </div>
        )}
      </div>

      {/* --- Browse known companies, with bulk multiselect add (4.6.8) --- */}
      <div style={{ borderTop: '1px solid var(--line)', marginTop: 14, paddingTop: 12 }}>
        <button
          className="link-btn"
          onClick={() => {
            const next = !browseOpen;
            setBrowseOpen(next);
            if (next && known === null) loadKnown('');
          }}
        >
          {browseOpen ? 'Hide' : 'Browse'} companies we already know →
        </button>

        {browseOpen && (
          <div style={{ marginTop: 10 }}>
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                loadKnown(e.target.value.trim());
              }}
              placeholder="Search by name…"
            />

            {selectedCompanyIds.size > 0 && (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12 }}>{selectedCompanyIds.size} selected</span>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setAddPickerOpen(true)}>
                  Add to tracklist…
                </button>
                <button className="link-btn" style={{ fontSize: 12 }} onClick={() => setSelectedCompanyIds(new Set())}>
                  Clear
                </button>
              </div>
            )}

            {known === null ? (
              <div className="gen-status" style={{ marginTop: 8 }}>
                <Spinner /> &nbsp;Loading…
              </div>
            ) : known.length === 0 ? (
              <div className="disabled-note" style={{ marginTop: 8 }}>
                {query ? 'No matches.' : 'No companies resolved yet.'}
              </div>
            ) : (
              known.map((c) => (
                <BrowseRow
                  key={c.id}
                  company={c}
                  checked={selectedCompanyIds.has(c.id)}
                  onToggle={() => toggleCompanySelected(c.id)}
                />
              ))
            )}
          </div>
        )}
      </div>

      {addPickerOpen && (
        <AddToTracklistModal
          registryIds={[...selectedCompanyIds]}
          onDone={handleBulkAddDone}
          onCancel={() => setAddPickerOpen(false)}
        />
      )}
    </div>
  );
}

function CompanyRow({ company, busy, onRemove }) {
  return (
    <div
      style={{
        borderTop: '1px solid var(--line)',
        padding: '9px 0',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{company.company_name_display}</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          {PLATFORM_LABEL[company.platform] || company.platform} · {company.slug_or_identifier}
        </div>
      </div>
      {onRemove && (
        <button className="link-btn" onClick={onRemove} disabled={busy}>
          Remove
        </button>
      )}
    </div>
  );
}

function BrowseRow({ company, checked, onToggle }) {
  return (
    <label
      style={{
        borderTop: '1px solid var(--line)',
        padding: '9px 0',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        cursor: 'pointer',
      }}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{company.company_name_display}</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          {PLATFORM_LABEL[company.platform] || company.platform} · {company.slug_or_identifier}
          {company.tracked ? ' · tracked' : ''}
        </div>
      </div>
    </label>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import Spinner from './Spinner';
import { PLATFORM_LABEL } from '../lib/platformLabels';

// System sector tracklists (spec 4.6.9; §15 #25b) — browse the 16 built-in,
// AI-classified sector lists and subscribe/unsubscribe. A subscription is
// zero-copy (tracklist_subscriptions, shipped in 25a): the moment you
// subscribe, every company in that sector is instantly part of your tracked
// union (registry.js's listTrackedCompanies) with no backfill step, and any
// company the classification pipeline adds to that sector later shows up
// automatically. Sibling to TracklistsCard.jsx in the same Settings section —
// same idiom (null=loading, []=loaded-empty, one error, one busy flag), same
// card/list styling, no new CSS.


// The server tags each built-in list with its family and orders them
// startup, sponsor, sector (companies/tracklists.js listSystemTracklists).
const KIND_HEADING = { startup: 'Startups', sponsor: 'Visa sponsors', sector: 'Sectors' };
const KIND_NOTE = {
  startup: 'YC companies hiring in the US, refreshed from the YC directory',
  sponsor: 'from certified H-1B filings',
};

export default function SectorTracklistsCard() {
  const [lists, setLists] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [preview, setPreview] = useState(null); // null=loading, []=empty, else companies

  const loadLists = useCallback(async () => {
    try {
      const { tracklists } = await api.listSystemTracklists();
      setLists(tracklists || []);
    } catch (e) {
      setLists([]);
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    loadLists();
  }, [loadLists]);

  async function toggleSubscribe(list) {
    setBusyId(list.id);
    setError(null);
    try {
      if (list.subscribed) await api.unsubscribeTracklist(list.id);
      else await api.subscribeTracklist(list.id);
      await loadLists();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleView(list) {
    const next = openId === list.id ? null : list.id;
    setOpenId(next);
    if (next && (list.subscribed || list.company_count > 0)) {
      setPreview(null);
      try {
        const { companies } = await api.listTracklistCompanies(list.id);
        setPreview(companies || []);
      } catch (e) {
        setPreview([]);
        setError(e.message);
      }
    }
  }

  const subscribedCount = (lists || []).filter((l) => l.subscribed).length;

  return (
    <div className="setting-card">
      <h3>Built-in Tracklists</h3>
      <p>
        Company lists CareerOS keeps up to date for you. Subscribe to one and every company in it — now and
        later — is instantly part of your ATS Direct scan pool.
      </p>

      {lists === null ? (
        <div className="gen-status">
          <Spinner /> &nbsp;Loading…
        </div>
      ) : lists.length === 0 ? (
        <div className="disabled-note" style={{ margin: 0 }}>No built-in tracklists available yet.</div>
      ) : (
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 4 }}>
          {subscribedCount > 0 && (
            <div className="disabled-note" style={{ margin: '8px 0 4px', textAlign: 'left' }}>
              Subscribed to {subscribedCount} list{subscribedCount === 1 ? '' : 's'} — a large list keeps
              scanning companies until your target is met, and automatically resumes exactly where it left off
              if it ever runs out of time, so every company gets scanned in rotation.
            </div>
          )}
          {lists.map((l, i) => (
            <div key={l.id}>
              {(i === 0 || lists[i - 1].kind !== l.kind) && KIND_HEADING[l.kind] && (
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-dim)', padding: '12px 0 2px' }}>
                  {KIND_HEADING[l.kind]}
                </div>
              )}
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
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{l.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                    {l.company_count} companies{KIND_NOTE[l.kind] ? ` · ${KIND_NOTE[l.kind]}` : ''}
                  </div>
                </div>
                {l.company_count > 0 && (
                  <button className="link-btn" style={{ fontSize: 12 }} onClick={() => toggleView(l)}>
                    {openId === l.id ? 'Hide' : 'View'}
                  </button>
                )}
                <button
                  className={l.subscribed ? 'btn btn-ghost' : 'btn btn-primary'}
                  style={{ fontSize: 12, padding: '5px 10px' }}
                  onClick={() => toggleSubscribe(l)}
                  disabled={busyId === l.id}
                >
                  {busyId === l.id ? <Spinner /> : l.subscribed ? 'Unsubscribe' : 'Subscribe'}
                </button>
              </div>
              {openId === l.id && (
                <div style={{ paddingLeft: 12, paddingBottom: 8 }}>
                  {preview === null ? (
                    <div className="gen-status" style={{ marginTop: 4 }}>
                      <Spinner /> &nbsp;Loading…
                    </div>
                  ) : preview.length === 0 ? (
                    <div className="disabled-note" style={{ margin: '4px 0' }}>No companies yet.</div>
                  ) : (
                    <>
                      {preview.slice(0, 50).map((c) => (
                        <div key={c.id} style={{ fontSize: 12, color: 'var(--text-dim)', padding: '3px 0' }}>
                          {c.company_name_display}{' '}
                          <span style={{ opacity: 0.7 }}>· {PLATFORM_LABEL[c.platform] || c.platform}</span>
                        </div>
                      ))}
                      {l.company_count > 50 && (
                        <div className="disabled-note" style={{ margin: '4px 0 0' }}>
                          Showing first 50 of {l.company_count}.
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

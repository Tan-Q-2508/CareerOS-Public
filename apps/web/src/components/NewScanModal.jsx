import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import Spinner from './Spinner';
import { HALF_HOUR_SLOTS, formatSlotLabel, nextHalfHourSlot } from '../lib/display';

// New Scan form — surfaces spec 4.1's required fields explicitly (title,
// location, visa toggle, keywords), plus a multi-select of the user's BYO Scraper
// actors (spec 4.2). Per-source count + posted-within are now inline, not
// tucked under an Advanced collapsible (2026-08-15 UX pass) — see below.
//
// Two-stage layout (2026-08-15): the source picker used to sit in the middle
// of the form, so a user filled in title/location before knowing which
// per-source fields even applied. Now it's Stage 1 — nothing else renders
// until a source is picked — and everything below it is one flat list, no
// "+ Advanced options" toggle, in a fixed order: title(s) -> tracklist (ATS
// Direct only) -> location -> keywords -> minimum score -> visa filter ->
// schedule -> job count -> posted within.
export default function NewScanModal({ onClose, onStarted }) {
  // Multi-title scans (4.6.15, ATS Direct only) — `titles` is the canonical
  // list; `titleInput` is the free-text box a title is staged from before
  // being added as a chip. Non-ATS sources stay single-title: adding a new
  // one REPLACES the list instead of appending (enforced in addTitle below),
  // so the UI never lets a non-ATS source drift into a state the server
  // would reject.
  const [titles, setTitles] = useState([]);
  const [titleInput, setTitleInput] = useState('');
  const [suggestions, setSuggestions] = useState(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState(null);
  // Multi-location (4.6.6, ATS Direct only) — same chip pattern as titles:
  // `locations` is the list, `location` the box one is staged from. Other
  // sources keep a single location (adding one replaces it).
  const [locations, setLocations] = useState([]);
  const [location, setLocation] = useState('');
  const [keywords, setKeywords] = useState('');
  const [visaOn, setVisaOn] = useState(true);
  const [threshold, setThreshold] = useState(7.5);
  // 'on_demand' (spec 4.7): source + pre-filter only, the user picks what to score.
  const [scoreMode, setScoreMode] = useState('auto');
  const [csCount, setCsCount] = useState(50);
  const [ldCount, setLdCount] = useState(100);
  const [postedDays, setPostedDays] = useState(3);
  // ATS Direct's posted-within default is "any time" (4.6.6, §15 #25c-2) — a
  // separate field from postedDays above rather than reusing it, since the
  // two sources default to opposite things ('' here means no filtering at
  // all, sent as posted_within_days: undefined; postedDays above always
  // sends a real number).
  const [atsPostedDays, setAtsPostedDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // "Schedule Scan" (spec §12.6) — an opt-in layer on top of the one-off run
  // below; saves this exact config as a scan_schedules row so it re-runs on
  // its own via the scheduler, without replacing today's manual run.
  // run_at_time/timezone (2026-08-15) let the user pick WHEN it repeats,
  // not just how often — previously a schedule ran at whatever instant it
  // happened to be created/last claimed at.
  const [repeatOn, setRepeatOn] = useState(false);
  const [frequency, setFrequency] = useState('weekly');
  const [runAtTime, setRunAtTime] = useState(() => nextHalfHourSlot());

  // Sourcing: Core Scraper (temporarily disabled — "Coming soon") + the user's
  // saved BYO actors + ATS Direct (4.6.6, §15 #24, selector revised #25c-2).
  // Exactly one scraper per scan (A5) — a single-select, not a checkbox list.
  const [sourceList, setSourceList] = useState(null);
  const [selected, setSelected] = useState('');
  const [atsCount, setAtsCount] = useState(200);
  const isAtsDirect = selected === 'ats_direct';

  // §15 #25c-2, single-select as of 4.6.15 — the company selector is
  // tracklists/subscriptions primary (4.6.6, revised): exactly ONE of the
  // user's own tracklists or a system tracklist they're subscribed to,
  // defaulting to NOTHING pre-selected (4.6.6's explicit "no silent
  // default" decision). One tracklist per scan keeps the rotating cursor's
  // progress for each tracklist independent and easy to reason about
  // (scanCursor.js), rather than one shared cursor across an arbitrary
  // combination. An optional narrow-to-specific-companies sub-picker stays
  // available underneath for the case where the tracklist itself is still
  // too broad, and doubles as the legacy §24 selector.
  const [tracklists, setTracklists] = useState(null);
  const [tracklistId, setTracklistId] = useState(null);
  const [resolved, setResolved] = useState(null); // { count, companies, truncated } from the live resolve endpoint
  const [resolveLoading, setResolveLoading] = useState(false);
  const [narrowOpen, setNarrowOpen] = useState(false);
  const [narrowIds, setNarrowIds] = useState(new Set());
  const [narrowFilter, setNarrowFilter] = useState('');

  useEffect(() => {
    Promise.all([api.listSourcingActors(), api.listTracklists()])
      .then(([{ core_scraper, actors }, { tracklists: tls }]) => {
        setTracklists(tls || []);
        const cs = { id: 'cs', label: 'Core Scraper', builtin: true, enabled: !!core_scraper?.enabled };
        const ats = { id: 'ats_direct', label: 'ATS Direct', builtin: true, enabled: (tls || []).length > 0 };
        setSourceList([cs, ...(actors || []), ats]);
        setSelected((cur) => cur || (actors && actors.length ? actors[0].id : cs.enabled ? 'cs' : ''));
      })
      .catch(() => {
        setSourceList([{ id: 'cs', label: 'Core Scraper', builtin: true, enabled: false }]);
        setTracklists([]);
      });
  }, []);

  // Live resolved company count/sample — re-fetched whenever the tracklist
  // selection or the narrow sub-picker's selection changes, so the form shows
  // real numbers (and the narrow sub-picker's own browsable list) rather than
  // making the user guess how many companies a tracklist combination covers.
  useEffect(() => {
    if (selected !== 'ats_direct' || !tracklistId) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    setResolveLoading(true);
    api
      .resolveTracklistCompanies([tracklistId], [...narrowIds])
      .then((r) => {
        if (!cancelled) setResolved(r);
      })
      .catch(() => {
        if (!cancelled) setResolved(null);
      })
      .finally(() => {
        if (!cancelled) setResolveLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, tracklistId, [...narrowIds].sort().join(',')]);

  // Single tracklist per scan (4.6.15) — clicking the already-selected radio
  // clears it (radio inputs alone can't be unchecked by the user).
  function selectTracklist(id) {
    setTracklistId((cur) => (cur === id ? null : id));
    setNarrowIds(new Set()); // selection changed — a stale narrow pick could reference a company outside the new set
  }

  function toggleNarrow(id) {
    setNarrowIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Multi-title (4.6.15) is ATS Direct only — every other source builds one
  // paid search query per title, so adding there REPLACES the single title
  // instead of appending, matching what the server accepts.
  function addTitle(raw) {
    const t = raw.trim();
    if (!t) return;
    setTitles((cur) => {
      if (cur.some((x) => x.toLowerCase() === t.toLowerCase())) return cur;
      return isAtsDirect ? [...cur, t] : [t];
    });
  }

  function addTitleFromInput() {
    addTitle(titleInput);
    setTitleInput('');
  }

  function removeTitle(t) {
    setTitles((cur) => cur.filter((x) => x !== t));
  }

  function addLocationFromInput() {
    const l = location.trim();
    setLocation('');
    if (!l) return;
    setLocations((cur) => {
      if (cur.some((x) => x.toLowerCase() === l.toLowerCase())) return cur;
      return isAtsDirect ? [...cur, l] : [l];
    });
  }

  async function fetchSuggestions() {
    setSuggestLoading(true);
    setSuggestError(null);
    try {
      const { titles: suggested } = await api.suggestScanTitles();
      setSuggestions(suggested || []);
    } catch (e) {
      setSuggestError(e.message);
    } finally {
      setSuggestLoading(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    // A title still sitting unadded in the input box at submit time counts
    // too — a common "forgot to press Enter" case.
    const pending = titleInput.trim();
    let finalTitles = titles;
    if (pending && !titles.some((x) => x.toLowerCase() === pending.toLowerCase())) {
      finalTitles = isAtsDirect ? [...titles, pending] : [pending];
    }
    const pendingLoc = location.trim();
    let finalLocations = locations;
    if (pendingLoc && !locations.some((x) => x.toLowerCase() === pendingLoc.toLowerCase())) {
      finalLocations = isAtsDirect ? [...locations, pendingLoc] : [pendingLoc];
    }
    if (!finalTitles.length) {
      setError('Job title is required.');
      return;
    }
    if (!selected) {
      setError('Select a scraper.');
      return;
    }
    if (isAtsDirect && !tracklistId) {
      setError('Select a tracklist to scan.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const baseFields = {
        job_titles: finalTitles,
        locations: finalLocations,
        keywords: keywords.trim(),
        visa_filter_on: visaOn,
        threshold: Number(threshold),
        score_mode: scoreMode,
        cs_job_count: Number(csCount),
        ld_job_count: Number(ldCount),
        ats_job_count: Number(atsCount),
        tracklist_ids: isAtsDirect && tracklistId ? [tracklistId] : undefined,
        tracked_company_ids: isAtsDirect ? [...narrowIds] : undefined,
        posted_within_days: isAtsDirect ? (atsPostedDays ? Number(atsPostedDays) : undefined) : Number(postedDays),
        sources: [selected],
      };

      const { scan_id } = await api.startScan(baseFields);
      // Scheduling is additive — it doesn't replace today's run above. A
      // failure here shouldn't block the scan that already started.
      if (repeatOn) {
        api
          .createSchedule({
            ...baseFields,
            frequency,
            run_at_time: runAtTime,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          })
          .catch((e) => console.error('createSchedule failed:', e.message));
      }
      onStarted(scan_id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Run New Scan</h2>
        <div className="sub">Add your own scraper in Settings to source jobs.</div>

        <form onSubmit={submit}>
          <label className="field-label">Source to run (pick one)</label>
          {sourceList === null ? (
            <div className="gen-status" style={{ marginTop: 0 }}>
              <Spinner /> &nbsp;Loading sources…
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
              {sourceList.map((a) => {
                const off = a.builtin && !a.enabled;
                return (
                  <label
                    key={a.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.5 : 1 }}
                  >
                    <input
                      type="radio"
                      name="scan-source"
                      checked={selected === a.id}
                      disabled={off}
                      onChange={() => setSelected(a.id)}
                      style={{ width: 'auto', margin: 0 }}
                    />
                    {a.label}
                    {a.builtin && (
                      <span className="nav-soon" style={{ margin: 0 }}>
                        {off ? (a.id === 'ats_direct' ? 'Create a tracklist in Settings' : 'Coming soon') : 'House'}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          {selected && (
            <>
              <label className="field-label">Job title{isAtsDirect ? '(s)' : ' or role'} *</label>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -4, marginBottom: 6 }}>
                {isAtsDirect
                  ? 'Add one or more job titles — every company board is fetched once regardless of how many.'
                  : 'One title per scan.'}
              </div>
              {titles.length > 0 && (
                <div className="wb-kw-chips wb-kw-chips-staged" style={{ marginBottom: 6 }}>
                  {titles.map((t) => (
                    <button key={t} type="button" className="wb-kw-chip active" onClick={() => removeTitle(t)} title="Click to remove">
                      {t} ✕
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addTitleFromInput();
                    }
                  }}
                  placeholder={isAtsDirect ? 'e.g. Product Manager — press Enter to add' : 'Software Engineer'}
                  autoFocus
                />
                {isAtsDirect && (
                  <button type="button" className="btn btn-ghost" style={{ flexShrink: 0 }} onClick={addTitleFromInput} disabled={!titleInput.trim()}>
                    Add
                  </button>
                )}
              </div>

              <div style={{ marginTop: 6, marginBottom: 10 }}>
                <button type="button" className="advanced-toggle" onClick={fetchSuggestions} disabled={suggestLoading}>
                  {suggestLoading ? (
                    <>
                      <Spinner /> &nbsp;Suggesting…
                    </>
                  ) : (
                    '✦ Suggest from my resume'
                  )}
                </button>
                {suggestError && <div className="error-text" style={{ marginTop: 4 }}>{suggestError}</div>}
                {suggestions && suggestions.length > 0 && (
                  <div className="wb-kw-chips" style={{ marginTop: 6 }}>
                    {suggestions
                      .filter((s) => !titles.some((t) => t.toLowerCase() === s.toLowerCase()))
                      .map((s) => (
                        <button key={s} type="button" className="wb-kw-chip" onClick={() => addTitle(s)}>
                          + {s}
                        </button>
                      ))}
                  </div>
                )}
                {suggestions && suggestions.length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>No suggestions found from your resume.</div>
                )}
              </div>

              {isAtsDirect &&
                (() => {
                  const lists = tracklists || [];
                  return (
                    <div style={{ marginBottom: 10 }}>
                      <label className="field-label">Tracklist to scan</label>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -4, marginBottom: 6 }}>
                        One tracklist per scan (4.6.15) — your own or a subscribed sector list. Click a selected one again
                        to clear it.
                      </div>
                      <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 6, padding: 6 }}>
                        {lists.map((t) => (
                          <label
                            key={t.id}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer', padding: '3px 0' }}
                          >
                            <input
                              type="radio"
                              name="scan-tracklist"
                              checked={tracklistId === t.id}
                              onClick={() => selectTracklist(t.id)}
                              onChange={() => {}}
                              style={{ width: 'auto', margin: 0 }}
                            />
                            {t.name}
                            {t.is_system && <span className="nav-soon" style={{ margin: 0 }}>Built-in</span>}
                            <span style={{ color: 'var(--text-dim)', marginLeft: 'auto' }}>{t.company_count}</span>
                          </label>
                        ))}
                        {!lists.length && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No tracklists yet — create one in Settings.</div>}
                      </div>

                      <div style={{ fontSize: 11.5, marginTop: 6 }}>
                        {resolveLoading ? (
                          <>
                            <Spinner /> &nbsp;Resolving companies…
                          </>
                        ) : !tracklistId ? (
                          <span style={{ color: 'var(--text-dim)' }}>Select a tracklist.</span>
                        ) : resolved ? (
                          <span>
                            <strong>{resolved.count}</strong> compan{resolved.count === 1 ? 'y' : 'ies'} selected
                            {resolved.missing_tracklist_ids?.length ? ' (some selected lists no longer exist)' : ''}.
                          </span>
                        ) : null}
                      </div>

                      {resolved && resolved.count > 0 && (
                        <button
                          type="button"
                          className="advanced-toggle"
                          style={{ marginTop: 6 }}
                          onClick={() => setNarrowOpen((s) => !s)}
                        >
                          {narrowOpen ? '− Hide' : '+'} Narrow to specific companies{narrowIds.size > 0 ? ` (${narrowIds.size})` : ''}
                        </button>
                      )}
                      {narrowOpen &&
                        resolved &&
                        (() => {
                          const all = resolved.companies || [];
                          const filtered = narrowFilter.trim()
                            ? all.filter((c) => c.company_name_display.toLowerCase().includes(narrowFilter.trim().toLowerCase()))
                            : all;
                          return (
                            <div style={{ marginTop: 6 }}>
                              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
                                Leave all unchecked to scan every company in the selected tracklists
                                {resolved.truncated ? ` (showing first ${all.length} of ${resolved.count} — narrow with the filter to find more)` : ''}.
                              </div>
                              {all.length > 20 && (
                                <input
                                  type="text"
                                  value={narrowFilter}
                                  onChange={(e) => setNarrowFilter(e.target.value)}
                                  placeholder={`Filter ${all.length} companies…`}
                                  style={{ marginBottom: 6 }}
                                />
                              )}
                              <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 6, padding: 6 }}>
                                {filtered.map((c) => (
                                  <label
                                    key={c.id}
                                    style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer', padding: '3px 0' }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={narrowIds.has(c.id)}
                                      onChange={() => toggleNarrow(c.id)}
                                      style={{ width: 'auto', margin: 0 }}
                                    />
                                    {c.company_name_display}
                                  </label>
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                    </div>
                  );
                })()}

              <label className="field-label">Location{isAtsDirect ? '(s) (optional)' : ''}</label>
              {locations.length > 0 && (
                <div className="wb-kw-chips wb-kw-chips-staged" style={{ marginBottom: 6 }}>
                  {locations.map((l) => (
                    <button key={l} type="button" className="wb-kw-chip active" onClick={() => setLocations((cur) => cur.filter((x) => x !== l))} title="Click to remove">
                      {l} ✕
                    </button>
                  ))}
                </div>
              )}
              {isAtsDirect ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addLocationFromInput();
                      }
                    }}
                    placeholder="e.g. India — press Enter to add another"
                  />
                  <button type="button" className="btn btn-ghost" style={{ flexShrink: 0 }} onClick={addLocationFromInput} disabled={!location.trim()}>
                    Add
                  </button>
                </div>
              ) : (
                <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="San Jose, CA · or a country" />
              )}
              {isAtsDirect && (
                <div
                  style={{
                    fontSize: 11,
                    color: locations.length || location.trim() ? 'var(--text-dim)' : 'var(--warning-text, #a66a00)',
                    marginTop: 4,
                    marginBottom: 8,
                  }}
                >
                  {locations.length || location.trim()
                    ? 'Add as many as you like (e.g. India and USA). A posting in any of them is kept; the rest are filtered out before scoring (4.6.16).'
                    : 'Leave blank to scan every country the selected companies post to — jobs from anywhere in the world will be scored. Enter a country, state, or city to narrow it down.'}
                </div>
              )}

              <label className="field-label">Keywords (optional)</label>
              <input type="text" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="remote, full-time" />

              <label className="field-label">Minimum score to save (0–10) *</label>
              <input type="number" min={0} max={10} step={0.1} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -6, marginBottom: 8 }}>
                {scoreMode === 'on_demand'
                  ? 'Jobs that can’t reach this score are marked so you can skip them. Jobs you choose to score are kept whatever they score.'
                  : 'Only jobs scoring at or above this are kept — everything below is scored once, then discarded.'}
              </div>

              <label className="field-label">Scoring</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
                {[
                  ['auto', 'Score every job automatically'],
                  ['on_demand', 'Only score the jobs I pick'],
                ].map(([value, label]) => (
                  <label key={value} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="scan-score-mode"
                      checked={scoreMode === value}
                      onChange={() => setScoreMode(value)}
                      style={{ width: 'auto', margin: 0 }}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8 }}>
                {scoreMode === 'on_demand'
                  ? 'Jobs are found and pre-filtered with no AI cost. Each one gets a quick read of how well it matches your résumé; you pick which ones to score.'
                  : 'Every job that passes the pre-filter is scored against your résumé as it is found.'}
              </div>

              <div className="switch-row">
                <div>
                  <div>Visa Sponsorship Filter</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Excludes jobs that explicitly refuse sponsorship.</div>
                </div>
                <div className={`switch ${visaOn ? 'on' : ''}`} role="switch" aria-checked={visaOn} onClick={() => setVisaOn((v) => !v)} />
              </div>

              <div className="switch-row">
                <div>
                  <div>Schedule Scan</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Re-runs this exact search automatically — no need to keep the app open.</div>
                </div>
                <div className={`switch ${repeatOn ? 'on' : ''}`} role="switch" aria-checked={repeatOn} onClick={() => setRepeatOn((v) => !v)} />
              </div>
              {repeatOn && (
                <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                  <div style={{ flex: 1 }}>
                    <label className="field-label">Frequency</label>
                    <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                      <option value="daily">Daily</option>
                      <option value="weekdays">Weekdays</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="field-label">Time</label>
                    <select value={runAtTime} onChange={(e) => setRunAtTime(e.target.value)}>
                      {HALF_HOUR_SLOTS.map((slot) => (
                        <option key={slot} value={slot}>
                          {formatSlotLabel(slot)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {selected === 'cs' ? (
                <>
                  <label className="field-label">Core Scraper job count (10–100)</label>
                  <input type="number" min={10} max={100} value={csCount} onChange={(e) => setCsCount(e.target.value)} />
                </>
              ) : isAtsDirect ? (
                <>
                  <label className="field-label">ATS Direct target (10–500)</label>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -6, marginBottom: 8 }}>
                    The scan keeps pulling from more companies in the selection until it stores this many survivors, or
                    every selected company has been checked (4.6.6).
                  </div>
                  <input type="number" min={10} max={500} value={atsCount} onChange={(e) => setAtsCount(e.target.value)} />
                </>
              ) : (
                <>
                  <label className="field-label">BYO Scraper job count (10–500)</label>
                  <input type="number" min={10} max={500} value={ldCount} onChange={(e) => setLdCount(e.target.value)} />
                </>
              )}

              <label className="field-label">Posted within</label>
              {isAtsDirect ? (
                <>
                  <select value={atsPostedDays} onChange={(e) => setAtsPostedDays(e.target.value)}>
                    <option value="">Any time</option>
                    <option value="1">Last day</option>
                    <option value="3">Last 3 days</option>
                    <option value="7">Last 7 days</option>
                    <option value="14">Last 14 days</option>
                    <option value="30">Last 30 days</option>
                  </select>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -6, marginBottom: 8 }}>
                    Filters by each posting's own posted date (4.6.6). Defaults to any time.
                  </div>
                </>
              ) : (
                <input type="number" min={1} max={30} value={postedDays} onChange={(e) => setPostedDays(e.target.value)} />
              )}
            </>
          )}

          {error && <div className="error-text">{error}</div>}

          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn btn-primary" disabled={busy || !selected}>
              {busy ? (
                <>
                  <Spinner /> &nbsp;Starting…
                </>
              ) : repeatOn ? (
                'Run Scan & Save Schedule'
              ) : (
                'Run Scan'
              )}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

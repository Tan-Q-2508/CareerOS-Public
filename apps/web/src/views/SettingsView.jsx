import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useMe } from '../context/MeContext';
import { useAuth } from '../context/AuthContext';
import Spinner from '../components/Spinner';
import ScraperModal from '../components/ScraperModal';
import TracklistsCard from '../components/TracklistsCard';
import SectorTracklistsCard from '../components/SectorTracklistsCard';
import WatchlistCard from '../components/WatchlistCard';
import AnswerBankCard from '../components/AnswerBankCard';
import { HALF_HOUR_SLOTS, formatSlotLabel } from '../lib/display';

// Multi-title scans (4.6.15) — a schedule row's job_titles (canonical) falls
// back to the legacy scalar job_title, joined for display. Mirrors
// packages/shared/src/scanTitles.js's contract; duplicated here in plain JS
// because apps/web doesn't import @careeros/shared.
function scheduleTitleLabel(s) {
  return s.job_titles && s.job_titles.length ? s.job_titles.join(', ') : s.job_title || 'Untitled scan';
}

const TABS = [
  { key: 'profile', label: 'Profile & Resume' },
  { key: 'ai', label: 'AI (BYOK)' },
  { key: 'scraper', label: 'BYO Scraper' },
  { key: 'companies', label: 'Tracked Companies' },
  { key: 'delivery', label: 'File Delivery' },
  { key: 'schedules', label: 'Scheduled Scans' },
  { key: 'account', label: 'Account' },
];

export default function SettingsView() {
  const { me, refresh } = useMe();
  const { connectDrive, signOut } = useAuth();
  const navigate = useNavigate();
  const user = me?.user;
  const [activeTab, setActiveTab] = useState(TABS[0].key);

  const [years, setYears] = useState('');
  const [domainKw, setDomainKw] = useState('');
  const [offDomainKw, setOffDomainKw] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const [resume, setResume] = useState(null);
  const fileRef = useRef(null);
  const [reup, setReup] = useState(false);
  const [reupMsg, setReupMsg] = useState(null);

  // §15 #25c-1 (spec 4.6.10) — "Automatically track companies I scrape" toggle.
  const [autoTrackSaving, setAutoTrackSaving] = useState(false);
  const [autoTrackErr, setAutoTrackErr] = useState(null);

  async function toggleAutoTrack() {
    setAutoTrackErr(null);
    setAutoTrackSaving(true);
    try {
      await api.updateProfile({ auto_track_scraped_companies: !user.auto_track_scraped_companies });
      await refresh();
    } catch (e) {
      setAutoTrackErr(e.message);
    } finally {
      setAutoTrackSaving(false);
    }
  }

  // Sourcing: Core Scraper (house) + BYO Scraper actors (spec 4.2)
  const [actors, setActors] = useState(null);
  // Account identity (3.1) — display name via PATCH /api/me, account deletion
  // via DELETE /api/me?confirm=true. Both routes shipped in §15 #56e with no
  // client at all, so until §15 #59 the name could not be changed and the
  // account could not be deleted from the app, while 3.1 described both as
  // live surfaces. full_name is not decoration: extractContact prefers it for
  // the résumé header name line (7.2).
  const [displayName, setDisplayName] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameMsg, setNameMsg] = useState(null);
  const [nameErr, setNameErr] = useState(null);
  // The stored value is the baseline the field resets to; re-seed whenever the
  // user record reloads, but never over a name the user is mid-edit on.
  useEffect(() => {
    if (user && !nameSaving) setDisplayName(user.full_name || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.full_name]);

  async function saveDisplayName(e) {
    e.preventDefault();
    setNameErr(null);
    setNameMsg(null);
    setNameSaving(true);
    try {
      // An empty string is a real choice, not a validation failure: it clears
      // the override and lets the parsed résumé's own name win again, which is
      // exactly what the route does with it.
      await api.updateMe({ full_name: displayName.trim() });
      await refresh();
      setNameMsg(displayName.trim() ? 'Saved.' : 'Cleared — your résumé’s own name will be used.');
    } catch (e2) {
      setNameErr(e2.message);
    } finally {
      setNameSaving(false);
    }
  }

  // Account deletion. Irreversible and cascading (13.7), so it is gated on
  // typing the exact word rather than on an ok/cancel a misclick can clear.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState(null);

  async function deleteAccount() {
    setDeleteErr(null);
    setDeleting(true);
    try {
      await api.deleteAccount();
      // The auth row is gone, so the session is already dead server-side.
      // Sign out locally too, or the app keeps rendering against a token that
      // now resolves to nothing.
      await signOut();
    } catch (e2) {
      setDeleteErr(e2.message);
      setDeleting(false);
    }
  }

  const [coreScraper, setCoreScraper] = useState(null);
  const [byokEnabled, setByokEnabled] = useState(true);
  const [scraperModal, setScraperModal] = useState(null); // null | { actor? }
  const loadActors = useCallback(async () => {
    try {
      const { actors, byok_enabled, core_scraper } = await api.listSourcingActors();
      setActors(actors);
      setByokEnabled(byok_enabled);
      setCoreScraper(core_scraper || null);
    } catch {
      setActors([]);
    }
  }, []);
  useEffect(() => {
    loadActors();
  }, [loadActors]);

  // AI BYOK (spec 13.3) — bring your own key for Gemini/OpenAI-compatible/Anthropic.
  const AI_PROVIDERS = [
    { value: 'gemini', label: 'Gemini', modelPlaceholder: 'gemini-3.1-pro-preview', hasBaseUrl: false },
    { value: 'openai_compatible', label: 'OpenAI-compatible', modelPlaceholder: 'gpt-4o-mini', hasBaseUrl: true },
    { value: 'anthropic', label: 'Anthropic', modelPlaceholder: 'claude-sonnet-4-5', hasBaseUrl: false },
  ];
  const [aiCreds, setAiCreds] = useState(null); // { active_provider, saved, byok_enabled }
  const [aiProviderChoice, setAiProviderChoice] = useState('gemini');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState(null);
  const [aiMsg, setAiMsg] = useState(null);

  const loadAiCreds = useCallback(async () => {
    try {
      const data = await api.listAiCredentials();
      setAiCreds(data);
      if (data.active_provider) setAiProviderChoice(data.active_provider);
    } catch {
      setAiCreds({ active_provider: null, saved: [], byok_enabled: false });
    }
  }, []);
  useEffect(() => {
    loadAiCreds();
  }, [loadAiCreds]);

  // Google Drive (spec 11.3) — shares one OAuth grant with Gmail (googleDrive.js
  // / googleGmail.js both read/write the same stored refresh token), so
  // disconnecting here disconnects Gmail's status-check too. This card was a
  // dead Session-7 placeholder (hardcoded disabled button, stale "Phase 2"
  // copy) even after Drive actually shipped 2026-07-27 — the only real entry
  // point was the contextual "Save to Drive" button on a generated document
  // (DocumentActions.jsx). Wired up 2026-08-03 so Settings has a real status +
  // reconnect surface too (same pattern as TrackerView's Gmail card).
  const [drive, setDrive] = useState(null); // { connected, google_email?, connected_at? }
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveErr, setDriveErr] = useState(null);
  const loadDrive = useCallback(async () => {
    try {
      setDrive(await api.driveStatus());
    } catch {
      setDrive({ connected: false });
    }
  }, []);
  useEffect(() => {
    loadDrive();
  }, [loadDrive]);

  async function disconnectDriveAndRefresh() {
    setDriveBusy(true);
    setDriveErr(null);
    try {
      await api.disconnectDrive();
      await loadDrive();
    } catch (e) {
      setDriveErr(e.message);
    } finally {
      setDriveBusy(false);
    }
  }

  const aiUsingByok = !!aiCreds?.active_provider;
  const aiSavedForChoice = aiCreds?.saved?.find((s) => s.provider_name === aiProviderChoice) || null;
  const aiProviderMeta = AI_PROVIDERS.find((p) => p.value === aiProviderChoice);

  async function switchToCai() {
    setAiBusy(true);
    setAiErr(null);
    try {
      await api.activateAiProvider(null);
      await loadAiCreds();
    } catch (e) {
      setAiErr(e.message);
    } finally {
      setAiBusy(false);
    }
  }

  async function saveAndTestAiKey() {
    if (!aiApiKey.trim() || !aiModel.trim()) {
      setAiErr('API key and model are required.');
      return;
    }
    setAiBusy(true);
    setAiErr(null);
    setAiMsg(null);
    try {
      await api.saveAiCredential({
        provider_name: aiProviderChoice,
        api_key: aiApiKey.trim(),
        model: aiModel.trim(),
        base_url: aiBaseUrl.trim() || undefined,
      });
      await api.testAiCredential(aiProviderChoice);
      setAiApiKey('');
      setAiMsg('Key connected and tested successfully.');
      await loadAiCreds();
    } catch (e) {
      setAiErr(e.message);
    } finally {
      setAiBusy(false);
    }
  }

  async function retestAiKey() {
    setAiBusy(true);
    setAiErr(null);
    setAiMsg(null);
    try {
      await api.testAiCredential(aiProviderChoice);
      setAiMsg('Test succeeded.');
      await loadAiCreds();
    } catch (e) {
      setAiErr(e.message);
    } finally {
      setAiBusy(false);
    }
  }

  async function activateAiKey() {
    setAiBusy(true);
    setAiErr(null);
    try {
      await api.activateAiProvider(aiProviderChoice);
      await loadAiCreds();
    } catch (e) {
      setAiErr(e.message);
    } finally {
      setAiBusy(false);
    }
  }

  async function removeAiKey() {
    if (!window.confirm(`Remove your saved ${aiProviderMeta.label} key?`)) return;
    setAiBusy(true);
    setAiErr(null);
    try {
      await api.deleteAiCredential(aiProviderChoice);
      await loadAiCreds();
    } catch (e) {
      setAiErr(e.message);
    } finally {
      setAiBusy(false);
    }
  }

  async function removeActor(id, label) {
    if (!window.confirm(`Remove "${label}"? Its stored key is deleted.`)) return;
    try {
      await api.deleteSourcingActor(id);
      loadActors();
    } catch (e) {
      setErr(e.message);
    }
  }

  // Scheduled scans (spec §12.6) — view/pause/resume/delete "Schedule Scan"
  // schedules created from the New Scan modal.
  const [schedules, setSchedules] = useState(null);
  const loadSchedules = useCallback(async () => {
    try {
      const { schedules } = await api.listSchedules();
      setSchedules(schedules);
    } catch {
      setSchedules([]);
    }
  }, []);
  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  async function toggleSchedule(s) {
    try {
      await api.updateSchedule(s.id, { active: !s.active });
      loadSchedules();
    } catch (e) {
      setErr(e.message);
    }
  }

  async function deleteSchedule(s) {
    if (!window.confirm(`Delete the schedule for "${scheduleTitleLabel(s)}"?`)) return;
    try {
      await api.deleteSchedule(s.id);
      loadSchedules();
    } catch (e) {
      setErr(e.message);
    }
  }

  // Time-of-day (2026-08-15) — run_at_time is stored in the schedule's own
  // timezone; changing it just PATCHes that one field, which recomputes
  // next_run_at server-side (scanSchedules.js).
  async function updateScheduleTime(s, runAtTime) {
    try {
      await api.updateSchedule(s.id, { run_at_time: runAtTime });
      loadSchedules();
    } catch (e) {
      setErr(e.message);
    }
  }

  // The years the pre-filter/scoring actually use: the manual override when
  // set, otherwise the live résumé-derived value (4.3) — not the stored
  // column, which only refreshes on résumé upload.
  const experience = me?.experience || null;
  const yearsManual = !!user?.years_of_experience_manual;
  const effectiveYears = yearsManual ? user?.years_of_experience : experience?.total ?? user?.years_of_experience;

  useEffect(() => {
    if (user) {
      setYears(effectiveYears ?? '');
      setDomainKw((user.domain_keywords || []).join(', '));
      setOffDomainKw((user.off_domain_title_keywords || []).join(', '));
    }
  }, [user]);

  useEffect(() => {
    api.getResume().then(({ resume_version }) => setResume(resume_version)).catch(() => {});
  }, []);

  async function saveProfile(e) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setSaving(true);
    try {
      // Years are only sent when actually edited: the server treats any sent
      // value as a manual override, which would freeze the résumé-derived
      // number just because the keywords were saved.
      const patch = {
        domain_keywords: splitList(domainKw),
        off_domain_title_keywords: splitList(offDomainKw),
      };
      if (String(years) !== String(effectiveYears ?? '')) patch.years_of_experience = Number(years);
      await api.updateProfile(patch);
      await refresh();
      setMsg('Profile saved.');
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setSaving(false);
    }
  }

  async function reupload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setReup(true);
    setReupMsg(null);
    try {
      const { resume_version } = await api.uploadResume(file);
      setResume(resume_version);
      setReupMsg(`Uploaded v${resume_version.version_number}. Existing scores keep their old version.`);
      refresh().catch(() => {});
    } catch (e) {
      setReupMsg(e.message);
    } finally {
      setReup(false);
    }
  }

  return (
    <div>
      <div className="view-header">
        <div className="view-title">Settings</div>
      </div>

      {/* Settings restructure (spec 3.1, §15 #25a) — named sections, most-
          frequently-touched first, in 3.1's stated order. Information
          architecture only: no card below is redesigned, only re-grouped.
          Sub-tab nav added §15 bug batch 2026-08-06: was 7 sections stacked
          on one scrolling page; now only the active tab's section renders. */}

      <div className="settings-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`settings-tab ${activeTab === t.key ? 'active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'profile' && (
      <div className="settings-section">
        <h2 className="settings-section-title">Profile &amp; Resume</h2>
        <div className="settings-grid">
          {/* Account identity (3.1). Deliberately name-only: users.email
              mirrors auth.users.email through the signup trigger, so changing
              it belongs to Supabase Auth's own verified flow. The address is
              shown, not editable, so the page reads honestly instead of
              offering a field that cannot work. */}
          <div className="setting-card">
            <h3>Display Name</h3>
            <p>
              Used on generated résumés when your parsed résumé has no better candidate for the
              header name line. Signed in as <strong>{user?.email || '…'}</strong> — your email comes
              from your sign-in identity and is changed there, not here.
            </p>
            <form onSubmit={saveDisplayName}>
              <label className="field-label">Full name</label>
              <input
                type="text"
                maxLength={200}
                value={displayName}
                placeholder="Leave empty to use the name on your résumé"
                onChange={(e) => setDisplayName(e.target.value)}
              />
              {nameErr && <div className="error-text">{nameErr}</div>}
              {nameMsg && <div className="ok-text">{nameMsg}</div>}
              <button className="btn btn-primary" disabled={nameSaving} style={{ marginTop: 4 }}>
                {nameSaving ? <Spinner /> : 'Save Name'}
              </button>
            </form>
          </div>

          {/* Pre-filter profile — REAL (PATCH /api/profile, spec 4.3) */}
          <div className="setting-card">
            <h3>Scan Profile</h3>
            <p>
              Tunes the deterministic pre-filter (years-gap and off-domain checks) before any AI
              scoring. Auto-seeded from your résumé; edit to override.
            </p>
            <form onSubmit={saveProfile}>
              <label className="field-label">Years of professional experience</label>
              <input
                type="number"
                min={0}
                max={60}
                step={0.1}
                value={years}
                onChange={(e) => setYears(e.target.value)}
              />
              {yearsManual ? (
                <p className="disabled-note" style={{ margin: '-4px 0 10px', textAlign: 'left' }}>
                  Set manually.{' '}
                  {experience ? <>From your résumé it would be {experience.total}. </> : null}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={async () => {
                      await api.updateProfile({ years_of_experience: null });
                      await refresh();
                    }}
                  >
                    Use my résumé instead
                  </button>
                </p>
              ) : experience ? (
                <p className="disabled-note" style={{ margin: '-4px 0 10px', textAlign: 'left' }}>
                  From your résumé: {experience.fullTime} full-time
                  {experience.masters ? <> + {experience.masters} master&apos;s degree</> : null}
                  {experience.internship ? <> + {experience.internship} internship (half weight)</> : null}
                  . Degree time isn&apos;t counted as work experience; a posting that offers a
                  master&apos;s track (&ldquo;or Master&apos;s + 3 years&rdquo;) lowers its own bar instead.
                </p>
              ) : null}
              <label className="field-label">Domain keywords (comma-separated)</label>
              <textarea value={domainKw} onChange={(e) => setDomainKw(e.target.value)} />
              <label className="field-label">Off-domain title keywords (comma-separated)</label>
              <textarea value={offDomainKw} onChange={(e) => setOffDomainKw(e.target.value)} />

              {err && <div className="error-text">{err}</div>}
              {msg && <div className="ok-text">{msg}</div>}

              <button className="btn btn-primary" disabled={saving} style={{ marginTop: 4 }}>
                {saving ? <Spinner /> : 'Save Profile'}
              </button>
            </form>
          </div>

          {/* Master résumé — REAL (re-upload) */}
          <div className="setting-card">
            <h3>Master Résumé</h3>
            <p>
              {resume
                ? `Active: ${resume.original_filename || `v${resume.version_number}`} (v${resume.version_number}).`
                : 'No active résumé.'}{' '}
              Uploading a new one re-parses your profile; existing scored jobs keep the version they
              were scored against.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              style={{ display: 'none' }}
              onChange={reupload}
            />
            <button
              className="btn btn-ghost"
              onClick={() => fileRef.current?.click()}
              disabled={reup}
            >
              {reup ? (
                <>
                  <Spinner /> &nbsp;Parsing…
                </>
              ) : (
                'Upload New Version'
              )}
            </button>
            {reupMsg && <div className="ok-text" style={{ marginTop: 8 }}>{reupMsg}</div>}
          </div>
        </div>
      </div>
      )}

      {activeTab === 'ai' && (
      <div className="settings-section">
        <h2 className="settings-section-title">AI (BYOK)</h2>
        <div className="settings-grid">
          {/* AI Provider — real BYOK (spec 13.3) */}
          <div className="setting-card">
            <h3>AI Provider</h3>
            <p>
              Use CareerOS AI (billed in COS) or bring your own key — BYOK reduces the AI-fee
              portion of every action to an external fee, it never eliminates it.
            </p>

            {aiCreds === null ? (
              <div className="gen-status">
                <Spinner /> &nbsp;Loading…
              </div>
            ) : (
              <>
                <div className="toggle-row">
                  <div className={`toggle-btn ${!aiUsingByok ? 'selected' : ''}`} onClick={!aiBusy && aiUsingByok ? switchToCai : undefined} style={{ cursor: aiUsingByok ? 'pointer' : 'default' }}>
                    CareerOS AI
                  </div>
                  <div
                    className={`toggle-btn ${aiUsingByok ? 'selected' : ''} ${aiCreds.byok_enabled ? '' : 'disabled'}`}
                    style={{ cursor: aiCreds.byok_enabled ? 'pointer' : 'default' }}
                  >
                    Bring Your Own Key
                  </div>
                </div>

                {!aiCreds.byok_enabled ? (
                  <div className="disabled-note">
                    {aiCreds.byok_disabled_reason === 'phase'
                      ? "Bring Your Own Key is temporarily unavailable while we finish tuning scoring and generation. It returns at launch — any key you've saved is kept."
                      : "BYOK key storage isn't configured on the server."}
                  </div>
                ) : (
                  <>
                    <label className="field-label">Provider</label>
                    <select
                      value={aiProviderChoice}
                      onChange={(e) => {
                        setAiProviderChoice(e.target.value);
                        setAiErr(null);
                        setAiMsg(null);
                      }}
                    >
                      {AI_PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>

                    {aiSavedForChoice && (
                      <div className="disabled-note" style={{ textAlign: 'left' }}>
                        Saved: model <strong style={{ color: 'var(--text)' }}>{aiSavedForChoice.model}</strong>
                        {aiSavedForChoice.base_url ? ` @ ${aiSavedForChoice.base_url}` : ''}
                        {aiSavedForChoice.validated_at ? ' · tested ✓' : ' · not tested'}
                        {aiCreds.active_provider === aiProviderChoice ? ' · ACTIVE' : ''}
                      </div>
                    )}

                    <label className="field-label">{aiProviderMeta.label} API key {aiSavedForChoice ? '(rotate)' : ''}</label>
                    <input type="password" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} placeholder="Paste your key" autoComplete="off" />
                    <label className="field-label">Model</label>
                    <input type="text" value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder={aiProviderMeta.modelPlaceholder} />
                    {aiProviderMeta.hasBaseUrl && (
                      <>
                        <label className="field-label">Base URL (optional — defaults to OpenAI's)</label>
                        <input type="text" value={aiBaseUrl} onChange={(e) => setAiBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
                      </>
                    )}

                    {aiErr && <div className="error-text">{aiErr}</div>}
                    {aiMsg && <div className="ok-text">{aiMsg}</div>}

                    <div className="btn-row" style={{ marginTop: 8 }}>
                      <button className="btn btn-primary" onClick={saveAndTestAiKey} disabled={aiBusy}>
                        {aiBusy ? <Spinner /> : aiSavedForChoice ? 'Save & test' : 'Connect & test'}
                      </button>
                      {aiSavedForChoice && (
                        <button className="btn btn-ghost" onClick={retestAiKey} disabled={aiBusy}>
                          Test again
                        </button>
                      )}
                      {aiSavedForChoice && aiSavedForChoice.validated_at && aiCreds.active_provider !== aiProviderChoice && (
                        <button className="btn btn-ghost" onClick={activateAiKey} disabled={aiBusy}>
                          Activate
                        </button>
                      )}
                      {aiSavedForChoice && (
                        <button className="link-btn" style={{ color: 'var(--danger)' }} onClick={removeAiKey} disabled={aiBusy}>
                          Remove
                        </button>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      )}

      {activeTab === 'scraper' && (
      <div className="settings-section">
        <h2 className="settings-section-title">BYO Scraper</h2>
        <div className="settings-grid">
          {/* Sourcing — Core Scraper (house) + BYO Scraper actor management (spec 4.2) */}
          <div className="setting-card">
            <h3>Sourcing</h3>
            <p>
              Connect your own scrapers (Apify actors) for any job board and pick which run per
              scan. Keys are encrypted at rest.
            </p>

            {/* Core Scraper — temporarily disabled by product decision */}
            <div style={{ borderTop: '1px solid var(--line)', padding: '9px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', opacity: coreScraper?.enabled ? 1 : 0.6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  Core Scraper
                  <span className="nav-soon" style={{ margin: '0 0 0 6px' }}>House</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                  JSearch aggregator · house-run, no setup — for now, use your own scraper below
                </div>
              </div>
              <span className="disabled-note" style={{ margin: 0 }}>Coming soon</span>
            </div>

            {actors === null ? (
              <div className="gen-status">
                <Spinner /> &nbsp;Loading scrapers…
              </div>
            ) : (
              <div>
                {actors.map((a) => (
                  <div
                    key={a.id}
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
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        {a.label}
                        {a.builtin && <span className="nav-soon" style={{ margin: '0 0 0 6px' }}>Built-in</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                        {a.provider_name === 'scraperapi' ? 'ScraperAPI' : 'Apify'} · {a.board} · up to {a.job_count_max} jobs
                        {!a.builtin && (a.validated_at ? ' · tested ✓' : ' · not tested')}
                        {!a.builtin && a.provider_name !== 'scraperapi' && a.has_mapping ? ' · mapped' : ''}
                      </div>
                    </div>
                    {!a.builtin && (
                      <>
                        <button className="link-btn" style={{ fontSize: 11.5 }} onClick={() => setScraperModal({ actor: a })}>
                          {a.provider_name === 'scraperapi' ? 'Test' : 'Test & map'}
                        </button>
                        <button className="link-btn" style={{ fontSize: 11.5, color: 'var(--danger)' }} onClick={() => removeActor(a.id, a.label)}>
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            {!byokEnabled && (
              <div className="disabled-note" style={{ textAlign: 'left' }}>
                Adding your own scrapers is unavailable — the server has no encryption key set. Core
                Scraper still works.
              </div>
            )}
            <button
              className={`btn btn-primary ${byokEnabled ? '' : 'disabled'}`}
              style={{ marginTop: 12 }}
              disabled={!byokEnabled}
              onClick={() => setScraperModal({})}
            >
              Add a Scraper
            </button>
          </div>
        </div>
      </div>
      )}

      {activeTab === 'companies' && (
      <div className="settings-section">
        <h2 className="settings-section-title">Tracked Companies</h2>
        {/* C3 (bug #9): Auto-track is a single checkbox — sharing a 2-column
            grid row with the much taller TracklistsCard set the row height to
            the tall card and pushed SectorTracklistsCard far below both.
            Auto-track now gets its own compact full-width row, outside the
            grid entirely; TracklistsCard and SectorTracklistsCard below are
            genuine peers in their own grid row.

            The SAME failure recurred on WatchlistCard (§15 #59). As the third
            child of a 2-column grid it landed in row 2, under both a 514-line
            browse-the-registry card and a 22-item sector list — far enough
            below the fold that the live database held zero
            watchlist_suggestions rows: nobody had ever reached the button.
            "Build my watchlist" is the primary AI action in this section and
            it is short, so it leads, in its own full-width row. The lesson
            this comment is really recording: .settings-grid is for genuine
            PEERS in pairs. A third card is not a peer, it is a second row
            nobody scrolls to. */}
        <div className="settings-row-full">
          <WatchlistCard />
        </div>
        <div className="setting-card settings-row-full">
          <h3>Auto-track</h3>
          <p>
            Companies your scans and manual JD entries surface are no longer tracked automatically
            (§15 #25c-1) — use "Track this company" on a job, or the browse list below, to add one
            deliberately. Turn this on to go back to the old always-on behavior; auto-tracked
            companies land in a dedicated <strong>Scraped Companies</strong> list, kept separate from
            your curated tracklists.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!user?.auto_track_scraped_companies}
              onChange={toggleAutoTrack}
              disabled={autoTrackSaving || !user}
            />
            <span style={{ fontSize: 13 }}>Automatically track companies I scrape</span>
            {autoTrackSaving && <Spinner />}
          </label>
          {autoTrackErr && <div className="error-text" style={{ marginTop: 8 }}>{autoTrackErr}</div>}
        </div>
        <div className="settings-grid">
          <TracklistsCard />
          <SectorTracklistsCard />
        </div>
      </div>
      )}

      {activeTab === 'delivery' && (
      <div className="settings-section">
        <h2 className="settings-section-title">File Delivery</h2>
        <div className="settings-grid">
          {/* File delivery (spec 11.2/11.3) */}
          <div className="setting-card">
            <h3>File Delivery</h3>
            <p>Every generated file has a working download button, no setup required.</p>
            {drive === null ? (
              <div className="gen-status">
                <Spinner /> &nbsp;Checking Google Drive…
              </div>
            ) : drive.connected ? (
              <>
                <p style={{ fontSize: 12.5 }}>
                  Connected to Google Drive{drive.google_email ? ` as ${drive.google_email}` : ''}. Use
                  &quot;Save to Drive&quot; on any generated document.
                </p>
                <button className="btn btn-ghost" onClick={disconnectDriveAndRefresh} disabled={driveBusy}>
                  {driveBusy ? 'Disconnecting…' : 'Disconnect Google Drive'}
                </button>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                  Also disconnects Gmail status-checking — they share one grant.
                </div>
              </>
            ) : (
              <>
                <button className="btn btn-ghost" onClick={() => connectDrive(window.location.href)}>
                  Connect Google Drive
                </button>
                <div className="disabled-note">Not connected — or your grant expired and needs reconnecting</div>
              </>
            )}
            {driveErr && <span className="error-text" style={{ marginLeft: 8 }}>{driveErr}</span>}
          </div>
        </div>
      </div>
      )}

      {activeTab === 'schedules' && (
      <div className="settings-section">
        <h2 className="settings-section-title">Scheduled Scans</h2>
        <div className="settings-grid">
          {/* Scheduled Scans (spec §12.6) — recurring "Schedule Scan" schedules */}
          <div className="setting-card">
            <h3>Scheduled Scans</h3>
            <p>Recurring scans created from &quot;Schedule Scan&quot; on New Scan. Run automatically — no need to have the app open.</p>

            {schedules === null ? (
              <div className="gen-status">
                <Spinner /> &nbsp;Loading schedules…
              </div>
            ) : schedules.length === 0 ? (
              <div className="disabled-note" style={{ textAlign: 'left' }}>
                No scheduled scans yet. Toggle &quot;Schedule Scan&quot; when running a new scan.
              </div>
            ) : (
              <div>
                {schedules.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      borderTop: '1px solid var(--line)',
                      padding: '9px 0',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      opacity: s.active ? 1 : 0.6,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        {scheduleTitleLabel(s)}
                        <span className="nav-soon" style={{ margin: '0 0 0 6px' }}>
                          {s.active ? 'Active' : 'Paused'}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                        {[
                          s.sources?.[0] === 'ats_direct'
                            ? s.tracklist_ids?.length
                              ? `${s.tracklist_ids.length} tracklist(s)`
                              : s.tracked_company_ids?.length
                                ? `${s.tracked_company_ids.length} companies`
                                : 'all tracked companies'
                            : s.location,
                          s.frequency,
                          s.run_at_time && formatSlotLabel(s.run_at_time.slice(0, 5)),
                          s.timezone,
                          s.score_mode === 'on_demand' && 'you pick what to score',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        {s.active && s.next_run_at && ` · next: ${new Date(s.next_run_at).toLocaleString()}`}
                        {s.consecutive_skips > 0 && ` · ${s.consecutive_skips} skipped run(s)`}
                      </div>
                    </div>
                    <select
                      value={(s.run_at_time || '09:00').slice(0, 5)}
                      onChange={(e) => updateScheduleTime(s, e.target.value)}
                      style={{ fontSize: 11.5, width: 'auto' }}
                      title="Time this schedule runs, in its own timezone"
                    >
                      {HALF_HOUR_SLOTS.map((slot) => (
                        <option key={slot} value={slot}>
                          {formatSlotLabel(slot)}
                        </option>
                      ))}
                    </select>
                    <button className="link-btn" style={{ fontSize: 11.5 }} onClick={() => toggleSchedule(s)}>
                      {s.active ? 'Pause' : 'Resume'}
                    </button>
                    <button className="link-btn" style={{ fontSize: 11.5, color: 'var(--danger)' }} onClick={() => deleteSchedule(s)}>
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {activeTab === 'account' && (
      <div className="settings-section">
        <h2 className="settings-section-title">Account</h2>
        <div className="settings-grid">
          {/* COS balance card */}
          <div className="setting-card">
            <h3>COS Balance</h3>
            <p>
              {user?.cos_balance != null ? `${Math.round(user.cos_balance)} COS available. ` : ''}
              Purchasing isn&apos;t open yet — balances are admin-granted in Phase 1.
            </p>
            <button className="btn btn-primary disabled" disabled title="Purchasing isn't open yet">
              Buy COS
            </button>
            <div className="disabled-note">Purchasing isn&apos;t open yet</div>
            <button
              className="btn btn-ghost"
              style={{ marginTop: 8 }}
              onClick={() => navigate('/buy-cos')}
            >
              View Pricing Breakdown
            </button>
          </div>

          {/* Saved application answers (§17.3). Lives under Account rather
              than beside the autofill feature because the reason it exists is
              the delete affordance — Account is where someone goes to remove
              data they gave, and self-identification answers are the ones they
              are most likely to be looking for. */}
          <AnswerBankCard />
        </div>

        {/* Account deletion (13.7). Its own full-width row BELOW the grid, not
            a third grid card — a destructive control should be the last thing
            on the page, reached deliberately, and the .settings-grid third-card
            trap (see the Tracked Companies comment) would have buried it
            anyway. The cascade is real: deleting the auth row cascades through
            public.users to every user-scoped table, and stored documents are
            swept first so a failure leaves a visibly broken account rather than
            invisibly orphaned files. */}
        <div className="setting-card settings-row-full" style={{ marginTop: 20, borderColor: 'var(--danger)' }}>
          <h3>Delete Account</h3>
          <p>
            Permanently deletes your account and everything in it — résumé versions, scored jobs,
            applications, generated documents, saved answers, connected keys and schedules. This
            cannot be undone and there is no export.
          </p>
          {!deleteOpen ? (
            <button
              className="btn btn-ghost"
              style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
              onClick={() => {
                setDeleteErr(null);
                setDeleteConfirm('');
                setDeleteOpen(true);
              }}
            >
              Delete my account
            </button>
          ) : (
            <>
              <label className="field-label">
                Type <strong>DELETE</strong> to confirm
              </label>
              <input
                type="text"
                value={deleteConfirm}
                autoComplete="off"
                onChange={(e) => setDeleteConfirm(e.target.value)}
                disabled={deleting}
              />
              {deleteErr && <div className="error-text">{deleteErr}</div>}
              <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                <button
                  className="btn"
                  style={{ background: 'var(--danger)', color: '#fff' }}
                  disabled={deleting || deleteConfirm !== 'DELETE'}
                  onClick={deleteAccount}
                >
                  {deleting ? <Spinner /> : 'Permanently delete'}
                </button>
                <button className="btn btn-ghost" disabled={deleting} onClick={() => setDeleteOpen(false)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      )}

      {scraperModal && (
        <ScraperModal
          actor={scraperModal.actor}
          onClose={() => setScraperModal(null)}
          onSaved={loadActors}
        />
      )}
    </div>
  );
}

function splitList(s) {
  return String(s)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

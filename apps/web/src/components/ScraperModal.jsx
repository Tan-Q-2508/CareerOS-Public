import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import Spinner from './Spinner';

// Add / re-map a BYO Scraper actor (spec 4.2). Flow: connect (key + actor id +
// label) -> test call (runs the actor once, returns a raw sample) -> field-mapping
// screen (map internal fields to the sample's keys, auto-guessed) -> save. For a
// non-LinkedIn actor the user also supplies the actor's input JSON, which doubles
// as the sample input and the stored input_template.

// Internal fields (4.2) + the actor keys we auto-guess a mapping from.
const FIELDS = [
  ['title', ['title', 'jobTitle']],
  ['companyName', ['companyName', 'company', 'companyTitle']],
  ['location', ['location', 'jobLocation', 'formattedLocation']],
  ['link', ['link', 'jobUrl', 'url', 'jobPostingUrl', 'jobPostingLink']],
  ['descriptionText', ['descriptionText', 'jobDescriptionText', 'descriptionPlain', 'description', 'jobDescription', 'descriptionHtml']],
  ['postedAt', ['postedAt', 'listedAt', 'postedDate', 'publishedAt', 'postedTime']],
  ['seniorityLevel', ['seniorityLevel', 'experienceLevel']],
  ['employmentType', ['employmentType', 'jobType', 'contractType']],
  ['salary', ['salary', 'salaryMin', 'compensationMin', 'minSalary']],
];

function guessKey(aliases, keys) {
  for (const a of aliases) {
    const exact = keys.find((k) => k.toLowerCase() === a.toLowerCase());
    if (exact) return exact;
  }
  for (const a of aliases) {
    const fuzzy = keys.find((k) => k.toLowerCase().includes(a.toLowerCase()) || a.toLowerCase().includes(k.toLowerCase()));
    if (fuzzy) return fuzzy;
  }
  return '';
}

export default function ScraperModal({ actor, onClose, onSaved }) {
  const remap = !!actor; // editing an existing actor's mapping vs adding a new one
  const [step, setStep] = useState(remap ? 'sample' : 'form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // provider: 'apify' (arbitrary actor, needs field mapping) or 'scraperapi'
  // (a generic proxy — CareerOS owns a fixed LinkedIn parser, so there's no
  // mapping step; a test call just confirms the key works, spec 2.0/13.2).
  const [provider, setProvider] = useState(actor?.provider_name || 'apify');

  // form fields
  const [label, setLabel] = useState(actor?.label || '');
  const [actorId, setActorId] = useState(actor?.actor_id || '');
  const [token, setToken] = useState('');
  const [board, setBoard] = useState(actor?.board || 'linkedin');
  const [jobMax, setJobMax] = useState(actor?.job_count_max || 100);
  const [inputJson, setInputJson] = useState('');

  const [createdId, setCreatedId] = useState(actor?.id || null);
  const [sampleKeys, setSampleKeys] = useState([]);
  const [sampleJob, setSampleJob] = useState(null);
  const [mapping, setMapping] = useState({});
  const [showHelp, setShowHelp] = useState(false);

  const runSample = useCallback(
    async (id) => {
      setBusy(true);
      setError(null);
      try {
        if (provider === 'scraperapi') {
          const { sample } = await api.sampleSourcingActor(id);
          setSampleJob(sample);
          setStep('done');
          return;
        }
        let input;
        if (board !== 'linkedin' && inputJson.trim()) {
          try {
            input = JSON.parse(inputJson);
          } catch {
            setError('Actor input must be valid JSON.');
            setBusy(false);
            return;
          }
        }
        const { keys } = await api.sampleSourcingActor(id, input);
        setSampleKeys(keys || []);
        // Auto-guess a starting mapping.
        const g = {};
        for (const [field, aliases] of FIELDS) {
          const k = guessKey(aliases, keys || []);
          if (k) g[field] = k;
        }
        setMapping(g);
        setStep('map');
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    },
    [provider, board, inputJson]
  );

  // Re-map: run the sample immediately on open.
  useEffect(() => {
    if (remap && createdId) runSample(createdId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect() {
    if (provider === 'scraperapi') {
      if (!label.trim() || !token.trim()) {
        setError('Label and API key are required.');
        return;
      }
    } else if (!label.trim() || !actorId.trim() || !token.trim()) {
      setError('Label, actor ID, and Apify token are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body =
        provider === 'scraperapi'
          ? { label: label.trim(), provider_name: 'scraperapi', api_key: token.trim(), job_count_max: Number(jobMax) }
          : { label: label.trim(), provider_name: 'apify', actor_id: actorId.trim(), apify_token: token.trim(), board, job_count_max: Number(jobMax) };
      const { actor: created } = await api.addSourcingActor(body);
      setCreatedId(created.id);
      await runSample(created.id); // sets busy false + advances
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  async function saveMapping() {
    setBusy(true);
    setError(null);
    try {
      const patch = { output_mapping: mapping };
      if (board !== 'linkedin' && inputJson.trim()) {
        try {
          patch.input_template = JSON.parse(inputJson);
        } catch {
          /* already validated in runSample */
        }
      }
      await api.updateSourcingActor(createdId, patch);
      onSaved();
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" style={{ maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
        <h2>{remap ? 'Re-map scraper' : 'Add a scraper'}</h2>

        {step === 'form' && (
          <>
            <div className="sub">
              {provider === 'scraperapi'
                ? 'Connect your own ScraperAPI key to source LinkedIn jobs. Your key is encrypted at rest and only used to run your scans.'
                : 'Connect your own Apify actor for any job board. Your key is encrypted at rest and only used to run your scans.'}
            </div>

            {!remap && (
              <>
                <label className="field-label">Provider</label>
                <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="apify">Apify (any actor, any board)</option>
                  <option value="scraperapi">ScraperAPI (generic proxy — LinkedIn)</option>
                </select>
              </>
            )}

            {provider === 'apify' && (
              <button
                type="button"
                className="advanced-toggle"
                onClick={() => setShowHelp((s) => !s)}
                style={{ marginBottom: showHelp ? 8 : 14 }}
              >
                {showHelp ? '− Hide' : "+ New to Apify? Here's how to find these"}
              </button>
            )}
            {provider === 'apify' && showHelp && (
              <div
                className="disabled-note"
                style={{ textAlign: 'left', marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                <div>
                  <strong style={{ color: 'var(--text)' }}>1. Get the scraper (Apify actor ID)</strong>
                  <br />
                  Go to <strong>apify.com</strong> and make a free account. Click <strong>Store</strong> at the
                  top, then search for something like &quot;LinkedIn Jobs Scraper&quot;. Open one and click{' '}
                  <strong>Try for free</strong> — it's now saved to your account. On that actor's page, look
                  for the <strong>Actor ID</strong> (shown as something like{' '}
                  <code>username~actor-name</code>) — copy that into the field above.
                </div>
                <div>
                  <strong style={{ color: 'var(--text)' }}>2. Get your API token</strong>
                  <br />
                  In Apify, click your profile picture (top right) → <strong>Settings</strong> →{' '}
                  <strong>Integrations</strong>. Copy the token under &quot;Personal API tokens&quot; (it starts
                  with <code>apify_api_</code>) — paste that into the field above.
                </div>
                <div>
                  That's it — click <strong>Connect &amp; test</strong> below and we'll run it once to make
                  sure it works.
                </div>
              </div>
            )}

            <label className="field-label">Label</label>
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={provider === 'scraperapi' ? 'My ScraperAPI Key' : 'My Indeed Scraper'} />
            {provider === 'apify' && (
              <>
                <label className="field-label">Board</label>
                <select value={board} onChange={(e) => setBoard(e.target.value)}>
                  <option value="linkedin">LinkedIn (search input handled for you)</option>
                  <option value="other">Other (you provide the actor input)</option>
                </select>
                <label className="field-label">Apify actor ID</label>
                <input type="text" value={actorId} onChange={(e) => setActorId(e.target.value)} placeholder="user~actor-name" />
              </>
            )}
            <label className="field-label">{provider === 'scraperapi' ? 'ScraperAPI key' : 'Apify API token'}</label>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={provider === 'scraperapi' ? 'sk_…' : 'apify_api_…'} autoComplete="off" />
            <label className="field-label">Max jobs per scan (10–500)</label>
            <input type="number" min={10} max={500} value={jobMax} onChange={(e) => setJobMax(e.target.value)} />
            {provider === 'apify' && board === 'other' && (
              <>
                <label className="field-label">Actor input (JSON) — used to run the actor</label>
                <textarea
                  value={inputJson}
                  onChange={(e) => setInputJson(e.target.value)}
                  placeholder={'{ "position": "{{title}}", "location": "{{location}}", "maxItems": "{{count}}" }'}
                  style={{ minHeight: 70, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
                />
                <div className="disabled-note" style={{ textAlign: 'left', marginTop: -4 }}>
                  Use {'{{title}}'}, {'{{location}}'}, {'{{keywords}}'}, {'{{count}}'}, {'{{postedWithinDays}}'} placeholders.
                </div>
              </>
            )}
            {error && <div className="error-text">{error}</div>}
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={connect} disabled={busy}>
                {busy ? (
                  <>
                    <Spinner /> &nbsp;Connecting & testing…
                  </>
                ) : (
                  'Connect & test'
                )}
              </button>
              <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
            </div>
          </>
        )}

        {step === 'sample' && (
          <div className="empty-state">
            <Spinner /> &nbsp;Running a test call to fetch a sample listing…
            {error && <div className="error-text">{error}</div>}
          </div>
        )}

        {step === 'done' && (
          <>
            <div className="sub">
              Test call succeeded — ScraperAPI has its own fixed LinkedIn parser, so there's no
              field mapping to set up.
            </div>
            {sampleJob ? (
              <div className="disabled-note" style={{ textAlign: 'left' }}>
                Found: <strong style={{ color: 'var(--text)' }}>{sampleJob.title}</strong>
                {sampleJob.companyName ? ` @ ${sampleJob.companyName}` : ''}
              </div>
            ) : (
              <div className="disabled-note" style={{ textAlign: 'left' }}>
                The test call succeeded but returned no listings for this search — that's fine,
                your key is validated.
              </div>
            )}
            {error && <div className="error-text">{error}</div>}
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  onSaved();
                  onClose();
                }}
              >
                Done
              </button>
            </div>
          </>
        )}

        {step === 'map' && (
          <>
            <div className="sub">
              Test call succeeded ({sampleKeys.length} fields). Map each résumé-scoring field to the
              actor's field — we auto-matched what we could.
            </div>
            <div style={{ maxHeight: '46vh', overflowY: 'auto' }}>
              {FIELDS.map(([field]) => (
                <div key={field} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: '1px solid var(--line)' }}>
                  <span style={{ width: 130, fontSize: 12.5 }}>{field}</span>
                  <span style={{ color: 'var(--text-dim)' }}>→</span>
                  <select
                    value={mapping[field] || ''}
                    onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))}
                    style={{ flex: 1, margin: 0 }}
                  >
                    <option value="">(don't map)</option>
                    {sampleKeys.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            {error && <div className="error-text">{error}</div>}
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={saveMapping} disabled={busy}>
                {busy ? <Spinner /> : 'Save scraper'}
              </button>
              <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

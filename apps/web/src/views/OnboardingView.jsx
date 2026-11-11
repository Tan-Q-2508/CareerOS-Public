import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useMe } from '../context/MeContext';
import Spinner from '../components/Spinner';

// First-run gate (spec 13.1): a user must upload a master résumé before scanning.
export default function OnboardingView() {
  const { refresh } = useMe();
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function upload() {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      await api.uploadResume(file);
      await refresh();
      navigate('/');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <div className="card-narrow" style={{ maxWidth: 460 }}>
        <div className="view-title" style={{ fontSize: 22, marginBottom: 6 }}>
          Upload your master résumé
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 20 }}>
          CareerOS parses this once into a structured profile and reuses it to score
          jobs and generate tailored résumés and cover letters. A Word{' '}
          <strong>.docx</strong> file, up to 5&nbsp;MB. Parsing can take a couple of
          minutes — please don't close this tab while it's working.
        </p>

        <input
          ref={inputRef}
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          style={{ display: 'none' }}
          onChange={(e) => {
            setFile(e.target.files?.[0] || null);
            setError(null);
          }}
        />

        <button
          className="btn btn-ghost"
          style={{ width: '100%' }}
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          {file ? `Selected: ${file.name}` : 'Choose .docx file'}
        </button>

        {error && <div className="error-text">{error}</div>}

        <button
          className="btn btn-primary"
          style={{ width: '100%', marginTop: 12 }}
          onClick={upload}
          disabled={!file || busy}
        >
          {busy ? (
            <>
              <Spinner /> &nbsp;Parsing résumé…
            </>
          ) : (
            'Upload & Parse'
          )}
        </button>
        {busy && (
          <div className="disabled-note" style={{ marginTop: 8 }}>
            This runs an AI parse and can take up to a minute.
          </div>
        )}
      </div>
    </div>
  );
}

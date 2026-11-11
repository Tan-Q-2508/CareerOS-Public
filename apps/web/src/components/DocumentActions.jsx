import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';

// Download/Save-to-Drive for a completed generated_documents row (spec
// 11.2/11.3). Originally JobDetailView-only; extracted so Copilot Mode's
// export success panel (spec 7.14.3 step 4) can reuse the exact same signed-
// URL download and Drive-connect flow rather than a second copy.

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Download a completed .docx. Fetches a fresh signed, time-limited URL on
// click (never a stored public link), reads the bytes in-page, checks they are
// a real .docx, and hands them to the browser as an ordinary download named
// from the document's friendly filename. Where the file goes (and whether the
// browser asks for a folder, remembering the last one) is the browser's own
// "Ask where to save each file" setting. This deliberately does NOT use the
// File System Access Save-As picker: on the maintainer's Chrome it was
// rejected for every folder (Desktop included) with no error, so nothing was
// ever saved, while ordinary downloads work.
export function DownloadDoc({ docId }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);

  function anchorDownload(href, filename) {
    const a = document.createElement('a');
    a.href = href;
    if (filename) a.download = filename;
    a.rel = 'noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Fetch the file into memory and check it really is a .docx (a ZIP: "PK").
  // An error body is never saved under a .docx name.
  async function fetchDocx(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`The file could not be fetched (${resp.status}). Please try again.`);
    const blob = await resp.blob();
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (blob.size < 100 || head[0] !== 0x50 || head[1] !== 0x4b) {
      throw new Error('The downloaded file was not a valid Word document. Please try again.');
    }
    return blob.slice(0, blob.size, DOCX_MIME);
  }

  async function download() {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const { url, filename } = await api.getDocumentDownload(docId);
      let blob;
      try {
        blob = await fetchDocx(url);
      } catch (e) {
        // Could not read the bytes in-page (network/CORS). Let the browser fetch
        // the signed URL itself — Content-Disposition names the file — unless
        // the response was a definite bad file, which the user should see.
        if (/valid Word document|could not be fetched/.test(e.message)) throw e;
        anchorDownload(url);
        setDone(filename);
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      anchorDownload(objectUrl, filename);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      setDone(filename);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 4 }}>
      <button className="link-btn" onClick={download} disabled={busy} style={{ fontSize: 12.5 }}>
        {busy ? 'Preparing…' : 'Download .docx ↓'}
      </button>
      {done && <span style={{ marginLeft: 8, fontSize: 12.5 }}>Downloaded {done}</span>}
      {err && <span className="error-text" style={{ marginLeft: 8 }}>{err}</span>}
    </div>
  );
}

// Save a completed .docx to the user's Google Drive. Free, unconditional like
// DownloadDoc. If Drive isn't connected yet (or the grant was revoked), the
// server returns 'gmail_not_connected' (Gmail/Drive share one grant — see
// googleOAuth.js) and this sends the user through the combined-scope connect
// flow, same as TrackerView's Gmail reconnect.
export function SaveToDrive({ docId }) {
  const { connectDrive } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [link, setLink] = useState(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const { webViewLink } = await api.saveDocumentToDrive(docId);
      setLink(webViewLink);
    } catch (e) {
      if (e.body?.error === 'gmail_not_connected') {
        connectDrive(window.location.href);
        return;
      }
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 4 }}>
      <button className="link-btn" onClick={save} disabled={busy} style={{ fontSize: 12.5 }}>
        {busy ? 'Saving…' : 'Save to Drive'}
      </button>
      {link && (
        <a href={link} target="_blank" rel="noreferrer" style={{ marginLeft: 8, fontSize: 12.5 }}>
          View in Drive ↗
        </a>
      )}
      {err && <span className="error-text" style={{ marginLeft: 8 }}>{err}</span>}
    </div>
  );
}

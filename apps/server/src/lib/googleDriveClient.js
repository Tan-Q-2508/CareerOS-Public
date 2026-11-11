// Minimal Google Drive REST client (spec §11.3). Hand-rolled with fetch, same
// pattern as gmailClient.js, to avoid pulling in the heavy googleapis SDK. Runs
// under a per-user access token (see googleOAuth.js) with the narrow drive.file
// scope — the app can only see/manage files/folders it creates itself, so every
// lookup here is scoped to ids we already stored, never a blind search of the
// user's whole Drive.

const API_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function driveFetch(accessToken, url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) },
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (json.error && json.error.message) || `Drive API HTTP ${resp.status}`;
    throw Object.assign(new Error(msg), { status: resp.status });
  }
  return json;
}

// Root "CareerOS" folder — created once, then reused by id (never re-searched
// by name after that, per the narrow scope's limits on searching files the app
// didn't create). Caller is responsible for persisting the returned id.
async function findOrCreateRootFolder(accessToken, existingId) {
  if (existingId) return existingId;
  const created = await driveFetch(accessToken, `${API_BASE}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'CareerOS', mimeType: FOLDER_MIME }),
  });
  return created.id;
}

// Per-job "{Company}-{Job Title}" subfolder, created once under the root and
// reused thereafter by id (jobs.drive_folder_id).
async function findOrCreateJobFolder(accessToken, rootFolderId, existingId, folderName) {
  if (existingId) return existingId;
  const created = await driveFetch(accessToken, `${API_BASE}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderName, mimeType: FOLDER_MIME, parents: [rootFolderId] }),
  });
  return created.id;
}

// Upload (or, if fileId is given, overwrite in place) a real .docx — never
// converted to Google Docs format (spec §11.3), so the mimeType is set
// explicitly on both the metadata and the multipart body part.
async function uploadDocx(accessToken, { fileId, folderId, filename, buffer }) {
  const metadata = fileId ? { name: filename } : { name: filename, mimeType: DOCX_MIME, parents: [folderId] };
  const boundary = 'careeros-drive-upload';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: ${DOCX_MIME}\r\n\r\n`,
      'utf8'
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--`, 'utf8'),
  ]);
  const url = fileId
    ? `${UPLOAD_BASE}/files/${fileId}?uploadType=multipart&fields=id,webViewLink`
    : `${UPLOAD_BASE}/files?uploadType=multipart&fields=id,webViewLink`;
  const json = await driveFetch(accessToken, url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return { fileId: json.id, webViewLink: json.webViewLink };
}

module.exports = { findOrCreateRootFolder, findOrCreateJobFolder, uploadDocx };

import { supabase } from './supabase';

const BASE = import.meta.env.VITE_API_BASE_URL || '';

// Central fetch wrapper: attaches the current Supabase JWT as a Bearer token
// (requireAuth on the server), JSON-encodes bodies, and normalizes errors.
async function request(path, { method = 'GET', body, headers = {}, isForm = false, timeoutMs } = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;

  const finalHeaders = { ...headers };
  if (token) finalHeaders.Authorization = `Bearer ${token}`;

  let payload = body;
  if (body && !isForm) {
    finalHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: finalHeaders,
      body: payload,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      const timeoutErr = new Error('This is taking longer than expected. Please try again.');
      timeoutErr.status = 0;
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  }

  let json = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  if (!res.ok) {
    const message = (json && (json.error || json.message)) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export const api = {
  // Account / profile
  me: () => request('/api/me'),
  updateProfile: (patch) => request('/api/profile', { method: 'PATCH', body: patch }),
  // Account-level identity, separate from the scan profile above (3.1). Only
  // full_name is settable: users.email mirrors auth.users.email through the
  // signup trigger, so the route rejects an `email` key outright rather than
  // desynchronising the row from the identity the user signs in with.
  updateMe: (patch) => request('/api/me', { method: 'PATCH', body: patch }),
  // 13.7. confirm=true is required by the route, not by this wrapper — the
  // typed-confirmation gate lives in the UI, and sending the flag from here
  // keeps a stray call from being one fetch away from a cascade delete.
  deleteAccount: () => request('/api/me?confirm=true', { method: 'DELETE' }),

  // Resume
  getResume: () => request('/api/resume'),
  uploadResume: (file) => {
    const form = new FormData();
    form.append('resume', file);
    return request('/api/resume', { method: 'POST', body: form, isForm: true, timeoutMs: 240000 });
  },

  // Scans
  listScans: () => request('/api/scans'),
  startScan: (config) => request('/api/scan', { method: 'POST', body: config }),
  // Cooperative: the scan stops at its next job boundary. Jobs already sourced
  // and scored are kept — they were done, and they were billed.
  cancelScan: (id) => request(`/api/scans/${id}/cancel`, { method: 'POST' }),
  suggestScanTitles: () => request('/api/scan/suggest-titles', { method: 'POST' }),
  getScan: (id) => request(`/api/scan/${id}`),
  getScanJobs: (id) => request(`/api/scan/${id}/jobs`),
  // On-demand scoring (spec 4.7): score jobs picked from an unscored list.
  scoreJobs: (jobIds) => request('/api/jobs/score', { method: 'POST', body: { job_ids: jobIds } }),
  deleteScan: (id) => request(`/api/scan/${id}`, { method: 'DELETE' }),
  bulkDeleteScans: (ids) => request('/api/scans/bulk-delete', { method: 'POST', body: { ids } }),
  listAllJobs: () => request('/api/jobs'),

  // Jobs (single fetch + manual entry, spec §6)
  getJob: (id) => request(`/api/jobs/${id}`),
  listManualJobs: () => request('/api/jobs/manual'),
  enterManualJob: (body) => request('/api/jobs/manual', { method: 'POST', body }),

  // Generation
  generationGaps: (jobId) => request(`/api/jobs/${jobId}/generation-gaps`),
  generateResume: (jobId) => request(`/api/jobs/${jobId}/generate-resume`, { method: 'POST' }),
  generateCoverLetter: (jobId) =>
    request(`/api/jobs/${jobId}/generate-cover-letter`, { method: 'POST' }),
  // Custom application Q&A (spec 8.6) — synchronous, no polling.
  answerQuestion: (jobId, question) =>
    request(`/api/jobs/${jobId}/answer-question`, { method: 'POST', body: { question } }),
  listQuestionAnswers: (jobId) => request(`/api/jobs/${jobId}/question-answers`),
  getDocument: (id) => request(`/api/documents/${id}`),
  getDocumentDownload: (id) => request(`/api/documents/${id}/download`),
  // Cooperative — see the server route. A 200 means the run will stop at its
  // next milestone, not that it already has.
  cancelDocument: (id) => request(`/api/documents/${id}/cancel`, { method: 'POST' }),
  saveDocumentToDrive: (id) => request(`/api/documents/${id}/save-to-drive`, { method: 'POST' }),
  listJobDocuments: (jobId) => request(`/api/jobs/${jobId}/documents`),
  generationStatus: (jobId) => request(`/api/jobs/${jobId}/generation-status`),

  // BYO Scraper actors (spec 4.2)
  listSourcingActors: () => request('/api/sourcing-actors'),
  addSourcingActor: (body) => request('/api/sourcing-actors', { method: 'POST', body }),
  sampleSourcingActor: (id, input) =>
    request(`/api/sourcing-actors/${id}/sample`, { method: 'POST', body: input ? { input } : {} }),
  updateSourcingActor: (id, patch) => request(`/api/sourcing-actors/${id}`, { method: 'PATCH', body: patch }),
  deleteSourcingActor: (id) => request(`/api/sourcing-actors/${id}`, { method: 'DELETE' }),

  // AI BYOK (spec 13.3)
  listAiCredentials: () => request('/api/ai-credentials'),
  saveAiCredential: (body) => request('/api/ai-credentials', { method: 'POST', body }),
  testAiCredential: (providerName) => request(`/api/ai-credentials/${providerName}/test`, { method: 'POST' }),
  activateAiProvider: (providerName) =>
    request('/api/ai-credentials/activate', { method: 'POST', body: { provider_name: providerName } }),
  deleteAiCredential: (providerName) => request(`/api/ai-credentials/${providerName}`, { method: 'DELETE' }),

  // Application tracker (spec §9)
  listApplications: () => request('/api/applications'),
  saveApplication: (jobId) => request('/api/applications', { method: 'POST', body: { job_id: jobId } }),
  updateApplication: (id, patch) => request(`/api/applications/${id}`, { method: 'PATCH', body: patch }),
  markNotForMe: (jobId) => request('/api/applications/not-for-me', { method: 'POST', body: { job_id: jobId } }),

  // Gmail status check (spec §9.1)
  gmailStatus: () => request('/api/google/gmail/status'),
  connectGmail: (payload) => request('/api/google/gmail/connect', { method: 'POST', body: payload }),
  disconnectGmail: () => request('/api/google/gmail', { method: 'DELETE' }),
  // Async run + poll (bug batch 2026-07-28 — matches the scan poll shape):
  // emailCheck() kicks off the check and returns { run_id, status: 'queued' };
  // emailCheckStatus(id) polls { run: {...} } until status is completed/failed.
  emailCheck: () => request('/api/email-check', { method: 'POST' }),
  emailCheckStatus: (id) => request(`/api/email-check/${id}`),

  // Google Drive (spec §11.3) — shares one OAuth grant with Gmail.
  driveStatus: () => request('/api/google/drive/status'),
  connectDrive: (payload) => request('/api/google/drive/connect', { method: 'POST', body: payload }),
  disconnectDrive: () => request('/api/google/drive', { method: 'DELETE' }),

  // Recurring scans (spec §12)
  listSchedules: () => request('/api/scan-schedules'),
  createSchedule: (body) => request('/api/scan-schedules', { method: 'POST', body }),
  updateSchedule: (id, patch) => request(`/api/scan-schedules/${id}`, { method: 'PATCH', body: patch }),
  deleteSchedule: (id) => request(`/api/scan-schedules/${id}`, { method: 'DELETE' }),

  // ATS Direct companies (spec 4.6.3/4.6.5) — "Request a company" is the same
  // dedup-then-detect pipeline as auto-detect, triggered by hand.
  requestCompany: (company, link) => request('/api/companies/request', { method: 'POST', body: { company, link } }),
  listTrackedCompanies: () => request('/api/companies/tracked'),
  listKnownCompanies: (q) => request(`/api/companies/known${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  trackCompany: (id) => request(`/api/companies/${id}/track`, { method: 'POST' }),
  untrackCompany: (id) => request(`/api/companies/${id}/track`, { method: 'DELETE' }),

  // AI-curated watchlist (spec 20, §15 #50). curateWatchlist runs two AI calls
  // the user waits on, so it's a plain POST rather than the scan routes'
  // 202-then-poll shape. Accepting a suggestion is what writes a real
  // tracklist row — curate itself stages and nothing else.
  // Returns 202 { run_id } at once; poll getWatchlistRun for progress.
  curateWatchlist: (input) => request('/api/watchlist/curate', { method: 'POST', body: { input } }),
  getWatchlistRun: (id) => request(`/api/watchlist/runs/${id}`),
  listWatchlistSuggestions: (status = 'pending') => request(`/api/watchlist/suggestions?status=${status}`),
  acceptWatchlistSuggestion: (id, tracklistIds, newTracklistName) =>
    request(`/api/watchlist/suggestions/${id}/accept`, { method: 'POST', body: { tracklistIds, newTracklistName } }),
  acceptWatchlistSuggestions: (ids, tracklistIds, newTracklistName) =>
    request('/api/watchlist/suggestions/accept', { method: 'POST', body: { ids, tracklistIds, newTracklistName } }),
  rejectWatchlistSuggestion: (id) => request(`/api/watchlist/suggestions/${id}/reject`, { method: 'POST' }),

  // Tracklists (spec 4.6.8) — personal, multi-list company organization.
  listTracklists: () => request('/api/tracklists'),
  createTracklist: (name) => request('/api/tracklists', { method: 'POST', body: { name } }),
  renameTracklist: (id, name) => request(`/api/tracklists/${id}`, { method: 'PATCH', body: { name } }),
  deleteTracklist: (id) => request(`/api/tracklists/${id}`, { method: 'DELETE' }),
  listTracklistCompanies: (id, q) =>
    request(`/api/tracklists/${id}/companies${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  addCompaniesToTracklists: (registryIds, tracklistIds, newTracklistName) =>
    request('/api/tracklists/companies', { method: 'POST', body: { registryIds, tracklistIds, newTracklistName } }),
  removeCompanyFromTracklist: (tracklistId, registryId) =>
    request(`/api/tracklists/${tracklistId}/companies/${registryId}`, { method: 'DELETE' }),
  // §15 #25c-2 — the ATS Direct scan form's tracklist selector: given chosen
  // tracklist ids (+ optional narrow registry ids), resolves the live
  // company set they'll actually scan (count + a capped browsable sample).
  resolveTracklistCompanies: (tracklistIds, registryIds) =>
    request('/api/tracklists/resolve-companies', {
      method: 'POST',
      body: { tracklist_ids: tracklistIds, registry_ids: registryIds },
    }),

  // Sector tracklists (spec 4.6.9) — system-provided, sector-tagged.
  listSystemTracklists: () => request('/api/tracklists/system'),
  subscribeTracklist: (tracklistId) =>
    request('/api/tracklist-subscriptions', { method: 'POST', body: { tracklist_id: tracklistId } }),
  unsubscribeTracklist: (tracklistId) => request(`/api/tracklist-subscriptions/${tracklistId}`, { method: 'DELETE' }),

  // Notifications (spec §12.5)
  listNotifications: (unreadOnly) => request(`/api/notifications${unreadOnly ? '?unread=true' : ''}`),
  markNotificationRead: (id) => request(`/api/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () => request('/api/notifications/read-all', { method: 'POST' }),

  // Confirmed skills (7.13)
  getConfirmedSkills: () => request('/api/confirmed-skills'),
  confirmSkill: (skill_term, context, entry_ref) =>
    request('/api/confirmed-skills', { method: 'POST', body: { skill_term, context, entry_ref } }),

  // COS ledger (spec 13.4)
  listCosTransactions: (limit) => request(`/api/cos-transactions${limit ? `?limit=${limit}` : ''}`),

  // Copilot Mode (spec 7.14)
  layoutConfig: () => request('/api/resume/layout-config'),
  listCopilotSessionsForJob: (jobId, status) => request(`/api/jobs/${jobId}/copilot/sessions${status ? `?status=${status}` : ''}`),
  startCopilotSession: (jobId) => request(`/api/jobs/${jobId}/copilot/sessions`, { method: 'POST' }),
  continueCopilotSession: (jobId) => request(`/api/jobs/${jobId}/copilot/continue`, { method: 'POST' }),
  getCopilotSession: (sessionId) => request(`/api/resume/copilot/sessions/${sessionId}`),
  patchCopilotSession: (sessionId, contentTree) =>
    request(`/api/resume/copilot/sessions/${sessionId}`, { method: 'PATCH', body: { content_tree: contentTree } }),
  copilotRewriteBullet: (sessionId, bulletId, instruction) =>
    request(`/api/resume/copilot/sessions/${sessionId}/bullets/${bulletId}/rewrite`, { method: 'POST', body: { instruction } }),
  // keywords: string[] — multi-keyword staging (Phase 3 bug fix, 2026-08-02).
  copilotInjectKeyword: (sessionId, bulletId, keywords) =>
    request(`/api/resume/copilot/sessions/${sessionId}/bullets/${bulletId}/inject-keyword`, { method: 'POST', body: { keywords } }),
  revertBulletEdit: (sessionId, bulletId) =>
    request(`/api/resume/copilot/sessions/${sessionId}/bullets/${bulletId}/revert`, { method: 'POST' }),
  editBulletText: (sessionId, bulletId, text) =>
    request(`/api/resume/copilot/sessions/${sessionId}/bullets/${bulletId}/text`, { method: 'PUT', body: { text } }),
  exportCopilotSession: (sessionId) => request(`/api/resume/copilot/sessions/${sessionId}/export`, { method: 'POST' }),
  // Resume Vault drawer (7.14.11) + Custom Bullet Injector (7.14.14)
  getCopilotVault: (sessionId) => request(`/api/resume/copilot/sessions/${sessionId}/vault`),
  adoptVaultItem: (sessionId, payload) =>
    request(`/api/resume/copilot/sessions/${sessionId}/vault/adopt`, { method: 'POST', body: payload }),
  addCustomBullet: (sessionId, entryId, text) =>
    request(`/api/resume/copilot/sessions/${sessionId}/bullets`, { method: 'POST', body: { entry_id: entryId, text } }),
  addAiBullet: (sessionId, entryId, instruction) =>
    request(`/api/resume/copilot/sessions/${sessionId}/bullets`, { method: 'POST', body: { entry_id: entryId, mode: 'ai', instruction } }),
  patchCopilotHeader: (sessionId, fields) =>
    request(`/api/resume/copilot/sessions/${sessionId}/header`, { method: 'PATCH', body: fields }),
  patchCopilotSkills: (sessionId, rows) =>
    request(`/api/resume/copilot/sessions/${sessionId}/skills`, { method: 'PATCH', body: { rows } }),

  // Saved application answers (§17.3). The bank could be written to and read
  // back BY A FORM, but never listed or cleared by the person it belongs to —
  // which matters most for the self-identification answers stored since the
  // EEO work (gender, race, veteran and disability status, pronouns).
  listApplicationAnswers: () => request('/api/autofill/answers'),
  deleteApplicationAnswer: (id) => request(`/api/autofill/answers/${id}`, { method: 'DELETE' }),
  clearApplicationAnswers: () => request('/api/autofill/answers?confirm=true', { method: 'DELETE' }),
};

export { request };

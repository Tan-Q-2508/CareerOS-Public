const { Router } = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const googleOAuth = require('../lib/googleOAuth');

// Google Drive connection management (spec §11.3). Shares one OAuth grant with
// Gmail (googleOAuth.js) — the frontend requests the union of scopes
// (gmail.readonly + drive.file) on either "Connect Gmail" or "Connect Google
// Drive", so connecting/disconnecting either one connects/disconnects both.
// This route file exists for a symmetric, discoverable API (mirrors
// googleGmail.js) and for a Drive-specific status check (does the stored grant
// actually include drive.file), not because the underlying grant is separate.

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const router = Router();

// POST /api/google/drive/connect — store the refresh token from the OAuth grant.
router.post('/api/google/drive/connect', requireAuth, async (req, res, next) => {
  try {
    if (!googleOAuth.isConfigured()) {
      return res.status(503).json({ error: 'Google integration is not configured on the server' });
    }
    const b = req.body || {};
    const refreshToken = (b.refresh_token || '').trim();
    if (!refreshToken) {
      return res.status(400).json({ error: 'no_refresh_token', message: 'No refresh token was returned by Google — reconnect and approve access.' });
    }
    await googleOAuth.storeRefreshToken(req.user.id, {
      refreshToken,
      googleEmail: b.google_email || req.user.email,
      scopes: b.scopes || null,
    });
    const status = await googleOAuth.getStatus(req.user.id);
    res.json({ connected: true, ...status });
  } catch (err) {
    next(err);
  }
});

// GET /api/google/drive/status — { connected, google_email?, scopes?, connected_at? }.
// connected is true only if the stored grant's scopes actually include drive.file
// — a user who only ever connected Gmail (before this feature existed, or on an
// older client) shouldn't read as Drive-connected.
router.get('/api/google/drive/status', requireAuth, async (req, res, next) => {
  try {
    const status = await googleOAuth.getStatus(req.user.id);
    const connected = status.connected && (status.scopes || '').includes(DRIVE_SCOPE);
    res.json({ ...status, connected, configured: googleOAuth.isConfigured() });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/google/drive — disconnect. Deletes the shared grant, so this also
// disconnects Gmail (see file header) — the frontend should make that clear.
router.delete('/api/google/drive', requireAuth, async (req, res, next) => {
  try {
    await googleOAuth.disconnect(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

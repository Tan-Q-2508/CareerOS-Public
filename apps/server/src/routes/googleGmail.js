const { Router } = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const googleOAuth = require('../lib/googleOAuth');

// Gmail connection management (spec §9.1). Acquisition is Supabase-mediated: the
// frontend runs the "Connect Gmail" OAuth grant, captures the one-time
// provider_refresh_token, and POSTs it here to be encrypted + stored. The token
// is never returned to the client after storage.

const router = Router();

// POST /api/google/gmail/connect — store the refresh token from the OAuth grant.
router.post('/api/google/gmail/connect', requireAuth, async (req, res, next) => {
  try {
    if (!googleOAuth.isConfigured()) {
      return res.status(503).json({ error: 'Gmail integration is not configured on the server' });
    }
    const b = req.body || {};
    const refreshToken = (b.refresh_token || '').trim();
    if (!refreshToken) {
      // Supabase only returns provider_refresh_token on a fresh consent with
      // access_type=offline + prompt=consent; a missing one means the grant
      // didn't produce one (e.g. the user already consented without offline).
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

// GET /api/google/gmail/status — { connected, google_email?, scopes?, connected_at? }.
router.get('/api/google/gmail/status', requireAuth, async (req, res, next) => {
  try {
    const status = await googleOAuth.getStatus(req.user.id);
    res.json({ ...status, configured: googleOAuth.isConfigured() });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/google/gmail — disconnect (delete the stored grant).
router.delete('/api/google/gmail', requireAuth, async (req, res, next) => {
  try {
    await googleOAuth.disconnect(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

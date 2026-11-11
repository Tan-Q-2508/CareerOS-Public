const { Router } = require('express');
const { getSupabaseAdmin } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const {
  listTracklists,
  createTracklist,
  renameTracklist,
  deleteTracklist,
  listTracklistCompanies,
  addCompaniesToTracklists,
  removeCompanyFromTracklist,
  listSystemTracklists,
  subscribeToSystemTracklist,
  unsubscribeFromSystemTracklist,
} = require('../companies/tracklists');
const { resolveScanSelection } = require('../companies/registry');

// Tracklist CRUD + membership (spec 4.6.8; Phase 4, §15 #25a).
//
// The routes/companies.js request/track/untrack/browse endpoints (§23/§24)
// stay as-is — they now write through the retargeted registry.js functions
// (trackCompany/untrackCompany/listTrackedCompanies/listKnownCompanies), which
// resolve against this module's tables. This router is the NEW surface: named
// list management and the bulk multiselect add flow 4.6.8 asks for.

const router = Router();

router.get('/api/tracklists', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    res.json({ tracklists: await listTracklists(db, req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/api/tracklists', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const tracklist = await createTracklist(db, req.user.id, (req.body || {}).name);
    res.status(201).json({ tracklist });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.patch('/api/tracklists/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const tracklist = await renameTracklist(db, req.user.id, req.params.id, (req.body || {}).name);
    res.json({ tracklist });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/api/tracklists/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    await deleteTracklist(db, req.user.id, req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/api/tracklists/:id/companies', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const q = (req.query.q || '').trim() || null;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    const companies = await listTracklistCompanies(db, req.user.id, req.params.id, { q, limit, offset });
    res.json({ companies });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/tracklists/companies — 4.6.8's bulk multiselect add flow.
// { registryIds: string[], tracklistIds?: string[], newTracklistName?: string }
router.post('/api/tracklists/companies', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const body = req.body || {};
    const result = await addCompaniesToTracklists(db, req.user.id, {
      registryIds: body.registryIds,
      tracklistIds: body.tracklistIds,
      newTracklistName: body.newTracklistName,
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/tracklists/resolve-companies — §15 #25c-2's ATS Direct scan form
// (4.6.6, revised): given a set of tracklist ids (personal-owned or
// subscribed-system) plus an optional narrow-to-companies sub-picker, returns
// the deduped, active company set they resolve to. Powers the New Scan
// modal's live selected-company count and its narrow sub-picker without
// requiring the client to independently re-implement the union/intersect
// logic resolveScanSelection already owns (the same function runAtsDirectSourcing
// uses when the scan actually runs, so what the form previews and what the
// scan queries can't drift apart). Response is capped for rendering — the
// caller wants a count + a browsable sample, not every row of an 800-company
// sector list serialized over the wire.
router.post('/api/tracklists/resolve-companies', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const body = req.body || {};
    const tracklistIds = Array.isArray(body.tracklist_ids) ? body.tracklist_ids.filter(Boolean) : [];
    const registryIds = Array.isArray(body.registry_ids) ? body.registry_ids.filter(Boolean) : [];
    const { companies, resolvedTracklistIds, missingTracklistIds } = await resolveScanSelection(db, req.user.id, {
      tracklistIds,
      registryIds,
    });
    const RENDER_CAP = 500;
    res.json({
      count: companies.length,
      companies: companies.slice(0, RENDER_CAP),
      truncated: companies.length > RENDER_CAP,
      resolved_tracklist_ids: resolvedTracklistIds,
      missing_tracklist_ids: missingTracklistIds,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/api/tracklists/:id/companies/:registryId', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    await removeCompanyFromTracklist(db, req.user.id, req.params.id, req.params.registryId);
    res.json({ removed: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// System (sector) tracklists — spec 4.6.9, §15 #25b. Placed AFTER
// /api/tracklists/:id-shaped routes to avoid ambiguity with Express's
// path-param matching (there's no /api/tracklists/system id collision risk
// since this is a distinct literal segment, but keeping the order deliberate
// and readable: CRUD, then membership, then system/subscriptions).
// ---------------------------------------------------------------------------

router.get('/api/tracklists/system', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    res.json({ tracklists: await listSystemTracklists(db, req.user.id) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/api/tracklist-subscriptions', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const tracklistId = (req.body || {}).tracklist_id;
    if (!tracklistId) return res.status(400).json({ error: 'tracklist_id is required' });
    await subscribeToSystemTracklist(db, req.user.id, tracklistId);
    res.status(201).json({ subscribed: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Keyed by tracklist_id, not the subscription row id — the UI already has the
// tracklist id in hand from listSystemTracklists and never sees a
// subscription row's own id. Minor deviation from 4.6.8's literal
// "DELETE .../:id" phrasing; spec allows "or equivalent."
router.delete('/api/tracklist-subscriptions/:tracklistId', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    await unsubscribeFromSystemTracklist(db, req.user.id, req.params.tracklistId);
    res.json({ unsubscribed: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;

const { Router } = require('express');
const { getSupabaseAdmin } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');

// In-app notifications (spec §12.5) — a bell/list in the sidebar surfacing scan
// skip/pause/failure alerts written by the scheduler (runDueScans.js). No
// external email/push at MVP; this is the entire delivery mechanism.

const router = Router();

// GET /api/notifications — most recent first, capped. ?unread=true filters.
router.get('/api/notifications', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    let q = db
      .from('notifications')
      .select('id, type, message, read, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (req.query.unread === 'true') q = q.eq('read', false);
    const { data, error } = await q;
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));

    // Unread count is always the TRUE total (independent of the ?unread filter
    // above), so the sidebar bell badge stays accurate either way.
    const { count, error: cErr } = await db
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('read', false);
    if (cErr) return next(Object.assign(new Error(cErr.message), { status: 500 }));

    res.json({ notifications: data || [], unread_count: count || 0 });
  } catch (err) {
    next(err);
  }
});

router.post('/api/notifications/:id/read', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('notifications')
      .update({ read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select('id')
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!data) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true, id: data.id });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/read-all — bulk mark-read (2026-08-15 UX pass).
// Same predicate the per-row route already relies on implicitly (user_id +
// unread only), just applied to every matching row in one update instead of
// requiring N requests from the client.
router.post('/api/notifications/read-all', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('notifications')
      .update({ read: true })
      .eq('user_id', req.user.id)
      .eq('read', false)
      .select('id');
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    res.json({ ok: true, count: (data || []).length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

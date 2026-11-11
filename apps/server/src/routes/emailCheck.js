const { Router } = require('express');
const { getSupabaseAdmin } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const { runEmailCheck } = require('../email/runEmailCheck');
const googleOAuth = require('../lib/googleOAuth');
const cosGuard = require('../lib/cosGuard');

// POST /api/email-check — button-triggered Gmail status check (spec §9.1).
// Runs ASYNC (bug batch 2026-07-28, matching POST /api/scan's dispatch shape):
// creates an `email_check_runs` row and returns it immediately; the actual
// Gmail search + AI classification continues in the background and the client
// polls GET /api/email-check/:id for progress/result — a real ProgressConsole
// (apps/web/src/components/ProgressConsole.jsx) replaces what used to be just
// a button spinner for the whole multi-second run. Never moves a stage itself —
// applying a suggestion is a normal PATCH /api/applications/:id from the client.

const router = Router();

router.post('/api/email-check', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const userId = req.user.id;
    const cosCheck = await cosGuard.checkCosBalance(db, userId, 'email_check');
    if (!cosCheck.ok) {
      return res.status(402).json({ error: cosGuard.paywallMessage(cosCheck.balance, cosCheck.required) });
    }

    // Fail fast for the common case (Gmail never connected) — same 400 shape
    // the client already handles, and no run row needed for a check that
    // can't even start. A revoked/expired token (rarer — only discoverable by
    // actually calling Google) still surfaces via the run row's error_code
    // below, since that can only be known mid-run.
    const gmailStatus = await googleOAuth.getStatus(userId);
    if (!gmailStatus.connected) {
      return res.status(400).json({ error: 'gmail_not_connected', message: 'Gmail is not connected' });
    }

    const { data: run, error: insErr } = await db
      .from('email_check_runs')
      .insert({ user_id: userId, status: 'queued' })
      .select('id, status')
      .single();
    if (insErr) return next(Object.assign(new Error(insErr.message), { status: 500 }));

    // Fire and forget — the check continues in the background after we respond.
    runEmailCheck(userId, { runId: run.id }).catch((e) => console.error('runEmailCheck dispatch error:', e));

    res.status(202).json({ run_id: run.id, status: 'queued' });
  } catch (err) {
    if (err instanceof googleOAuth.GmailNotConnectedError || err.code === 'gmail_not_connected') {
      return res.status(400).json({ error: 'gmail_not_connected', message: err.message });
    }
    next(err);
  }
});

// GET /api/email-check/:id — poll a run's status/progress/result (mirrors
// GET /api/scan/:id). Scoped to the requesting user, same as every other run row.
router.get('/api/email-check/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('email_check_runs')
      .select('id, status, progress, result, checked_count, candidate_count, error_message, error_code, started_at, completed_at, created_at')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!data) return res.status(404).json({ error: 'Run not found' });
    res.json({ run: data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

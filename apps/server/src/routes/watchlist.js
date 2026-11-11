const { Router } = require('express');
const { getSupabaseAdmin, tunables } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const { curateWatchlist } = require('../watchlist/curate');
const { makeProgressLogger } = require('../lib/progress');
const { addCompaniesToTracklists } = require('../companies/tracklists');
const { activeResumeVersion } = require('./resume');
const aiRouter = require('../lib/aiRouter');

// AI-curated watchlist (spec 20, §15 #50).
//
// POST   /api/watchlist/curate            "Build my watchlist"
// GET    /api/watchlist/suggestions       the staged, still-pending list
// POST   /api/watchlist/suggestions/:id/accept   -> real tracklist_companies row
// POST   /api/watchlist/suggestions/:id/reject
//
// Staged, never auto-saved (spec 20 step 3): curate writes only
// watchlist_suggestions rows. Accepting one is what writes a real
// tracklist_companies row, and it does so through 4.6.8's existing
// addCompaniesToTracklists rather than touching the table directly — same
// validation, same new-list-creation path, no second write route into
// tracklists.

const router = Router();

// POST /api/watchlist/curate — body: { input?: string } → 202 { run_id }
//
// A tracked run (watchlist_runs), same shape as the email check: curating
// takes 30-90 s, so the work happens in the background and the client polls
// GET /api/watchlist/runs/:id for its progress milestones.
router.post('/api/watchlist/curate', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    // Empty input is valid (spec 20) — with none, the AI infers targets from
    // the master résumé alone. Only the ABSENCE of a résumé is an error.
    const freeText = String((req.body && req.body.input) || '');

    const { data: user, error: userErr } = await db.from('users').select('*').eq('id', req.user.id).maybeSingle();
    if (userErr) throw userErr;
    if (!user) return res.status(404).json({ error: 'User not found' });

    const resume = await activeResumeVersion(db, req.user.id);
    if (!resume || !resume.parsed_profile) {
      return res.status(400).json({ error: 'Upload and parse a résumé first — the watchlist is built from it.' });
    }

    const { data: run, error: runErr } = await db
      .from('watchlist_runs')
      .insert({ user_id: req.user.id, status: 'queued', input: freeText.trim() || null })
      .select('id')
      .single();
    if (runErr) throw runErr;

    res.status(202).json({ run_id: run.id });

    setImmediate(() => {
      runCuration(db, { runId: run.id, userId: req.user.id, user, profile: resume.parsed_profile, freeText }).catch((e) =>
        console.error('watchlist: run crashed outside its own handler:', e.message || e)
      );
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

async function runCuration(db, { runId, userId, user, profile, freeText }) {
  const logProgress = makeProgressLogger(db, 'watchlist_runs', runId);
  await db.from('watchlist_runs').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', runId);
  let credential;
  try {
    credential = await aiRouter.resolveAiCredential(db, userId);
    const result = await curateWatchlist(db, userId, {
      freeText,
      profile,
      user,
      credential,
      onProgress: logProgress,
      // 16.10: every AI call is logged as it completes — including the spec
      // call of a run whose ranking call later fails.
      onUsage: (u) => logUsage(db, userId, credential, u),
    });
    // BILLING, deliberately absent (spec 20 "Cost"): watchlist_curate is 3 COS
    // flat under 13.4 but stays unbilled — NOT calling cosGuard.debitCos is the
    // entire mechanism, same as companies/sectors.js's logSectorUsage. The fee
    // already sits in tunables.flatFees.watchlist_curate.
    await db
      .from('watchlist_runs')
      .update({
        status: 'completed',
        spec: result.spec,
        candidates_considered: result.candidatesConsidered,
        result_count: result.suggestions.length,
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId);
  } catch (e) {
    console.error(`watchlist run ${runId} failed:`, e.message || e);
    await logProgress('failed', `Stopped: ${e.message || e}`.slice(0, 240));
    await db
      .from('watchlist_runs')
      .update({ status: 'failed', error_message: String(e.message || e).slice(0, 500), completed_at: new Date().toISOString() })
      .eq('id', runId);
  }
}

async function logUsage(db, userId, credential, u) {
  const { error } = await db.from('ai_usage_log').insert({
    user_id: userId,
    action_type: u.actionType,
    provider: credential.mode === 'cai' ? 'gemini' : credential.provider,
    connection_mode: u.connectionMode,
    model: u.model,
    input_tokens: u.usage && u.usage.input_tokens,
    output_tokens: u.usage && u.usage.output_tokens,
    cached_tokens: u.usage && u.usage.cached_tokens,
    total_tokens: u.usage && u.usage.total_tokens,
    raw_usage: u.usage,
    cost_usd: u.costUsd,
  });
  if (error) console.error('watchlist: ai_usage_log insert failed:', error.message);
}

// GET /api/watchlist/runs/:id — status + progress of one curate run.
router.get('/api/watchlist/runs/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { data, error } = await db
      .from('watchlist_runs')
      .select('id, status, input, progress, spec, candidates_considered, result_count, error_message, created_at, completed_at')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Run not found' });
    res.json({ run: { ...data, cos_would_charge: tunables.flatFees.watchlist_curate } });
  } catch (err) {
    next(err);
  }
});

// GET /api/watchlist/suggestions?status=pending
router.get('/api/watchlist/suggestions', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const status = (req.query && req.query.status) || 'pending';
    const { data, error } = await db
      .from('watchlist_suggestions')
      .select(
        'id, company_ats_registry_id, rank, rationale, evidence_type, status, run_input, created_at, decided_at, ' +
          'company_ats_registry(company_name_display, platform, slug_or_identifier)'
      )
      .eq('user_id', req.user.id)
      .eq('status', status)
      // Newest run first, ranked within it — the card groups by run.
      .order('created_at', { ascending: false })
      .order('rank', { ascending: true });
    if (error) throw error;

    res.json({ suggestions: data || [] });
  } catch (err) {
    next(err);
  }
});

// POST /api/watchlist/suggestions/:id/accept — body: { tracklistIds?, newTracklistName? }
//
// The accept half of 20's staged flow. Writes a real tracklist_companies row
// via 4.6.8's own multiselect-add function, then marks the suggestion decided.
// The suggestion row is kept rather than deleted so a re-run doesn't
// re-recommend a company the user already acted on.
router.post('/api/watchlist/suggestions/:id/accept', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const result = await acceptSuggestions(db, req.user.id, [req.params.id], req.body || {});
    if (!result.accepted) return res.status(404).json({ error: 'Pending suggestion not found' });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/watchlist/suggestions/accept — body: { ids: string[], tracklistIds?, newTracklistName? }
// "Add all" for the suggestions the user is looking at — still an explicit
// user decision per click (spec 20 step 3), never an automatic save.
router.post('/api/watchlist/suggestions/accept', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids is required' });
    res.json(await acceptSuggestions(db, req.user.id, ids, req.body || {}));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// A NAMED target list is found-or-created — never blindly created. The card
// sends "My Watchlist" for every Add until a list is picked, and plain
// creation 409'd on the unique (user, lower(name)) index from the second Add
// on, so only the first suggestion ever reached a list.
async function resolveTargetLists(db, userId, { tracklistIds, newTracklistName }) {
  const ids = Array.from(new Set((tracklistIds || []).filter(Boolean)));
  const name = String(newTracklistName || '').trim();
  if (!name) return { tracklistIds: ids, newTracklistName: null };
  const { data: existing, error } = await db
    .from('tracklists')
    .select('id, name')
    .eq('user_id', userId)
    .ilike('name', name.replace(/[%_\\]/g, (c) => `\\${c}`))
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (existing) return { tracklistIds: [...ids, existing.id], newTracklistName: null };
  return { tracklistIds: ids, newTracklistName: name };
}

async function acceptSuggestions(db, userId, suggestionIds, body) {
  const { data: rows, error } = await db
    .from('watchlist_suggestions')
    .select('id, company_ats_registry_id, status')
    .in('id', suggestionIds)
    .eq('user_id', userId)
    .eq('status', 'pending');
  if (error) throw error;
  if (!rows || !rows.length) return { accepted: 0 };

  const target = await resolveTargetLists(db, userId, body);
  const added = await addCompaniesToTracklists(db, userId, {
    registryIds: rows.map((r) => r.company_ats_registry_id),
    tracklistIds: target.tracklistIds,
    newTracklistName: target.newTracklistName,
  });

  const { error: updErr } = await db
    .from('watchlist_suggestions')
    .update({ status: 'accepted', decided_at: new Date().toISOString() })
    .in('id', rows.map((r) => r.id))
    .eq('user_id', userId);
  if (updErr) throw updErr;

  return { accepted: rows.length, added, tracklistIds: added.tracklistIds };
}

// POST /api/watchlist/suggestions/:id/reject — persists nothing to tracklists.
router.post('/api/watchlist/suggestions/:id/reject', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { data, error } = await db
      .from('watchlist_suggestions')
      .update({ status: 'rejected', decided_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Pending suggestion not found' });

    res.json({ rejected: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

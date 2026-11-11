const { Router } = require('express');
const { getSupabaseAdmin, apifyAdapter, scraperApiAdapter, jsearchAdapter, tunables } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const { encryptSecret, decryptSecret, isConfigured: cryptoConfigured } = require('../lib/secretCrypto');

// BYO Scraper actor management (spec 4.2 / 13.2). Multi-actor BYOK sourcing:
// each saved actor is a provider_credentials row (provider_type='sourcing',
// provider_name='apify') with its own encrypted key, label, per-actor ceiling,
// and config_json { actor_id, board, output_mapping? }. Keys are NEVER returned
// to the client.
//
// The temporary built-in LinkedIn preset was removed when Core Scraper (JSearch)
// landed (spec 4.2): Core Scraper is now the always-on house source, and BYO
// Scraper is pure BYOK — each user connects their own scraper key (LinkedIn
// included). The GET response advertises Core Scraper's configured state.

const router = Router();

// Shape a saved DB row for the client (no key material).
function shapeActor(row) {
  const cfg = row.config_json || {};
  return {
    id: row.id,
    builtin: false,
    label: row.label,
    provider_name: row.provider_name,
    actor_id: cfg.actor_id || null,
    board: cfg.board || 'other',
    job_count_max: row.job_count_max,
    has_mapping: !!cfg.output_mapping,
    validated_at: row.validated_at,
    created_at: row.created_at,
  };
}

// GET /api/sourcing-actors — the always-on Core Scraper + the user's saved BYO actors.
router.get('/api/sourcing-actors', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('provider_credentials')
      .select('id, provider_name, label, job_count_max, config_json, validated_at, created_at')
      .eq('user_id', req.user.id)
      .eq('provider_type', 'sourcing')
      .order('created_at', { ascending: true });
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    res.json({
      core_scraper: { id: 'cs', label: 'Core Scraper', enabled: tunables.coreScraperEnabled, configured: jsearchAdapter.isConfigured() },
      actors: (data || []).map(shapeActor),
      byok_enabled: cryptoConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

const SOURCING_PROVIDERS = ['apify', 'scraperapi'];

// POST /api/sourcing-actors — connect a new actor. Body: { label, provider_name?
// ('apify'|'scraperapi', defaults to 'apify' for back-compat), actor_id
// (apify only), apify_token|api_key, job_count_max?, board? }. Apify needs an
// actor_id (an arbitrary actor); ScraperAPI is a generic proxy with its own
// fixed LinkedIn parser (scraperApiAdapter.js) — no actor_id, board is always
// 'linkedin'. Encrypts the key; validation/sample is a separate call
// (POST /:id/sample) so saving doesn't force a paid run.
router.post('/api/sourcing-actors', requireAuth, async (req, res, next) => {
  try {
    if (!cryptoConfigured()) {
      return res.status(503).json({ error: 'BYO Scraper key storage is not configured on the server' });
    }
    const db = getSupabaseAdmin();
    const b = req.body || {};
    const label = (b.label || '').trim();
    const providerName = (b.provider_name || 'apify').trim();
    const token = (b.apify_token || b.api_key || '').trim();
    if (!SOURCING_PROVIDERS.includes(providerName)) {
      return res.status(400).json({ error: `provider_name must be one of: ${SOURCING_PROVIDERS.join(', ')}` });
    }
    if (!label) return res.status(400).json({ error: 'label is required' });
    if (!token) return res.status(400).json({ error: providerName === 'apify' ? 'apify_token is required' : 'api_key is required' });
    if (label.toLowerCase() === 'cs' || label.toLowerCase() === 'core scraper') {
      return res.status(400).json({ error: 'that label is reserved' });
    }

    const actorId = (b.actor_id || '').trim();
    if (providerName === 'apify' && !actorId) {
      return res.status(400).json({ error: 'actor_id is required' });
    }

    let jobMax = Number(b.job_count_max) || tunables.ldJobCount.default;
    jobMax = Math.max(tunables.ldJobCount.min, Math.min(tunables.ldJobCount.max, Math.round(jobMax)));
    const configJson = providerName === 'apify'
      ? { actor_id: actorId, board: (b.board || 'other').trim() }
      : { board: 'linkedin' }; // ScraperAPI's parser is LinkedIn-only for now (spec 2.0)
    if (providerName === 'apify' && b.input_template !== undefined) configJson.input_template = b.input_template;

    const { data, error } = await db
      .from('provider_credentials')
      .insert({
        user_id: req.user.id,
        provider_type: 'sourcing',
        provider_name: providerName,
        encrypted_key: encryptSecret(token),
        label,
        job_count_max: jobMax,
        config_json: configJson,
      })
      .select('id, provider_name, label, job_count_max, config_json, validated_at, created_at')
      .single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'An actor with that label already exists' });
      return next(Object.assign(new Error(error.message), { status: 500 }));
    }
    res.status(201).json({ actor: shapeActor(data) });
  } catch (err) {
    next(err);
  }
});

// POST /api/sourcing-actors/:id/sample — run the actor once (test call) and return
// one raw sample listing + its keys for the mapping screen. Marks validated_at.
// Body (optional): { input } — actor input; defaults to a small LinkedIn search.
router.post('/api/sourcing-actors/:id/sample', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data: row, error } = await db
      .from('provider_credentials')
      .select('id, provider_name, encrypted_key, config_json')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .eq('provider_type', 'sourcing')
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!row) return res.status(404).json({ error: 'Actor not found' });

    let token;
    try {
      token = decryptSecret(row.encrypted_key);
    } catch (e) {
      return res.status(500).json({ error: 'Stored key could not be decrypted' });
    }
    const cfg = row.config_json || {};

    if (row.provider_name === 'scraperapi') {
      // ScraperAPI's own parser is fixed (no user-configurable field mapping,
      // unlike an arbitrary Apify actor's raw JSON) — the "sample" is already
      // a fully-normalized job.
      const jobs = await scraperApiAdapter.fetchSample({ token, title: 'analyst', maxItems: 1 });
      const sample = jobs[0] || null;
      await db.from('provider_credentials').update({ validated_at: new Date().toISOString() }).eq('id', row.id);
      return res.json({ sample, keys: sample ? Object.keys(sample) : [], count: jobs.length });
    }

    const input =
      (req.body && req.body.input) ||
      (cfg.board === 'linkedin'
        ? { urls: [apifyAdapter.buildSearchUrl({ title: 'analyst', postedWithinDays: tunables.postedWithinDays })], count: tunables.ldJobCount.min, scrapeCompany: false }
        : {});

    const items = await apifyAdapter.fetchSample({ token, actorId: cfg.actor_id, input, maxItems: 3 });
    const sample = items[0] || null;
    await db.from('provider_credentials').update({ validated_at: new Date().toISOString() }).eq('id', row.id);
    res.json({ sample, keys: sample ? Object.keys(sample) : [], count: items.length });
  } catch (err) {
    // Provider errors (bad key/actor) surface here — report cleanly, don't 500-crash.
    res.status(400).json({ error: `Test call failed: ${err.message || err}` });
  }
});

// PATCH /api/sourcing-actors/:id — label / job_count_max / output_mapping / rotate key.
router.patch('/api/sourcing-actors/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const b = req.body || {};
    const { data: row, error: rErr } = await db
      .from('provider_credentials')
      .select('id, config_json')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .eq('provider_type', 'sourcing')
      .maybeSingle();
    if (rErr) return next(Object.assign(new Error(rErr.message), { status: 500 }));
    if (!row) return res.status(404).json({ error: 'Actor not found' });

    const patch = {};
    if (b.label !== undefined) {
      const l = String(b.label).trim();
      if (!l) return res.status(400).json({ error: 'label cannot be empty' });
      patch.label = l;
    }
    if (b.job_count_max !== undefined) {
      let j = Number(b.job_count_max) || tunables.ldJobCount.default;
      patch.job_count_max = Math.max(tunables.ldJobCount.min, Math.min(tunables.ldJobCount.max, Math.round(j)));
    }
    const cfg = { ...(row.config_json || {}) };
    if (b.output_mapping !== undefined) cfg.output_mapping = b.output_mapping;
    if (b.actor_id !== undefined) cfg.actor_id = String(b.actor_id).trim();
    if (b.board !== undefined) cfg.board = String(b.board).trim();
    if (b.input_template !== undefined) cfg.input_template = b.input_template;
    patch.config_json = cfg;
    const rotatedKey = b.apify_token || b.api_key;
    if (rotatedKey) {
      if (!cryptoConfigured()) return res.status(503).json({ error: 'Key storage not configured' });
      patch.encrypted_key = encryptSecret(String(rotatedKey).trim());
      patch.validated_at = null; // re-validate after a rotate
    }

    const { data, error } = await db
      .from('provider_credentials')
      .update(patch)
      .eq('id', row.id)
      .eq('user_id', req.user.id)
      .select('id, provider_name, label, job_count_max, config_json, validated_at, created_at')
      .single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'An actor with that label already exists' });
      return next(Object.assign(new Error(error.message), { status: 500 }));
    }
    res.json({ actor: shapeActor(data) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/sourcing-actors/:id — remove an actor + its stored key.
router.delete('/api/sourcing-actors/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('provider_credentials')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .eq('provider_type', 'sourcing')
      .select('id')
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!data) return res.status(404).json({ error: 'Actor not found' });
    res.json({ ok: true, id: data.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

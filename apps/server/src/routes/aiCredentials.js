const { Router } = require('express');
const { getSupabaseAdmin, tunables } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const { encryptSecret, decryptSecret, isConfigured: cryptoConfigured } = require('../lib/secretCrypto');
const aiRouter = require('../lib/aiRouter');

// AI BYOK credential management (spec 13.3, Phase 2 session 14). One active
// provider at a time — provider_credentials already allows at most one row per
// (user_id, provider_name) where provider_type='ai' (the Stage-1 sourcing
// migration's partial unique index); users.active_ai_provider (new column,
// 20260727000000_ai_byok.sql) picks which saved row, if any, is live. null
// means CAI. Mirrors sourcingActors.js's connect->test->activate shape.

const PROVIDERS = ['gemini', 'openai_compatible', 'anthropic'];

const TEST_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
function validateTest(p) {
  return p && p.ok === true ? null : 'model did not return the expected test payload';
}

function shapeRow(row) {
  const cfg = row.config_json || {};
  return {
    provider_name: row.provider_name,
    model: cfg.model || null,
    base_url: cfg.base_url || null,
    validated_at: row.validated_at,
    created_at: row.created_at,
  };
}

const router = Router();

// GET /api/ai-credentials — active provider + every saved AI key (no key material).
router.get('/api/ai-credentials', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data: user, error: uErr } = await db
      .from('users')
      .select('active_ai_provider')
      .eq('id', req.user.id)
      .single();
    if (uErr) return next(Object.assign(new Error(uErr.message), { status: 500 }));

    const { data, error } = await db
      .from('provider_credentials')
      .select('provider_name, config_json, validated_at, created_at')
      .eq('user_id', req.user.id)
      .eq('provider_type', 'ai')
      .order('created_at', { ascending: true });
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));

    // Phase 3 #17 (spec 13.3/0.1): BYOK AI is temporarily disabled. Report the
    // truth — every call really does route through CAI right now, regardless
    // of what's saved in users.active_ai_provider (left untouched so Phase 4
    // restores it automatically) — and tell the client *why* BYOK is off so
    // it can distinguish "temporarily off for this phase" from the
    // pre-existing "server has no SECRET_ENCRYPTION_KEY" case.
    const byokEnabled = cryptoConfigured() && tunables.aiByokEnabled;
    let byokDisabledReason = null;
    if (!byokEnabled) byokDisabledReason = !tunables.aiByokEnabled ? 'phase' : 'crypto';

    res.json({
      active_provider: tunables.aiByokEnabled ? user.active_ai_provider : null,
      saved: (data || []).map(shapeRow),
      byok_enabled: byokEnabled,
      byok_disabled_reason: byokDisabledReason,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai-credentials — connect/rotate a key for one provider. Body:
// { provider_name, api_key, model, base_url? }. Encrypts + upserts; the row
// starts unvalidated (validated_at null) until POST .../test succeeds.
router.post('/api/ai-credentials', requireAuth, async (req, res, next) => {
  try {
    if (!tunables.aiByokEnabled) {
      return res.status(503).json({ error: 'BYOK AI is temporarily unavailable during Phase 3 stabilization' });
    }
    if (!cryptoConfigured()) {
      return res.status(503).json({ error: 'BYOK key storage is not configured on the server' });
    }
    const db = getSupabaseAdmin();
    const b = req.body || {};
    const providerName = (b.provider_name || '').trim();
    const apiKey = (b.api_key || '').trim();
    const model = (b.model || '').trim();
    const baseUrl = (b.base_url || '').trim();

    if (!PROVIDERS.includes(providerName)) {
      return res.status(400).json({ error: `provider_name must be one of: ${PROVIDERS.join(', ')}` });
    }
    if (!apiKey) return res.status(400).json({ error: 'api_key is required' });
    if (!model) return res.status(400).json({ error: 'model is required' });

    const configJson = { model };
    if (baseUrl) configJson.base_url = baseUrl;

    // Supabase's .upsert({onConflict}) emits a plain ON CONFLICT(columns), which
    // Postgres can't resolve against a PARTIAL unique index (the ai-provider
    // uniqueness is scoped `where provider_type='ai'`, spec 13.1) — it needs the
    // WHERE clause repeated or the constraint referenced by name, neither of
    // which the upsert() API exposes. Select-then-insert-or-update instead,
    // same pattern sourcingActors.js's PATCH already uses.
    const { data: existing, error: selErr } = await db
      .from('provider_credentials')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('provider_type', 'ai')
      .eq('provider_name', providerName)
      .maybeSingle();
    if (selErr) return next(Object.assign(new Error(selErr.message), { status: 500 }));

    const fields = {
      encrypted_key: encryptSecret(apiKey),
      config_json: configJson,
      validated_at: null, // re-validate after every connect/rotate
    };
    const query = existing
      ? db.from('provider_credentials').update(fields).eq('id', existing.id)
      : db.from('provider_credentials').insert({ ...fields, user_id: req.user.id, provider_type: 'ai', provider_name: providerName });

    const { data, error } = await query.select('provider_name, config_json, validated_at, created_at').single();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    res.status(201).json({ credential: shapeRow(data) });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai-credentials/:provider_name/test — one cheap real call through
// the matching adapter to validate the key before it can be activated.
router.post('/api/ai-credentials/:provider_name/test', requireAuth, async (req, res, next) => {
  try {
    if (!tunables.aiByokEnabled) {
      return res.status(503).json({ error: 'BYOK AI is temporarily unavailable during Phase 3 stabilization' });
    }
    const db = getSupabaseAdmin();
    const providerName = req.params.provider_name;
    const { data: row, error } = await db
      .from('provider_credentials')
      .select('id, provider_name, encrypted_key, config_json')
      .eq('user_id', req.user.id)
      .eq('provider_type', 'ai')
      .eq('provider_name', providerName)
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!row) return res.status(404).json({ error: 'No saved key for that provider' });

    const cfg = row.config_json || {};
    let apiKey;
    try {
      apiKey = decryptSecret(row.encrypted_key);
    } catch (e) {
      return res.status(500).json({ error: 'Stored key could not be decrypted' });
    }

    const credential = { mode: 'byok', provider: row.provider_name, apiKey, baseUrl: cfg.base_url || null, model: cfg.model };
    await aiRouter.structuredCall(credential, {
      tier: 'cheap',
      systemInstruction: 'You are a connectivity test. Reply only with the required JSON.',
      prompt: 'Reply with exactly {"ok": true}.',
      responseSchema: TEST_SCHEMA,
      validate: validateTest,
    });

    await db.from('provider_credentials').update({ validated_at: new Date().toISOString() }).eq('id', row.id);
    res.json({ ok: true });
  } catch (err) {
    // Provider errors (bad key/model/base_url) surface here — report cleanly, don't 500-crash.
    res.status(400).json({ error: `Test call failed: ${err.message || err}` });
  }
});

// POST /api/ai-credentials/activate — body { provider_name | null }. null
// switches back to CAI. Refuses to activate an unvalidated row.
router.post('/api/ai-credentials/activate', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const providerName = req.body && req.body.provider_name ? String(req.body.provider_name).trim() : null;

    if (providerName) {
      // Only guard the direction that would actually turn BYOK back on for a
      // call — switching back to CAI (providerName === null, below) always
      // stays open, same for DELETE, since neither can violate the phase's
      // "everything routes through CAI" guarantee.
      if (!tunables.aiByokEnabled) {
        return res.status(503).json({ error: 'BYOK AI is temporarily unavailable during Phase 3 stabilization' });
      }
      if (!PROVIDERS.includes(providerName)) {
        return res.status(400).json({ error: `provider_name must be one of: ${PROVIDERS.join(', ')}` });
      }
      const { data: row, error } = await db
        .from('provider_credentials')
        .select('validated_at')
        .eq('user_id', req.user.id)
        .eq('provider_type', 'ai')
        .eq('provider_name', providerName)
        .maybeSingle();
      if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
      if (!row || !row.validated_at) {
        return res.status(400).json({ error: 'Test this key successfully before activating it' });
      }
    }

    const { error: updErr } = await db.from('users').update({ active_ai_provider: providerName }).eq('id', req.user.id);
    if (updErr) return next(Object.assign(new Error(updErr.message), { status: 500 }));
    res.json({ ok: true, active_provider: providerName });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/ai-credentials/:provider_name — remove a saved key; if it was
// active, falls back to CAI.
router.delete('/api/ai-credentials/:provider_name', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const providerName = req.params.provider_name;

    const { data, error } = await db
      .from('provider_credentials')
      .delete()
      .eq('user_id', req.user.id)
      .eq('provider_type', 'ai')
      .eq('provider_name', providerName)
      .select('provider_name')
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!data) return res.status(404).json({ error: 'No saved key for that provider' });

    const { data: user } = await db.from('users').select('active_ai_provider').eq('id', req.user.id).single();
    if (user && user.active_ai_provider === providerName) {
      await db.from('users').update({ active_ai_provider: null }).eq('id', req.user.id);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

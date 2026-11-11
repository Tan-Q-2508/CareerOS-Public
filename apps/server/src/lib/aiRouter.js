const { geminiAdapter, openaiCompatibleAdapter, anthropicAdapter, tunables } = require('@careeros/shared');
const { decryptSecret } = require('./secretCrypto');

// The seam every AI call site goes through instead of importing geminiAdapter
// directly (spec 13.3, Phase 2 session 14 — full AI BYOK). Resolves a user's
// active provider once per orchestrator run, then dispatches every structured
// call to the right adapter with a uniform contract regardless of CAI vs BYOK.
//
// CAI keeps its existing cheap/strong model tiering (tunables.aiModelTier);
// BYOK does not — the user configured one model for everything on their saved
// provider_credentials row (config_json.model), so `tier` is simply ignored in
// that branch. This keeps the BYOK UX (and its cost math) to one number
// instead of asking a user to pick two models per provider.

// { mode: 'cai' } | { mode: 'byok', provider, apiKey, baseUrl, model }
async function resolveAiCredential(db, userId) {
  // Phase 3 #17 (spec 13.3/0.1): BYOK AI is temporarily disabled so every
  // in-flight scoring/generation fix is measured against one uniform AI
  // path. This is a routing gate, not a removal — a user's saved
  // provider_credentials row and users.active_ai_provider are left exactly
  // as they are and are honored again the moment the flag flips back on at
  // PUBLIC LAUNCH — §15 #33, Phase 6 — no rebuild needed. (This comment said
  // "Phase 4" for a year; so did apps/web/README.md, differently. §15 #28 was
  // reused for Greenhouse autofill, which is where the confusion came from.)
  // Short-circuits before either DB read.
  if (!tunables.aiByokEnabled) return { mode: 'cai' };

  const { data: user, error: uErr } = await db
    .from('users')
    .select('active_ai_provider')
    .eq('id', userId)
    .single();
  if (uErr) throw uErr;
  if (!user.active_ai_provider) return { mode: 'cai' };

  const { data: row, error: cErr } = await db
    .from('provider_credentials')
    .select('provider_name, encrypted_key, config_json, validated_at')
    .eq('user_id', userId)
    .eq('provider_type', 'ai')
    .eq('provider_name', user.active_ai_provider)
    .maybeSingle();
  if (cErr) throw cErr;
  // The active provider's row is missing/unvalidated (e.g. deleted out from
  // under it) — fail safe to CAI rather than 500ing every AI call site.
  if (!row || !row.validated_at) return { mode: 'cai' };

  const cfg = row.config_json || {};
  return {
    mode: 'byok',
    provider: row.provider_name,
    apiKey: decryptSecret(row.encrypted_key),
    baseUrl: cfg.base_url || null,
    model: cfg.model,
  };
}

// CAI model candidates for a given tier — an ORDERED LIST, not a single
// model. Since the developer-mode migration off Vertex (GCP trial billing
// unlinked), each tier's free-tier quota is small and lives per-model-ID, not
// per-tier — e.g. gemini-3.6-flash and gemini-3.5-flash each get their own
// independent daily/per-minute allotment on the AI Studio free plan. Listing
// several same-class models per tier and trying them in order turns N small
// per-model quotas into one larger effective pool, without paying for a
// bigger quota on any single model. 'cheap'/'strong' are tunables.aiModelTier
// (cheap -> Flash-Lite family, strong -> plain Flash family, disjoint pools so
// high-volume cheap-tier calls can't starve strong-tier's quota); 'parse' is
// résumé parsing's own dedicated tunables.parseModel list (kept separate from
// the scoring/generation tiers since it's free/unbilled and may diverge from
// them later, even though its candidates equal 'strong''s today).
function resolveCaiModelCandidates(tier) {
  const list = tier === 'parse' ? tunables.parseModel : tunables.aiModelTier[tier];
  return Array.isArray(list) ? list : [list];
}

// Single representative model for a tier — used only where one model name is
// needed for an estimate (BYOK-equivalent cost math below), not for an actual
// call. Always the first/primary candidate.
function resolveCaiModel(tier) {
  return resolveCaiModelCandidates(tier)[0];
}

// Per-model cooldown after a timeout (in-process, best-effort). See structuredCall.
const modelCooldownUntil = new Map();
function isTimeoutError(err) {
  const msg = String((err && (err.message || err.name)) || '').toLowerCase();
  return (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) || /aborted|timed out|timeout/.test(msg);
}
function isCoolingDown(model) {
  return (modelCooldownUntil.get(model) || 0) > Date.now();
}
function startCooldown(model) {
  const ms = tunables.aiModelCooldownMs;
  if (ms > 0) modelCooldownUntil.set(model, Date.now() + ms);
}

// Uniform structured call across CAI and every BYOK adapter. `tier` is
// 'cheap'|'strong'|'parse' — the same choice every call site already made via
// tunables.aiModelTier/parseModel before this refactor.
async function structuredCall(credential, { tier, systemInstruction, prompt, responseSchema, validate, timeoutMs }) {
  if (credential.mode === 'cai') {
    const candidates = resolveCaiModelCandidates(tier);
    let lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i];
      // A model that just hung is skipped for a few minutes rather than making
      // every job wait out its full timeout again (Vertex gemini-3.8-flash
      // intermittently hangs a call for the whole timeout while its siblings
      // answer in ~2s). Never skips the last candidate, so a tier is always tried.
      if (isCoolingDown(model) && i < candidates.length - 1) {
        console.log(`[aiRouter] skipping ${model} (timed out recently), tier=${tier}`);
        continue;
      }
      try {
        return await geminiAdapter.structuredCall({ model, systemInstruction, prompt, responseSchema, validate, timeoutMs });
      } catch (err) {
        lastErr = err;
        if (isTimeoutError(err)) startCooldown(model);
        console.log(`[aiRouter] model failed, trying next candidate tier=${tier} model=${model} error=${err.message}`);
      }
    }
    throw lastErr;
  }

  const { provider, apiKey, baseUrl, model } = credential;
  if (provider === 'gemini') {
    // BYOK Gemini reuses the same adapter in developer mode, just with the
    // user's own AI Studio key instead of the server's env-configured one.
    return geminiAdapter.structuredCall({
      model,
      systemInstruction,
      prompt,
      responseSchema,
      validate,
      apiKey,
      timeoutMs,
    }).then((r) => ({ ...r, costUsd: null, connectionMode: 'byok' }));
  }
  if (provider === 'openai_compatible') {
    return openaiCompatibleAdapter.structuredCall({ apiKey, baseUrl, model, systemInstruction, prompt, responseSchema, validate });
  }
  if (provider === 'anthropic') {
    return anthropicAdapter.structuredCall({ apiKey, model, systemInstruction, prompt, responseSchema, validate });
  }
  throw new Error(`aiRouter: unknown BYOK provider "${provider}"`);
}

// COS AI-fee math (spec 13.4): CAI charges the full margin on real measured
// cost; BYOK reduces that to 10% of what CAI would have charged for the same
// work, floored at 1 COS so the line never displays as a literal 0. For BYOK
// we don't know the provider's real dollar cost (that's the user's own spend,
// 13.3) — so "what CAI would have charged" is estimated from the real token
// counts the BYOK call reported, priced against the CAI model for that call's
// own tier. This is a token-count-based estimate, not a claim about the
// external provider's actual cost — same "directional, not live quotes"
// spirit as the rest of 13.4's calibration approach.
//
// `usages` is a list of { usage, costUsd, tier } — one entry per structuredCall
// made during the action (a scan/generation/email-check can mix cheap- and
// strong-tier calls, so each entry carries its own tier rather than one
// blanket tier for the whole batch).
function computeAiFeeCos({ credential, usages }) {
  const items = (usages || []).filter(Boolean);
  if (credential.mode === 'cai') {
    const totalUsd = items.reduce((sum, u) => sum + (u.costUsd || 0), 0);
    return Number((totalUsd * tunables.cosMargin * tunables.cosExchangeRate).toFixed(4));
  }

  const caiEquivalentUsd = items.reduce((sum, u) => {
    return sum + (geminiAdapter.computeCostUsd(resolveCaiModel(u.tier), u.usage) || 0);
  }, 0);
  const caiEquivalentCos = caiEquivalentUsd * tunables.cosMargin * tunables.cosExchangeRate;
  const external = caiEquivalentCos * tunables.byokExternalAiFeeRate;
  return Number(Math.max(tunables.byokExternalAiFeeFloor, external).toFixed(4));
}

// Per-job AI-fee increment for a scan (13.4), used so each job's AI cost is
// debited as soon as it's scored instead of one lump sum at scan end — a scan
// that dies partway through (Render free-tier restart mid-run, no persistent
// queue) still bills for the jobs it actually scored rather than leaking that
// cost entirely (confirmed live: an orphaned scan had scored 16 jobs, real
// Gemini calls already made, and never billed a single COS for them).
//
// CAI is exact and linear (no floor), so each job's slice is charged as-is.
// BYOK applies computeAiFeeCos's floor once per SCAN, not per job — flooring
// every job individually would over-charge a multi-job BYOK scan (34 jobs
// would floor to 34 COS instead of 1). So the caller threads `priorRawCos`
// (the running pre-floor external total) and `priorChargedCos` (what's
// actually been debited so far) through every call; this returns only the
// marginal amount owed once the cumulative total first crosses the floor,
// converging to the exact same scan-level total `computeAiFeeCos` would have
// produced for a scan that runs to completion — just paid out progressively.
function aiFeeCosDelta({ credential, usages, priorRawCos = 0, priorChargedCos = 0 }) {
  const items = (usages || []).filter(Boolean);
  if (credential.mode === 'cai') {
    const usd = items.reduce((sum, u) => sum + (u.costUsd || 0), 0);
    const delta = Number((usd * tunables.cosMargin * tunables.cosExchangeRate).toFixed(4));
    return { delta, rawCos: priorRawCos, chargedCos: priorChargedCos + delta };
  }

  const caiEquivalentUsd = items.reduce((sum, u) => {
    return sum + (geminiAdapter.computeCostUsd(resolveCaiModel(u.tier), u.usage) || 0);
  }, 0);
  const rawCos = priorRawCos + caiEquivalentUsd * tunables.cosMargin * tunables.cosExchangeRate * tunables.byokExternalAiFeeRate;
  const owed = Math.max(tunables.byokExternalAiFeeFloor, rawCos);
  const delta = Number(Math.max(0, owed - priorChargedCos).toFixed(4));
  return { delta, rawCos, chargedCos: priorChargedCos + delta };
}

module.exports = { resolveAiCredential, structuredCall, resetModelCooldowns: () => modelCooldownUntil.clear(), computeAiFeeCos, aiFeeCosDelta };

const { GoogleGenAI } = require('@google/genai');
const tunables = require('../tunables.json');

// One Gemini adapter, two connection modes (spec 16.7):
//   vertex    -> Google Cloud Vertex AI, service-account ADC
//   developer -> Gemini Developer API, an AI Studio API key
// Session 4/5/6 reuse this same adapter with different prompts.

let cachedClient = null;
let cachedMode = null;

function getConnectionMode() {
  return process.env.GEMINI_CONNECTION_MODE || tunables.aiConnectionMode || 'vertex';
}

// Render can't mount a key file, so the service-account JSON arrives as an env
// var. Materialize it to a temp file and point ADC at it, once.
function ensureVertexAdc() {
  const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (json && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const keyPath = path.join(os.tmpdir(), 'careeros-gcp-sa.json');
    fs.writeFileSync(keyPath, json, { mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
  }
}

function isConfigured() {
  const mode = getConnectionMode();
  if (mode === 'developer') return Boolean(process.env.GEMINI_API_KEY);
  return Boolean(
    process.env.GCP_PROJECT_ID &&
      (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
  );
}

function getClient() {
  const mode = getConnectionMode();
  if (cachedClient && cachedMode === mode) return cachedClient;

  if (mode === 'developer') {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('AI not configured: GEMINI_API_KEY is required for developer mode');
    }
    cachedClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  } else {
    if (!process.env.GCP_PROJECT_ID) {
      throw new Error('AI not configured: GCP_PROJECT_ID is required for vertex mode');
    }
    ensureVertexAdc();
    cachedClient = new GoogleGenAI({
      vertexai: true,
      project: process.env.GCP_PROJECT_ID,
      location: process.env.GCP_VERTEX_LOCATION || 'us-central1',
    });
  }
  cachedMode = mode;
  return cachedClient;
}

// `thoughtsTokenCount` is reported separately from `candidatesTokenCount`, and
// Google bills it at the OUTPUT rate ("Output price (including thinking
// tokens)"). Reading only candidatesTokenCount left every thinking model's
// reasoning unpriced, which is what made logged cost run ~27% under the GCP
// invoice — not the rates. output_tokens stays the visible-candidate count so
// existing rows keep their meaning; thoughts_tokens is the added term.
function normalizeUsage(meta) {
  const m = meta || {};
  return {
    input_tokens: m.promptTokenCount ?? 0,
    output_tokens: m.candidatesTokenCount ?? 0,
    thoughts_tokens: m.thoughtsTokenCount ?? 0,
    cached_tokens: m.cachedContentTokenCount ?? 0,
    total_tokens: m.totalTokenCount ?? 0,
  };
}

// Real $ cost for the call (spec 16.10). Rates in tunables.geminiRates ($/1M tokens).
// Cached tokens are billed at the discounted `cached` rate, not full input — this
// is what makes Phase 1's logged cost reflect cache-read economics (5.6/16.10), so
// Gemini's implicit prefix caching across a scan batch actually shows up as savings.
// promptTokenCount (input_tokens) INCLUDES cached tokens, so bill the non-cached
// remainder at rate.input and the cached portion at rate.cached.
function computeCostUsd(model, usage) {
  const rate = (tunables.geminiRates && tunables.geminiRates[model]) || null;
  if (!rate) return null;
  const cached = usage.cached_tokens || 0;
  const uncachedInput = Math.max(0, usage.input_tokens - cached);
  const cachedRate = rate.cached ?? rate.input; // fall back to full input rate if unset
  const inCost = (uncachedInput / 1_000_000) * rate.input + (cached / 1_000_000) * cachedRate;
  const outCost = (((usage.output_tokens || 0) + (usage.thoughts_tokens || 0)) / 1_000_000) * rate.output;
  return Number((inCost + outCost).toFixed(6));
}

/**
 * Structured-output call. Returns { parsed, usage, costUsd, model, connectionMode }.
 * usage is summed across attempts so cost logging (16.10) reflects real spend.
 *
 * `validate(parsed)` should return a falsy value when valid, or an error string
 * describing what's wrong. On an invalid result we retry once, feeding the error
 * back to the model; if it still fails we throw (16.8 — never persist malformed).
 *
 * `apiKey`, if supplied, is a per-user BYOK Gemini key (AI Studio/developer
 * mode) — used instead of the server's own env-configured client (aiRouter.js,
 * spec 13.3). Never cached across calls, unlike the CAI singleton client.
 */
// Transport-level failures (dropped/wedged HTTP/2 connection, DNS blip, the
// 5-minute undici headers timeout) are distinct from schema-validation
// failures below: they mean the call never got a response at all, so retrying
// with the *same* prompt is correct (nothing to correct), but retrying on the
// cached singleton client risks reusing the same wedged connection — so on a
// transport-error retry we drop the cache and force a fresh client/connection.
const TRANSPORT_ERROR_PATTERN = /fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|headers timeout/i;

function isTransportError(err) {
  if (err && err.name === 'AbortError') return true;
  const msg = String((err && err.message) || err);
  const causeMsg = err && err.cause ? String(err.cause.message || err.cause) : '';
  if (/aborted/i.test(msg) || /aborted/i.test(causeMsg)) return true;
  return TRANSPORT_ERROR_PATTERN.test(msg) || TRANSPORT_ERROR_PATTERN.test(causeMsg);
}

// Rate-limit/quota failures (added Session #26, spec §4.6.12) — distinct from
// both transport errors above and schema-validation failures below. Before
// this, a 429/RESOURCE_EXHAUSTED threw immediately with no retry at all: fine
// under the old fully-sequential scoring loop (one job at a time, naturally
// rate-limited by its own AI-call latency), but under a bounded scoring
// worker pool (atsDirectPipeline.js), several workers can trip a quota
// window within milliseconds of each other, and without a retry path every
// job in flight at that instant would fail and strand `prefiltered`. The
// underlying `@google/genai` SDK's `ApiError` (vertex_internal/index.js)
// carries the real HTTP status as `.status`; the JSON-stringified message
// also always carries `RESOURCE_EXHAUSTED` for a Gemini quota trip
// specifically, so both are checked in case a different SDK path (developer
// mode) surfaces the code differently. No `Retry-After` header is available
// on `ApiError` (it captures message + status only, not response headers),
// so this backs off exponentially with jitter rather than reading one.
const RATE_LIMIT_STATUS = 429;
const RATE_LIMIT_MESSAGE_PATTERN = /RESOURCE_EXHAUSTED|rate.?limit|quota exceeded/i;

function isRateLimitError(err) {
  if (err && Number(err.status) === RATE_LIMIT_STATUS) return true;
  const msg = String((err && err.message) || err);
  return RATE_LIMIT_MESSAGE_PATTERN.test(msg);
}

// `getCurrentClient` is called fresh on every attempt (not passed a fixed
// instance) so that nulling the module-level cache below is immediately
// visible here too — otherwise a later validation-retry in structuredCall
// could keep reusing the same stale client reference.
// Bounds each individual generateContent call so a wedged connection or a
// slow model response fails fast into the transport-retry path below instead
// of silently riding the SDK's own ~5-minute default (see comment above).
const CALL_TIMEOUT_MS = tunables.geminiCallTimeoutMs || 90000;

async function generateWithTransportRetry(getCurrentClient, apiKey, params, timeoutMs = CALL_TIMEOUT_MS) {
  const maxTransportAttempts = 3;
  const maxRateLimitAttempts = 5;
  let transportAttempt = 0;
  let rateLimitAttempt = 0;

  for (;;) {
    const startedAt = Date.now();
    try {
      const boundedParams = {
        ...params,
        config: { ...params.config, abortSignal: AbortSignal.timeout(timeoutMs) },
      };
      console.log(
        `[geminiAdapter] generateContent start model=${params.model} transportAttempt=${transportAttempt} rateLimitAttempt=${rateLimitAttempt} timeoutMs=${timeoutMs}`
      );
      const result = await getCurrentClient().models.generateContent(boundedParams);
      console.log(`[geminiAdapter] generateContent ok model=${params.model} elapsedMs=${Date.now() - startedAt}`);
      return result;
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      if (isRateLimitError(err)) {
        if (rateLimitAttempt >= maxRateLimitAttempts - 1) throw err;
        rateLimitAttempt += 1;
        // Exponential backoff + full jitter (2s, 4s, 8s, 16s base, each
        // randomized in [0, base]) — a quota window clears on its own on a
        // timescale of seconds, and jitter keeps several concurrently-backed-
        // off workers from all retrying in the same instant and re-tripping
        // the same window together.
        const base = 2000 * 2 ** (rateLimitAttempt - 1);
        const backoffMs = Math.random() * base;
        console.log(
          `[geminiAdapter] rate-limited model=${params.model} elapsedMs=${elapsedMs} retry=${rateLimitAttempt}/${maxRateLimitAttempts} backoffMs=${Math.round(backoffMs)}`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      if (isTransportError(err)) {
        if (transportAttempt >= maxTransportAttempts - 1) throw err;
        transportAttempt += 1;
        // Force a fresh client/connection before retrying — the cached
        // singleton's HTTP/2 connection is the likely culprit.
        if (!apiKey) { cachedClient = null; }
        console.log(
          `[geminiAdapter] transport error model=${params.model} elapsedMs=${elapsedMs} retry=${transportAttempt}/${maxTransportAttempts} error=${err.message}`
        );
        await new Promise((r) => setTimeout(r, 1000 * transportAttempt));
        continue;
      }
      console.log(`[geminiAdapter] generateContent failed model=${params.model} elapsedMs=${elapsedMs} error=${err.message}`);
      throw err;
    }
  }
}

async function structuredCall({ model, systemInstruction, prompt, responseSchema, validate, apiKey, timeoutMs }) {
  const getCurrentClient = apiKey ? () => new GoogleGenAI({ apiKey }) : getClient;
  const connectionMode = apiKey ? 'developer' : getConnectionMode();

  const usage = { input_tokens: 0, output_tokens: 0, thoughts_tokens: 0, cached_tokens: 0, total_tokens: 0, attempts: 0, raw: [] };
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const contents =
      attempt === 0
        ? prompt
        : `${prompt}\n\nYour previous response failed validation: ${lastError}\nReturn corrected JSON that exactly matches the required schema.`;

    const response = await generateWithTransportRetry(getCurrentClient, apiKey, {
      model,
      contents,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema,
        temperature: 0,
      },
    }, timeoutMs);

    const attemptUsage = normalizeUsage(response.usageMetadata);
    usage.input_tokens += attemptUsage.input_tokens;
    usage.output_tokens += attemptUsage.output_tokens;
    usage.thoughts_tokens += attemptUsage.thoughts_tokens;
    usage.cached_tokens += attemptUsage.cached_tokens;
    usage.total_tokens += attemptUsage.total_tokens;
    usage.attempts += 1;
    usage.raw.push(response.usageMetadata || null);

    let parsed;
    try {
      parsed = JSON.parse(response.text);
    } catch (err) {
      lastError = `output was not valid JSON (${err.message})`;
      continue;
    }

    const validationError = validate ? validate(parsed) : null;
    if (validationError) {
      lastError = validationError;
      continue;
    }

    return { parsed, usage, costUsd: computeCostUsd(model, usage), model, connectionMode };
  }

  throw Object.assign(
    new Error(`Gemini structured call failed schema validation after retry: ${lastError}`),
    { status: 502 }
  );
}

module.exports = { structuredCall, isConfigured, getConnectionMode, computeCostUsd };

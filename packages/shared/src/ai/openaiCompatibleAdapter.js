// OpenAI-compatible BYOK adapter (spec 2.0/13.3, Phase 2 session 14). Covers
// OpenAI itself plus any provider that mimics its Chat Completions schema
// (Together.ai, Groq, DeepSeek, Mistral, OpenRouter, local models via Ollama)
// — the only real variable across all of them is base_url. Matches
// geminiAdapter.js's structuredCall contract so every call site is
// adapter-agnostic (see aiRouter.js): same input shape (model/systemInstruction/
// prompt/responseSchema/validate) plus BYOK's own per-user apiKey/baseUrl, same
// output shape ({parsed, usage, costUsd, model, connectionMode}).
//
// costUsd is always null here — this is the user's own key, spending their own
// money against their own provider account, not ours to know or log as a real
// dollar figure. aiRouter.computeAiFeeCos still prices the COS fee off the
// real token counts this adapter reports, per spec 13.4's 10%-of-CAI-floored-
// at-1 rule.

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function normalizeUsage(u) {
  const usage = u || {};
  const cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    cached_tokens: cached,
    total_tokens: usage.total_tokens ?? 0,
  };
}

/**
 * Structured-output call against an OpenAI-compatible Chat Completions endpoint.
 * Returns { parsed, usage, costUsd: null, model, connectionMode: 'byok' }.
 * Same retry-on-invalid-output contract as geminiAdapter.structuredCall: one
 * retry, feeding the validation/parse error back to the model, then throw
 * (16.8 — never persist malformed output).
 */
async function structuredCall({ apiKey, baseUrl, model, systemInstruction, prompt, responseSchema, validate }) {
  if (!apiKey) throw new Error('openaiCompatibleAdapter: apiKey is required');
  if (!model) throw new Error('openaiCompatibleAdapter: model is required');
  const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;

  const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0, attempts: 0, raw: [] };
  let lastError = null;
  let userContent = prompt;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      userContent = `${prompt}\n\nYour previous response failed validation: ${lastError}\nReturn corrected JSON that exactly matches the required schema.`;
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userContent },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'result', schema: responseSchema, strict: true },
        },
      }),
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = (json.error && json.error.message) || `OpenAI-compatible API HTTP ${resp.status}`;
      throw Object.assign(new Error(msg), { status: resp.status });
    }

    const attemptUsage = normalizeUsage(json.usage);
    usage.input_tokens += attemptUsage.input_tokens;
    usage.output_tokens += attemptUsage.output_tokens;
    usage.cached_tokens += attemptUsage.cached_tokens;
    usage.total_tokens += attemptUsage.total_tokens;
    usage.attempts += 1;
    usage.raw.push(json.usage || null);

    const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      lastError = `output was not valid JSON (${err.message})`;
      continue;
    }

    const validationError = validate ? validate(parsed) : null;
    if (validationError) {
      lastError = validationError;
      continue;
    }

    return { parsed, usage, costUsd: null, model, connectionMode: 'byok' };
  }

  throw Object.assign(
    new Error(`OpenAI-compatible structured call failed schema validation after retry: ${lastError}`),
    { status: 502 }
  );
}

module.exports = { structuredCall, DEFAULT_BASE_URL };

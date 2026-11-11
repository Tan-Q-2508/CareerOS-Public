// Anthropic BYOK adapter (spec 2.0/13.3, Phase 2 session 14). The Messages API
// has no native JSON-mode — structured output is forced via tool use: one
// synthetic tool ("emit_result") whose input_schema IS the caller's
// responseSchema, plus tool_choice forcing that exact tool, so the model's only
// possible reply is a call to it. Anthropic parses the tool call's `input`
// against the schema itself, so there's no JSON.parse step (unlike Gemini/
// OpenAI, which return a JSON string to parse).
//
// Matches geminiAdapter.js's structuredCall contract (see aiRouter.js): same
// input shape plus BYOK's own apiKey/model, same output shape ({parsed, usage,
// costUsd, model, connectionMode}). costUsd is always null — this is the
// user's own key/spend, not ours to know (see openaiCompatibleAdapter.js for
// the same reasoning).

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;
const TOOL_NAME = 'emit_result';

function normalizeUsage(u) {
  const usage = u || {};
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cached_tokens: usage.cache_read_input_tokens ?? 0,
    total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  };
}

/**
 * Structured-output call against Anthropic's Messages API, forced through tool
 * use. Returns { parsed, usage, costUsd: null, model, connectionMode: 'byok' }.
 * Same retry-on-invalid-output contract as geminiAdapter.structuredCall.
 */
async function structuredCall({ apiKey, model, systemInstruction, prompt, responseSchema, validate, maxTokens }) {
  if (!apiKey) throw new Error('anthropicAdapter: apiKey is required');
  if (!model) throw new Error('anthropicAdapter: model is required');

  const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0, attempts: 0, raw: [] };
  let lastError = null;
  let userContent = prompt;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      userContent = `${prompt}\n\nYour previous response failed validation: ${lastError}\nCall ${TOOL_NAME} again with corrected input that exactly matches the required schema.`;
    }

    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
        temperature: 0,
        system: systemInstruction,
        tools: [{ name: TOOL_NAME, description: 'Emit the structured result.', input_schema: responseSchema }],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = (json.error && json.error.message) || `Anthropic API HTTP ${resp.status}`;
      throw Object.assign(new Error(msg), { status: resp.status });
    }

    const attemptUsage = normalizeUsage(json.usage);
    usage.input_tokens += attemptUsage.input_tokens;
    usage.output_tokens += attemptUsage.output_tokens;
    usage.cached_tokens += attemptUsage.cached_tokens;
    usage.total_tokens += attemptUsage.total_tokens;
    usage.attempts += 1;
    usage.raw.push(json.usage || null);

    const toolUse = (json.content || []).find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);
    if (!toolUse) {
      lastError = 'model did not call the required tool';
      continue;
    }
    const parsed = toolUse.input;

    const validationError = validate ? validate(parsed) : null;
    if (validationError) {
      lastError = validationError;
      continue;
    }

    return { parsed, usage, costUsd: null, model, connectionMode: 'byok' };
  }

  throw Object.assign(
    new Error(`Anthropic structured call failed schema validation after retry: ${lastError}`),
    { status: 502 }
  );
}

module.exports = { structuredCall };

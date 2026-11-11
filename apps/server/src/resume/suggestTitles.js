const aiRouter = require('../lib/aiRouter');

// Resume-suggested scan titles (4.6.15, button-triggered from NewScanModal).
// Cheap-tier structured call, same template as email/classifyEmails.js and
// resume/parseResume.js: fixed schema, a grounding-flavored system
// instruction, light output validation. Free action (§16.10's precedent,
// same as resume_parse) — the route logs to ai_usage_log only, no
// cos_transactions row, since this only ever fires on an explicit button
// press and returns no billable content of its own.

const SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    titles: { type: 'array', items: { type: 'string' } },
  },
  required: ['titles'],
};

const SYSTEM_INSTRUCTION = [
  'You suggest job-search titles for a job-search tool, based on ONE candidate\'s resume.',
  'You are given their past role titles and declared skills.',
  'Return 8-12 job titles this person could realistically search for RIGHT NOW, in the SAME seniority range evidenced by their most recent/senior roles — never a level up or down from what their experience actually supports.',
  'Include the exact titles they have actually held, PLUS natural close variants and synonyms a recruiter or job board might use for the same role (e.g. "Product Manager" -> also "Manager, Product", "Technical Product Manager" if their skills support it) — this widens what a company-board search will match, since job boards phrase the same role differently company to company.',
  'Ground every suggestion in the resume content below — do not invent a job family with no support in their actual roles/skills. This is a search-term suggestion, not a resume claim, but it should still be a title a hiring manager would recognize as a fair characterization of this person\'s background.',
  'Return strict JSON: { "titles": [...] }, deduplicated, ordered most-relevant first.',
].join('\n');

function profileBlock(parsedProfile) {
  const roles = (parsedProfile.roles || []).map(
    (r) => `- ${r.title || '(untitled)'} at ${r.company || '(unknown)'} (${r.dates?.start || '?'} - ${r.dates?.end || '?'})`
  );
  const skills = (parsedProfile.skills_declared || []).join(', ');
  return ['PAST ROLES:', roles.length ? roles.join('\n') : '(none listed)', '', `DECLARED SKILLS: ${skills || '(none listed)'}`].join(
    '\n'
  );
}

function validateSuggestions(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.titles)) return 'titles must be an array';
  if (!p.titles.length) return 'titles must not be empty';
  for (const t of p.titles) {
    if (typeof t !== 'string' || !t.trim()) return 'each title must be a non-empty string';
  }
  return null;
}

/**
 * @param {{parsedProfile: object, credential: object}} input
 * @returns {Promise<{titles: string[], usage, costUsd, model, connectionMode}>}
 */
async function suggestTitlesFromResume({ parsedProfile, credential }) {
  const prompt = profileBlock(parsedProfile || {});
  const result = await aiRouter.structuredCall(credential, {
    tier: 'cheap',
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt,
    responseSchema: SUGGEST_SCHEMA,
    validate: validateSuggestions,
  });

  // Defensive trim/dedupe even though the prompt already asks for it — model
  // output isn't a hard contract, same posture as every other structuredCall
  // consumer in this codebase.
  const seen = new Set();
  const titles = [];
  for (const raw of result.parsed.titles) {
    const t = String(raw || '').trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    titles.push(t);
  }

  return {
    titles,
    usage: result.usage,
    costUsd: result.costUsd,
    model: result.model,
    connectionMode: result.connectionMode,
  };
}

module.exports = { suggestTitlesFromResume, SUGGEST_SCHEMA, validateSuggestions };

const { humanizer } = require('@careeros/shared');
const aiRouter = require('../lib/aiRouter');

// Custom application Q&A (spec 8.6) — modeled closely on draftCoverLetter.js's
// runDraft: strong tier, structured JSON, the exact same grounding/
// no-fabrication instruction pattern (CLAUDE.md non-negotiable — every claim
// traces to the real master résumé or a confirmed skill). Unlike a cover
// letter this produces plain text, synchronously, with no measured-checks
// repair loop — one draft, one answer.

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
  },
  required: ['answer'],
};

function systemInstruction() {
  return [
    'You answer a custom job-application question on behalf of a candidate, for a specific job, in their voice, as they would submit it in an application form.',
    'Rules:',
    '- Ground everything in the candidate’s real résumé (provided) and their confirmed skills. Never invent experience, tools, employers, or metrics.',
    '- If the question asks about the target company or role specifically (e.g. "why do you want to work here"), reference concrete details from the job description provided — never invent facts about the company you were not given.',
    '- Write in first person, as the candidate.',
    '- Be specific and concrete rather than generic — reference real accomplishments and skills from the résumé where they genuinely answer the question; do not pad with filler.',
    '- Target roughly 3-6 sentences (80-180 words) unless the question clearly calls for more.',
    '- Plain prose only — no markdown, no bullet points, no headers, no asterisks.',
    'Return strict JSON matching the schema.',
    ...(humanizer.isEnabled() ? [humanizer.humanizerInstruction('answer')] : []),
  ].join('\n');
}

function serializeProfile(profile) {
  return {
    roles: (profile.roles || []).map((r) => ({ title: r.title, company: r.company, bullets: (r.bullets || []).map((b) => b.text) })),
    projects: (profile.projects || []).map((p) => ({ title: p.title, bullets: (p.bullets || []).map((b) => b.text) })),
    skills_declared: profile.skills_declared || [],
    certifications: profile.certifications || [],
  };
}

// Hard validation: the answer must be a real, non-empty string. Grounding
// itself isn't machine-checkable the way a banned-phrase scan is (that's what
// the system instruction + the résumé-only context window are for), matching
// how draftCoverLetter.js's makeValidate() treats keyword grounding as
// cosmetic, not a hard gate.
function makeValidate() {
  return function validate(p) {
    if (!p || typeof p !== 'object') return 'root is not an object';
    if (typeof p.answer !== 'string' || !p.answer.trim()) return 'answer must be a non-empty string';
    return null;
  };
}

/**
 * Draft an answer to one application question.
 * @returns { answer, usage, costUsd, model, connectionMode, tier }
 */
async function runDraft({ profile, jobContext, question, confirmedSkills = [], confirmedContext = [], credential }) {
  const notes = (confirmedContext || [])
    .filter((c) => c && c.term && c.context)
    .map((c) => `- ${c.term}: ${c.context}`);
  const parts = [
    'CANDIDATE RÉSUMÉ (source of truth — every claim must trace here):',
    JSON.stringify(serializeProfile(profile)),
    '\n---\n',
    'TARGET JOB:',
    JSON.stringify({ title: jobContext.title, company: jobContext.company, jd_profile: jobContext.jdProfile }),
    '\n---\n',
    'SCORING ANALYSIS (what is genuinely the candidate’s, grounded — adopt transferable "reword_to" phrasing):',
    JSON.stringify(jobContext.tiered || {}),
    '\n---\n',
    `CONFIRMED SKILLS the candidate verified they genuinely used (use exact JD spelling): ${confirmedSkills.join(', ') || '(none yet)'}`,
  ];
  if (notes.length) parts.push('\n---\n', 'CONFIRMED-SKILL EXPLANATIONS (the candidate’s own notes — ground claims in these):', notes.join('\n'));
  parts.push('\n---\n', 'APPLICATION QUESTION TO ANSWER:', question);

  const result = await aiRouter.structuredCall(credential, {
    tier: 'strong',
    systemInstruction: systemInstruction(),
    prompt: parts.join('\n'),
    responseSchema: ANSWER_SCHEMA,
    // Humanizer (spec 8.7): one corrective retry on AI tells, then dashes and
    // curly quotes are fixed in code.
    validate: humanizer.isEnabled()
      ? humanizer.nudgeOnce(makeValidate(), (p) => [p.answer], { allow: humanizer.jdAllowList(jobContext), where: 'the answer' })
      : makeValidate(),
  });
  const answer = result.parsed.answer.trim();
  return {
    answer: humanizer.isEnabled() ? humanizer.scrubTells(answer) : answer,
    usage: result.usage,
    costUsd: result.costUsd,
    model: result.model,
    connectionMode: result.connectionMode,
    tier: 'strong',
  };
}

module.exports = { runDraft, makeValidate, ANSWER_SCHEMA };

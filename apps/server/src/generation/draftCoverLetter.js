const { tunables, humanizer } = require('@careeros/shared');
const aiRouter = require('../lib/aiRouter');
const { bannedPhraseHits } = require('./coverLetterChecks');

// Step 1 of the 8.5 pipeline (identical mechanism to 7.12): the AI drafts the
// cover letter body as data — exactly 4 paragraphs. The letter scaffolding
// (contact/date/recipient/subject/greeting/closing) is added deterministically
// in the renderer. Strong tier (gemini-2.5-pro). Every claim traces to the
// résumé (8.4, no fabrication); banned generic phrases (8.3) are rejected at
// validation for an immediate retry.
//
// The draft used to carry a `bold_keywords` list, which the renderer bolded
// inside the body. That was 8.4's rule until it was removed on sign-off: the
// letter still works the JD's exact terminology into the prose (where the ATS
// value is — see the TERMINOLOGY rule below), it just no longer emphasises it
// visually. This also makes the two documents agree, since §7 has always
// forbidden bold keyword highlighting inside résumé bullets.

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    paragraphs: { type: 'array', items: { type: 'string' } },
  },
  required: ['paragraphs'],
};

function systemInstruction() {
  const banned = tunables.coverLetter.bannedPhrases.map((p) => `"${p}"`).join(', ');
  return [
    'You write the BODY of a cover letter tailored to a specific job. Output structured data, not a formatted letter — the contact block, date, recipient, subject line, greeting and sign-off are added later.',
    'Rules (LOCKED, spec Section 8):',
    '- Exactly 4 body paragraphs, 300-350 words TOTAL across them.',
    '- Tone: confident and direct, minimal warmth. No fluff.',
    '- Paragraph 1 MUST open with a specific hook that references exact terminology from the job description (a named required skill or responsibility) — not a generic opener.',
    '- Ground everything in the candidate’s real résumé (provided). Never invent experience, tools, employers, or metrics.',
    '- TERMINOLOGY: when you reference a skill the candidate genuinely has that the JD names, use the JD’s EXACT wording for it (adopt any transferable "reword_to" phrasing) — this keeps the letter aligned with the résumé and the JD.',
    '- Suggested arc: (1) hook + why this role/company specifically; (2) and (3) concrete achievements from the résumé mapped to the JD’s needs; (4) a brief, confident close.',
    `- STRICTLY AVOID these generic AI-cover-letter phrases or close paraphrases of them: ${banned}.`,
    '- Write the paragraph text as PLAIN prose. Do NOT use markdown, asterisks or underscores, and do NOT emphasise anything — the letter body carries no bold or italic text at all.',
    'Return strict JSON matching the schema.',
    ...(humanizer.isEnabled() ? [humanizer.humanizerInstruction('coverLetter')] : []),
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

// Hard validation (retried by structuredCall): the things that must be right —
// 4 non-empty paragraphs, no banned generic phrases (8.3).
function makeValidate() {
  return function validate(p) {
    if (!p || typeof p !== 'object') return 'root is not an object';
    if (!Array.isArray(p.paragraphs) || p.paragraphs.length !== 4) return 'paragraphs must be an array of exactly 4 strings';
    for (const [i, para] of p.paragraphs.entries()) {
      if (typeof para !== 'string' || !para.trim()) return `paragraphs[${i}] must be a non-empty string`;
    }
    const hits = bannedPhraseHits(p.paragraphs.join(' '));
    if (hits.length) return `remove the banned generic phrase(s): ${hits.join(', ')}`;
    return null;
  };
}

/**
 * Draft (or repair-redraft) the cover letter body.
 * @returns { draft:{paragraphs}, usage, costUsd, model, connectionMode }
 */
async function runDraft({ profile, jobContext, confirmedSkills = [], confirmedContext = [], repairInstructions = null, credential }) {
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
  if (repairInstructions) parts.push('\n---\n', 'REVISION REQUIRED — return the FULL corrected letter body applying exactly these fixes:', repairInstructions);

  const result = await aiRouter.structuredCall(credential, {
    tier: 'strong',
    systemInstruction: systemInstruction(),
    prompt: parts.join('\n'),
    responseSchema: DRAFT_SCHEMA,
    // Humanizer (spec 8.7): one corrective retry on AI tells, then dashes and
    // curly quotes are fixed in code.
    validate: humanizer.isEnabled()
      ? humanizer.nudgeOnce(makeValidate(), (p) => p.paragraphs, { allow: humanizer.jdAllowList(jobContext), where: 'the letter' })
      : makeValidate(),
  });
  if (humanizer.isEnabled()) result.parsed.paragraphs = result.parsed.paragraphs.map(humanizer.scrubTells);
  return {
    draft: result.parsed,
    usage: result.usage,
    costUsd: result.costUsd,
    model: result.model,
    connectionMode: result.connectionMode,
    tier: 'strong',
  };
}

module.exports = { runDraft, makeValidate, DRAFT_SCHEMA };

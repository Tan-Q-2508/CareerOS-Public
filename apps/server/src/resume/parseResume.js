const mammoth = require('mammoth');
const aiRouter = require('../lib/aiRouter');

// Structured resume profile — the spec 16.2 schema, expressed as a Gemini
// responseSchema. Bullet `id`s are omitted here and assigned deterministically
// in code after parsing (stable r{role}b{bullet} ids, not model-generated).
const BULLET_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    skills_demonstrated: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'skills_demonstrated'],
};

const RESUME_PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    roles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          company: { type: 'string' },
          location: { type: 'string' },
          dates: {
            type: 'object',
            properties: {
              start: { type: 'string' },
              end: { type: 'string' },
            },
            required: ['start', 'end'],
          },
          bullets: { type: 'array', items: BULLET_SCHEMA },
        },
        required: ['title', 'company', 'bullets'],
      },
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          dates: {
            type: 'object',
            properties: {
              start: { type: 'string' },
              end: { type: 'string' },
            },
            required: ['start', 'end'],
          },
          bullets: { type: 'array', items: BULLET_SCHEMA },
        },
        required: ['title', 'bullets'],
      },
    },
    education: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          degree: { type: 'string' },
          field: { type: 'string' },
          institution: { type: 'string' },
          location: { type: 'string' },
          dates: {
            type: 'object',
            properties: {
              start: { type: 'string' },
              end: { type: 'string' },
            },
            required: ['start', 'end'],
          },
        },
        required: ['institution'],
      },
    },
    skills_declared: { type: 'array', items: { type: 'string' } },
    certifications: { type: 'array', items: { type: 'string' } },
  },
  required: ['roles', 'projects', 'education', 'skills_declared', 'certifications'],
};

const SYSTEM_INSTRUCTION = [
  'You extract a resume into a strict structured profile for a job-matching system.',
  'Rules:',
  '- Use ONLY information present in the resume text. Never invent roles, bullets, skills, dates, or education.',
  '- Preserve the exact wording of each bullet and job title as written.',
  '- dates.start / dates.end use "YYYY-MM"; use "present" for a current role\'s end. Capture dates for ROLES, PROJECTS, and EDUCATION whenever the resume shows them (e.g. graduation/attendance ranges, project timeframes). If a line reads "Month Year – Month Year" or "Month Year – Present", you MUST populate BOTH dates.start AND dates.end — never emit start and silently leave end blank when the resume states it. Only use an empty string for a date you truly cannot find in the text.',
  '- education.degree = the degree TYPE only (e.g. "Master of Science", "Bachelor of Technology"). education.field = the major/specialization only (e.g. "Engineering Management"). Do NOT repeat the field inside degree — they render together, so duplication produces "Master of Science, Engineering Management, Engineering Management".',
  '- location on a ROLE or an EDUCATION entry = the city/state (or city/country) where that job or school was, exactly as the resume states it (e.g. "San Jose, CA"). Omit it entirely if the resume does not state a location for that entry — never invent or guess one.',
  "- skills_demonstrated on a bullet lists ONLY skills that bullet's own text genuinely evidences (tools, technologies, methods, competencies actually shown). If a bullet demonstrates no clear skill, return an empty list — do not pad it.",
  '- skills_declared is the skills the resume explicitly lists in a skills/summary section (distinct from per-bullet demonstrated skills).',
  '- Return every required field; use empty arrays when a section is absent.',
].join('\n');

function validateProfile(p) {
  if (!p || typeof p !== 'object') return 'root is not an object';
  for (const key of ['roles', 'projects', 'education', 'skills_declared', 'certifications']) {
    if (!Array.isArray(p[key])) return `"${key}" must be an array`;
  }
  for (const [i, role] of p.roles.entries()) {
    if (typeof role.title !== 'string') return `roles[${i}].title must be a string`;
    if (!Array.isArray(role.bullets)) return `roles[${i}].bullets must be an array`;
    for (const [j, b] of role.bullets.entries()) {
      if (typeof b.text !== 'string') return `roles[${i}].bullets[${j}].text must be a string`;
      if (!Array.isArray(b.skills_demonstrated)) {
        return `roles[${i}].bullets[${j}].skills_demonstrated must be an array`;
      }
    }
  }
  return null;
}

// Deterministic, stable bullet ids so scoring's grounding rule (5.6) can cite a
// specific bullet by id rather than trusting a model-generated one.
function assignBulletIds(profile) {
  (profile.roles || []).forEach((role, i) => {
    (role.bullets || []).forEach((b, j) => {
      b.id = `r${i}b${j}`;
    });
  });
  (profile.projects || []).forEach((proj, i) => {
    (proj.bullets || []).forEach((b, j) => {
      b.id = `p${i}b${j}`;
    });
  });
  return profile;
}

/**
 * Parse a .docx resume buffer into the structured profile (16.2).
 * Returns { parsedProfile, usage, costUsd, model, connectionMode }.
 * Throws if the docx has no extractable text or the AI output fails validation.
 */
async function parseResume(buffer, credential) {
  const { value: text } = await mammoth.extractRawText({ buffer });
  if (!text || !text.trim()) {
    throw Object.assign(new Error('Could not extract any text from the .docx'), { status: 422 });
  }

  const startedAt = Date.now();
  console.log(`[parseResume] starting AI parse, extracted ${text.length} chars`);
  let result;
  try {
    result = await aiRouter.structuredCall(credential, {
      tier: 'parse',
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt: `Resume text:\n\n${text}`,
      responseSchema: RESUME_PROFILE_SCHEMA,
      validate: validateProfile,
    });
  } catch (err) {
    console.log(`[parseResume] AI parse failed after ${Date.now() - startedAt}ms: ${err.message}`);
    throw err;
  }
  console.log(`[parseResume] AI parse succeeded in ${Date.now() - startedAt}ms, attempts=${result.usage?.attempts}`);

  return {
    parsedProfile: assignBulletIds(result.parsed),
    // Raw mammoth-extracted text, returned so the caller can ground the
    // parsed skills against it (keywordPipeline.groundResumeProfile,
    // 2026-08-13 root-cause pass) — parsing has always been AI-only with no
    // code-level check that an extracted skill genuinely appears in the
    // résumé; this is what makes that check possible without re-downloading
    // or re-parsing the file a second time.
    resumeText: text,
    usage: result.usage,
    costUsd: result.costUsd,
    model: result.model,
    connectionMode: result.connectionMode,
  };
}

module.exports = { parseResume, RESUME_PROFILE_SCHEMA };

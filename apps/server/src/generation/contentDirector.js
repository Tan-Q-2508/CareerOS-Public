const aiRouter = require('../lib/aiRouter');

// Content Director (spec 7.5/7.8/7.14): a cheap AI pass that DECIDES which
// roles and projects appear (not their wording) — depth over breadth, gap
// reasoning against the whole timeline, current/full-time roles protected.
// Ranks every included role AND project together on one relevance scale (a
// project is not second-class — a strong-fit project can outrank a mediocre
// job) and assigns each included entry an explicit bullet_target of 2/3/4:
// the single most relevant entry gets 4, at least half get 3, the rest get 2
// — so bullet depth reflects relevance instead of a flat range.

function monthsBetween(d) {
  if (!d || !d.start) return null;
  const p = (s) => {
    const m = String(s).match(/(\d{4})-(\d{1,2})/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const s = p(d.start);
  if (!s) return null;
  let e;
  if (!d.end || /present|current/i.test(String(d.end))) {
    const n = new Date();
    e = [n.getFullYear(), n.getMonth() + 1];
  } else e = p(d.end);
  if (!e) return null;
  return (e[0] - s[0]) * 12 + (e[1] - s[1]);
}
const isOngoing = (d) => !d || !d.end || /present|current/i.test(String(d.end));

// 7.5: the ONLY role that may be left off is a finished internship of 3 months
// or less. Everything else (the current role, any full-time role, any role
// longer than 3 months, a role whose dates can't be read) is shown, because a
// missing real role reads as a gap or as less experience than the candidate
// has. This is a hard rule in code, not a judgment handed to the Director.
const SHORT_INTERNSHIP_MAX_MONTHS = 3;
function isDroppableRole(role) {
  const r = role || {};
  const months = monthsBetween(r.dates);
  return !isOngoing(r.dates) && months != null && months <= SHORT_INTERNSHIP_MAX_MONTHS && /intern/i.test(r.title || '');
}
function mandatoryRoleIndices(profile) {
  return ((profile && profile.roles) || []).map((r, i) => (isDroppableRole(r) ? -1 : i)).filter((i) => i >= 0);
}

const ENTRY = {
  type: 'object',
  properties: { index: { type: 'number' }, bullet_target: { type: 'number' } },
  required: ['index', 'bullet_target'],
};
const DIRECTOR_SCHEMA = {
  type: 'object',
  properties: {
    include_roles: { type: 'array', items: ENTRY },
    include_projects: { type: 'array', items: ENTRY },
    reasoning: { type: 'string' },
  },
  required: ['include_roles', 'include_projects', 'reasoning'],
};

// The mandatory-role check runs on the FIRST attempt only, so the Director
// ranks those roles itself; a retry that still omits one is accepted and the
// safety net in runDraftPhase adds it (structuredCall fails the whole call
// after one retry, and a missing role must never fail a generation).
function makeValidate(mandatory = []) {
  let calls = 0;
  return function validate(p) {
    calls += 1;
    if (!p || typeof p !== 'object') return 'root is not an object';
    if (calls === 1 && Array.isArray(p.include_roles)) {
      const got = new Set(p.include_roles.map((e) => e && e.index));
      const missing = mandatory.filter((i) => !got.has(i));
      if (missing.length) return `include_roles is missing role index ${missing.join(', ')}; every role marked ALWAYS SHOWN must be included with a bullet_target`;
    }
    for (const key of ['include_roles', 'include_projects']) {
      if (!Array.isArray(p[key])) return `${key} must be an array`;
      for (const e of p[key]) {
        if (typeof e.index !== 'number' || e.index < 0 || !Number.isInteger(e.index)) return `${key} entries need a real non-negative integer index (got ${JSON.stringify(e.index)}) — cite an actual role/project index from the input, never invent one`;
        if (![2, 3, 4].includes(e.bullet_target)) return `${key} index ${e.index}: bullet_target must be 2, 3, or 4 (got ${e.bullet_target})`;
      }
    }
    const all = [...p.include_roles, ...p.include_projects];
    if (all.length >= 2) {
      const fours = all.filter((e) => e.bullet_target === 4).length;
      if (fours > 1) return 'only ONE entry (the single most relevant) may have bullet_target 4';
      const threesPlus = all.filter((e) => e.bullet_target >= 3).length;
      if (threesPlus < Math.ceil(all.length / 2)) return 'at least half of all included roles+projects must have bullet_target >= 3';
    }
    return null;
  };
}

async function runDirector({ profile, jobContext, confirmedContext = [], credential }) {
  const roles = (profile.roles || []).map((r, i) => ({
    index: i, title: r.title, company: r.company,
    start: r.dates && r.dates.start, end: (r.dates && r.dates.end) || 'present',
    months: monthsBetween(r.dates), ongoing: isOngoing(r.dates),
    always_shown: !isDroppableRole(r),
  }));
  const mandatory = mandatoryRoleIndices(profile);
  const projects = (profile.projects || []).map((p, i) => ({ index: i, title: p.title, start: p.dates && p.dates.start, end: p.dates && p.dates.end }));
  const education = (profile.education || []).map((e) => ({ degree: e.degree, start: e.dates && e.dates.start, end: e.dates && e.dates.end }));
  const jd = jobContext.jdProfile || {};
  const totalMonths = roles.reduce((a, r) => a + (r.months || 0), 0);
  const years = (totalMonths / 12).toFixed(1);

  const sys = [
    'You are the CONTENT DIRECTOR for a one-page résumé. You decide which work roles and projects best represent THIS candidate for THIS job — using judgment, not a formula.',
    `Context: this candidate has about ${years} years of total experience.`,
    '',
    'WORK EXPERIENCE IS FIXED BY RULE, NOT BY YOU. Every role marked always_shown: true MUST be in include_roles: the current role, every full-time role, and every role longer than 3 months, internships included. A real role left off reads to a recruiter as a gap or as less experience than the candidate has, and a 4-9 month internship is substantial experience for an early-career candidate. Your judgment on these roles is ONLY their bullet_target (depth), never whether they appear.',
    'The only roles you may leave out are always_shown: false ones: finished internships of 3 months or less. Include one when it is relevant to the target job; leave it out when it is not. A later step adds it back automatically if the page still has room.',
    '',
    'PROJECTS ARE WHERE YOU CHOOSE. A one-page résumé holds about 18-22 bullet lines across Work Experience + Projects. Fit the projects into what the required roles leave: usually 1-2 projects, the most relevant first. Every included entry needs at least 2 real bullets, so do not include a project you would give fewer. Leftover room is filled automatically afterwards from unused bullets and entries, so err slightly toward FEWER projects rather than more.',
    '',
    'GAPS: judge continuity against the merged timeline of roles + EDUCATION + PROJECTS. A month is "covered" if any role, education period, or project overlaps it.',
    '',
    'Projects are NOT second-class: judge them on the SAME relevance scale as roles. A project that maps tightly onto the target job\'s domain can and should outrank a mediocre-fit job for depth. Order projects newest-first among themselves.',
    '',
    'BULLET DEPTH PER ENTRY (bullet_target): rank every role AND project you decide to include TOGETHER on one relevance scale (to the target job), then assign each included entry a bullet_target of 2, 3, or 4:',
    '- The SINGLE most relevant entry overall — could be a role OR a project — gets bullet_target 4. Only one entry gets 4.',
    '- At least HALF of all included entries (roles + projects combined) get bullet_target 3.',
    '- The least relevant entries get bullet_target 2 — that is fine and expected; a weaker entry carrying only 2 bullets is honest, not a failure.',
    '',
    'Return include_roles and include_projects as arrays of { index, bullet_target } (roles newest-first, projects newest-first), plus one paragraph of reasoning that states: which projects you chose and why, which single entry got the 4-bullet slot and why, and for any short internship you left out, why it was less relevant.',
  ].join('\n');

  // The bullet_target you assign here is a HARD ceiling the draft stage cannot
  // exceed later — so an entry that will need to carry one of these confirmed
  // explanations needs enough room decided NOW, not after the fact (2026-07-27
  // fix: previously the Director had no visibility into confirmed_skills at
  // all, so it could lock a 2-bullet budget onto the exact entry a confirmed
  // explanation belongs to, leaving the draft stage no room to include it no
  // matter how strongly it was told to).
  // entry_ref (2026-08-05 fix): when the user explicitly picked which
  // role/project an explanation belongs to (GapCheckModal's Explain picker),
  // state that directly instead of asking the model to infer it — inference
  // could (and per a reported bug, did) land on the wrong, unrelated entry.
  // Falls back to the old inference wording for older/unpicked confirmations.
  const describeEntryRef = (ref) => {
    const m = /^(role|project):(\d+)$/.exec(ref || '');
    if (!m) return null;
    return `${m[1]}_index ${m[2]}`;
  };
  const confirmedLine = confirmedContext.length
    ? `\n\nCONFIRMED SKILLS WITH REAL CONTEXT (the candidate explained exactly how they used these; that entry needs bullet_target 3 or 4, not 2, so there's room to actually include it):\n${confirmedContext
        .map((c) => {
          const entryDesc = describeEntryRef(c.entryRef);
          return entryDesc
            ? `- ${c.term}: "${c.context}" — the candidate specified this belongs to ${entryDesc}; use that entry, do not guess a different one.`
            : `- ${c.term}: "${c.context}" — read this and identify which role/project it clearly belongs to.`;
        })
        .join('\n')}`
    : '';

  const timeline = [
    ...roles.map((r) => ({ start: r.start, end: r.end, kind: /intern/i.test(r.title) ? 'INTERNSHIP' : 'FULL-TIME', label: `${r.title} @ ${r.company}` })),
    ...education.map((e) => ({ start: e.start, end: e.end, kind: 'EDUCATION', label: e.degree })),
    ...projects.map((p) => ({ start: p.start, end: p.end, kind: 'PROJECT', label: p.title })),
  ]
    .filter((x) => x.start)
    .sort((a, b) => String(b.start).localeCompare(String(a.start)))
    .map((x) => `  ${x.start} → ${x.end || 'present'}  [${x.kind}]  ${x.label}`)
    .join('\n');

  const prompt = `MERGED TIMELINE (newest first — use this to check month-by-month coverage for gap reasoning):\n${timeline}\n\nROLES (by index):\n${JSON.stringify(roles)}\n\nPROJECTS (by index):\n${JSON.stringify(projects)}\n\nEDUCATION:\n${JSON.stringify(education)}\n\nTARGET JOB: ${jobContext.title} @ ${jobContext.company}\nREQUIRED SKILLS: ${(jd.required_skills || []).join(', ')}\nNICE-TO-HAVE: ${(jd.nice_to_have_skills || []).join(', ')}${confirmedLine}`;

  const res = await aiRouter.structuredCall(credential, { tier: 'cheap', systemInstruction: sys, prompt, responseSchema: DIRECTOR_SCHEMA, validate: makeValidate(mandatory) });
  return { director: res.parsed, usage: res.usage, costUsd: res.costUsd, model: res.model, connectionMode: res.connectionMode, tier: 'cheap' };
}

module.exports = { runDirector, monthsBetween, isOngoing, isDroppableRole, mandatoryRoleIndices, makeValidate };

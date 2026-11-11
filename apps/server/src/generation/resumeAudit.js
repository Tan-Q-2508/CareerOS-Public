const { humanizer } = require('@careeros/shared');
const { monthsBetween, isOngoing } = require('./contentDirector');

// Deterministic résumé audit modelled on what the public résumé checkers
// grade (Resume Worded's Impact / Brevity / Style / Sections groups, Rezi's
// content audits) plus the CareerOS-specific timeline rule from 7.5. Pure: it
// reads an assembled model (generateResume's asm.model) and the master
// profile, never calls AI. Used by scripts/resume-batch-audit.js to compare
// generation changes across a batch of real jobs.

const WEAK_OPENERS = new Set(['assisted', 'helped', 'worked', 'responsible', 'participated', 'handled', 'involved', 'tasked', 'supported', 'aided', 'did', 'made', 'was', 'were']);
const PRONOUN_RE = /\b(I|me|my|mine|we|our|us)\b/;
const PASSIVE_RE = /\b(was|were|been|being|is|are)\s+[a-z]+ed\b/i;

const opener = (l) => (String(l).match(/^[A-Za-z][A-Za-z-]*/) || [''])[0].toLowerCase();

function wordsOf(model) {
  const parts = [
    model.professionalTitle,
    ...(model.summary || []),
    ...(model.experience || []).flatMap((r) => [r.title, r.company, ...(r.bullets || [])]),
    ...(model.projects || []).flatMap((p) => [p.title, ...(p.bullets || [])]),
    ...(model.education || []).flatMap((e) => [e.degreeField, e.institution]),
    ...(model.skills || []).flatMap((s) => [s.label, ...(s.items || [])]),
  ];
  return parts.filter(Boolean).join(' ').split(/\s+/).filter(Boolean).length;
}

// Three-word phrases that recur across bullets ("cross-functional teams to").
function repeatedPhrases(lines, minCount = 3) {
  const stop = new Set(['and', 'the', 'to', 'of', 'a', 'in', 'for', 'on', 'with', 'by', 'across', 'from', 'at', 'an']);
  const counts = new Map();
  for (const l of lines) {
    const w = String(l).toLowerCase().replace(/[^a-z0-9%+ -]/g, ' ').split(/\s+/).filter(Boolean);
    const seen = new Set();
    for (let i = 0; i + 2 < w.length; i++) {
      const tri = w.slice(i, i + 3);
      if (tri.filter((t) => stop.has(t)).length > 1) continue;
      const k = tri.join(' ');
      if (seen.has(k)) continue;
      seen.add(k);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n >= minCount).map(([phrase, count]) => ({ phrase, count }));
}

/**
 * @param model    assembled résumé model (asm.model)
 * @param profile  master parsed_profile
 * @param opts     { fillFraction, roleIndices } — roleIndices: master role
 *                 indices that appear in the model (from the generator's
 *                 selection); when absent, roles are matched by title+company.
 */
function auditResume(model, profile, { fillFraction = null, roleIndices = null } = {}) {
  const roles = profile.roles || [];
  const shown = roleIndices
    ? new Set(roleIndices)
    : new Set(roles.map((r, i) => ((model.experience || []).some((e) => e.title === r.title || (e.company || '').startsWith(r.company || '\u0000')) ? i : -1)).filter((i) => i >= 0));
  const dropped = roles.map((r, i) => ({ i, r })).filter(({ i }) => !shown.has(i)).map(({ i, r }) => ({
    index: i, title: r.title, company: r.company, months: monthsBetween(r.dates), ongoing: isOngoing(r.dates),
  }));
  const droppedOver3 = dropped.filter((d) => d.ongoing || d.months == null || d.months > 3);

  const bullets = [...(model.experience || []).flatMap((r) => r.bullets || []), ...(model.projects || []).flatMap((p) => p.bullets || [])];
  const allLines = [...(model.summary || []), ...bullets];
  const openers = new Map();
  for (const l of bullets) { const w = opener(l); if (w) openers.set(w, (openers.get(w) || 0) + 1); }
  const repeatedVerbs = [...openers.entries()].filter(([, n]) => n > 2).map(([verb, count]) => ({ verb, count }));
  const weak = bullets.filter((l) => WEAK_OPENERS.has(opener(l)));
  const quantified = bullets.filter((l) => /\d/.test(l));
  const tells = allLines.flatMap((l) => humanizer.aiTellHits(l));
  const pronouns = allLines.filter((l) => PRONOUN_RE.test(l));
  const passive = bullets.filter((l) => PASSIVE_RE.test(l));
  const words = wordsOf(model);

  return {
    rolesShown: shown.size,
    rolesInMaster: roles.length,
    droppedRoles: dropped,
    droppedOver3Months: droppedOver3,
    projectsShown: (model.projects || []).length,
    bulletsPerRole: (model.experience || []).map((r) => (r.bullets || []).length),
    bulletsPerProject: (model.projects || []).map((p) => (p.bullets || []).length),
    totalBullets: bullets.length,
    fillFraction,
    words,
    repeatedVerbs,
    repeatedPhrases: repeatedPhrases(bullets),
    weakOpeners: weak,
    quantifiedRatio: bullets.length ? Number((quantified.length / bullets.length).toFixed(2)) : 0,
    aiTells: tells.map((h) => h.match),
    pronounLines: pronouns,
    passiveLines: passive,
  };
}

module.exports = { auditResume, repeatedPhrases, WEAK_OPENERS };

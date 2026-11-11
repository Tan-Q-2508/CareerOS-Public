const { tunables } = require('@careeros/shared');

// Derive pre-filter inputs from the parsed resume profile (16.2) — the
// auto-derive half of the hybrid approach (spec 4.3 inputs). Values are only
// used to seed users.* when those columns are null; a manual override wins.

function parseYm(s, now) {
  if (!s) return null;
  if (/present|current/i.test(s)) return now.getFullYear() * 12 + now.getMonth();
  const m = String(s).match(/(\d{4})-(\d{1,2})/);
  if (!m) return null;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

// Candidate experience as a recruiter counts it (spec 4.3 inputs), month by
// month so overlapping stints never double-count: each calendar month takes
// the HIGHEST weight of anything covering it.
//   full-time role                          1.0
//   internship / co-op / trainee role       tunables.candidateYears.internshipWeight (0.5)
//   master's or doctorate                   tunables.candidateYears.mastersWeight (0)
//   bachelor's                              0
// Degree time is not work experience to a recruiter. A master's counts only
// where the POSTING offers it as a substitute ("Bachelor's + 5 yrs OR
// Master's + 3 yrs") — extractYearsRequired reads that track and lowers the
// bar instead, so crediting the degree here as well would count it twice.
// Returns years to one decimal, the per-kind breakdown shown in Settings, and
// the per-role list the fit judge weighs function-relevant years from.
const INTERN_TITLE_RE = /\b(intern|interns|internship|co-?op|trainee|apprentice|apprenticeship|student|graduate assistant|research assistant|teaching assistant)\b/i;
const GRAD_DEGREE_RE = /\b(master|masters|master's|mba|m\.?\s?s\.?c?|m\.?\s?eng|m\.?\s?tech|m\.?\s?a\.?|ph\.?\s?d|doctor|doctorate)\b/i;

function monthRange(dates, now) {
  const start = parseYm(dates && dates.start, now);
  if (start == null) return null;
  const nowIdx = now.getFullYear() * 12 + now.getMonth();
  const end = Math.min(parseYm(dates && dates.end, now) ?? nowIdx, nowIdx);
  return end >= start ? [start, end] : null;
}

function experienceBreakdown(profile, now = new Date()) {
  const cy = tunables.candidateYears;
  const mastersWeight = Number(cy.mastersWeight ?? 0);
  const byMonth = new Map(); // month index -> { w, kind }
  const cover = (range, w, kind) => {
    if (!(w > 0)) return;
    for (let m = range[0]; m <= range[1]; m += 1) {
      const cur = byMonth.get(m);
      if (!cur || w > cur.w) byMonth.set(m, { w, kind });
    }
  };
  const roles = [];
  for (const role of profile.roles || []) {
    const range = monthRange(role.dates, now);
    if (!range) continue;
    const intern = INTERN_TITLE_RE.test(role.title || '');
    const weight = intern ? cy.internshipWeight : 1;
    cover(range, weight, intern ? 'internship' : 'fullTime');
    roles.push({
      title: role.title || '',
      company: role.company || '',
      months: range[1] - range[0] + 1,
      kind: intern ? 'internship' : 'fullTime',
      weight,
    });
  }
  let gradBudget = cy.mastersCapMonths;
  for (const ed of profile.education || []) {
    if (!GRAD_DEGREE_RE.test(ed.degree || '')) continue;
    const range = monthRange(ed.dates, now);
    if (!range || gradBudget <= 0) continue;
    const capped = [range[0], Math.min(range[1], range[0] + gradBudget - 1)];
    gradBudget -= capped[1] - capped[0] + 1;
    cover(capped, mastersWeight, 'masters');
  }
  if (!byMonth.size) return null;
  const months = { fullTime: 0, internship: 0, masters: 0 };
  for (const { w, kind } of byMonth.values()) months[kind] += w;
  const yrs = (m) => Math.round((m / 12) * 10) / 10;
  return {
    total: yrs(months.fullTime + months.internship + months.masters),
    fullTime: yrs(months.fullTime),
    internship: yrs(months.internship),
    masters: yrs(months.masters),
    roles,
  };
}

// Holds a master's or doctorate — the pre-filter's years step uses a posting's
// stated master's-track bar ("…or Master's + 3 years") when this is true.
function hasGraduateDegree(profile) {
  return ((profile && profile.education) || []).some((ed) => GRAD_DEGREE_RE.test(ed.degree || ''));
}

function yearsOfExperience(profile, now = new Date()) {
  const b = experienceBreakdown(profile, now);
  return b ? b.total : null;
}

// Domain keywords = the user's own skills (declared + demonstrated), deduped.
function domainKeywords(profile) {
  const set = new Map(); // lowercase -> original
  for (const s of profile.skills_declared || []) {
    const k = String(s).trim();
    if (k) set.set(k.toLowerCase(), k);
  }
  for (const role of profile.roles || []) {
    for (const b of role.bullets || []) {
      for (const s of b.skills_demonstrated || []) {
        const k = String(s).trim();
        if (k) set.set(k.toLowerCase(), k);
      }
    }
  }
  return [...set.values()];
}

function deriveProfileInputs(profile) {
  return {
    yearsOfExperience: yearsOfExperience(profile),
    domainKeywords: domainKeywords(profile),
  };
}

module.exports = { deriveProfileInputs, yearsOfExperience, experienceBreakdown, hasGraduateDegree, domainKeywords };

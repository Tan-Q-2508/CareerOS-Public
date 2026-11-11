const tunables = require('../tunables.json');

// Work-authorization restriction detector (spec 4.1 / 4.3 step 1). A match is
// a hard pre-filter DROP when the scan's visa filter is on — it runs before any
// AI call, so every restriction caught here is AI cost never spent on a job
// the user cannot take. Four categories, each a list of regex sources in
// tunables.prefilter.workAuthRejectPatterns:
//
//   no_sponsorship    "we do not sponsor", "without current or future visa
//                     sponsorship", "Sponsorship: not available", …
//   citizen_only      "must be a U.S. citizen", "U.S. citizens, permanent
//                     residents, refugees and asylees only", …
//   us_person_export  "U.S. person as defined by ITAR", export-control
//                     citizenship requirements
//   clearance         "active Secret clearance", "ability to obtain a U.S.
//                     security clearance", "Required Clearance: TS/SCI"
//
// Every pattern runs on normalizeWorkAuthText's output, never raw JD text:
// curly apostrophes are straightened (htmlToText decodes &rsquo; to ’, which
// defeated "don't sponsor"), "H-1B"/"H1-B" collapse to "h1b" (the hyphen broke
// the filler-word match), and "U.S." collapses to "us" so the abbreviation's
// periods don't end a sentence mid-requirement — patterns use [^.] as their
// same-sentence bound.
//
// Deliberately NOT restrictions: "authorized to work in the US" alone, E-Verify
// / I-9 notices, "executive sponsors", "company-sponsored events", security
// clearances listed as a pay factor. Each is covered by a negative test.

function normalizeWorkAuthText(text) {
  if (!text) return '';
  return String(text)
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\bU\.\s?S\.(\s?A\.)?/gi, 'US')
    .replace(/\bH-?1-?B\b/gi, 'h1b')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function compileCategories(src) {
  const out = {};
  for (const [category, patterns] of Object.entries(src || {})) {
    out[category] = (patterns || []).map((p) => new RegExp(p, 'gi'));
  }
  return out;
}

const cfg = tunables.prefilter.workAuth || {};
const COMPILED = compileCategories(cfg.rejectPatterns);
// A no_sponsorship match whose "sponsor" word is actually a PERSON sponsor
// ("executive sponsors", "company-sponsored events") is not a visa statement.
const SPONSOR_GUARD = new RegExp(cfg.sponsorGuardPattern || '$^', 'i');
// Same-sentence carve-out for citizen_only: "must be a US citizen, permanent
// resident, or otherwise authorized to work" admits any work authorization.
const CITIZEN_ESCAPE = new RegExp(cfg.citizenEscapePattern || '$^', 'i');

function sentenceAround(text, index, length) {
  const start = text.lastIndexOf('.', index) + 1;
  let end = text.indexOf('.', index + length);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

/**
 * @returns {{category: string, match: string} | null}
 */
function detectWorkAuthReject(text, { categories } = {}) {
  const norm = normalizeWorkAuthText(text);
  if (!norm) return null;
  const compiled = categories ? compileCategories(categories) : COMPILED;
  for (const [category, regexes] of Object.entries(compiled)) {
    for (const re of regexes) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(norm)) !== null) {
        if (m[0].length === 0) { re.lastIndex += 1; continue; }
        if (category === 'no_sponsorship' && SPONSOR_GUARD.test(m[0])) continue;
        if (category === 'citizen_only' && CITIZEN_ESCAPE.test(sentenceAround(norm, m.index, m[0].length))) continue;
        return { category, match: m[0].trim() };
      }
    }
  }
  return null;
}

// Legacy shape (string or null) kept for scoreJob.applyUsOnlySignal and the
// audit script.
function detectVisaReject(text) {
  const hit = detectWorkAuthReject(text);
  return hit ? hit.match : null;
}

module.exports = { detectWorkAuthReject, detectVisaReject, normalizeWorkAuthText };

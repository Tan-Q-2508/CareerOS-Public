// What level of role a posting is, when that level is something the fit judge
// has been measured to misread (§15 #63 follow-up, spec 5.6). Deterministic,
// no AI — it bounds the callback rubric in fitCall.callbackFromRubric.
//
//   'support'  an assistant / administrative / clerical role. For a candidate
//              with real professional experience this is below their level, and
//              overqualified applicants are usually screened out — but the
//              rubric's seniority anchors only ever penalized being SHORT of a
//              role, so "Project Assistant" came back 8.0.
//   'program'  a structured early-career program (graduate / rotational /
//              development / leadership program, fellowship). These draw a
//              selective, high-volume pool; the judge ignored its own
//              "selective program" standing anchor and scored a GSK graduate
//              program 9.5.
//   null       everything else — deliberately including internships and plain
//              "New Grad" roles (maintainer's call: internships score as they
//              always have; a new-grad role is one the candidate is eligible for).

// The title with its trailing location/team qualifiers removed:
// "Project Assistant - National Building Group" -> "Project Assistant".
function titleHead(title) {
  return String(title || '')
    .split(/\s[-–—|]\s|,|\(/)[0]
    .trim();
}

// Assistant/administrator as the HEAD noun ("Project Assistant", "Office
// Assistant", "Executive Assistant") — never as a modifier ("Assistant Project
// Manager", "Assistant Director"), where the head is a manager/director.
const SUPPORT_HEAD_RE = /\b(assistants?|receptionists?|secretar(?:y|ies)|clerks?)$/i;
const SUPPORT_MODIFIER_RE = /\b(administrative|admin)\s+(coordinator|specialist|associate|support|assistant|officer)s?\b/i;

const PROGRAM_TITLE_RE =
  /\b(?:graduate|rotational|rotation|development|leadership(?:\s+development)?|early[-\s]career|apm|associate\s+product\s+manager)\s+program(?:me)?s?\b|\brotational\b|\bfellowship\b/i;
const PROGRAM_BODY_RE =
  /\b(?:program(?:me)?s?\s+(?:is|are)\s+(?:designed|intended)\s+(?:for|to accelerate the development of)\s+(?:recent\s+)?graduates)\b|\bgraduates who (?:don'?t|do not) have significant (?:previous\s+)?(?:professional\s+)?(?:work\s+)?experience\b/i;

function postingLevel({ title, text } = {}) {
  const head = titleHead(title);
  if (SUPPORT_HEAD_RE.test(head) || SUPPORT_MODIFIER_RE.test(head) || /\bassistants?\s+to\b/i.test(head)) return 'support';
  if (PROGRAM_TITLE_RE.test(String(title || ''))) return 'program';
  if (PROGRAM_BODY_RE.test(String(text || '').replace(/[’‘]/g, "'"))) return 'program';
  return null;
}

// The line call 2 reads in its PRECOMPUTED FACTS, so the note and risk tags
// say the same thing the bounded score does.
function postingLevelFact(level) {
  if (level === 'support')
    return 'Posting level (precomputed): an assistant/administrative support role, below the level of a candidate with professional experience — overqualified applicants are usually screened out.';
  if (level === 'program')
    return 'Posting level (precomputed): a structured early-career program (graduate/rotational/development) — a selective, high-volume applicant pool.';
  return null;
}

module.exports = { postingLevel, postingLevelFact, titleHead };

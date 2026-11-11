const synonymsRaw = require('./synonyms.json');
const { synonymsFor } = require('./calculateAtsScore');
const tunables = require('../tunables.json');

// Turns raw JD requirement strings — which the extraction LLM sometimes
// copies verbatim as full requirement sentences instead of atomic ATS-
// searchable terms — into short, résumé-searchable atoms. See
// handoffs/jd_term_normalization_handoff.md for the motivating bug: strings
// like "Product management, software engineering, or data science
// experience" can never appear in a résumé as a literal substring
// (calculateAtsScore.js's rawPresent), so they were permanent misses that
// also distorted the match denominator (one sentence = 1 unit of `total`
// while packing 4-5 real skills).
//
// Conservative by design (maintainer decision 2026-08-04): under-splitting
// (leaving a slightly-too-long atom) is far cheaper than over-splitting
// (fracturing "React Native" into "React" + "Native", which corrupts the
// keyword itself). Every transform here is idempotent — normalizeJdProfile
// applied twice must equal applied once — because that's what lets it be
// called at both the scoreJob.js write path AND every read boundary
// (loadJobAndResume.js, copilot.js, generationInputs.js) for free.

const MAX_ATOMS_PER_TERM = (tunables.scoring && tunables.scoring.maxAtomsPerJdTerm) || 5;
const MIN_ATOM_LEN = 2;
const MAX_ATOM_LEN = 40;
const MAX_ATOM_WORDS = 4;

// ---- do-not-split whitelist ----
// Auto-seeded from synonyms.json: any canonical key or variant containing a
// character that our slash/list splitting would otherwise treat as a
// delimiter (/ . & +). This keeps ci/cd, node.js, gd&t, power bi (via key)
// etc. intact without hand-listing everything twice.
function seedProtectedFromSynonyms(map) {
  const protect = new Set();
  for (const [canon, variants] of Object.entries(map)) {
    if (canon.startsWith('_')) continue;
    const all = [canon, ...(variants || [])];
    for (const term of all) {
      const t = String(term).toLowerCase().trim();
      if (/[/.&+]/.test(t)) protect.add(t);
    }
  }
  return protect;
}

// Hand-maintained compounds synonyms.json doesn't know about — real
// multi-word skill names that our splitting rules would otherwise fracture
// (a bare word-count/slash rule can't tell "React Native" apart from a
// genuine "X, Y" list). Kept separate from synonyms.json on purpose: that
// file's own _comment scopes it to synonym matching, not split protection —
// overloading it would couple two concerns that will drift independently.
const HAND_PROTECTED = [
  'react native',
  'machine learning',
  'deep learning',
  'product management',
  'project management',
  'data science',
  'data engineering',
  'computer science',
  'natural language processing',
  'a/b testing',
  'go-to-market',
  'r&d',
  'c++',
  'c#',
  '.net',
  'ui/ux',
  'qa/qc',
  'p&l',
  's&op',
  'ci/cd',
  'node.js',
];

const PROTECTED = new Set([...seedProtectedFromSynonyms(synonymsRaw), ...HAND_PROTECTED]);

function isProtected(s) {
  return PROTECTED.has(String(s).toLowerCase().trim());
}

// Bare connectives/stopwords that occasionally survive splitting as their
// own "atom" (e.g. the "and" in a list split we didn't intend, or residue
// left after a lead-in strip) — never a real keyword on their own.
const STOPWORD_RESIDUE = new Set([
  'and', 'or', 'with', 'in', 'of', 'the', 'a', 'an',
  'background', 'related', 'similar', 'etc', 'equivalent', 'experience',
]);

// ---- shape gate ----
// Whether a string is short/simple enough to plausibly be a single
// ATS-searchable keyword. Used both to filter split output and (via the
// literal-keyword safety net guard, generateResume.js) to stop a sentence
// from ever being pasted into a Skills section.
function isAtomicTerm(s) {
  const t = String(s || '').trim();
  if (t.length < MIN_ATOM_LEN || t.length > MAX_ATOM_LEN) return false;
  if (STOPWORD_RESIDUE.has(t.toLowerCase())) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > MAX_ATOM_WORDS) return false;
  return true;
}

// ---- lead-in / trailing-qualifier stripping ----
const LEAD_IN_PATTERNS = [
  // Stray conjunction left dangling after a comma+or split, e.g. splitting
  // "engineering, or data science experience" on the comma alone (not the
  // "or", since it's closer) leaves "or data science experience" as the next
  // token. Must run before the other lead-ins so it doesn't block them.
  /^(and|or)\s+/i,
  // A parenthetical example list like "(e.g. Cursor, GitHub Copilot)" explodes
  // (explodeParens) into ["e.g. Cursor", "GitHub Copilot"] — without this, the
  // "e.g." qualifier survives as part of the first item's atomic term and ships
  // as a literal keyword (e.g. "e.g. Cursor").
  /^(e\.?g\.?|i\.e\.?|ex\.?|such as|for example)\s+/i,
  /^(strong|proven|demonstrated|deep|solid|excellent|hands[- ]on|working|prior|direct)\s+/i,
  /^(experience|familiarity|knowledge|background|expertise|proficiency|fluency|comfort)\s+(with|in|of|using)\s+/i,
  /^(ability|willingness)\s+to\s+/i,
  /^\d+\+?\s*years?\s+(of\s+)?(experience\s+)?(with|in)?\s*/i,
];

const TRAILING_PATTERNS = [
  /\s+(experience|background|skills?|expertise|knowledge|required|preferred|\(?is\s+a\s+plus\)?|a\s+plus|nice\s+to\s+have)$/i,
];

function wordCount(s) {
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

function stripLeadInsAndTrailers(raw) {
  let s = String(raw).trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of LEAD_IN_PATTERNS) {
      const next = s.replace(re, '');
      if (next !== s) { s = next.trim(); changed = true; }
    }
    for (const re of TRAILING_PATTERNS) {
      // Only strip a trailing qualifier when at least 3 words precede it —
      // an already-short, already-atomic phrase like "Analytical skills" or
      // "Communication skills" should pass through unchanged rather than
      // getting reduced to a single bare adjective. Multi-word compounds
      // like "data science experience" (3 words) still get trimmed to
      // "data science", which matters because the matcher does a literal
      // substring match on multi-word terms — "experience" tacked on almost
      // never appears verbatim in a résumé.
      if (wordCount(s) <= 2) continue;
      const next = s.replace(re, '');
      if (next !== s) { s = next.trim(); changed = true; }
    }
  }
  return s;
}

// ---- mid-string qualifier split: "X such as A, B" -> ["X", "A, B"] ----
// LEAD_IN_PATTERNS above is `^`-anchored only — it strips a qualifier that
// already sits at the START of an atom (e.g. after explodeParens produces
// "e.g. Cursor" from "(e.g. Cursor, GitHub Copilot)"). It does nothing for
// the far more common case where the qualifier sits MID-STRING, introducing
// an enumerated example list after a general term: "BI tools such as Power
// BI, Tableau" previously fell straight through to splitList/stripLeadIns
// with no comma before "such as", so the WHOLE phrase survived as one
// non-atomic string, or (worse) a downstream comma-split on "Power BI,
// Tableau" alone corrupted "Power BI" by leaving "BI tools such as Power BI"
// dangling as its own bogus atom. Bug report (2026-08-12, B1): this is the
// most visible of the four keyword-extraction defects.
//
// Splits into TWO pieces — the general term before the qualifier (kept as
// its own atom, further normalized on the next fixed-point iteration) and
// the enumerated specifics after it (left for splitList/splitSlash to break
// apart on their own commas/or's) — never discarding either side. Requires
// whitespace immediately before the qualifier, so it can never fire at
// absolute string position 0 (that's LEAD_IN_PATTERNS' job — redundant but
// harmless if both would apply) and can't false-positive on a word that
// merely CONTAINS one of these phrases as a substring (each alternative is
// itself whitespace-delimited on both sides).
const MID_QUALIFIER_RE = /^(.*?)[,:]?\s+(?:such as|e\.g\.?|i\.e\.?|for example|including)\s+(.*)$/i;

function splitMidQualifiers(s) {
  if (isProtected(s)) return [s];
  const m = s.match(MID_QUALIFIER_RE);
  if (!m) return [s];
  const general = m[1].trim();
  const specifics = m[2].trim();
  const out = [];
  if (general) out.push(general);
  if (specifics) out.push(specifics);
  return out.length ? out : [s];
}

// ---- parenthetical explode: "X (a, b, c)" -> ["X", "a", "b", "c"] ----
function explodeParens(s) {
  const m = s.match(/^(.*?)\(([^()]*)\)\s*$/);
  if (!m) return [s];
  const head = m[1].trim();
  const inner = m[2].trim();
  const out = [];
  if (head) out.push(head);
  if (inner) out.push(...inner.split(',').map((x) => x.trim()).filter(Boolean));
  return out.length ? out : [s];
}

// ---- list split: always on comma / "or"; "and" only for Oxford-shaped or long strings ----
function splitList(s) {
  if (isProtected(s)) return [s];
  const commaCount = (s.match(/,/g) || []).length;
  const shouldSplitAnd = commaCount >= 2 || s.length > 40;
  let parts = [s];
  parts = parts.flatMap((p) => (isProtected(p) ? [p] : p.split(/\s*,\s*|\s+\bor\b\s+/i)));
  if (shouldSplitAnd) {
    parts = parts.flatMap((p) => (isProtected(p) ? [p] : p.split(/\s+\band\b\s+/i)));
  }
  return parts.map((p) => p.trim()).filter(Boolean);
}

// ---- slash split: only when the WHOLE atom is single-token/single-token(/...)+ ----
const SLASH_WHOLE_TOKEN_RE = /^[\w.+#&-]+(\/[\w.+#&-]+)+$/;
function splitSlash(s) {
  if (isProtected(s)) return [s];
  if (!SLASH_WHOLE_TOKEN_RE.test(s)) return [s];
  return s.split('/').map((p) => p.trim()).filter(Boolean);
}

/**
 * Normalize one raw JD requirement string into 1..N atomic, ATS-searchable
 * terms. Never returns an empty array — falls back to the original raw
 * string so a requirement is never silently dropped, even if it doesn't
 * decompose cleanly.
 */
const DATE_ONLY_RE =
  /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(?:19|20)\d{2}(?:\s*[-–]\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(?:(?:19|20)\d{2}|present))?$/i;

function normalizeJdTerm(raw) {
  const original = String(raw || '').trim();
  if (!original) return [];
  if (isProtected(original)) return [original];

  // Explode/split/strip to a fixed point (capped) rather than once each —
  // any single transform can reveal a new opportunity for another, e.g.:
  //  - a comma-split fragment can itself end in a parenthetical that still
  //    needs exploding ("GAAP, SEC reporting requirements (10-Q/10-K), SOX
  //    ..." only reveals the "(10-Q/10-K)" group AFTER the comma split), and
  //  - a trailing-qualifier strip can reveal a NEW trailing parenthetical
  //    ("direct-to-consumer (DTC) experience" only ends in "(DTC)" AFTER
  //    " experience" is stripped).
  // Without looping to a fixed point, a single normalization pass produces a
  // different (less-split) result than a second pass over its own output —
  // breaking the idempotency invariant every read-boundary call site relies on.
  let atoms = [original];
  for (let i = 0; i < 5; i++) {
    const next = atoms
      .flatMap((a) => (isProtected(a) ? [a] : explodeParens(a)))
      .flatMap((a) => (isProtected(a) ? [a] : splitMidQualifiers(a)))
      .flatMap((a) => (isProtected(a) ? [a] : splitList(a)))
      .flatMap((a) => (isProtected(a) ? [a] : splitSlash(a)))
      .map((a) => (isProtected(a) ? a : stripLeadInsAndTrailers(a)));
    if (JSON.stringify(next) === JSON.stringify(atoms)) { atoms = next; break; }
    atoms = next;
  }

  // Dedupe case-insensitively (and via known synonyms) while preserving
  // first-seen casing/spelling.
  const seen = new Set();
  const deduped = [];
  for (const a of atoms) {
    const key = a.toLowerCase();
    if (!key || seen.has(key)) continue;
    let isDup = false;
    for (const existing of deduped) {
      const variants = synonymsFor(existing);
      if (variants.includes(key)) { isDup = true; break; }
    }
    if (isDup) continue;
    seen.add(key);
    deduped.push(a);
  }

  // A bare date ("Oct 2025", "2023") is never a keyword. It arrives by
  // exploding a dated credential, "Lean Six Sigma Black Belt (Oct 2025)" —
  // where the five-word head fails the shape gate and, before this, the date
  // was the ONLY atom kept: the credential collapsed to "Oct 2025".
  const undated = deduped.filter((a) => !DATE_ONLY_RE.test(a));
  const kept = undated.filter((a) => isProtected(a) || isAtomicTerm(a));

  if (!kept.length) {
    // never silently delete a requirement
    return undated.length && undated.length < deduped.length ? undated.slice(0, MAX_ATOMS_PER_TERM) : [original];
  }
  return kept.slice(0, MAX_ATOMS_PER_TERM);
}

/**
 * Normalize a { required, nice } pair of raw skill-string arrays into
 * atomized, cross-deduped lists. An atom present in both lists is kept only
 * under `required` — atomization makes cross-list collisions much more
 * likely (e.g. a required mega-phrase and a nice-to-have phrase both
 * containing "APIs"), and each duplicate would otherwise double-count in
 * calculateAtsScore.js's totalWeight.
 */
function normalizeJdSkillLists({ required, nice }) {
  const req = [];
  const reqSeen = new Set();
  for (const raw of required || []) {
    for (const atom of normalizeJdTerm(raw)) {
      const key = atom.toLowerCase();
      if (reqSeen.has(key)) continue;
      reqSeen.add(key);
      req.push(atom);
    }
  }
  const niceOut = [];
  const niceSeen = new Set();
  for (const raw of nice || []) {
    for (const atom of normalizeJdTerm(raw)) {
      const key = atom.toLowerCase();
      if (reqSeen.has(key) || niceSeen.has(key)) continue; // dedupe against required too
      niceSeen.add(key);
      niceOut.push(atom);
    }
  }
  return { required_skills: req, nice_to_have_skills: niceOut };
}

/**
 * Normalize a full jd_profile object. Idempotent: calling this on an
 * already-normalized profile returns an equivalent result (verified in
 * offline checks). Non-skill fields pass through untouched.
 */
function normalizeJdProfile(jdProfile) {
  if (!jdProfile || typeof jdProfile !== 'object') return jdProfile;
  // Flag-gated (tunables.scoring.normalizeJdTerms) so rollback is a single
  // boolean flip, matching the useUnifiedAtsEngineV2 precedent — off means
  // every call site becomes a pass-through no-op.
  if (tunables.scoring && tunables.scoring.normalizeJdTerms === false) return jdProfile;
  const { required_skills, nice_to_have_skills } = normalizeJdSkillLists({
    required: jdProfile.required_skills,
    nice: jdProfile.nice_to_have_skills,
  });
  return { ...jdProfile, required_skills, nice_to_have_skills };
}

module.exports = {
  normalizeJdTerm,
  normalizeJdSkillLists,
  normalizeJdProfile,
  isAtomicTerm,
};

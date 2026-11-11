const table = require('./equivalents.json');

// True-equivalent expansion for keyword coverage (spec 5.1). A posting term is
// held when the candidate's text literally contains the term OR one of the
// strings this returns:
//   identity  the same thing spelled another way — "artificial intelligence" /
//             "AI", "PowerBI" / "Power BI", "Google Workspace" / "G Suite",
//             "CAPM" / "Certified Associate in Project Management"
//   suites    a posting asking for "Microsoft Word" is met by a candidate who
//             holds "Microsoft Office" (never the reverse)
//   ladders   "Lean Six Sigma Green Belt" is met by a Black Belt (never the
//             reverse)
//   spelling  hyphen / space variants ("cross-functional" / "cross functional")
//
// Deliberately NOT here: different words for similar work ("led" vs "managed",
// "collaboration" vs "coordination"). synonyms.json carries those and
// strictLiteralMatching keeps it off — an ATS does not credit a paraphrase.

// Single common English words are never SEARCHED for as a stand-in: a
// posting's "Google Drive" must not be met by a bullet that says "drive
// adoption". They still work as lookup keys (a bare "Docs" term maps to
// "google docs").
const NOT_SEARCHABLE = new Set(['docs', 'sheets', 'slides', 'calendar', 'drive', 'word', 'ts', 'js']);

const norm = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');

const identityOf = new Map();
for (const group of table.identity || []) {
  const members = group.map(norm);
  for (const m of members) {
    const set = identityOf.get(m) || new Set([m]);
    for (const x of members) set.add(x);
    identityOf.set(m, set);
  }
}
const identity = (t) => [...(identityOf.get(norm(t)) || [norm(t)])];

// member -> holders, expanded through identity on both sides.
const coveredBy = new Map();
function addCover(covered, holders) {
  for (const c of covered.flatMap(identity)) {
    const set = coveredBy.get(c) || new Set();
    for (const h of holders.flatMap(identity)) set.add(h);
    coveredBy.set(c, set);
  }
}
for (const s of table.suites || []) addCover(s.members.map(norm), s.holders.map(norm));
for (const l of table.ladders || []) addCover(l.covers.map(norm), l.holders.map(norm));

// "cross-functional" / "cross functional", "road mapping" / "roadmapping".
function spellingVariants(t) {
  const out = new Set([t]);
  if (t.includes('-')) {
    out.add(t.replace(/-/g, ' '));
    out.add(t.replace(/-/g, ''));
  }
  const words = t.split(' ');
  if (words.length === 2 && !t.includes('-')) out.add(words.join(''));
  if (words.length >= 2 && words.length <= 3) {
    for (let i = 0; i < words.length - 1; i++) {
      out.add([...words.slice(0, i), `${words[i]}-${words[i + 1]}`, ...words.slice(i + 2)].join(' '));
    }
  }
  return [...out];
}

// The same thing spelled two ways ("PMP" / "Project Management Professional"),
// as opposed to a suite or ladder cover, which runs one way only.
function sameThing(a, b) {
  const x = norm(a);
  const y = norm(b);
  return x === y || (equivalentsFor(x).includes(y) && equivalentsFor(y).includes(x));
}

// The table is fixed at load, so a term's equivalents never change. Cached
// because keyword coverage asks for the same few hundred terms millions of
// times across a user's jobs; recomputing them is what froze the server for
// seconds per refresh. Frozen: callers share one array.
const equivalentsCache = new Map();
const EQUIVALENTS_CACHE_MAX = 20000;

/**
 * The strings, other than `term` itself, whose presence in the candidate's
 * text means the candidate holds `term`. Lowercase. Read-only.
 */
function equivalentsFor(term) {
  const key = String(term || '');
  let hit = equivalentsCache.get(key);
  if (hit) return hit;
  hit = Object.freeze(computeEquivalents(key));
  if (equivalentsCache.size >= EQUIVALENTS_CACHE_MAX) equivalentsCache.clear();
  equivalentsCache.set(key, hit);
  return hit;
}

function computeEquivalents(term) {
  const t = norm(term);
  if (!t) return [];
  const out = new Set();
  const ids = identity(t);
  for (const x of ids) {
    for (const v of spellingVariants(x)) out.add(v);
    for (const h of coveredBy.get(x) || []) out.add(h);
  }
  out.delete(t);
  return [...out].filter((x) => !NOT_SEARCHABLE.has(x));
}

module.exports = { equivalentsFor, sameThing };

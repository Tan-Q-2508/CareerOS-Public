// Company-name normalization + slug-candidate generation for ATS Direct.
//
// normalizeCompanyName() is spec 4.6.4's dedup key: lowercase, strip common
// legal suffixes (a FIXED list, deliberately not a smart detector), strip
// punctuation, collapse whitespace. Built here in #22 because name-guess
// detection (4.6.2) needs it; #23's registry dedup imports this rather than
// writing a second, subtly-different copy.
//
// Slug-candidate GENERATION used to live here too; §15 #25d (4.6.11) moved it to
// slugRules.js, which requires this file — so nothing here may require that one.
// The conservatism note that governed it moved with it; see slugRules.js's header.

// Trailing legal-entity suffixes only. Order matters for multi-token entries.
const LEGAL_SUFFIXES = [
  'incorporated', 'corporation', 'limited', 'company',
  'inc', 'llc', 'llp', 'lp', 'ltd', 'corp', 'co',
  'plc', 'gmbh', 'ag', 'sa', 'sas', 'bv', 'nv', 'ab', 'as', 'oy',
  'pty', 'pte', 'srl', 'spa', 'kk',
];

// Lowercase, de-accent, and reduce to space-separated alphanumeric tokens.
// Dotted acronyms are closed up FIRST ("L.L.C." -> "llc", "S.A." -> "sa"), so
// they survive as one token and the suffix-stripper below can actually see them
// — spec 4.6.4 names "L.L.C." explicitly, and splitting it into "l l c" would
// have quietly exempted every dotted legal suffix from stripping.
function basicClean(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Mn}/gu, '')                          // diacritics: "Sodexō" -> "sodexo"
    .replace(/[’'`]/g, '')                            // possessives close up: "mcdonald's" -> "mcdonalds"
    .replace(/\b(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, ''))
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * spec 4.6.4's normalized dedup key. Returns '' for empty/unusable input.
 */
function normalizeCompanyName(name) {
  if (name == null) return '';
  let s = basicClean(name);
  if (!s) return '';

  // Strip trailing legal suffixes repeatedly ("Acme Holdings Co Ltd"), but never
  // strip the name down to nothing — a company literally called "Company" keeps
  // its name rather than normalizing to the empty string.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (s === suffix) break;
      if (s.endsWith(` ${suffix}`)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

module.exports = { normalizeCompanyName, basicClean, LEGAL_SUFFIXES };

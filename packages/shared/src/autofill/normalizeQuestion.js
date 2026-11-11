// normalizeQuestion.js — the reuse key for the Application Autofill answer
// bank (spec 0.1 Phase 5, §15 session 28).
//
// The SAME question is worded slightly differently on every ATS: Greenhouse
// renders "Are you legally authorized to work in the United States? *", Lever
// renders "Are you legally authorized to work in the United States?", Workday
// renders "Are you legally authorized to work in the United States". Keying
// the answer bank on raw text would store three rows and reuse none of them —
// which would silently defeat session 29's deliverable ("a question already
// answered on a prior Greenhouse application autofills here too").
//
// So this is deliberately a CONSERVATIVE normalizer, not a fuzzy matcher: it
// strips only presentation noise (case, required markers, edge punctuation,
// smart quotes, whitespace, a fixed set of "(optional)"-style annotations).
// It never drops meaningful words, because two questions that differ by a
// real word are two different questions and must not collapse onto one stored
// answer. Fuzzy tolerance, if it's ever wanted, belongs in the extension's
// field matcher where a human still reviews the result before it's inserted —
// not in the storage key, where a wrong collapse is silent and permanent.
//
// This file is the CANONICAL copy. apps/extension/src/core/normalizeQuestion.js
// is a byte-identical copy (Chrome can't load files from outside the extension
// directory); `npm run sync:extension-shared` refreshes it and
// `npm run test:autofill` fails if the two ever drift.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CareerOSAutofillNormalize = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // Parenthetical annotations that are pure presentation and carry no meaning
  // for what's being asked. Anything NOT on this list is left alone — e.g.
  // "(in years)" or "(city, state)" genuinely change the question.
  const NOISE_PARENTHETICALS = [
    'required',
    'optional',
    'if applicable',
    'select one',
    'choose one',
    'please select',
    'yes/no',
  ];

  function normalizeQuestion(input) {
    if (input === null || input === undefined) return '';
    let s = String(input);

    // Unicode presentation characters -> their ASCII equivalents, so a smart
    // apostrophe doesn't fork the key.
    s = s
      .replace(/[‘’‛′]/g, "'")
      .replace(/[“”‟″]/g, '"')
      .replace(/[‐-―−]/g, '-')
      .replace(/[   ]/g, ' ')
      .replace(/…/g, '...');

    s = s.toLowerCase();

    // Required markers, in every rendering we've seen: a trailing asterisk,
    // a bullet-style asterisk, or the literal word.
    s = s.replace(/[*✱✻＊]/g, ' ');
    s = s.replace(/\brequired\b/g, ' ');

    // Noise parentheticals only (see the list above).
    s = s.replace(/[([{]([^)\]}]*)[)\]}]/g, (match, inner) => {
      const cleaned = inner.trim().replace(/\s+/g, ' ');
      return NOISE_PARENTHETICALS.includes(cleaned) ? ' ' : match;
    });

    // Everything that isn't a letter, digit, or intra-word apostrophe becomes
    // a space. This folds "?" , ":" , "—" and stray punctuation away without
    // touching word content.
    s = s.replace(/['’]/g, '');
    s = s.replace(/[^a-z0-9]+/g, ' ');

    s = s.trim().replace(/\s+/g, ' ');

    // Leading politeness/filler that platforms add inconsistently. Applied
    // repeatedly so "please tell us..." and "please, could you tell us..."
    // land in the same place. Only ever stripped from the FRONT — a "please"
    // mid-sentence is part of the question.
    const LEADING_FILLER = ['please', 'kindly', 'the', 'q'];
    let changed = true;
    while (changed) {
      changed = false;
      for (const word of LEADING_FILLER) {
        if (s === word) return '';
        if (s.startsWith(word + ' ')) {
          s = s.slice(word.length + 1);
          changed = true;
        }
      }
    }

    return s;
  }

  return { normalizeQuestion };
});

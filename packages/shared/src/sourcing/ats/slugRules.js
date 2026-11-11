// Slug-candidate RULE REGISTRY for name-guess mode (spec 4.6.2) and the
// pattern-mining pass that widens it (4.6.11). Phase 4, §15 #25d.
//
// Before this file, slugCandidates() was a hand-written sequence of pushes. The
// rules are the same transformations, just named and individually addressable —
// which is what 4.6.11's mining pass needs: to say "rule X would have resolved
// N companies baseline missed, at a wrong-hit rate of R" you need X to be a
// thing with an identity, not three lines inside a function.
//
// TWO TIERS, and the distinction is the whole guardrail:
//   * 'baseline' — the fixed set 4.6.2 shipped with. ALWAYS live. Emitted first,
//     so a mined rule can never outrank a baseline candidate and steal a probe.
//   * 'mined' — pattern-discovery candidates. NEVER live by default. A mined
//     rule only enters the live candidate set by being listed in
//     tunables.atsDirect.detect.minedRules — a reviewed config change, made
//     after the mining pass (apps/server/src/companies/slugMining.js) reports
//     it clears both gates on the real 11k-company registry. Merely writing a
//     rule here changes NOTHING about production detection.
//
// Why so careful: Lever and Ashby expose no company name in their payloads, so
// a guessed slug that lands on an unrelated company's board is unverifiable and
// goes into the GLOBAL registry (4.6.5), feeding the wrong company's postings to
// every user until someone notices by hand. A miss just parks in
// company_ats_unresolved for the re-sweep. That asymmetry is why the mining gate
// is a collision rate, not a hit count.

const { normalizeCompanyName, basicClean } = require('./companyName');

// Descriptor words that companies routinely drop from their board slug
// ("Acme Technologies" -> `acme`). Deliberately NOT the legal-suffix list —
// those are already stripped by normalizeCompanyName; these are ordinary
// English nouns that are part of the real name, so dropping them is a guess.
const GENERIC_DESCRIPTORS = new Set([
  'technologies', 'technology', 'tech', 'labs', 'laboratories', 'systems',
  'solutions', 'services', 'group', 'holdings', 'partners', 'ventures',
  'capital', 'ventures', 'media', 'studios', 'studio', 'industries',
  'international', 'worldwide', 'global', 'digital', 'software', 'consulting',
  'enterprises', 'brands', 'health', 'networks',
]);

const STOPWORDS = new Set(['the', 'and', 'of']);

function tokensOf(s) {
  return s ? s.split(' ').filter(Boolean) : [];
}

// Every rule produces its variants from an already-cleaned token list, then this
// renders each token list in the two shapes real slugs actually take.
function joins(tokens) {
  if (!tokens.length) return [];
  return [tokens.join(''), tokens.join('-')];
}

const SLUG_RULES = [
  // ---- baseline (4.6.2's original fixed set) -------------------------------
  {
    id: 'normalized_full',
    tier: 'baseline',
    description: 'Legal-suffix-stripped full name, closed up and hyphenated.',
    generate: (ctx) => joins(ctx.normalizedTokens),
  },
  {
    id: 'with_legal_suffix',
    tier: 'baseline',
    description: 'Full name INCLUDING the legal suffix ("acmeinc") — plenty of boards register that way.',
    generate: (ctx) =>
      ctx.rawTokens.join(' ') === ctx.normalizedTokens.join(' ') ? [] : joins(ctx.rawTokens),
  },
  {
    id: 'ampersand_dropped',
    tier: 'baseline',
    description: '"A & B" with the ampersand dropped outright rather than spelled "and".',
    generate: (ctx) => {
      if (!/&/.test(ctx.name)) return [];
      const dropped = tokensOf(
        String(ctx.name).toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
      );
      return joins(dropped);
    },
  },

  // ---- mined candidates (inert unless promoted via tunables) ---------------
  {
    id: 'drop_generic_descriptors',
    tier: 'mined',
    description: 'Drop generic descriptor words ("Acme Technologies" -> acme), keeping at least one token.',
    generate: (ctx) => {
      const kept = ctx.normalizedTokens.filter((t) => !GENERIC_DESCRIPTORS.has(t));
      if (!kept.length || kept.length === ctx.normalizedTokens.length) return [];
      return joins(kept);
    },
  },
  {
    id: 'drop_stopwords',
    tier: 'mined',
    description: 'Drop "the"/"and"/"of" ("The Acme Group" -> acmegroup).',
    generate: (ctx) => {
      const kept = ctx.normalizedTokens.filter((t) => !STOPWORDS.has(t));
      if (!kept.length || kept.length === ctx.normalizedTokens.length) return [];
      return joins(kept);
    },
  },
  {
    id: 'acronym',
    tier: 'mined',
    description: 'First letter of each token ("International Business Machines" -> ibm).',
    generate: (ctx) => {
      const t = ctx.normalizedTokens;
      if (t.length < 2 || t.length > 4) return [];
      const acr = t.map((w) => w[0]).join('');
      return acr.length >= 2 ? [acr] : [];
    },
  },
  {
    id: 'first_word',
    tier: 'mined',
    description: 'First token alone ("Acme Payment Systems" -> acme). The highest-collision rule by construction — exactly what the gate is for.',
    generate: (ctx) => {
      const t = ctx.normalizedTokens;
      if (t.length < 2) return [];
      return t[0].length >= 3 ? [t[0]] : [];
    },
  },
  {
    id: 'first_two_words',
    tier: 'mined',
    description: 'First two tokens of a 3+ token name.',
    generate: (ctx) => (ctx.normalizedTokens.length >= 3 ? joins(ctx.normalizedTokens.slice(0, 2)) : []),
  },
  {
    id: 'underscored',
    tier: 'mined',
    description: 'snake_case join — some boards use underscores where the guesser only tries hyphens.',
    generate: (ctx) => (ctx.normalizedTokens.length >= 2 ? [ctx.normalizedTokens.join('_')] : []),
  },
  {
    id: 'digits_stripped',
    tier: 'mined',
    description: 'Trailing digits removed ("Acme 360" -> acme) — common for names carrying a product number.',
    generate: (ctx) => {
      const kept = ctx.normalizedTokens.filter((t) => !/^\d+$/.test(t));
      if (!kept.length || kept.length === ctx.normalizedTokens.length) return [];
      return joins(kept);
    },
  },
];

const RULES_BY_ID = new Map(SLUG_RULES.map((r) => [r.id, r]));
const BASELINE_RULE_IDS = SLUG_RULES.filter((r) => r.tier === 'baseline').map((r) => r.id);
const MINED_RULE_IDS = SLUG_RULES.filter((r) => r.tier === 'mined').map((r) => r.id);

/**
 * Shared per-name context every rule reads, computed once.
 */
function ruleContext(name) {
  const normalized = normalizeCompanyName(name);
  return {
    name: String(name == null ? '' : name),
    normalizedTokens: tokensOf(normalized),
    rawTokens: tokensOf(basicClean(name)),
  };
}

/**
 * Run one rule, returning de-duplicated, non-empty candidates.
 */
function runRule(rule, ctx) {
  let out;
  try {
    out = rule.generate(ctx) || [];
  } catch {
    return [];
  }
  const seen = new Set();
  const res = [];
  for (const c of out) {
    if (typeof c !== 'string') continue;
    const v = c.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    res.push(v);
  }
  return res;
}

/**
 * The live candidate list: every baseline rule in order, then whichever mined
 * rules the caller has promoted (tunables.atsDirect.detect.minedRules).
 *
 * @param {string} name raw display name
 * @param {{minedRuleIds?: string[]}} [opts]
 * @returns {string[]} de-duplicated, baseline-first, UNCAPPED (the caller caps)
 */
function generateCandidates(name, { minedRuleIds = [] } = {}) {
  const ctx = ruleContext(name);
  if (!ctx.normalizedTokens.length) return [];

  const ids = [...BASELINE_RULE_IDS, ...minedRuleIds.filter((id) => {
    const r = RULES_BY_ID.get(id);
    return r && r.tier === 'mined';
  })];

  const out = [];
  const seen = new Set();
  for (const id of ids) {
    for (const c of runRule(RULES_BY_ID.get(id), ctx)) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/**
 * 4.6.2's public entry point (moved here from companyName.js by §15 #25d).
 * Behaviour is unchanged from the pre-25d hand-written version whenever
 * `minedRuleIds` is empty, which is the shipped default.
 *
 * @param {string} name raw display name
 * @param {number} max cap (tunables.atsDirect.detect.maxSlugCandidates)
 * @param {{minedRuleIds?: string[]}} [opts]
 */
function slugCandidates(name, max = 5, opts = {}) {
  const out = generateCandidates(name, opts);
  return out.slice(0, Math.max(1, max));
}

module.exports = {
  SLUG_RULES,
  slugCandidates,
  RULES_BY_ID,
  BASELINE_RULE_IDS,
  MINED_RULE_IDS,
  GENERIC_DESCRIPTORS,
  ruleContext,
  runRule,
  generateCandidates,
};

const tunables = require('../tunables.json');
const { equivalentsFor } = require('../ats/equivalents');

// Humanizer (spec 7.15 / 8.7): the rules that keep generated résumés, cover
// letters, application answers and Copilot bullet edits from reading as AI
// output. Two halves share one word list (tunables.humanizer):
//   - humanizerInstruction(kind): the prompt block each generator appends.
//   - aiTellHits / documentTells: a deterministic detector the generators'
//     validators use for one corrective retry, and that the comparison script
//     reports.
// scrubTells() fixes the purely mechanical tells (dashes, curly quotes) in code
// so they never cost a retry.
//
// Sources: Wikipedia "Signs of AI writing"; Kobak et al., Science Advances 2025
// (excess vocabulary in 14M PubMed abstracts); stylometry studies of ChatGPT vs
// human essays (burstiness, nominalization, stance); recruiter reports of the
// phrases that mark an AI-written application.

function cfg() {
  return tunables.humanizer || {};
}

function isEnabled() {
  return !!cfg().enabled;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One regex per banned word, matching its common inflections (delve, delves,
// delved, delving; showcase, showcasing; leverage, leveraged).
function wordPattern(word) {
  const w = word.toLowerCase();
  const forms = [escapeRe(w)];
  if (/e$/.test(w)) forms.push(escapeRe(w.slice(0, -1)) + '(?:ing|ed|es)');
  const body = forms.length > 1 ? `(?:${forms.join('|')})` : forms[0];
  return new RegExp(`(?<![\\w-])${body}(?:s|es|d|ed|ing|ly)?(?![\\w-])`, 'i');
}

const patternCache = new Map();
function patternFor(word) {
  if (!patternCache.has(word)) patternCache.set(word, wordPattern(word));
  return patternCache.get(word);
}

// Trailing participle clauses that restate significance instead of saying
// something ("..., ensuring quality", "..., showcasing expertise").
const ING_TAIL_RE = /,\s+(ensuring|highlighting|showcasing|underscoring|reflecting|fostering|emphasizing|demonstrating|symbolizing|solidifying|cementing|reinforcing)\b/gi;
// Clauses that tack a result onto the end of a sentence. Fine once or twice
// in a document; every bullet ending this way is a template.
const RESULT_TAIL_RE = /(?:,\s+|\s)(resulting in|leading to|contributing to)\b/gi;
const NOT_ONLY_RE = /\bnot only\b[^.;]{0,120}?\bbut\b/i;
const NOT_X_ITS_Y_RE = /\b(?:it'?s|it is|this is|this was)\s+not\s+(?:just\s+)?[^.;,]{1,60},\s+(?:it'?s|it is|but)\b/i;
// An em or en dash used as a sentence connector is a tell; one between two
// digits ("2019–2021", "10–15%") is a range and is not (see aiTellHits).
const CURLY_RE = /[“”‘’]/;
// Filler a model adds to reach a length target ("...by 15% on time",
// "...by 30% overall"). Adverbs that add nothing a reader can check.
const FILLER_TAIL_RE = /\s(overall|on time|as needed|in a timely manner|end-to-end|at scale|successfully|effectively|efficiently)\.?\s*$/i;
const FILLER_WORD_RE = /\b(successfully|effectively|efficiently|seamlessly|various|numerous)\b/i;

/**
 * Deterministic tells in one piece of text.
 * @param text
 * @param opts.allow  words/phrases to skip because the job description itself
 *                    uses them (the JD's own wording always wins, spec 7.12).
 * @returns [{ rule, match }]
 */
function aiTellHits(text, { allow = [] } = {}) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const allowLc = new Set((allow || []).map((a) => String(a).toLowerCase()));
  const allowText = [...allowLc].join(' | ');
  const hits = [];
  const c = cfg();
  for (const word of c.bannedWords || []) {
    if (allowLc.has(word.toLowerCase()) || patternFor(word).test(allowText)) continue;
    const m = t.match(patternFor(word));
    if (m) hits.push({ rule: 'ai_word', match: m[0] });
  }
  const lc = t.toLowerCase();
  for (const phrase of c.bannedPhrases || []) {
    const p = phrase.toLowerCase();
    if (allowLc.has(p)) continue;
    if (lc.includes(p)) hits.push({ rule: 'ai_phrase', match: phrase });
  }
  let m;
  ING_TAIL_RE.lastIndex = 0;
  while ((m = ING_TAIL_RE.exec(t))) hits.push({ rule: 'ing_tail', match: m[0].trim() });
  if (NOT_ONLY_RE.test(t)) hits.push({ rule: 'not_only_but', match: t.match(NOT_ONLY_RE)[0] });
  if (NOT_X_ITS_Y_RE.test(t)) hits.push({ rule: 'not_x_its_y', match: t.match(NOT_X_ITS_Y_RE)[0] });
  if (/[—–]/.test(t.replace(/\d\s*[—–]\s*\d/g, ''))) hits.push({ rule: 'dash', match: '—' });
  if (CURLY_RE.test(t)) hits.push({ rule: 'curly_quote', match: t.match(CURLY_RE)[0] });
  for (const line of t.split(/\n/)) {
    const tail = line.match(FILLER_TAIL_RE);
    if (tail) hits.push({ rule: 'filler', match: tail[1] });
  }
  const fw = t.match(FILLER_WORD_RE);
  if (fw) hits.push({ rule: 'filler', match: fw[1] });
  return hits;
}

// Hits that a model should be asked to fix. Dashes and curly quotes are left
// out: scrubTells() fixes them in code.
function rewriteHits(text, opts) {
  return aiTellHits(text, opts).filter((h) => h.rule !== 'dash' && h.rule !== 'curly_quote');
}

/** Mechanical fix for dashes and curly quotes. Leaves numeric ranges alone. */
function scrubTells(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(\d)\s*[—–]\s*(\d)/g, '$1-$2')
    .replace(/\s*[—–]\s*([^—–]*?)\s*[—–]\s*/g, (all, inner) => (inner.length <= 60 ? ` (${inner}) ` : `, ${inner}, `))
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/,\s*,/g, ',')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Bare command forms a résumé line should never open with ("Deliver Power BI
// dashboard"). Irregular pasts that match their base form (lead/led aside:
// "Set", "Cut", "Put", "Run" vs "Ran") are left out: "Set up" and "Cut" are
// valid past tense.
const BASE_FORM_OPENERS = new Set(['deliver', 'build', 'manage', 'lead', 'drive', 'own', 'create', 'design', 'develop', 'implement', 'coordinate', 'analyze', 'launch', 'define', 'establish', 'oversee', 'write', 'direct', 'handle', 'improve', 'reduce', 'increase', 'support', 'partner', 'collaborate', 'execute', 'map', 'standardize', 'onboard', 'negotiate', 'track', 'ship', 'train', 'hire', 'grow', 'scale', 'automate', 'architect', 'engineer', 'deploy', 'plan', 'present', 'identify', 'conduct', 'facilitate']);

/**
 * Present-tense openers in lines that belong to finished work ("Deliver" or
 * "Delivering" under a role that ended). Present tense is normal for a
 * current role, so callers pass only the lines of ended roles and projects.
 */
function presentTenseOpeners(pastLines) {
  return (pastLines || [])
    .map((l) => (String(l || '').match(/^[A-Za-z]+/) || [''])[0])
    .filter((w) => BASE_FORM_OPENERS.has(w.toLowerCase()) || /^[A-Z][a-z]+ing$/.test(w));
}

// Filler a model tacks onto the END of a résumé bullet to reach its length
// target ("...by 30% successfully", "...by 15% overall"). Dropping it leaves
// the sentence complete, so it is removed in code rather than re-asked.
const FILLER_TAIL_STRIP_RE = /\s+(overall|successfully|measurably|effectively|efficiently|significantly|consistently|substantially|as needed)(\s+(overall|successfully|measurably))?(?=\.?\s*$)/i;
const NUMBER_ON_TIME_RE = /(\d%?)\s+on time(?=\.?\s*$)/i;
function stripFillerTail(text) {
  if (typeof text !== 'string') return text;
  return text.replace(FILLER_TAIL_STRIP_RE, '').replace(NUMBER_ON_TIME_RE, '$1');
}

/**
 * Capitalised names (products, vendors, tools, acronyms) in a line that
 * appear nowhere in the grounding text: the master profile, confirmed
 * skills and the job posting. The humanizer's "be specific" push can tempt a
 * model into inventing one ("Salesforce" where the source only said "CRM"),
 * which is fabrication, so these are flagged for a rewrite.
 * @param line
 * @param haystackLc  the grounding text, lower-cased
 */
function ungroundedNames(line, haystackLc) {
  const words = String(line || '').split(/[^A-Za-z0-9+#.&'-]+/).filter(Boolean)
    .map((raw) => raw.replace(/^[.'-]+|[.'-]+$/g, '').replace(/'s$/, ''));
  // Whole words only: "sap" inside "sapling" is not a source for "SAP".
  const inHay = (t) => new RegExp(`(^|[^a-z0-9])${escapeRe(t)}($|[^a-z0-9])`).test(haystackLc);
  const known = (t) => {
    const lc = t.toLowerCase();
    if (COMMON_CAPITALISED.has(lc) || inHay(lc)) return true;
    // Plurals of a grounded name ("APIs", "OKRs") count as grounded.
    if (/s$/.test(lc) && inHay(lc.slice(0, -1))) return true;
    // A recognised synonym ("Large Language Models" for "LLM").
    return [...equivalentsFor(t), ...(NAME_ALIASES[lc] || [])].some((e) => inHay(String(e).toLowerCase()));
  };
  const out = [];
  // Words that open a sentence are capitalised for grammar, not because they
  // are names: the bullet's first word, and any word after ". ".
  const sentenceStarts = new Set(
    [...String(line || '').matchAll(/(?:^|[.!?]\s+)([A-Za-z][\w-]*)/g)].map((m) => m[1]),
  );
  let i = 1; // the first word is the bullet's verb
  while (i < words.length) {
    if (!/[A-Z]/.test(words[i] || '') || words[i].length < 2 || (/^[A-Z][a-z]+$/.test(words[i]) && sentenceStarts.has(words[i]))) { i += 1; continue; }
    // A run of capitalised words is one name ("Google Vertex AI"); a name that
    // is grounded as a whole, or via a synonym, is fine as a whole.
    let j = i;
    while (j + 1 < words.length && /[A-Z]/.test(words[j + 1])) j += 1;
    const run = words.slice(i, j + 1);
    if (!known(run.join(' '))) {
      for (const w of run) {
        // A hyphenated compound ("Stripe-billed") is grounded when its name part is.
        const parts = w.split('-').filter((x) => /[A-Z]/.test(x));
        if (!parts.every(known)) out.push(w);
      }
    }
    i = j + 1;
  }
  return [...new Set(out)];
}
/**
 * Numbers in a line that the source does not contain with the same unit.
 * A rewrite may drop a number, never change one: "17%" must not become
 * "17 points" (a different claim), and a number with no source is invented.
 * A bare number in the line matches the same number with any unit in the
 * source ("5 vendors" for "5+ vendors", "14 to 11 rupees" for "₹14 to ₹11").
 * Years of experience ("4+ years") are derived, not quoted, so are skipped.
 * @returns [string] the offending numbers as written in the line
 */
function ungroundedNumbers(line, sourceText) {
  const NUM_RE = /(?<![A-Za-z\d.])[$₹€£]?\d+(?:[.,]\d+)*(?:\s?(?:%|percent\b|points?\b|pts\b|pp\b|x\b|\+|[kKmMbB]\b))?/g;
  const norm = (tok) => {
    const t = tok.toLowerCase().replace(/[$₹€£,\s]/g, '').replace(/percent$/, '%').replace(/(points?|pts|pp)$/, 'pt');
    const m = /^(\d+(?:\.\d+)?)(.*)$/.exec(t);
    return m ? { value: String(Number(m[1])), unit: m[2] } : null;
  };
  const source = [...String(sourceText || '').matchAll(NUM_RE)].map((m) => norm(m[0])).filter(Boolean);
  const text = String(line || '').replace(/\b\d+\+?\s*(?:years?|yrs?)\b(?:\s+of)?/gi, ' ');
  const out = [];
  for (const m of text.matchAll(NUM_RE)) {
    const n = norm(m[0]);
    if (!n) continue;
    // A small bare count ("6 platforms", "3-path") is usually the source's
    // own list counted or spelled out; invented metrics carry a unit.
    if (n.unit === '' && Number(n.value) <= 10 && Number.isInteger(Number(n.value))) continue;
    const ok = source.some((s) => s.value === n.value && (n.unit === '' || s.unit === n.unit || (n.unit === '+' && s.unit === '')));
    if (!ok) out.push(m[0].trim());
  }
  return [...new Set(out)];
}

/**
 * Remove a name from a line where it is one item of a list ("Power BI and
 * Tableau" -> "Power BI"; "Excel, Tableau, and SQL" -> "Excel and SQL").
 * Used for a skill the candidate has but whose source never ties it to this
 * entry (spec 7.13: a skill with no "how I used it" note belongs in Skills).
 * Returns the line unchanged when the name is not a removable list item.
 */
function dropListItem(line, name) {
  const n = escapeRe(name);
  const text = String(line || '');
  const tries = [
    // "A, B, and N" -> "A and B"
    [new RegExp(`([^,;]+?),\\s+([^,;]+?),?\\s+(?:and|&)\\s+${n}(?![\\w-])`), '$1 and $2'],
    // "A, N, and B" / "A, N, B" -> drop the middle item
    [new RegExp(`,\\s+${n}(?=,)`), ''],
    // "A and N" / "A & N"
    [new RegExp(`\\s+(?:and|&)\\s+${n}(?![\\w-])`), ''],
    // "N and A" / "N & A"
    [new RegExp(`(?<![\\w-])${n}\\s+(?:and|&)\\s+`), ''],
    // "N, A, and B" -> "A and B" is handled by the middle-item case once N moves; leading item:
    [new RegExp(`(?<![\\w-])${n},\\s+`), ''],
  ];
  for (const [re, rep] of tries) {
    if (re.test(text)) {
      let out = text.replace(re, rep).replace(/\s{2,}/g, ' ').replace(/,\s*,/g, ',');
      // A list that shrank to two items loses its serial comma
      // ("Excel, and SQL" -> "Excel and SQL"); only when nothing before it
      // in the clause has a comma, i.e. it really is now a two-item list.
      out = out.replace(/(^|[;:]\s*)([^,;:]*?),\s+(and|&)\s+/, '$1$2 $3 ');
      return /[a-z0-9]/i.test(out) ? out : text;
    }
  }
  return text;
}

// Generic names a specific source term honestly covers.
const NAME_ALIASES = {
  sql: ['postgres', 'postgresql', 'mysql', 'sqlite', 'supabase', 'sql server', 'bigquery', 'snowflake'],
  postgres: ['postgresql', 'supabase'],
  postgresql: ['postgres', 'supabase'],
};
// Capitalised words that are not names (a line can use them without a source).
const COMMON_CAPITALISED = new Set(['i', 'csat', 'kpi', 'kpis', 'q1', 'q2', 'q3', 'q4', 'ceo', 'cfo', 'coo', 'cto', 'ai', 'us', 'u.s', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);

function sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function stdev(nums) {
  if (nums.length < 2) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length);
}

/**
 * Document-level tells across a set of bullets or sentences: the same opening
 * verb over and over, the same result-tail template on every line, and how
 * uniform the lengths are (burstiness).
 * @returns { repeatedOpeners:[{verb,count}], resultTails, lengthStdev, problems:[string] }
 */
function documentTells(lines, { maxSameOpener, maxResultTails } = {}) {
  const c = cfg();
  const maxOpen = maxSameOpener ?? c.maxSameOpeningVerb ?? 2;
  const maxTails = maxResultTails ?? c.maxResultTails ?? 2;
  const clean = (lines || []).map((l) => String(l || '').trim()).filter(Boolean);
  const openers = new Map();
  for (const l of clean) {
    const w = (l.match(/^[A-Za-z][A-Za-z-]*/) || [''])[0].toLowerCase();
    if (w) openers.set(w, (openers.get(w) || 0) + 1);
  }
  const repeatedOpeners = [...openers.entries()].filter(([, n]) => n > maxOpen).map(([verb, count]) => ({ verb, count }));
  let resultTails = 0;
  for (const l of clean) resultTails += (l.match(RESULT_TAIL_RE) || []).length;
  const lengths = clean.flatMap((l) => sentencesOf(l)).map((s) => s.split(/\s+/).length);
  const problems = [];
  // Two sentences in one bullet is how a model fills a two-line target.
  const twoSentences = clean.filter((l) => /[a-z0-9%)][.!?]\s+[A-Z]/.test(l.replace(/\b(?:e\.g|i\.e|U\.S|Inc|Ltd|Co|vs|approx)\.\s/g, ' ')));
  if (twoSentences.length) problems.push(`${twoSentences.length} bullet(s) are two sentences glued together; make each ONE sentence: ${twoSentences.map((l) => `"${l.slice(0, 50)}..."`).join('; ')}`);
  for (const r of repeatedOpeners) problems.push(`${r.count} lines open with "${r.verb}" (max ${maxOpen}); vary the opening verbs`);
  if (resultTails > maxTails) problems.push(`${resultTails} lines end with a "resulting in / leading to / contributing to" tail (max ${maxTails}); state the result directly in some of them`);
  return { repeatedOpeners, resultTails, lengthStdev: Number(stdev(lengths).toFixed(2)), problems };
}

const COMMON_DONTS = [
  'Do not use these words (or their inflections), which readers now recognise as AI vocabulary: {WORDS}. The one exception: a term the job description itself uses may be kept in the JD\'s wording.',
  'Do not use these stock phrases: {PHRASES}.',
  'No puffery or significance claims ("plays a key role", "a testament to", "in today\'s fast-paced landscape"). State what happened; let the fact carry the weight.',
  'No trailing participle clause that restates importance (", ensuring quality", ", showcasing expertise", ", highlighting the value of"). If the result matters, give it as a fact or a number.',
  'No "not only X but also Y" and no "it\'s not X, it\'s Y" constructions.',
  'No reflexive lists of three. List two or four things when that is what is true; only use three when there really are three.',
  'No em dashes or en dashes as punctuation. Use a comma, a period, or parentheses. (A range like 2019-2021 is fine.)',
  'Say "is" or "was" where it works; do not reach for "serves as", "stands as", "represents" or "boasts".',
  'No vague self-praise without proof ("strong analytical skills", "excellent communicator", "detail-oriented"). Show the thing instead.',
  'No bold, no markdown, no curly quotes.',
];

const COMMON_DOS = [
  'Use plain, specific verbs a person would say out loud, chosen for what was actually done in each line (the verb that fits a migration plan is not the one that fits a vendor negotiation). Do not lean on one favourite plain verb either: a page where every line opens with the same verb reads as generated just as much as one full of "spearheaded".',
  'Prefer a concrete noun, tool, number, or name over an adjective, but ONLY one that is already in the source material you were given. Never add a product, vendor, tool, platform or number to make a line sound specific (writing "Salesforce" where the source only says "CRM" is fabrication). If the source is general, stay general.',
  'Vary length and shape. Real writing mixes short and long lines; do not make every line the same length or the same template.',
  'Keep the field\'s own jargon and the JD\'s exact terms. Practitioners use jargon; they do not use marketing language.',
];

const KIND_RULES = {
  resume: [
    'Résumé bullets stay telegraphic: no "I"/"my", no articles where a person would drop them, and most open with a verb.',
    'Do not build every bullet on the same template ("Verb X using Y, resulting in Z%"). Mix shapes: most lead with the action, an occasional one leads with the scope or the outcome; some carry a number, some just state what was done.',
    'Do not open more than {MAX_OPEN} bullets in the whole résumé with the same verb, and use a "resulting in / leading to / contributing to" tail on at most {MAX_TAILS} bullets.',
    'Do not open a bullet with a verb that hides what was done: Assisted, Helped, Worked on, Responsible for, Participated in, Supported, Handled, Involved in, Tasked with. Name the specific action the candidate took in that work, without overstating their part (work they supported is not work they "led").',
    'Never pad a bullet to reach its length target. No filler tails ("on time", "overall", "end-to-end", "at scale") and no empty adverbs ("successfully", "effectively", "efficiently"). If the true fact is shorter than the target, write it shorter or add a real detail from the source bullet; the layout will pick another variant.',
    'Every variant is ONE complete sentence that says something on its own; never two sentences in one bullet ("...architecture. Authored the plan..."). A two_line variant fills two lines with more detail in the same sentence, not with a second sentence. Stay within the length targets; a variant that overruns is shortened by dropping whole clauses, so put the most important fact first.',
    'Keep each role in its real tense: every bullet of a finished role or project is past tense; present tense is only for ongoing work in a current role.',
    'Keep money and units as the source writes them ("$425K", "₹14 to ₹11"), never spelled out ("425K dollar").',
    'A job-description term goes into a bullet only when the source bullet\'s facts really are that thing. Never relabel work with a JD term it is not (vendor root-cause work is not "customer support operations"; an LLM integration is not "machine learning"). A term with no honest home belongs in Skills.',
    'A number stays attached to what it measured. Do not stretch one role\'s result into a wider claim ("cut shipment cost 21%" does not become "cut operational costs by up to 21%").',
    'Write percentages as digits with % ("21%", never "21 percent"), consistently across the page.',
    'The summary must still carry the job description\'s key terms that the candidate genuinely has (an ATS scores a term highest when it appears in both the summary and a bullet), but inside factual statements about real work ("Ran release and change management for a 6-platform ERP migration"), never as a skills list ("Expert in X, Y, and Z", "Skilled in ...", "Proven leader in ...").',
    'A summary number must name the work it came from ("cut shipment cost 21% at Flipkart"). Never merge numbers from different roles into one claim, and never relabel what a number measured ("shipment cost" is not "unit cost"). No number is better than a blended one.',
    'Summary bullets are facts about the candidate (years, domain, what they have actually done), not a sales pitch.',
  ],
  bulletEdit: [
    'The edited bullet stays telegraphic: verb first, no "I"/"my". Do not tack a ", resulting in ..." or ", ensuring ..." tail onto it unless the result is the point of the bullet.',
  ],
  coverLetter: [
    'Write like a capable person writing to another person, not like a template. Contractions (I\'ve, I\'m, it\'s) are fine.',
    'Mix sentence lengths. A short sentence now and then is good. Do not start consecutive sentences the same way, and do not start more than two sentences in the letter with "I".',
    'Include at least one detail that could only be written to this company or this role, taken from the job description. A letter that works for any company fails.',
    'Do not open with "I am writing to..." and do not end with a paragraph that summarises the letter. End on something concrete and brief.',
  ],
  answer: [
    'Answer the way the candidate would type it into the form: first person, contractions fine, direct.',
    'Lead with the answer, not a restatement of the question. No closing summary line ("Overall, ...", "In summary, ...").',
    'Mix sentence lengths and keep it specific to what the question actually asks.',
  ],
};

/**
 * The humanizer block appended to a generator's system prompt.
 * @param kind 'resume' | 'bulletEdit' | 'coverLetter' | 'answer'
 */
function humanizerInstruction(kind) {
  const c = cfg();
  const fill = (s) => s
    .replace('{WORDS}', (c.bannedWords || []).join(', '))
    .replace('{PHRASES}', (c.bannedPhrases || []).map((p) => `"${p}"`).join(', '))
    .replace('{MAX_OPEN}', String(c.maxSameOpeningVerb ?? 2))
    .replace('{MAX_TAILS}', String(c.maxResultTails ?? 2));
  return [
    'WRITE LIKE A PERSON, NOT A MODEL. The text must not read as AI-generated. These rules sit under the truthfulness and formatting rules above and never override them:',
    ...COMMON_DONTS.map((r) => `- ${fill(r)}`),
    ...COMMON_DOS.map((r) => `- ${r}`),
    ...(KIND_RULES[kind] || []).map((r) => `- ${fill(r)}`),
  ].join('\n');
}

/**
 * Wrap a generator's validator so the humanizer gets ONE corrective retry:
 * on the first call, once the base validator passes, word/phrase tells in
 * textsOf(parsed) are returned as the retry message. Every later call skips
 * the check, so a tell that survives the retry is accepted, never thrown
 * (structuredCall has one retry, then fails the whole call).
 */
function nudgeOnce(validate, textsOf, { allow = [], where = 'the text' } = {}) {
  let calls = 0;
  return function humanizedValidate(p) {
    calls += 1;
    const base = validate ? validate(p) : null;
    if (base || calls > 1) return base;
    const hits = (textsOf(p) || []).flatMap((t) => rewriteHits(t, { allow }));
    return hits.length ? describeHits(hits, where) : null;
  };
}

/**
 * The banned words and phrases the job posting itself uses. These stay
 * allowed: matching the JD's exact wording (spec 7.12) beats avoiding a tell.
 */
function jdAllowList(jobContext) {
  const jc = jobContext || {};
  const text = `${jc.jdText || ''} ${JSON.stringify(jc.jdProfile || {})} ${jc.title || ''}`;
  const lc = text.toLowerCase();
  const c = cfg();
  return [
    ...(c.bannedWords || []).filter((w) => patternFor(w).test(text)),
    ...(c.bannedPhrases || []).filter((p) => lc.includes(p.toLowerCase())),
  ];
}

/** A one-line fix request listing each hit, for a validator's retry message. */
function describeHits(hits, where) {
  const uniq = [...new Map(hits.map((h) => [`${h.rule}:${h.match.toLowerCase()}`, h])).values()];
  const parts = uniq.map((h) => {
    if (h.rule === 'ing_tail') return `the trailing clause "${h.match}"`;
    if (h.rule === 'not_only_but') return 'a "not only ... but" construction';
    if (h.rule === 'not_x_its_y') return 'an "it\'s not X, it\'s Y" construction';
    return `"${h.match}"`;
  });
  return `${where} reads as AI-written: rewrite it without ${parts.join(', ')} (see the WRITE LIKE A PERSON rules)`;
}

// Close synonyms for the opening verbs résumé bullets lean on most, used to
// break a repeat the draft's one retry left in place ("Built" opening three
// bullets: résumé checkers flag any verb that opens more than two). Each
// alternative takes the same kind of object as the verb it replaces, so the
// rest of the bullet reads unchanged. Past tense for finished work, present
// tense for the current role.
const OPENER_SWAPS = {
  built: ['Created', 'Developed', 'Set up'],
  created: ['Built', 'Developed', 'Produced'],
  developed: ['Built', 'Created', 'Produced'],
  designed: ['Created', 'Developed'],
  led: ['Directed', 'Headed', 'Ran'],
  managed: ['Oversaw', 'Ran', 'Directed'],
  ran: ['Conducted', 'Led', 'Managed'],
  drove: ['Led', 'Steered', 'Pushed'],
  owned: ['Led', 'Ran', 'Drove'],
  coordinated: ['Organized', 'Managed', 'Ran'],
  delivered: ['Completed', 'Produced', 'Shipped'],
  implemented: ['Rolled out', 'Introduced', 'Deployed'],
  launched: ['Introduced', 'Rolled out', 'Started'],
  established: ['Set up', 'Created', 'Introduced'],
  analyzed: ['Evaluated', 'Assessed', 'Examined'],
  reduced: ['Cut', 'Lowered', 'Decreased'],
  cut: ['Reduced', 'Lowered'],
  increased: ['Raised', 'Grew', 'Lifted'],
  lifted: ['Raised', 'Increased'],
  improved: ['Raised', 'Strengthened'],
  tracked: ['Monitored', 'Followed'],
  monitored: ['Tracked', 'Watched'],
  conducted: ['Ran', 'Led', 'Performed'],
  partnered: ['Worked', 'Collaborated'],
  collaborated: ['Worked', 'Partnered'],
  streamlined: ['Simplified', 'Sped up'],
  identified: ['Found', 'Pinpointed', 'Uncovered'],
  defined: ['Specified', 'Set'],
  translated: ['Converted', 'Turned'],
  executed: ['Carried out', 'Completed', 'Ran'],
  optimized: ['Tuned', 'Refined', 'Improved'],
  mapped: ['Charted', 'Documented'],
  facilitated: ['Ran', 'Led', 'Organized'],
  constructed: ['Built', 'Created', 'Set up'],
  engineered: ['Built', 'Designed', 'Developed'],
  produced: ['Created', 'Built', 'Prepared'],
  authored: ['Wrote', 'Drafted', 'Prepared'],
  wrote: ['Drafted', 'Authored', 'Prepared'],
  drafted: ['Wrote', 'Prepared', 'Authored'],
  prepared: ['Drafted', 'Produced', 'Wrote'],
  directed: ['Led', 'Ran', 'Managed'],
  oversaw: ['Managed', 'Directed', 'Ran'],
  headed: ['Led', 'Directed', 'Ran'],
  applied: ['Used', 'Adopted', 'Brought'],
  used: ['Applied', 'Adopted'],
  performed: ['Ran', 'Carried out', 'Completed'],
  initiated: ['Started', 'Launched', 'Introduced'],
  introduced: ['Launched', 'Rolled out', 'Started'],
  boosted: ['Raised', 'Increased', 'Lifted'],
  raised: ['Increased', 'Lifted', 'Grew'],
  lowered: ['Reduced', 'Cut', 'Decreased'],
  decreased: ['Reduced', 'Cut', 'Lowered'],
  generated: ['Produced', 'Created', 'Drove'],
  scaled: ['Grew', 'Expanded', 'Extended'],
  expanded: ['Grew', 'Extended', 'Scaled'],
  documented: ['Recorded', 'Wrote up', 'Captured'],
  evaluated: ['Assessed', 'Reviewed', 'Analyzed'],
  assessed: ['Evaluated', 'Reviewed', 'Analyzed'],
  reviewed: ['Assessed', 'Evaluated', 'Examined'],
  resolved: ['Fixed', 'Closed', 'Settled'],
  standardized: ['Unified', 'Systematized'],
  organized: ['Coordinated', 'Arranged', 'Ran'],
  // Thesaurus openers a model reaches for when told to vary its verbs. They
  // are swapped back to the plain verb whenever it is under the limit, at any
  // count (STILTED_OPENERS below).
  elevated: ['Raised', 'Increased', 'Lifted'],
  enhanced: ['Improved', 'Strengthened', 'Raised'],
  formulated: ['Drafted', 'Built', 'Created'],
  instituted: ['Introduced', 'Set up', 'Rolled out'],
  spearheaded: ['Led', 'Directed', 'Drove'],
  orchestrated: ['Coordinated', 'Ran', 'Led'],
  leveraged: ['Used', 'Applied'],
  utilized: ['Used', 'Applied'],
  championed: ['Led', 'Pushed', 'Drove'],
  bolstered: ['Strengthened', 'Raised', 'Improved'],
  fostered: ['Built', 'Grew', 'Encouraged'],
  propelled: ['Drove', 'Pushed', 'Raised'],
  catalyzed: ['Started', 'Drove', 'Launched'],
  effectuated: ['Completed', 'Carried out', 'Made'],
  build: ['Create', 'Develop'],
  lead: ['Direct', 'Head', 'Run'],
  manage: ['Oversee', 'Run', 'Direct'],
  run: ['Conduct', 'Lead', 'Manage'],
  drive: ['Lead', 'Steer', 'Push'],
  own: ['Lead', 'Run', 'Drive'],
  coordinate: ['Organize', 'Manage'],
  track: ['Monitor', 'Follow'],
};

// Openers swapped for a plain verb even when used once: they read as a
// thesaurus pick (or are banned AI vocabulary), not as what a person says.
const STILTED_OPENERS = new Set(['constructed', 'formulated', 'instituted', 'elevated', 'enhanced', 'spearheaded', 'orchestrated', 'leveraged', 'utilized', 'championed', 'bolstered', 'fostered', 'propelled', 'catalyzed', 'effectuated']);

const openerOf = (text) => (String(text || '').match(/^[A-Za-z][A-Za-z-]*/) || [''])[0];

/**
 * Pick a replacement for `verb` (lowercase) that is not itself already at
 * the limit and is not a banned AI word. `counts` maps lowercase opener ->
 * uses so far. Returns null when no alternative is free.
 */
function openerAlternative(verb, counts, max) {
  for (const alt of OPENER_SWAPS[verb] || []) {
    const key = openerOf(alt).toLowerCase();
    if ((counts.get(key) || 0) >= max) continue;
    if (aiTellHits(alt).length) continue;
    return alt;
  }
  return null;
}

/** Replace the opening verb of `text` with `alt` when it opens with `verb`. */
function swapOpener(text, verb, alt) {
  const w = openerOf(text);
  if (!w || w.toLowerCase() !== verb) return text;
  return alt + String(text).slice(w.length);
}

module.exports = {
  OPENER_SWAPS,
  STILTED_OPENERS,
  openerAlternative,
  swapOpener,
  isEnabled,
  humanizerInstruction,
  aiTellHits,
  rewriteHits,
  scrubTells,
  documentTells,
  describeHits,
  jdAllowList,
  nudgeOnce,
  presentTenseOpeners,
  stripFillerTail,
  ungroundedNames,
  ungroundedNumbers,
  dropListItem,
};

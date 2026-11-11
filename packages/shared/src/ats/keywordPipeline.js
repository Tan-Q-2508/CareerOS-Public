const tunables = require('../tunables.json');
const { sameThing } = require('./equivalents');

// Lazy/deferred, NOT a top-of-file require: calculateAtsScore.js needs this
// module for matchesTerm/isConfirmableSkill, and normalizeJdTerms.js needs
// calculateAtsScore.js for synonymsFor (its atomizer-dedupe step) — a
// top-level require here would complete the cycle mid-load and hand
// normalizeJdTerms.js a still-empty calculateAtsScore export. Deferring the
// require until sanitizeSkillList actually RUNS (well after every module has
// finished loading) sidesteps that without breaking either module apart.
function normalizeJdTerm(raw) {
  return require('./normalizeJdTerms').normalizeJdTerm(raw);
}

// THE single keyword pipeline (out-of-band root-cause pass, 2026-08-13) —
// replaces six-plus rounds of one-consumer-at-a-time patches (changelog:
// 2026-07-26 through 2026-08-14) that kept recurring because the same three
// primitives — the literal presence check, the "is this even a skill"
// filter, and JD-grounding — existed as multiple, independently-drifting
// copies. Every one of those copies now either lives here or re-exports from
// here; nothing about matching or filtering is redefined a second time
// anywhere else in the codebase.
//
// "Exactly like ATS job boards" (the operating goal for this pass): a real
// ATS keyword scanner only ever recognizes a term that is a literal
// substring/word match of the text it's scanning, tolerant of simple
// plurals — it does not credit synonyms, paraphrases, or different parts of
// speech. That is the rule enforced below (matchesTerm), and it is the same
// rule the JD-grounding check already enforced one level up (a term must be
// grounded in the JD's own text to be extracted in the first place). Before
// this pass those were two different definitions of "matches" (grounding:
// strict-literal; scoring: literal + a 26-entry synonym map) — now there is
// one.

// ---- text normalization (shared by grounding and matching) --------------
function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Naive plural-only stemmer — NOT a real lemmatizer (no verb-tense handling:
// "reporting" deliberately does not match "report"). Real ATS keyword tools
// do normalize simple plurals ("stakeholder" credited against a JD's
// "stakeholders", "KPI" against "KPIs") without going as far as full
// synonym/paraphrase matching — that specific tier of normalization
// (literal-but-not-brittle-on-plurals) is what this whole module targets,
// no more.
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function stemSetOf(normalizedText) {
  return new Set(normalizedText.split(' ').filter(Boolean).map(stem));
}

// ---- THE single literal matcher ------------------------------------------
// Case-insensitive presence, plural-tolerant: multi-word/special-char terms
// match as an exact substring (unchanged from the original three duplicate
// implementations); a single plain word ALSO credits its simple
// singular/plural counterpart, matching real ATS behavior for e.g. a résumé
// that says "stakeholders" against a JD asking for "Stakeholder". No
// synonym expansion — a genuinely different word ("led" vs. "managed")
// never counts as the same keyword, because a real ATS never treats them as
// the same keyword either.
function matchesTerm(lcText, term) {
  const k = String(term).toLowerCase().trim();
  if (!k) return false;
  if (/[^a-z0-9]/.test(k)) return lcText.includes(k);
  const candidates = new Set([k]);
  if (k.length > 2 && k.endsWith('y')) candidates.add(`${k.slice(0, -1)}ies`);
  else if (/(s|x|z|ch|sh)$/.test(k)) candidates.add(`${k}es`);
  else if (!k.endsWith('s')) candidates.add(`${k}s`);
  const stemmed = stem(k);
  if (stemmed !== k) candidates.add(stemmed);
  for (const c of candidates) {
    if (new RegExp(`\\b${c}\\b`).test(lcText)) return true;
  }
  return false;
}

// ---- junk-term filter: "is this even a confirmable skill" ----------------
// A "confirmed skill" (7.13) is a tool/technology/method the candidate has
// used — not a credential, an authorization status, a bare years-of-
// experience phrase, or a generic soft trait. JD/résumé extraction
// repeatedly surfaces those as if they were skills; this is the one filter
// every extraction site (JD and résumé alike) now runs through.
const NON_SKILL_RE = /\b(degrees?|bachelors?|masters?|master's|ph\.?d|doctorate|diplomas?|ged|certification required|authoriz|work authorization|citizen|visa|sponsor|eligible to work|clearance)\b/i;
const SOFT_TRAIT_RE = /\b(communication|interpersonal|analytical|critical[- ]thinking|problem[- ]solving|attention to detail|time[- ]management|organizational|team[- ]?(player|work)|leadership|detail[- ]oriented|self[- ]starter|work ethic)\b.*\b(skills?|abilit(y|ies))\b|^(skills?|abilit(y|ies))$/i;

// The same traits standing ALONE, with or without a modifier. The rule above
// only ever fired when the trait was followed by "skills"/"ability", so a JD
// phrased as "Written communication" or "Attention to detail" — which is how
// they are usually written — sailed through as a scoreable keyword. Every
// candidate claims these and no ATS keys on them, so they inflate the
// denominator with terms that are pure noise; worse, they are exactly the
// marginal terms the extractor is least consistent about, so they add churn to
// the score as well as padding. Anchored to the WHOLE term, so a real compound
// ("Program Management", "Stakeholder Communication Plan") is untouched.
// Also two traits joined by "and" ("Strategic and critical thinking", "Visual
// communication and storytelling") — both lifted verbatim from a posting's
// qualifications list and scored as keywords on a live 84.51° scan.
const SOFT_TRAIT_MODIFIER =
  '(?:strong|excellent|good|great|effective|exceptional|solid|superior|written|verbal|oral|proven|demonstrated|' +
  'visual|strategic|creative|sound|developing|emerging|basic)';
const SOFT_TRAIT_NOUN =
  '(?:communications?|interpersonal|analytical|(?:critical|strategic|creative|analytical)[-\\s]thinking|thinking|' +
  'problem[-\\s]solving|attention to detail|time[-\\s]management|organizational|organisational|organi[sz]ation|' +
  'team[-\\s]?(?:player|work)|leadership|detail[-\\s]oriented|self[-\\s]starter|work ethic|multitasking|' +
  'multi[-\\s]tasking|adaptability|flexibility|reliability|professionalism|business acumen|acumen|storytelling|' +
  'curiosity|creativity|judge?ment|decision[-\\s]making|delegat(?:ing|ion)|accountability|empathy|resilience)';
const SOFT_TRAIT_UNIT = `(?:${SOFT_TRAIT_MODIFIER}\\s+(?:and\\s+)?)*${SOFT_TRAIT_NOUN}`;
const BARE_SOFT_TRAIT_RE = new RegExp(
  `^${SOFT_TRAIT_UNIT}(?:\\s*(?:,|&|\\band\\b)\\s*${SOFT_TRAIT_UNIT})*(?:\\s+(?:skills?|abilit(?:y|ies)))?$`,
  'i'
);

// Umbrella/filler nouns that are not a nameable skill on their own. "others"
// is the tell-tale one — it comes straight out of a JD's "...and others" and
// was being stored and scored as a requirement. The extraction prompt already
// asks for the NAMED examples rather than the category; this is the
// deterministic backstop for when it hands over the category anyway.
const GENERIC_TERM_RE =
  /^(others?|etc\.?|various|miscellaneous|misc|tools?|systems?|software|technolog(y|ies)|platforms?|applications?|computers?|programs?|processes|procedures|duties|tasks?|responsibilities|experience|knowledge|expertise|proficiency|ability|abilities)$/i;

// Catches degree/education-clause FRAGMENTS specifically ("related field",
// "or a similar discipline", "relevant major"). Generic by shape (an
// optional connector + adjective + bare generic noun), not a growing list of
// exact phrases — a new unseen wording of the same fragment is still caught
// without needing another patch here. If this class of bug recurs again,
// the fix belongs in the extraction prompt (jdAtsCall.js / parseResume.js),
// not a third regex clause bolted on here.
const DEGREE_CLAUSE_FRAGMENT_RE =
  /^(or\s+(a|an)?\s*)?(a|an)?\s*(closely[- ]?)?(related|relevant|similar|equivalent|comparable|applicable)\s+(field|discipline|area|major|subject|degree)s?$/i;

// A bare years-of-experience phrase ("3+ years", "5-7 years of experience")
// isn't an independently-confirmable skill — it's a seniority signal.
const YEARS_ONLY_RE = /^\d+\+?\s*(-\s*\d+\s*)?years?(\s+of\s+experience)?$/i;

function isConfirmableSkill(term) {
  const t = String(term).trim();
  if (t.length < 2 || t.length > 60) return false;
  if (NON_SKILL_RE.test(t)) return false;
  if (SOFT_TRAIT_RE.test(t)) return false;
  if (BARE_SOFT_TRAIT_RE.test(t)) return false;
  if (GENERIC_TERM_RE.test(t)) return false;
  if (DEGREE_CLAUSE_FRAGMENT_RE.test(t)) return false;
  if (YEARS_ONLY_RE.test(t)) return false;
  return true;
}

// JD-side only, on top of isConfirmableSkill: terms a posting's text yields
// that no recruiter or ATS keys on as a keyword. Kept off the résumé side (a
// résumé listing "Mandarin" is fine; a posting requiring it is a hard
// requirement the fit judge checks, not a keyword to match).
//   - single generic words pulled from prose ("building", "planning",
//     "travel", "chat", "messaging" — all seen extracted live)
//   - "<adjective> experience" filler ("technology experience")
//   - natural languages
const JD_FILLER_WORD_RE =
  /^(building|build|planning|plan|execution|executing|delivery|delivering|travel|traveling|travelling|chat|messaging|workflows?|integrations?|collaboration|ownership|prioriti[sz]ation|innovation|excellence|impact|growth|scale|scaling|speed|shipping|launch(es|ing)?|presentations?|priorities|data|digital|analysis)$/i;
const JD_EXPERIENCE_FILLER_RE =
  /^(technology|technical|industry|relevant|related|professional|business|work|hands-on|prior|previous|domain|functional)\s+(experience|background)$/i;
const LANGUAGE_RE =
  /^(fluen(t|cy)( in)?\s+)?(english|mandarin( chinese)?|chinese|cantonese|spanish|french|german|japanese|korean|hindi|portuguese|arabic|italian|russian|vietnamese|dutch|polish|turkish|hebrew)(\s+(fluency|proficiency|language))?$/i;
// An alternative list's escape hatch, not an alternative: "…or equivalent
// experience", "…or a similar individual-contributor role".
const ESCAPE_CLAUSE_RE =
  /^(?:or\s+)?(?:an?\s+)?(?:equivalent|comparable|similar|relevant|related)\b.*\b(?:experience|role|roles|field|background|position)s?$/i;

// A phrase built only from words no recruiter searches on — "business vision
// and priorities", "customer and user problem spaces", "data and analysis",
// "Digital technologies" — every one lifted from a live posting's prose and
// scored as a requirement. A term survives if ANY content word is outside
// this vocabulary ("data products", "data quality", "customer research").
const VAGUE_WORDS = new Set([
  'business', 'businesses', 'customer', 'customers', 'user', 'users', 'client', 'clients',
  'vision', 'priorities', 'priority', 'problem', 'problems', 'space', 'spaces', 'team', 'teams', 'delivery',
  'value', 'values', 'outcome', 'outcomes', 'digital', 'technology', 'technologies', 'solution', 'solutions',
  'capability', 'capabilities', 'analytical', 'needs', 'goals', 'objectives', 'initiatives', 'results',
]);
const VAGUE_STOPWORDS = new Set(['and', 'or', 'of', 'the', 'to', 'for', 'in', 'with', 'a', 'an', '&']);
// "data" and "analysis" are vague only when strung together with a
// connector ("data and analysis"); "data analysis" itself is a real keyword.
const CONNECTED_VAGUE_WORDS = new Set([...VAGUE_WORDS, 'data', 'analysis', 'analytics', 'strategy', 'strategies']);
function isVaguePhrase(term) {
  const all = String(term).toLowerCase().split(/[\s/]+/).filter(Boolean);
  const words = all.filter((w) => !VAGUE_STOPWORDS.has(w));
  if (words.length < 2) return false;
  const vocab = all.length > words.length ? CONNECTED_VAGUE_WORDS : VAGUE_WORDS;
  return words.every((w) => vocab.has(w));
}

function isJdKeyword(term) {
  const t = String(term).trim();
  if (JD_FILLER_WORD_RE.test(t)) return false;
  if (JD_EXPERIENCE_FILLER_RE.test(t)) return false;
  if (LANGUAGE_RE.test(t)) return false;
  if (ESCAPE_CLAUSE_RE.test(t)) return false;
  if (isVaguePhrase(t)) return false;
  return true;
}

// Context nouns a posting wraps around the real keyword: "agile
// environment(s)", "Agile development methodologies", "lean methodologies",
// "BI tools", "data warehousing solutions", "delivery teams". A literal
// matcher cannot credit "Agile" against "agile environments", so each of
// these read as a gap for a candidate who has the skill. JD-side only — a
// résumé's own "asset tracking tools" is left as written.
const CONTEXT_SUFFIX_RE =
  /^(.+?)\s+(?:(?:development|delivery)\s+(?:methodolog(?:y|ies)|methods|practices|principles|processes)|environments?|methodolog(?:y|ies)|methods|principles|concepts|practices|tools|tooling|platforms|solutions|capabilities|teams|proficiency|familiarity|procedures)$/i;
// Fixed "X and Y" compounds that must never be split into halves.
const NO_SPLIT_RE = /^(?:research and development|sales and operations|mergers and acquisitions|learning and development|diversity and inclusion|health and safety|trust and safety|sales and marketing)$/i;
// "UAT testing" -> "UAT": only after an acronym, so "A/B testing" and
// "usability testing" keep their meaning.
const ACRONYM_TESTING_RE = /^([A-Z][A-Z0-9&]{1,5})\s+testing$/;
// Returns an array: when the stripped noun was shared by two modifiers ("AI
// and low-code tooling" = AI tooling + low-code tooling), each is its own term.
function stripContextSuffix(term) {
  const t = String(term).trim();
  const acr = ACRONYM_TESTING_RE.exec(t);
  if (acr) return [acr[1]];
  const m = CONTEXT_SUFFIX_RE.exec(t);
  if (!m || !m[1].trim()) return [t];
  const head = m[1].trim();
  const parts = head.split(/\s+(?:and|or|&)\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && !NO_SPLIT_RE.test(head) && parts.every((p) => p.split(/\s+/).length <= 2)) return parts;
  return [head];
}

// ---- grounding: "does this term actually occur in the source text" ------
// A term counts as "grounded" if it's a verbatim substring of the source
// text, or — allowing for light AI paraphrasing (casing, punctuation,
// simple plurals) — every one of its significant (3+ letter) words,
// stemmed, appears among the source text's own (stemmed) words. A term the
// model invented wholesale fails both and is dropped — the same
// hallucination guard a literal keyword scanner gets for free by
// construction. Deliberately strict beyond plurals: a real ATS keyword
// match does NOT credit a paraphrase or a different part of speech
// ("root-cause" the verb vs. "Root Cause Analysis" the noun phrase).
const LISTING_TRIGGER_RE = /\b(?:such as|like|e\.g\.,?|for example|including)\b/i;

function buildTextIndex(text) {
  const jobText = String(text || '');
  const normalizedJobText = normalizeForMatch(jobText);
  return { jobText, normalizedJobText, jdStemSet: stemSetOf(normalizedJobText) };
}
// Kept as an alias — "JD index" is the common call site, but the same index
// works for grounding résumé skills against résumé text (groundResumeProfile
// below); the logic has nothing JD-specific in it.
const buildJdIndex = buildTextIndex;

function isGrounded(skill, idx) {
  const t = normalizeForMatch(skill);
  if (!t) return false;
  if (idx.normalizedJobText.includes(t)) return true;
  const words = t.split(' ').filter((w) => w.length >= 3);
  if (!words.length) return false;
  return words.every((w) => idx.jdStemSet.has(stem(w)));
}

// If `skill` is immediately followed in the raw source text by a listing
// trigger ("operational tools such as Notion, Linear, Excel"), a real
// keyword scan extracts the NAMED items, not the category label — expand it
// here deterministically, regardless of whether the model already complied
// with an instruction to do this itself.
function namedExamplesFor(skill, idx) {
  const escaped = String(skill).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*(?:${LISTING_TRIGGER_RE.source})\\s*([^.;\\n]+)`, 'i');
  const m = re.exec(idx.jobText);
  if (!m) return null;
  const items = m[1]
    .split(/,|\band\b|\bor\b/i)
    .map((s) =>
      s
        .trim()
        .replace(/\.$/, '')
        // The capture group runs to the next sentence boundary, which can
        // trail a qualifier word past the last named item ("...Power BI,
        // Tableau required." -> last split item "Tableau required") — strip
        // it the same way the atomizer's TRAILING_PATTERNS would, but
        // unconditionally (no word-count guard): these are already-split
        // enumerated example items, not free-standing phrases where a short
        // 2-word compound like "Analytical skills" needs protecting.
        .replace(/\s+(?:required|preferred|is\s+a\s+plus|a\s+plus|nice\s+to\s+have)$/i, '')
        .trim()
    )
    .filter((s) => s.length >= 2 && s.length <= 40 && /[a-zA-Z]/.test(s));
  return items.length ? items : null;
}

// A posting that names one thing both ways ("PMP", "Project Management
// Professional") asks for it once.
function dedupeEquivalent(list) {
  const out = [];
  for (const s of list) if (!out.some((o) => sameThing(o, s))) out.push(s);
  return out;
}

function dedupeCaseInsensitive(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// One list, end to end: junk-filter -> ground + expand named examples ->
// atomize -> RE-GROUND the atoms + RE-EXPAND named examples -> re-filter
// junk -> dedupe. Two structural fixes live in this ordering (2026-08-13
// pass):
//   - RE-GROUNDING the atoms: normalizeJdTerm's splitter can manufacture a
//     string that's technically a substring only of the ORIGINAL raw term,
//     not necessarily a clean standalone match of the source text —
//     grounding a second time after atomization catches an atom the
//     splitter invented that isn't actually attested.
//   - RE-EXPANDING named examples on the atoms: the mid-qualifier splitter
//     (normalizeJdTerms.js's splitMidQualifiers) deliberately keeps the
//     general term ("BI tools") as ITS OWN atom alongside the specifics it
//     split out ("Power BI", "Tableau") — but the whole point of named-
//     example expansion is that the umbrella category should NOT survive
//     when the JD names the exact tools. Applying expansion only BEFORE
//     atomization missed this: a raw skill string containing its own
//     "such as" clause doesn't match the expansion regex against itself, so
//     it fell straight through to the atomizer, which exposed "BI tools" as
//     a fresh standalone atom — one indistinguishable, on a SECOND run
//     through this same pipeline, from a JD that listed "BI tools" as its
//     own raw skill (which correctly WOULD be expanded). Without a second
//     expansion pass, sanitize(sanitize(x)) != sanitize(x): "BI tools"
//     would survive pass 1 and vanish on pass 2 — the same JD giving two
//     different answers depending on how many times this ran, which is
//     unacceptable for logic that must run at write AND every read.
// `idx` is optional throughout: when the source text isn't available (e.g.
// a legacy caller with no jdText), grounding/expansion are skipped and only
// the junk-filter + atomizer run — degrades safely rather than throwing.
function sanitizeSkillList(rawSkills, idx) {
  let list = (rawSkills || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .filter(isConfirmableSkill);

  if (idx) {
    const out = [];
    for (const skill of list) {
      if (!isGrounded(skill, idx)) continue;
      const examples = namedExamplesFor(skill, idx);
      if (examples) out.push(...examples);
      else out.push(skill);
    }
    list = out;
  }

  const atomized = [];
  for (const s of list) atomized.push(...normalizeJdTerm(s));

  const final = [];
  for (const a of atomized) {
    if (!isConfirmableSkill(a)) continue;
    if (idx) {
      if (!isGrounded(a, idx)) continue;
      const examples = namedExamplesFor(a, idx);
      if (examples) {
        final.push(...examples.filter(isConfirmableSkill));
        continue;
      }
    }
    final.push(a);
  }

  return dedupeCaseInsensitive(final);
}

// CHANGED 2026-08-14: the text every JD-side grounding call should ground
// against — job title + description, not description alone. Found live
// (real user report against a real job, "Marketplace Operations Associate"):
// 65 of 222 scored jobs (29%) had their own title absent from the JD body
// text, so a keyword that only ever appeared in the title was silently
// dropped as "ungrounded." One helper, used at EVERY sanitizeJdProfile call
// site (write and every read boundary) — grounding against title+body at
// write but body-alone at read would mean a read re-sanitize strips the
// very title keywords the write path just preserved, the same
// write/read-boundary inconsistency the 2026-08-13 pass eliminated
// elsewhere. `job` is `{ title, description_text }`-shaped; either field
// may be absent (falls through to whatever text remains, or none).
function jdGroundingText(job) {
  return [job && job.title, job && job.description_text].filter(Boolean).join('\n');
}

// The posting sentence that names the most of a group's members; a group
// whose sentence is a degree requirement is a list of degree fields.
// "master's"/"masters" only: a bare "Master" is part of a credential name
// ("Master Change Agent", "Scrum Master"), not a degree.
const DEGREE_SENTENCE_RE = /\b(bachelor'?s?|bachelor’s|master'?s|master’s|degree|diploma|b\.s\.|m\.s\.|bsc|msc|mba|major|field of study|coursework)\b/i;
function bestSentence(members, idx) {
  const sentences = idx.jobText.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  let best = null;
  let bestHits = 0;
  for (const s of sentences) {
    const lc = s.toLowerCase();
    const hits = members.filter((m) => matchesTerm(lc, m)).length;
    if (hits > bestHits) { best = s; bestHits = hits; }
  }
  return bestHits >= 2 ? best : null;
}

function isDegreeFieldGroup(members, idx) {
  const best = bestSentence(members, idx);
  return !!best && DEGREE_SENTENCE_RE.test(best);
}

// A list of example TOOLS is not a list of alternatives. "Project management
// tools like Smartsheet, Confluence, Tableau, Lucid, Jira… etc." and "platforms
// such as monday.com, Asana, Smartsheet, ClickUp, or similar tools" name
// keywords an ATS scans for one by one — each is its own term. Extraction put
// the first in any_of_groups and the second in required_skills, so the same
// kind of list counted 1/1 on one job and 4/7 on another. A group is such a
// list when its posting sentence introduces the members with "like / such as /
// e.g. / including", most members are product names, and no member is joined
// by a bare "or" — "a language such as Python, Java, or Go" stays one
// alternatives requirement.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const looksLikeProduct = (m) => /^[A-Z0-9]/.test(m) || /[.\d]/.test(m) || /[a-z][A-Z]/.test(m);
function isToolExampleList(members, idx) {
  const best = bestSentence(members, idx);
  if (!best) return false;
  const lc = best.toLowerCase();
  const trigger = lc.search(LISTING_TRIGGER_RE);
  const firstMember = Math.min(...members.map((m) => lc.indexOf(m.toLowerCase())).filter((i) => i >= 0));
  if (trigger < 0 || !(trigger < firstMember)) return false;
  if (members.filter(looksLikeProduct).length < (members.length * 2) / 3) return false;
  return !members.some((m) => new RegExp(`\\bor\\s+${escapeRe(m.toLowerCase())}\\b`).test(lc));
}

function mergeOverlappingGroups(groups) {
  let out = groups.map((g) => [...g]);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = new Set(out[i].map((m) => m.toLowerCase()));
        const shared = out[j].filter((m) => a.has(m.toLowerCase())).length;
        if (shared && shared / Math.min(out[i].length, out[j].length) >= 0.5) {
          out[i] = dedupeCaseInsensitive([...out[i], ...out[j]]);
          out.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return out;
}

/**
 * The one canonical JD-profile sanitizer — idempotent (safe to run at write
 * AND every read boundary) and safe to call with no jdText (skips grounding
 * only). Flag-gated the same way normalizeJdTerms always was
 * (tunables.scoring.normalizeJdTerms) so rollback is a single boolean.
 */
function sanitizeJdProfile(jdProfile, jdText) {
  if (!jdProfile || typeof jdProfile !== 'object') return jdProfile;
  if (tunables.scoring && tunables.scoring.normalizeJdTerms === false) return jdProfile;

  const hasText = !!(jdText && String(jdText).trim());
  const idx = hasText ? buildJdIndex(jdText) : null;

  const jdList = (list) =>
    dedupeCaseInsensitive(
      sanitizeSkillList(list, idx)
        .flatMap(stripContextSuffix)
        .filter((s) => isConfirmableSkill(s) && isJdKeyword(s))
    );

  // Alternative lists ("product or program management, product marketing,
  // business development or technology experience") are ONE requirement met
  // by any member. A group that sanitizes down to one member is just a
  // required skill; members never also count as standalone required terms.
  //
  // A list of degree FIELDS ("Bachelor's in Business Administration,
  // Marketing, Finance, Computer Science…") is a credential, judged by the fit
  // call, never a keyword requirement. And two samples reading the same
  // sentence slightly differently must not become two requirements: groups
  // that overlap by half or more are merged into their union.
  const cleaned = (jdProfile.any_of_groups || [])
    .map((raw) => dedupeCaseInsensitive(jdList(raw)))
    .filter((members) => members.length && !(idx && isDegreeFieldGroup(members, idx)));
  const toolLists = idx ? cleaned.filter((g) => g.length > 1 && isToolExampleList(g, idx)) : [];
  const groups = mergeOverlappingGroups(cleaned.filter((g) => !toolLists.includes(g)));
  const groupKeys = new Set();
  const singles = [...groups.filter((g) => g.length === 1).map((g) => g[0]), ...toolLists.flat()];
  const multi = groups.filter((g) => g.length > 1);
  for (const g of multi) for (const m of g) groupKeys.add(m.toLowerCase());

  const required = dedupeEquivalent(dedupeCaseInsensitive([...jdList(jdProfile.required_skills), ...singles]))
    .filter((s) => !groupKeys.has(s.toLowerCase()));
  const reqKeys = new Set(required.map((s) => s.toLowerCase()));
  const nice = dedupeEquivalent(jdList(jdProfile.nice_to_have_skills))
    .filter((s) => !reqKeys.has(s.toLowerCase()) && !groupKeys.has(s.toLowerCase()) && !required.some((r) => sameThing(r, s)));

  return { ...jdProfile, required_skills: required, nice_to_have_skills: nice, any_of_groups: multi };
}

/**
 * Résumé-side counterpart — master résumé parsing (parseResume.js) has never
 * had any grounding at all: an AI call, prompt-only, no code-level check
 * that an extracted skill genuinely appears in the résumé. Grounds &
 * atomizes skills_declared, certifications, and every bullet's
 * skills_demonstrated against the WHOLE résumé text (not the individual
 * bullet — a bullet legitimately demonstrates a skill named elsewhere in
 * the résumé, e.g. the Skills section; per-bullet grounding would wrongly
 * gut skills_demonstrated). Safe with no resumeText (skips grounding only).
 */
function groundResumeProfile(profile, resumeText) {
  if (!profile || typeof profile !== 'object') return profile;
  const hasText = !!(resumeText && String(resumeText).trim());
  const idx = hasText ? buildTextIndex(resumeText) : null;

  const skills_declared = sanitizeSkillList(profile.skills_declared, idx);

  // Certifications are proper nouns ("AWS Certified Solutions Architect") —
  // grounded, not junk-filtered/atomized the same way a skill term is.
  const certifications = dedupeCaseInsensitive(
    (profile.certifications || []).map((c) => String(c || '').trim()).filter(Boolean)
  ).filter((c) => !idx || isGrounded(c, idx));

  const groundBullets = (bullets) =>
    (bullets || []).map((b) => ({ ...b, skills_demonstrated: sanitizeSkillList(b.skills_demonstrated, idx) }));

  const roles = (profile.roles || []).map((role) => ({ ...role, bullets: groundBullets(role.bullets) }));
  const projects = (profile.projects || []).map((proj) => ({ ...proj, bullets: groundBullets(proj.bullets) }));

  return { ...profile, skills_declared, certifications, roles, projects };
}

module.exports = {
  matchesTerm,
  isConfirmableSkill,
  isJdKeyword,
  isVaguePhrase,
  stripContextSuffix,
  buildJdIndex,
  buildTextIndex,
  isGrounded,
  namedExamplesFor,
  sanitizeJdProfile,
  groundResumeProfile,
  sanitizeSkillList,
  jdGroundingText,
  stem,
  normalizeForMatch,
};

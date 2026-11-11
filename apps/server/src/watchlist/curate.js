// CareerOS — AI-curated watchlist (spec 20, §15 #50).
//
// "Build my watchlist": given the user's master résumé profile and an optional
// free-text steer, recommend companies from company_ats_registry, each citing
// the specific data point that justified it.
//
// Reuses 5.6's existing two-tier call composition — cheap tier to extract a
// target spec, strong tier to rank candidates — rather than introducing a new
// one. Both go through aiRouter.structuredCall, the single seam every AI call
// in this codebase uses.
//
// ---------------------------------------------------------------------------
// THE GROUNDING RULE IS ENFORCED BY THE VALIDATOR, NOT THE PROMPT.
//
// Spec 20 step 2, matching CLAUDE.md's never-fabricate non-negotiable: every
// recommended company must cite a real, checkable data point — a visa_sponsors
// stat, a registry/sector fact, or a résumé-profile match — never an
// unsupported "this seems like a good fit."
//
// A prompt instruction alone would make that a preference. Here, makeValidator
// checks each candidate's citation against the rows ACTUALLY PASSED INTO the
// call: a company_id that wasn't in the candidate slice, an evidence_type of
// 'visa_sponsor' for a company with no visa_sponsors row, or 'sector' for a
// company with no sector tags, is rejected — which fails the structuredCall's
// own schema-validation retry (16.8) rather than quietly landing an
// unsupported recommendation in front of the user. Same enforcement posture as
// 5.6's bullet-id grounding (makeValidateFit in scoring/fitCall.js).
// ---------------------------------------------------------------------------
//
// BILLING: 3 COS flat (13.4), logged but UNBILLED through Phase 1 per
// CLAUDE.md's non-negotiable. The mechanism is simply that nothing here calls
// cosGuard.debitCos — exactly as companies/sectors.js's logSectorUsage
// documents for its own platform-overhead calls. Do not "fix" this before
// Section 15 shows Phase 2 pricing is live.

const { tunables, constants } = require('@careeros/shared');
const aiRouter = require('../lib/aiRouter');

const { WATCHLIST_EVIDENCE_TYPES, COMPANY_SECTOR_LABELS } = constants;
const CFG = tunables.watchlist;

// --- tier 1: target spec ---------------------------------------------------

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    role_families: { type: 'array', items: { type: 'string' } },
    domain_focus: { type: 'array', items: { type: 'string' } },
    sponsorship_required: { type: 'boolean' },
    exclusions: { type: 'array', items: { type: 'string' } },
  },
  required: ['role_families', 'domain_focus', 'sponsorship_required', 'exclusions'],
};

const SPEC_SYSTEM_INSTRUCTION = [
  'You turn a job-seeker profile plus an optional free-text steer into a structured company-target spec.',
  'Output strict JSON matching the schema:',
  '- role_families: the kinds of roles this person should target (e.g. "technical program management", "supply chain analytics"). 1-5 entries.',
  '- domain_focus: industries or problem domains that fit their background. 1-6 entries.',
  '- sponsorship_required: true ONLY if the free-text input says or clearly implies they need visa sponsorship. Default false — never infer this from the résumé alone, since a résumé does not state work authorization.',
  '- exclusions: things the user explicitly ruled out ("not big tech", "no consulting"). Empty array when they ruled out nothing.',
  'The free-text input may be empty — that is valid and common. With no input, infer everything from the profile alone and return an empty exclusions array.',
  'Do not invent constraints the user did not express. An empty exclusions list is a correct answer, not a failure to try.',
].join('\n');

function buildSpecPrompt({ profile, user, freeText }) {
  const lines = ['CANDIDATE PROFILE (from the master résumé, already parsed):'];
  if (user.years_of_experience !== null && user.years_of_experience !== undefined) {
    lines.push(`Years of experience: ${user.years_of_experience}`);
  }
  if (user.domain_keywords && user.domain_keywords.length) {
    lines.push(`Domain keywords: ${user.domain_keywords.join(', ')}`);
  }
  if (user.off_domain_title_keywords && user.off_domain_title_keywords.length) {
    lines.push(`Off-domain title patterns (roles this person is NOT targeting): ${user.off_domain_title_keywords.join(', ')}`);
  }
  const titles = (profile && profile.experience ? profile.experience : []).map((e) => e.title).filter(Boolean);
  if (titles.length) lines.push(`Roles held: ${titles.slice(0, 12).join('; ')}`);
  const skills = profile && profile.skills ? profile.skills : null;
  if (skills) lines.push(`Skills: ${JSON.stringify(skills).slice(0, 2000)}`);

  lines.push('');
  lines.push('FREE-TEXT INPUT FROM THE USER:');
  lines.push(freeText && freeText.trim() ? freeText.trim() : '(none given — infer from the profile alone)');
  return lines.join('\n');
}

async function extractTargetSpec({ profile, user, freeText, credential }) {
  const result = await aiRouter.structuredCall(credential, {
    tier: 'cheap',
    systemInstruction: SPEC_SYSTEM_INSTRUCTION,
    prompt: buildSpecPrompt({ profile, user, freeText }),
    responseSchema: SPEC_SCHEMA,
    validate: (p) => {
      if (!p || typeof p !== 'object') return 'spec must be an object';
      if (!Array.isArray(p.role_families) || !p.role_families.length) return 'role_families must be a non-empty array';
      if (!Array.isArray(p.domain_focus)) return 'domain_focus must be an array';
      if (typeof p.sponsorship_required !== 'boolean') return 'sponsorship_required must be a boolean';
      if (!Array.isArray(p.exclusions)) return 'exclusions must be an array';
      return null;
    },
  });
  return { spec: result.parsed, usage: result.usage, costUsd: result.costUsd, model: result.model, connectionMode: result.connectionMode };
}

// --- candidate slice -------------------------------------------------------

// PostgREST caps a single select at 1000 rows silently (the 25b gotcha).
async function selectAllPages(build, cap) {
  const pageSize = 1000;
  const all = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await build().range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < pageSize || (cap && all.length >= cap)) break;
    offset += pageSize;
  }
  return cap ? all.slice(0, cap) : all;
}

/**
 * Assemble the candidate slice the strong-tier call ranks over.
 *
 * The registry is ~19,600 rows — far too many to put in a prompt — so this is
 * a real selection step, not a formality. Ordering is by sponsorship volume
 * when the spec asks for sponsorship (that is the binding constraint), and
 * otherwise by sector match. Companies the user already tracks are excluded:
 * recommending what someone already has is noise, not a suggestion.
 */
async function buildCandidateSlice(db, userId, spec) {
  const cap = CFG.candidateSliceSize;

  // Companies the user has DELIBERATELY tracked — their own personal
  // tracklists only.
  //
  // Subscribed SYSTEM tracklists are deliberately NOT counted, and this is not
  // a shortcut. System sector lists are bulk auto-populated (4.6.9), and a user
  // subscribed to all 16 of them "tracks" ~26,500 company rows covering
  // essentially the whole registry — which is exactly the real account's state.
  // Counting those as already-chosen left 40 candidates out of 19,600 and made
  // the whole feature nearly inert. Subscribing to "Fintech" is not the same
  // act as picking a company, and §20 stages suggestions for one of the user's
  // OWN personal tracklists anyway.
  // THE FIRST THREE READS ARE INDEPENDENT AND RUN CONCURRENTLY. This is a
  // user-initiated, foreground action — someone is watching a spinner — and
  // this function was a noticeable share of its ~30s round trip purely because
  // reads that share no inputs were awaited one after another.
  //
  // The `tracked` set is NOT a query input anywhere below: it is applied as an
  // in-memory filter AFTER each fetch. That is what makes the sponsor read (and
  // the default-path registry page) safe to start before the tracking reads
  // have returned. Only tracklist_companies genuinely depends on a prior
  // result — it needs the list ids — so it alone stays sequential.
  const wantsSponsorshipSlice = !!spec.sponsorship_required;

  const [ownListsRes, decided, sponsorRows, defaultCompanies] = await Promise.all([
    db.from('tracklists').select('id').eq('user_id', userId),

    // Companies this user has already decided on. Re-suggesting a REJECTED
    // company is the one that matters: the staging row's unique key is
    // (user_id, company_ats_registry_id), so a re-run's upsert would flip that
    // row back to 'pending' and put a company the user explicitly said no to
    // straight back in front of them. Accepted ones are usually excluded by
    // `tracked` below anyway, but only if the user kept them in a list.
    selectAllPages(() =>
      db
        .from('watchlist_suggestions')
        .select('company_ats_registry_id')
        .eq('user_id', userId)
        .neq('status', 'pending')
        .order('company_ats_registry_id', { ascending: true })
    ),

    // Sponsorship is the binding constraint when the spec asks for it, so lead
    // with the sponsors — a company that cannot sponsor is not a candidate at
    // all for this user, no matter how well its sector matches.
    wantsSponsorshipSlice
      ? selectAllPages(
          () =>
            db
              .from('visa_sponsors')
              .select('company_ats_registry_id')
              .not('company_ats_registry_id', 'is', null)
              .gte('filing_count_last_fy', CFG.minSponsorFilings)
              .order('filing_count_last_fy', { ascending: false }),
          cap * 3
        )
      : Promise.resolve(null),

    wantsSponsorshipSlice
      ? Promise.resolve(null)
      : selectAllPages(
          () =>
            db
              .from('company_ats_registry')
              .select('id, company_name_display, platform, slug_or_identifier')
              .eq('status', 'active')
              .order('last_seen_at', { ascending: false, nullsFirst: false }),
          cap * 4
        ),
  ]);

  const listIds = ((ownListsRes && ownListsRes.data) || []).map((r) => r.id);
  const tracked = new Set();
  if (listIds.length) {
    const rows = await selectAllPages(() =>
      db
        .from('tracklist_companies')
        .select('company_ats_registry_id')
        .in('tracklist_id', listIds)
        .order('company_ats_registry_id', { ascending: true })
    );
    for (const r of rows) tracked.add(r.company_ats_registry_id);
  }
  for (const r of decided) tracked.add(r.company_ats_registry_id);

  // Fetch the registry rows themselves.
  let companies;
  if (wantsSponsorshipSlice) {
    const registryIds = [...new Set(sponsorRows.map((r) => r.company_ats_registry_id))].filter((id) => !tracked.has(id));
    companies = [];
    const CHUNK = 200;
    // Deliberately sequential: the `companies.length < cap * 2` stop condition
    // is load-bearing. Flattening this into a Promise.all would fetch every
    // chunk of a multi-thousand-id list to fill a 440-row target.
    for (let i = 0; i < registryIds.length && companies.length < cap * 2; i += CHUNK) {
      const { data, error } = await db
        .from('company_ats_registry')
        .select('id, company_name_display, platform, slug_or_identifier')
        .in('id', registryIds.slice(i, i + CHUNK))
        .eq('status', 'active');
      if (error) throw new Error(`candidate slice failed: ${error.message}`);
      companies.push(...(data || []));
    }
  } else {
    companies = defaultCompanies.filter((c) => !tracked.has(c.id));
  }

  // Enrich with the two evidence sources a citation can point at. Every chunk
  // is independent of every other, so they all go at once rather than in 3-5
  // serial waits — the same reasoning as the concurrent block above.
  const ids = companies.map((c) => c.id);
  const sectorsById = new Map();
  const sponsorById = new Map();
  const CHUNK = 200;
  const slices = [];
  for (let i = 0; i < ids.length; i += CHUNK) slices.push(ids.slice(i, i + CHUNK));

  const enrichment = await Promise.all(
    slices.map((slice) =>
      Promise.all([
        db.from('company_sectors').select('company_ats_registry_id, sector').in('company_ats_registry_id', slice),
        db
          .from('visa_sponsors')
          .select('company_ats_registry_id, employer_name_display, filing_count_last_fy, wage_level_distribution, avg_wage, source_fiscal_year, source_quarter')
          .in('company_ats_registry_id', slice)
          .order('filing_count_last_fy', { ascending: false }),
      ])
    )
  );

  for (const [{ data: secs }, { data: spons }] of enrichment) {
    for (const r of secs || []) {
      if (!sectorsById.has(r.company_ats_registry_id)) sectorsById.set(r.company_ats_registry_id, []);
      sectorsById.get(r.company_ats_registry_id).push(r.sector);
    }
    for (const r of spons || []) {
      if (!sponsorById.has(r.company_ats_registry_id)) sponsorById.set(r.company_ats_registry_id, r);
    }
  }

  const enriched = companies.map((c) => ({
    ...c,
    sectors: sectorsById.get(c.id) || [],
    sponsor: sponsorById.get(c.id) || null,
  }));

  // Prefer companies whose sectors overlap the spec's domain focus, so the
  // slice that reaches the model is already relevant rather than arbitrary.
  //
  // The spec's domain_focus is free-form model prose ("Artificial Intelligence
  // and LLMs"), while sectors are fixed keys ('ai_ml'). Matching the raw
  // strings against each other barely works — the first live run scored almost
  // nothing as a sector hit, so the slice collapsed into "whoever sponsors
  // most" and the recommendations ignored the user's actual domain. Matching
  // through COMPANY_SECTOR_LABELS ("AI & ML") plus the key's own word parts
  // bridges the two vocabularies.
  const focusText = (spec.domain_focus || []).concat(spec.role_families || []).join(' ').toLowerCase();
  const focusWords = new Set(focusText.split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const sectorMatches = (sector) => {
    const label = String(COMPANY_SECTOR_LABELS[sector] || sector).toLowerCase();
    const parts = [...label.split(/[^a-z0-9]+/), ...String(sector).split('_')].filter((w) => w.length > 2);
    return parts.some((w) => focusWords.has(w) || focusText.includes(w));
  };
  const wantsSponsorship = !!spec.sponsorship_required;
  const scored = enriched.map((c) => {
    const sectorHit = c.sectors.some(sectorMatches);
    // When sponsorship isn't a stated requirement, a filing record is a mild
    // tiebreak, not a ranking axis — otherwise the whole list becomes "biggest
    // H-1B filers", which is not what this user asked for.
    return { c, score: (sectorHit ? 3 : 0) + (c.sponsor ? (wantsSponsorship ? 2 : 1) : 0) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, cap).map((x) => x.c);
}

// --- tier 2: ranked selection ---------------------------------------------

const CURATE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          company_id: { type: 'string' },
          rank: { type: 'integer' },
          evidence_type: { type: 'string', enum: WATCHLIST_EVIDENCE_TYPES },
          rationale: { type: 'string' },
        },
        required: ['company_id', 'rank', 'evidence_type', 'rationale'],
      },
    },
  },
  required: ['results'],
};

const CURATE_SYSTEM_INSTRUCTION = (max, wantsSponsorship) =>
  [
    "You select and rank companies for a job-seeker's watchlist, from a fixed candidate list you are given.",
    `Return at most ${max} companies, ranked best-first starting at rank 1.`,
    'GROUNDING (hard rule, enforced by a validator — a violation is rejected, not merely discouraged):',
    '- Every result MUST cite a specific, checkable data point from the candidate data you were given.',
    '- evidence_type must be one of:',
    '  * "visa_sponsor" — the company has a real H-1B filing record in the data below. Only valid for companies where sponsorship data is actually shown. Cite the number.',
    '  * "sector" — the company\'s listed sectors match the target spec. Only valid for companies that have sectors listed below. Name the sector.',
    '  * "resume_match" — the company fits the candidate\'s stated domain keywords or role history. You MUST name at least one of the target spec\'s own domain_focus or role_families terms VERBATIM in the rationale; a validator checks for it. Say what the company does that overlaps that term — restating the spec back ("aligns with the candidate\'s domain focus and role family") names no overlap and is not a rationale.',
    '- rationale: ONE sentence naming the actual data point. "Filed 231 certified H-1B petitions, 24% at Level II" is grounded. "Strong culture fit" is not, and will be rejected.',
    '- NEVER recommend a company for a reason you cannot point at in the data below. If you cannot ground it, leave it out — a short grounded list beats a long unsupported one.',
    '- Use only company_id values from the candidate list. Never invent one.',
    "Honor the target spec's exclusions strictly.",
    wantsSponsorship
      ? 'sponsorship_required is TRUE for this candidate: prefer companies with a real H-1B filing record, and weigh the wage-level mix — an employer filing mostly at Levels I-II is a better prospect for a less senior candidate than one filing mostly at III-IV, regardless of raw volume.'
      : 'sponsorship_required is FALSE for this candidate. Do NOT rank by H-1B filing volume, and do not default to visa_sponsor evidence just because it is the most numeric — that would return a list of "big H-1B filers" instead of a list of companies that fit this person. Lead with sector and resume_match evidence, and prefer a list that spans the target spec\'s different domain_focus areas rather than fifteen companies from one industry.',
    'Return strict JSON matching the schema, ranks contiguous from 1, no duplicate company_id.',
  ].join('\n');

// Sector keys are an internal taxonomy id, not English. Everything that puts
// a sector in front of a person — or in front of a model whose output a person
// reads — goes through this.
const sectorLabel = (sector) => COMPANY_SECTOR_LABELS[sector] || sector;

function candidateBlock(candidates) {
  return [
    'CANDIDATE COMPANIES:',
    ...candidates.map((c) => {
      const bits = [`id=${c.id}`, `name=${c.company_name_display}`];
      // Sector KEYS ('ai_ml') never reach the model — only their display
      // labels ('AI & ML') do. A candidate block carrying raw keys taught the
      // model to quote them straight back, so user-facing rationales read
      // "matching its ai_ml focus". The grounding check is unaffected: it
      // tests that the company HAS sectors, never what the prose calls them.
      if (c.sectors.length) bits.push(`sectors=${c.sectors.map(sectorLabel).join('/')}`);
      if (c.sponsor) {
        const dist = c.sponsor.wage_level_distribution || {};
        const mix = Object.entries(dist)
          .filter(([, v]) => Number(v) > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
          .join(' ');
        bits.push(
          `h1b_filings=${c.sponsor.filing_count_last_fy} (FY${c.sponsor.source_fiscal_year} Q${c.sponsor.source_quarter}${mix ? `, wage levels ${mix}` : ''})`
        );
      }
      return bits.join(' | ');
    }),
  ].join('\n');
}

// Visa-class tokens carry digits that are part of a NAME, not a citation —
// "H-1B" would otherwise contribute a spurious 1 to every rationale that
// mentions the program at all, which is nearly all of them.
const VISA_CLASS_TOKEN = /\b(?:H-?1B|H-?2B|EB-?[123]|O-?1|L-?1|TN-?1)\b/gi;

/**
 * Every number that appeared in the rationale, thousands separators removed.
 * Returned as numbers, not strings, so "4,102" and "4102" compare equal.
 */
function numbersIn(text) {
  const cleaned = String(text || '').replace(VISA_CLASS_TOKEN, ' ');
  const out = [];
  for (const m of cleaned.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Every number this company's own candidate row actually put in front of the
 * model — i.e. exactly what candidateBlock() rendered for it, nothing more.
 *
 * The wage percentages are RECOMPUTED here with the same Math.round(v * 100)
 * candidateBlock uses, because the prompt carries rounded integers while the
 * DB carries fractions; comparing against the raw fraction would reject the
 * very number the model was shown. avg_wage is deliberately absent: it is
 * fetched into the candidate row but never rendered into the prompt, so a
 * rationale quoting a wage figure genuinely has no source.
 */
function citableNumbers(c) {
  const out = new Set();
  for (const n of numbersIn(c.company_name_display)) out.add(n);
  if (c.sponsor) {
    const s = c.sponsor;
    if (s.filing_count_last_fy != null) out.add(Number(s.filing_count_last_fy));
    if (s.source_fiscal_year != null) out.add(Number(s.source_fiscal_year));
    if (s.source_quarter != null) out.add(Number(s.source_quarter));
    for (const [, v] of Object.entries(s.wage_level_distribution || {})) {
      if (Number(v) > 0) out.add(Math.round(Number(v) * 100));
    }
  }
  return out;
}

/**
 * The validator that makes 20's grounding rule real. Checks each result
 * against the rows actually passed in — not against the prompt's wording.
 *
 * `extraNumbers` is the set of numbers the rest of the prompt legitimately
 * contains (the target spec's own prose, which is free-text and can carry
 * figures like "5+ years"). Numbers there are allowed everywhere; everything
 * else must trace to the company the result is about.
 */
function makeValidator(candidates, max, extraNumbers = new Set(), specTerms = new Set()) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const citableById = new Map(candidates.map((c) => [c.id, citableNumbers(c)]));
  const terms = [...specTerms].filter(Boolean);
  return function validate(p) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.results)) return 'results must be an array';
    if (p.results.length > max) return `at most ${max} results, got ${p.results.length}`;
    const seen = new Set();
    for (const r of p.results) {
      if (!r || typeof r !== 'object') return 'each result must be an object';
      const c = byId.get(r.company_id);
      if (!c) return `company_id "${r.company_id}" is not one of the candidate companies`;
      if (seen.has(r.company_id)) return `duplicate company_id "${r.company_id}"`;
      seen.add(r.company_id);
      if (!WATCHLIST_EVIDENCE_TYPES.includes(r.evidence_type)) return `unknown evidence_type "${r.evidence_type}"`;
      if (typeof r.rationale !== 'string' || r.rationale.trim().length < CFG.minRationaleChars) {
        return `result for "${r.company_id}" has no real rationale`;
      }
      // The grounding check proper: the cited evidence must EXIST for that
      // company in the data the model was given.
      if (r.evidence_type === 'visa_sponsor' && !c.sponsor) {
        return `result for "${c.company_name_display}" cites visa_sponsor evidence, but that company has no filing record in the candidate data`;
      }
      if (r.evidence_type === 'sector' && !c.sectors.length) {
        return `result for "${c.company_name_display}" cites sector evidence, but that company has no sectors in the candidate data`;
      }
      // resume_match had NO existence check at all, and that was the hole the
      // other two types' checks made conspicuous. Candidate rows carry no
      // résumé data, so there is nothing on the company side to check against —
      // which left the widest evidence type as the only ungrounded one, exactly
      // where the no-free-text path steers the model ("lead with sector and
      // resume_match evidence"). The predictable result was a templated
      // sentence: "X aligns with the candidate's domain focus in Y and role
      // family in Z", repeated with substitutions, clearing the 20-character
      // floor and citing nothing.
      //
      // The overlap it claims IS checkable, just from the other side: the
      // target spec's own domain_focus and role_families. Requiring the
      // rationale to name one of them is the same rule the other two types
      // already obey — cite something from the data you were given — and it
      // turns the template from a loophole into the minimum bar.
      if (r.evidence_type === 'resume_match' && terms.length) {
        const prose = r.rationale.toLowerCase();
        if (!terms.some((t) => prose.includes(t))) {
          return (
            `result for "${c.company_name_display}" cites resume_match evidence but names no specific overlap. ` +
            `Name at least one of the candidate's actual domain-focus or role-family terms (${terms.join(', ')}), ` +
            'or use a different evidence type.'
          );
        }
      }
      if (typeof r.rank !== 'number' || r.rank < 1) return `result for "${c.company_name_display}" has an invalid rank`;
      // Numeric grounding (16.8): a number written into the prose must be a
      // number this company's own data actually contains. Structural checks
      // above prove the company HAS a filing record; without this one, the
      // model could still invent that record's contents — a fabricated
      // filing count reads exactly as authoritative as a real one, and
      // CLAUDE.md's never-fabricate rule does not stop at résumé content.
      // On a mismatch this rides 16.8's existing path: the returned string is
      // fed back verbatim on structuredCall's single retry, and a second
      // failure throws 502 rather than persisting the rationale.
      const citable = citableById.get(r.company_id);
      for (const n of numbersIn(r.rationale)) {
        if (citable.has(n) || extraNumbers.has(n)) continue;
        const available = [...citable].sort((a, b) => a - b).join(', ') || 'none';
        return (
          `result for "${c.company_name_display}" cites the number ${n} in its rationale, ` +
          `which does not appear in that company's data (available: ${available}). ` +
          'Cite only figures shown for that company, exactly as shown.'
        );
      }

    }
    return null;
  };
}

// --- orchestration ---------------------------------------------------------

/**
 * Run one curate pass and stage the results.
 *
 * @returns {Promise<{suggestions: Array, spec: object, usages: Array, candidatesConsidered: number}>}
 */
// `onProgress(step, label)` and `onUsage(usage)` (both optional) report as
// each stage finishes rather than only on success, so a run that fails at the
// ranking call still shows where it got to and still logs the AI call it
// already paid for.
async function curateWatchlist(db, userId, { freeText = '', profile, user, credential, onProgress = async () => {}, onUsage = async () => {} }) {
  const usages = [];
  const recordUsage = async (u) => {
    usages.push(u);
    await onUsage(u);
  };

  await onProgress('spec', freeText.trim() ? `Reading your steer: “${freeText.trim().slice(0, 80)}”` : 'Reading your résumé (no steer given)');
  const specResult = await extractTargetSpec({ profile, user, freeText, credential });
  await recordUsage({
    actionType: 'watchlist_target_spec',
    model: specResult.model,
    connectionMode: specResult.connectionMode,
    usage: specResult.usage,
    costUsd: specResult.costUsd,
    tier: 'cheap',
  });
  const spec = specResult.spec;
  await onProgress(
    'spec_done',
    `Target: ${(spec.role_families || []).join(', ') || 'roles from your résumé'}` +
      (spec.domain_focus && spec.domain_focus.length ? ` in ${spec.domain_focus.join(', ')}` : '') +
      (spec.sponsorship_required ? ' · sponsorship required' : '')
  );

  await onProgress('candidates', 'Screening registry companies by sector and sponsorship record');
  const candidates = await buildCandidateSlice(db, userId, spec);
  if (!candidates.length) {
    await onProgress('candidates_done', 'No untracked, undecided companies matched that target');
    return { suggestions: [], spec, usages, candidatesConsidered: 0 };
  }
  await onProgress('candidates_done', `${candidates.length} candidate companies shortlisted`);
  await onProgress('rank', `Ranking ${candidates.length} companies with AI`);

  const max = CFG.maxSuggestions;
  const specJson = JSON.stringify(spec);
  const prompt = [
    'TARGET SPEC (from the candidate profile and their own words):',
    specJson,
    '',
    candidateBlock(candidates),
  ].join('\n');

  // The spec half of the prompt is free-text the cheap tier wrote ("5+ years
  // in fintech"), so a figure quoted back from it is grounded even though it
  // belongs to no company. Allowing those keeps the numeric check from
  // rejecting a legitimate rationale — a false rejection burns the single
  // 16.8 retry and can fail the whole curate call.
  const specNumbers = new Set(numbersIn(specJson));

  // What a resume_match rationale is allowed to claim an overlap WITH. The
  // spec's own domain focus and role families are the only résumé-side facts
  // in this call, so they are the only checkable ones. Multi-word entries are
  // kept whole AND split, so "technical program management" is satisfied by a
  // rationale naming "program management" but not by one naming nothing.
  const specTerms = new Set();
  for (const raw of [...(spec.domain_focus || []), ...(spec.role_families || [])]) {
    const term = String(raw || '').toLowerCase().trim();
    if (term.length > 2) specTerms.add(term);
    for (const word of term.split(/[^a-z0-9]+/)) {
      if (word.length > 3) specTerms.add(word);
    }
  }

  const result = await aiRouter.structuredCall(credential, {
    tier: 'strong',
    systemInstruction: CURATE_SYSTEM_INSTRUCTION(max, !!spec.sponsorship_required),
    prompt,
    responseSchema: CURATE_SCHEMA,
    validate: makeValidator(candidates, max, specNumbers, specTerms),
  });
  await recordUsage({
    actionType: 'watchlist_curate',
    model: result.model,
    connectionMode: result.connectionMode,
    usage: result.usage,
    costUsd: result.costUsd,
    tier: 'strong',
  });

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ranked = result.parsed.results.slice().sort((a, b) => a.rank - b.rank);

  // Staged, never auto-saved (spec 20 step 3). These are pending rows the user
  // accepts or rejects individually — nothing touches tracklist_companies here.
  const rows = ranked.map((r, i) => ({
    user_id: userId,
    company_ats_registry_id: r.company_id,
    rank: i + 1,
    rationale: r.rationale.trim(),
    evidence_type: r.evidence_type,
    status: 'pending',
    run_input: freeText && freeText.trim() ? freeText.trim() : null,
    decided_at: null,
    // Re-staging a company from an earlier run must move it to THIS run —
    // the card groups by run and orders newest first by created_at.
    created_at: new Date().toISOString(),
  }));

  if (rows.length) {
    const { error } = await db.from('watchlist_suggestions').upsert(rows, { onConflict: 'user_id,company_ats_registry_id' });
    if (error) throw new Error(`staging watchlist suggestions failed: ${error.message}`);
  }
  await onProgress('saved', rows.length ? `Saved ${rows.length} suggestion${rows.length === 1 ? '' : 's'} for you to review` : 'The AI found no strong fits among the shortlist');

  const suggestions = rows.map((row) => {
    const c = byId.get(row.company_ats_registry_id);
    return { ...row, company: { id: c.id, name: c.company_name_display, platform: c.platform, sectors: c.sectors, sponsor: c.sponsor } };
  });

  return { suggestions, spec, usages, candidatesConsidered: candidates.length };
}

module.exports = {
  curateWatchlist,
  extractTargetSpec,
  buildCandidateSlice,
  makeValidator,
  CURATE_SCHEMA,
  SPEC_SCHEMA,
};

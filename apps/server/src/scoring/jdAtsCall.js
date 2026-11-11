const aiRouter = require('../lib/aiRouter');
const tunables = require('@careeros/shared/src/tunables.json');
const { sanitizeJdProfile } = require('@careeros/shared');
const jdProfileCache = require('./jdProfileCache');

// Call 1 (spec 5.6 "Call composition"): extract the structured JD profile
// (16.3) from the JOB DESCRIPTION ALONE. ATS Match is the deterministic
// keyword coverage computed afterwards (calculateKeywordMatch, 5.1) — this
// call no longer sees the candidate's résumé at all. Showing the model the
// résumé's skills while asking it to list the JD's skills biased what it
// extracted toward terms the candidate already had, which is one way a
// posting came back with 2-3 keywords, all matched: "2/2 · 10/10".
//
// Tier and sample count are `tunables.scoring.jdExtraction`, not hardcoded —
// this used to pin `tier: 'cheap'` inline, so changing the model this stage
// runs on meant editing code. See runJdAts for what the measurements say
// about why the sample count matters more than the tier does.

// 16.3 JD profile shape as a Gemini responseSchema.
const JD_ATS_SCHEMA = {
  type: 'object',
  properties: {
    jd_profile: {
      type: 'object',
      properties: {
        required_skills: { type: 'array', items: { type: 'string' } },
        nice_to_have_skills: { type: 'array', items: { type: 'string' } },
        any_of_groups: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        years_required: { type: 'number', nullable: true },
        seniority_signals: { type: 'array', items: { type: 'string' } },
        responsibilities: { type: 'array', items: { type: 'string' } },
        salary_range: {
          type: 'object',
          properties: {
            min: { type: 'number', nullable: true },
            max: { type: 'number', nullable: true },
          },
          required: ['min', 'max'],
        },
        remote_policy: { type: 'string', nullable: true },
      },
      required: [
        'required_skills',
        'nice_to_have_skills',
        'any_of_groups',
        'years_required',
        'seniority_signals',
        'responsibilities',
        'salary_range',
        'remote_policy',
      ],
    },
  },
  required: ['jd_profile'],
};

const SYSTEM_INSTRUCTION = [
  'You are the JD-understanding stage of a job-fit scoring system. You see only the job posting — never a candidate.',
  'Extract a structured JD profile from the job description — required vs nice-to-have skills, years required, seniority signals, responsibilities, salary range, and remote policy.',
  '   - Use ONLY what the JD states. If a field is not stated, use null (years_required, salary min/max, remote_policy) or an empty array (skill/signal/responsibility lists). Never invent requirements.',
  '   - required_skills / nice_to_have_skills hold ONLY concrete, nameable skills: a tool, technology, platform, language, methodology, certification, or a specific measurable ability (e.g. "SQL", "Project Management", "Root Cause Analysis", "AWS"). Each entry must be a self-contained term someone could literally have or not have — never a sentence fragment.',
  '   - DO NOT extract education/degree requirements ("Bachelor\'s degree", "MBA", "related field", "or equivalent experience"), spoken languages ("English", "Fluent in Mandarin"), people-management or enrollment requirements, work authorization/visa/citizenship/clearance requirements, or bare years-of-experience phrases ("3+ years") — these are judged separately as hard requirements, never put in the skill lists.',
  '   - Extract ONLY from the role\'s qualifications, requirements, and responsibilities. Never from the company description, the product/mission blurb, benefits, or EEO text — a skill the company\'s product uses is not a requirement of the candidate.',
  '   - ALTERNATIVES: when the posting offers a list of alternatives any one of which satisfies the requirement ("5+ years of product or program management, product marketing, business development or technology experience", "Python, Java, or Go"), put the alternatives together as ONE entry in any_of_groups (e.g. ["product management", "program management", "product marketing", "business development"]) and NOT in required_skills. required_skills is only for terms the posting asks for individually.',
  '   - A list of example TOOLS or products is NOT a list of alternatives, even when it ends in "or similar" or "etc.": "project management tools like Smartsheet, Confluence, Tableau, Lucid, Jira, Microsoft Excel/PowerPoint/Word, Google Docs/Sheets/Slides etc." and "platforms such as monday.com, Asana, Smartsheet, ClickUp, or similar tools" put EACH named tool in required_skills (or nice_to_have_skills) as its own entry — an ATS scans for each one. any_of_groups is only for alternative functions, fields of experience, languages, or credentials where the posting says one of them is required.',
  '   - A single generic word is not a skill ("building", "planning", "execution", "travel", "chat", "messaging", "workflows"). Neither is "<something> experience" filler ("technology experience", "industry experience").',
  '   - EVERY TERM IS WHAT A RECRUITER TYPES INTO AN ATS SEARCH BOX: a 1-3 word noun phrase naming a tool, method, practice, domain, or credential ("product backlog", "acceptance criteria", "data governance", "SQL", "Lean", "CAPM"). Never copy a qualification bullet or a clause as a term — "Familiarity with customer research methods and a willingness to learn" yields "customer research"; "Exposure to developing data products in an agile environment with cross-functional teams" yields "data products" and "agile".',
  '   - Drop the context word a posting wraps around a skill: "agile environment" -> "Agile", "Agile development methodologies" -> "Agile", "lean methodologies" -> "Lean", "BI tools" -> "BI", "data warehousing solutions" -> "data warehousing", "UAT testing" -> "UAT", "AI and low-code tooling" -> "AI", "low-code".',
  '   - Personal traits are never skills, however they are phrased: thinking of any kind ("strategic and critical thinking"), acumen, storytelling or visual communication, curiosity, creativity, judgment, decision making, delegating, accountability, empathy, organization, "ability to work through ambiguity". Neither are vague business phrases ("business vision and priorities", "customer and user problem spaces", "data and analysis", "digital technologies", "delivery teams").',
  '   - Read the RESPONSIBILITIES as carefully as the qualifications: the concrete practices the role performs ("prioritize the product backlog", "write acceptance criteria", "own the product roadmap", "translate needs into user stories", "define success metrics / KPIs") are the keywords an ATS searches for, even when the qualifications section is all traits.',
  '   - Examples that describe how deeply to know ONE named tool are not separate requirements: "Excel at an intermediate level (e.g., pivot tables & charts, multiple criteria lookups, nested IF formulas, array formulas)" yields "Excel" and at most one widely-searched feature ("pivot tables") — never each feature. This differs from a CATEGORY with named examples ("operational tools such as Notion, Linear, Excel"), where each named tool IS the keyword.',
  '   - CERTIFICATION ALTERNATIVES are one requirement: "CAPM or equivalent (Lean Six Sigma Green Belt and/or Black Belt or Master Change Agent)" is ONE any_of_groups entry ["CAPM", "Lean Six Sigma Green Belt", "Lean Six Sigma Black Belt", "Master Change Agent"], never separate skills.',
  '   - any_of_groups never holds degree fields ("Bachelor\'s in Business Administration, Marketing, Finance, Computer Science") or an escape clause ("equivalent experience", "a similar role", "related field") — those are credentials, judged separately.',
  '   - When a sentence combines a degree requirement with a fallback clause (e.g. "Bachelor\'s degree in Engineering or a related field/equivalent experience"), extract NOTHING from it as a skill — the whole clause is a credential requirement, not a skill, and its filler half ("a related field", "equivalent experience") is not a skill either.',
  '   - Do not split one requirement into multiple fragments.',
  '   - Favor RECALL, not caution, on extraction of NAMEABLE terms: if the JD explicitly names a skill, tool, methodology, or practice — including process/collaboration practices like "cross-team collaboration", "program management", "process optimization" — extract it using the JD\'s own wording (trimmed to the searchable noun phrase described above), even if it is not a "hard tool." A separate deterministic pass after this call verifies every extracted term is actually grounded in the JD\'s own text and discards anything that is not, so it is safe and preferred to extract generously here rather than conservatively — under-extraction (missing a real, explicitly-stated requirement) is the failure to avoid, not over-extraction.',
  '   - When the JD names a category together with specific examples (e.g. "operational tools such as Notion, Linear, Excel", "a language like Python or Java"), extract the NAMED examples as separate skill entries ("Notion", "Linear", "Excel"), NOT the umbrella category alone ("operational tools"). Downstream matching is a literal string check against the candidate\'s résumé — a candidate who lists "Excel" gets no credit for a requirement recorded only as the vague category name, even though the JD itself named the exact tool they have.',
  '   - An ordinary posting names 4-15 such terms across its qualifications and responsibilities. Returning only 1-2 almost always means requirements were missed — reread the qualifications, responsibilities, and "you have / you will" sections before answering.',
  'Return strict JSON matching the schema.',
].join('\n');

// Second pass, run only when the first extraction's cleaned list came back
// below tunables.scoring.jdExtraction.minKeywords (strong tier, once per job).
const RECALL_INSTRUCTION = [
  SYSTEM_INSTRUCTION,
  'RECALL PASS: a first extraction of this posting kept too few skills (listed below). Find the concrete, nameable skills, tools, methods, and domain practices the posting states that it MISSED — especially in the qualifications and responsibilities. Use the posting\'s own wording. Return the full profile; the skill lists may repeat the ones already found.',
].join('\n');

function validateJdAts(p) {
  if (!p || typeof p !== 'object') return 'root is not an object';
  const jd = p.jd_profile;
  if (!jd || typeof jd !== 'object') return 'jd_profile must be an object';
  for (const key of ['required_skills', 'nice_to_have_skills', 'seniority_signals', 'responsibilities']) {
    if (!Array.isArray(jd[key])) return `jd_profile.${key} must be an array`;
  }
  if (jd.years_required != null && typeof jd.years_required !== 'number') {
    return 'jd_profile.years_required must be a number or null';
  }
  if (!jd.salary_range || typeof jd.salary_range !== 'object') {
    return 'jd_profile.salary_range must be an object';
  }
  return null;
}

// Compact, deterministic résumé skills view — identical across every job in a
// batch (stable serialization) so it caches. ATS is mechanical, so skills are
// the relevant surface, not full bullet prose.
function buildResumeSkillsBlock(profile) {
  const declared = profile.skills_declared || [];
  const demonstrated = new Set();
  for (const role of profile.roles || []) {
    for (const b of role.bullets || []) {
      for (const s of b.skills_demonstrated || []) demonstrated.add(s);
    }
  }
  for (const proj of profile.projects || []) {
    for (const b of proj.bullets || []) {
      for (const s of b.skills_demonstrated || []) demonstrated.add(s);
    }
  }
  const certs = profile.certifications || [];
  return [
    'CANDIDATE RÉSUMÉ SKILLS (fixed context for this scan batch):',
    `Declared skills: ${declared.join(', ') || '(none listed)'}`,
    `Demonstrated skills (from bullet points): ${[...demonstrated].join(', ') || '(none)'}`,
    `Certifications: ${certs.join(', ') || '(none)'}`,
  ].join('\n');
}

// Grounding, named-example expansion, junk-term filtering, and atomization
// all moved into packages/shared/src/ats/keywordPipeline.js (2026-08-13
// root-cause pass) as ONE pipeline (sanitizeJdProfile) run once, in
// scoreJob.js, instead of grounding happening here (extraction-time) and
// atomization happening separately at scoreJob.js write path with no
// re-grounding of the atoms it produced -- that split ordering was itself a
// source of bugs (an atom the splitter manufactured was never re-checked
// against the JD own text). This call now returns the model raw jd_profile
// untouched; call 2 (fitCall.js) still receives that same raw profile
// verbatim (unchanged, as before), and scoreJob.js is the one and only
// place sanitizeJdProfile runs at write time.


/**
 * Run call 1. Returns { jdProfile, atsMatch, usage, costUsd, model, connectionMode, tier }.
 * Throws (via structuredCall) if output fails validation after one retry (16.8).
 * `credential` (aiRouter.resolveAiCredential) picks CAI vs the user's BYOK provider (13.3).
 * `jobTitle` (2026-08-14, optional) — prepended ahead of the JD body so the
 * extractor sees the single strongest signal of what the role actually is,
 * and so a requirement that only ever appears in the title (confirmed live:
 * 29% of scored jobs had their own title absent from the body text) can
 * still be extracted and later survive grounding (keywordPipeline.js's
 * jdGroundingText grounds against this same title+body combination). Placed
 * AFTER resumeSkillsBlock so the stable cached prompt prefix (5.6) is
 * unchanged — only the per-job tail grows.
 */
// Skill extraction is NOT reproducible from a single call, and no model choice
// makes it so. Measured on four real postings, three runs each, temperature
// already 0: two identical runs agree on only 42-67% of the skills they
// extract (cheap tier), and the strong tier is WORSE on agreement (29%) even
// though it finds more per run — it sees a larger candidate pool and samples a
// different part of it each time. Roughly one run in five came back completely
// empty on some postings. So a single sample is a coin-flip about which
// subset of a JD's requirements gets scored, which is what made one job read
// "10.0 · 0/0" while the same JD re-run produced six skills.
//
// The fix is to stop depending on one sample: run the extraction `samples`
// times and UNION the skill lists. Union is safe here specifically because
// keywordPipeline.sanitizeJdProfile independently grounds every term against
// the JD's own text afterwards and drops anything not literally attested —
// so a union can raise recall but cannot admit a hallucination. Two cheap
// samples cost about the same as one strong call and find more than it does.
//
// Union raises RECALL; it does not make the result deterministic (measured:
// union-of-2 agreement 62%, no better than a single run's 67%). Genuine
// run-to-run stability would need the result cached against a hash of the JD
// text, which is a schema change and is recorded in the changelog as the
// remaining gap rather than pretended away here.
const DEFAULT_EXTRACTION = { tier: 'cheap', samples: 2, minKeywords: 4, minCacheableKeywords: 3 };

function extractionSettings(overrides) {
  const configured = (tunables.scoring && tunables.scoring.jdExtraction) || {};
  // Only REAL overrides may win. Spreading the caller's object wholesale lets
  // an absent argument (`runJdAts({...})` with no tier/samples, which is every
  // production call site) spread `undefined` over the configured value and
  // silently reset it to the floor — the configured samples:2 ran as 1.
  const explicit = Object.fromEntries(Object.entries(overrides || {}).filter(([, v]) => v !== undefined));
  const merged = { ...DEFAULT_EXTRACTION, ...configured, ...explicit };
  const samples = Math.max(1, Math.min(4, Number(merged.samples) || 1));
  return {
    tier: merged.tier === 'strong' ? 'strong' : 'cheap',
    samples,
    minKeywords: Number(merged.minKeywords) || 0,
    minCacheableKeywords: Number(merged.minCacheableKeywords) || 0,
  };
}

// Several samples may each read a years bar; the posting's bar is the lowest
// one any reading found (a range's lower bound, the basic-qualifications line).
function minYears(profiles) {
  const ys = profiles.map((p) => p && p.years_required).filter((y) => typeof y === 'number' && y > 0);
  return ys.length ? Math.min(...ys) : null;
}

function mergeProfiles(profiles) {
  const required = unionSkills(profiles.map((p) => p.required_skills));
  const requiredKeys = new Set(required.map((s) => s.toLowerCase()));
  const nice = unionSkills(profiles.map((p) => p.nice_to_have_skills)).filter((s) => !requiredKeys.has(s.toLowerCase()));
  // Everything that isn't a list or the years bar stays with the first
  // sample — averaging a salary range or picking between two remote policies
  // would invent a value no single reading of the JD supports.
  return { ...profiles[0], required_skills: required, nice_to_have_skills: nice, any_of_groups: unionGroups(profiles), years_required: minYears(profiles) };
}

// Alternative groups from every sample, one copy of each distinct member set.
function unionGroups(profiles) {
  const seen = new Set();
  const out = [];
  for (const p of profiles) {
    for (const g of (p && p.any_of_groups) || []) {
      const members = unionSkills([g]);
      if (!members.length) continue;
      const key = members.map((m) => m.toLowerCase()).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(members);
    }
  }
  return out;
}

function cleanedCount(jdProfile, groundingText) {
  const s = sanitizeJdProfile(jdProfile, groundingText);
  return (s.required_skills || []).length + (s.nice_to_have_skills || []).length + (s.any_of_groups || []).length;
}

function unionSkills(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const raw of list || []) {
      const s = String(raw || '').trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

// Identifies THIS prompt, so editing the system instruction invalidates every
// cached extraction rather than leaving rows the current prompt would never
// have produced.
const PROMPT_FINGERPRINT = `${(tunables.scoring && tunables.scoring.promptVersion) || 'v0'}:${jdProfileCache
  .sha256(SYSTEM_INSTRUCTION)
  .slice(0, 12)}`;

// Whether this call can be cached, and under what key.
//
// Its own function because the ternary this replaced was the quietest possible
// failure: caching is opt-in on `db && userId`, so a caller that passed a db
// but an UNDEFINED user id got no key, no read, no write, and no complaint.
// That is exactly what happened — `jobScorer` passed `user.id` from a `users`
// row SELECTed without `id`, and the cache sat inert through a 163-job scan
// while looking, from every angle including the table, indistinguishable from
// a cache that was merely cold.
//
// Passing no db at all is a legitimate mode (one-off scripts, the offline
// verification harness), so that stays silent. Passing a db WITHOUT a user is
// always a wiring mistake, and now says so.
function cacheKeyFor({ db, userId, jdText, resumeSkillsBlock, settings }) {
  if (!db) return null;
  if (!userId) {
    console.warn(
      '[jdAtsCall] extraction cache disabled for this call: a db handle was passed but no userId. ' +
        'This is a wiring bug — the same JD will re-extract to a different skill set every run.'
    );
    return null;
  }
  return jdProfileCache.buildCacheKey({
    jdText,
    resumeSkillsBlock,
    settings,
    promptVersion: PROMPT_FINGERPRINT,
  });
}

async function runJdAts({
  jobTitle,
  jobText,
  credential,
  tier,
  samples,
  // Caching is opt-in by passing a db handle and a user id. Without them this
  // behaves exactly as it always did, which is what keeps one-off scripts and
  // the offline verification harness working unchanged.
  db = null,
  userId = null,
  cacheText = null,
  forceRefresh = false,
}) {
  const settings = extractionSettings({ tier, samples });
  const titleLine = jobTitle ? `JOB TITLE: ${jobTitle}\n\n` : '';
  const prompt = `${titleLine}JOB DESCRIPTION TO ANALYZE:\n\n${jobText}`;

  // The cached answer must be keyed on the SAME text grounding runs against
  // (title + body), not the body alone — otherwise two postings sharing a
  // description but not a title would collide. No résumé in the key: the
  // extraction no longer depends on the candidate.
  const keyText = cacheText || `${jobTitle || ''}\n${jobText || ''}`;
  const cacheKey = cacheKeyFor({
    db,
    userId,
    jdText: keyText,
    resumeSkillsBlock: null,
    settings,
  });

  if (cacheKey && !forceRefresh) {
    const hit = await jdProfileCache.get(db, userId, cacheKey);
    if (hit) {
      return {
        jdProfile: hit.jdProfile,
        atsMatch: null,
        usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0, attempts: 0, raw: [] },
        costUsd: 0,
        model: hit.model,
        connectionMode: null,
        tier: settings.tier,
        samples: 0,
        fromCache: true,
      };
    }
  }

  const call = (systemInstruction, callTier, callPrompt) =>
    aiRouter.structuredCall(credential, {
      tier: callTier,
      systemInstruction,
      prompt: callPrompt,
      responseSchema: JD_ATS_SCHEMA,
      validate: validateJdAts,
      timeoutMs: tunables.scoring.callTimeoutMs,
    });

  const results = [await call(SYSTEM_INSTRUCTION, settings.tier, prompt)];
  for (let i = 1; i < settings.samples; i++) {
    // A failed extra sample must never fail the job: the first result already
    // stands on its own, and extra samples exist only to widen it.
    try {
      results.push(await call(SYSTEM_INSTRUCTION, settings.tier, prompt));
    } catch (e) {
      console.warn(`runJdAts: sample ${i + 1} failed, continuing with ${results.length} — ${e.message}`);
    }
  }

  let jdProfile = mergeProfiles(results.map((r) => r.parsed.jd_profile));

  // Minimum-keyword floor: a posting whose CLEANED list (after grounding and
  // junk-filtering — the list actually scored) is this thin was almost always
  // under-read, not genuinely requirement-free. One strong-tier recall pass,
  // told what was already found; its terms go through the same grounding, so
  // it can widen the list but never admit a term the posting doesn't state.
  let recallRan = false;
  if (settings.minKeywords && cleanedCount(jdProfile, keyText) < settings.minKeywords) {
    try {
      const found = [...jdProfile.required_skills, ...jdProfile.nice_to_have_skills];
      const recallPrompt = `ALREADY FOUND: ${found.join(', ') || '(nothing)'}\n\n---\n\n${prompt}`;
      results.push(await call(RECALL_INSTRUCTION, 'strong', recallPrompt));
      jdProfile = mergeProfiles(results.map((r) => r.parsed.jd_profile));
      recallRan = true;
    } catch (e) {
      console.warn(`runJdAts: recall pass failed, keeping ${cleanedCount(jdProfile, keyText)} term(s) — ${e.message}`);
    }
  }
  const sum = (f) => results.reduce((a, r) => a + (Number(f(r)) || 0), 0);

  // A thin extraction is not cached: caching it would replay the same
  // under-read every time the posting is re-scanned.
  if (cacheKey && cleanedCount(jdProfile, keyText) >= settings.minCacheableKeywords) {
    await jdProfileCache.put(db, userId, {
      cacheKey,
      jdHash: jdProfileCache.hashJdText(keyText),
      jdProfile,
      atsMatch: null,
      model: results[0].model,
      promptVersion: PROMPT_FINGERPRINT,
    });
  }

  return {
    jdProfile,
    atsMatch: null,
    recallRan,
    usage: results
      .map((r) => r.usage)
      .reduce((a, u) => ({
        input_tokens: (a.input_tokens || 0) + (u.input_tokens || 0),
        output_tokens: (a.output_tokens || 0) + (u.output_tokens || 0),
        cached_tokens: (a.cached_tokens || 0) + (u.cached_tokens || 0),
        total_tokens: (a.total_tokens || 0) + (u.total_tokens || 0),
        attempts: (a.attempts || 0) + (u.attempts || 0),
        raw: [...(a.raw || []), ...(u.raw || [])],
      })),
    costUsd: sum((r) => r.costUsd),
    model: results[0].model,
    connectionMode: results[0].connectionMode,
    tier: settings.tier,
    samples: results.length,
  };
}

module.exports = {
  runJdAts,
  buildResumeSkillsBlock,
  validateJdAts,
  JD_ATS_SCHEMA,
  extractionSettings,
  unionSkills,
  cacheKeyFor,
  PROMPT_FINGERPRINT,
};

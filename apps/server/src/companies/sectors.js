// Sector classification + system sector tracklists (spec 4.6.9). Phase 4,
// §15 #25b, third of the 25a-25d split.
//
// A cheap-tier, batched AI call assigns each company one or more sectors (up
// to MAX_SECTORS_PER_COMPANY) from a fixed
// list (packages/shared/src/constants.js's COMPANY_SECTORS) — the one
// deliberate exception to 4.6's no-AI-in-detection principle, since "what
// industry is this company in" is a semantic judgment, unlike the fully
// deterministic platform/slug detection in registry.js. Two callers:
//   - scripts/classify-sectors.js — the one-time bulk pass over the existing
//     registry.
//   - registry.js/resweep.js — the going-forward detection-time hook, fired
//     only on a genuinely NEW company_ats_registry row (never a re-sighting).
//
// Follows the house helper-module shape: a plain module taking the supabase
// client as its first argument (no DAO layer exists in this codebase).
//
// COST/BILLING: every classification call is platform overhead per spec
// 4.6.9 — "not billed to any user ... logged to ai_usage_log ... absorbed as
// platform overhead". logSectorUsage() writes ai_usage_log with user_id: null
// (20260807010000 made that column nullable for exactly this) and this module
// never calls cosGuard.debitCos — COS billing is never implicit in this
// codebase, so simply not calling it IS the "unbilled" mechanism (same
// pattern as routes/resume.js's free résumé parse).

const aiRouter = require('../lib/aiRouter');
const { constants } = require('@careeros/shared');
const { COMPANY_SECTORS, COMPANY_SECTOR_LABELS, MAX_SECTORS_PER_COMPANY, SECTOR_CLASSIFIER_VERSION } = constants;

const SECTOR_SET = new Set(COMPANY_SECTORS);

// Platform-overhead calls never resolve a per-user BYOK credential — 4.6.9
// draws no distinction by provider, and there is no user in scope to resolve
// one for. Always the house model.
const PLATFORM_CREDENTIAL = { mode: 'cai' };

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          company_id: { type: 'string' },
          sectors: { type: 'array', items: { type: 'string', enum: COMPANY_SECTORS } },
        },
        required: ['company_id', 'sectors'],
      },
    },
  },
  required: ['results'],
};

const SYSTEM_INSTRUCTION = [
  'You classify companies into industry sectors for a job-search platform\'s company directory.',
  `You are given a batch of companies (id, display name, and — where known — the ATS platform/board slug they post jobs on). Assign each company 1 to ${MAX_SECTORS_PER_COMPANY} sectors from this FIXED list, using only these exact keys:`,
  COMPANY_SECTORS.map((s) => `- ${s}`).join('\n'),
  'Disambiguation guidance for the common overlaps:',
  '- enterprise_saas vs devtools vs ai_ml: enterprise_saas is horizontal business software (CRM, HR, ops) sold to other companies; devtools is specifically for software engineers building/shipping software (CI/CD, observability, dev infra, API platforms); ai_ml is a company whose core product/value proposition IS an AI/ML model or AI-native application, not a company merely using AI internally.',
  '- consumer vs ecommerce: ecommerce is specifically buying/selling physical or digital goods online (marketplaces, D2C, retail infra); consumer is any other product primarily used by individual people for non-shopping purposes (social, fitness, personal finance apps, etc — note a pure consumer FINANCE app is fintech, not consumer).',
  '- biotech vs healthtech: biotech is life sciences / drug discovery / lab science; healthtech is software or hardware for clinical care, health insurance, or patient-facing health products.',
  '- hardware_semiconductors vs devtools vs enterprise_saas: hardware_semiconductors is a company whose product is PHYSICAL — chips, EDA/chip-design tooling, servers, networking gear, devices, electronics, instruments. A chip company is not enterprise_saas just because it sells to businesses, and not devtools just because engineers use its tools.',
  '- manufacturing_industrial: makes physical non-electronic goods at scale, or serves those who do — industrial equipment, machinery, materials, chemicals, automotive, construction, agriculture.',
  '- aerospace_defense: aviation, space, satellites, or defense/government-security contracting.',
  "- professional_services: sells human expertise as the product — consulting, agencies (marketing, advertising, design, PR), law, accounting, staffing and recruiting. A software company selling a tool is NOT professional_services; a firm selling people's time is.",
  '- nonprofit_government: nonprofits, NGOs, foundations, advocacy groups, political organizations, government agencies, public universities, museums, and research institutes. Mission rather than profit is the test.',
  '- food_hospitality: food and beverage production, restaurants, grocery, hotels, travel, and tourism.',
  'A company can genuinely span sectors, and large diversified companies genuinely span several. Assign EVERY sector the company demonstrably operates in as a real line of business — a conglomerate that sells retail, runs a logistics network, and sells cloud infrastructure gets all three, because dropping one would be a false statement about what that company does. Do not invent a sector to pad the list, but do not withhold one that is plainly true either: the failure this classifier has historically had is under-tagging real conglomerates, not over-tagging small companies. Assign as many sectors as are true and no more — let the count follow from the company, and do not aim for any particular number.',
  'The platform and slug tell you WHERE a company posts its jobs, not what it does. Never infer a sector from them: a company is not enterprise_saas because its board is hosted on a SaaS product, not devtools because its slug contains a technical word, and not any sector because its slug is a hosting hostname rather than a real name. Treat a slug that is a raw tenant identifier, a bare acronym, or a hosting domain as carrying NO information about the industry.',
  'If a company\'s industry cannot be determined with reasonable confidence from its name/platform data, use "other" — never invent a sector outside the fixed list, and never return an empty sectors array. "other" is the honest answer for a genuinely unidentifiable name (a bare acronym, a raw slug, a generic single word), and guessing on those is worse than admitting it. But do NOT reach for "other" on a company whose industry is clear and simply sits in one of the less obvious sectors above.',
  'Return strict JSON matching the schema, with exactly one result object per input company, using only the company_id values you were given.',
].join('\n');

function makeValidator(companyIds) {
  const idSet = new Set(companyIds);
  return function validate(p) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.results)) return 'results must be an array';
    for (const r of p.results) {
      if (!r || typeof r !== 'object') return 'each result must be an object';
      if (typeof r.company_id !== 'string' || !idSet.has(r.company_id)) {
        return `result.company_id "${r.company_id}" is not one of the input companies`;
      }
      if (!Array.isArray(r.sectors) || r.sectors.length === 0) {
        return `result for company_id "${r.company_id}" must have a non-empty sectors array`;
      }
      if (r.sectors.length > MAX_SECTORS_PER_COMPANY) {
        return `result for company_id "${r.company_id}" has more than ${MAX_SECTORS_PER_COMPANY} sectors`;
      }
      for (const s of r.sectors) {
        if (!SECTOR_SET.has(s)) return `result for company_id "${r.company_id}" has unknown sector "${s}"`;
      }
    }
    return null;
  };
}

/**
 * `other` means "this company's industry could not be determined" (4.6.9), so
 * it cannot coexist with a sector that WAS determined — a company tagged
 * `logistics, other` is claiming both to be known and unknown. Rare in
 * practice (2 of 500 in a live sample) but semantically wrong wherever it
 * happens, and it inflates the `other` share the gates report.
 *
 * Enforced here deterministically rather than left to the prompt: this is a
 * property of the vocabulary, not a judgement call, so it should not depend on
 * the model remembering it. Never empties the list — a lone `other` survives,
 * which is the honest answer for an unidentifiable name.
 */
function normalizeSectors(sectors) {
  const list = Array.from(new Set(sectors || []));
  if (list.length > 1 && list.includes('other')) return list.filter((s) => s !== 'other');
  return list;
}

function companiesBlock(companies) {
  return [
    'COMPANIES TO CLASSIFY:',
    ...companies.map((c) =>
      [`id=${c.id}`, `name=${c.company_name_display}`, `platform=${c.platform || '(unknown)'}`, `slug=${c.slug_or_identifier || '(unknown)'}`].join(
        ' | '
      )
    ),
  ].join('\n');
}

/**
 * One batched classification call. `companies` is a small-to-medium batch
 * (the bulk script and the detection-time fan-outs both cap batch size well
 * under any context-window concern).
 *
 * @param {Array<{id, company_name_display, platform, slug_or_identifier}>} companies
 * @returns {Promise<{byCompanyId: Map<string,string[]>, usage, costUsd, model, connectionMode}>}
 */
async function classifyCompanies(companies) {
  if (!companies || !companies.length) return { byCompanyId: new Map(), usage: null, costUsd: 0, model: null, connectionMode: null };

  const prompt = companiesBlock(companies);
  const validate = makeValidator(companies.map((c) => c.id));

  const result = await aiRouter.structuredCall(PLATFORM_CREDENTIAL, {
    tier: 'cheap',
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt,
    responseSchema: CLASSIFY_SCHEMA,
    validate,
  });

  const byCompanyId = new Map();
  for (const r of result.parsed.results) byCompanyId.set(r.company_id, normalizeSectors(r.sectors));

  return {
    byCompanyId,
    usage: result.usage,
    costUsd: result.costUsd,
    model: result.model,
    connectionMode: result.connectionMode,
  };
}

/**
 * Log one platform-overhead ai_usage_log row for a classification call.
 * user_id is deliberately null (never billed to any user, 4.6.9) — this is
 * the entire mechanism by which the call stays unbilled: nothing here ever
 * calls cosGuard.debitCos.
 */
async function logSectorUsage(db, result, { companyCount } = {}) {
  if (!result || !result.usage) return;
  const { error } = await db.from('ai_usage_log').insert({
    user_id: null,
    action_type: 'sector_classify',
    provider: 'gemini',
    connection_mode: result.connectionMode,
    model: result.model,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cached_tokens: result.usage.cached_tokens,
    total_tokens: result.usage.total_tokens,
    raw_usage: { ...result.usage.raw, companyCount },
    cost_usd: result.costUsd,
  });
  if (error) console.error('sector_classify ai_usage_log insert failed:', error.message);
}

/**
 * Fetch a company's current sector rows (sector + source), for idempotency
 * and admin-override checks.
 */
async function getCompanySectors(db, registryId) {
  const { data, error } = await db.from('company_sectors').select('sector, source').eq('company_ats_registry_id', registryId);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Replace a single company's sector assignment. Deletes rows no longer in
 * `sectors`, upserts the rest (company_sectors' unique index is plain, no
 * WHERE, so onConflict is safe here — unlike tracklists' partial indexes).
 * Then re-syncs that company's system-tracklist membership so the two stay
 * consistent (§4.6.9's "membership kept in sync by the classification
 * pipeline").
 *
 * @param {object} db
 * @param {string} registryId
 * @param {string[]} sectors
 * @param {{source: 'ai_bulk'|'ai_detect'|'admin'}} opts
 */
/**
 * @param {object} [opts]
 * @param {string} [opts.source]
 * @param {boolean} [opts.syncTracklists=true] set false ONLY for a bulk pass
 *   that will run one batched syncSectorTracklists over every touched id at the
 *   end. The per-company sync is ~4 extra round trips, which is nothing for the
 *   detection-time hook (one company at a time) and is the dominant cost of a
 *   registry-wide re-classification: measured at ~125 companies/minute against
 *   ~19,600 rows, it projected to 2.6 hours, essentially all of it tracklist
 *   bookkeeping being redone per company. Batched at the end instead, the same
 *   work is ~40 chunked queries. Defaults true so no existing caller changes
 *   behaviour by omission.
 */
async function applySectors(db, registryId, sectors, { source, syncTracklists = true } = {}) {
  const wanted = Array.from(new Set(sectors || []));

  const { data: existing, error: exErr } = await db.from('company_sectors').select('id, sector').eq('company_ats_registry_id', registryId);
  if (exErr) throw new Error(exErr.message);

  const wantedSet = new Set(wanted);
  const toDelete = (existing || []).filter((r) => !wantedSet.has(r.sector)).map((r) => r.id);
  if (toDelete.length) {
    const { error } = await db.from('company_sectors').delete().in('id', toDelete);
    if (error) throw new Error(error.message);
  }

  if (wanted.length) {
    // classifier_version/classified_at stamp WHICH generation of the classifier
    // produced these rows (4.6.9). This is what lets the bulk pass resume after
    // a crash and run in slices: the selector asks for companies whose rows
    // aren't at the current version, and a finished company answers that
    // question by carrying the stamp. Written on every upsert, including the
    // detection-time hook, so a company classified at detection is never
    // re-selected by the next bulk pass for no reason.
    const classifiedAt = new Date().toISOString();
    const rows = wanted.map((sector) => ({
      company_ats_registry_id: registryId,
      sector,
      source: source || 'ai_bulk',
      classifier_version: SECTOR_CLASSIFIER_VERSION,
      classified_at: classifiedAt,
    }));
    const { error } = await db
      .from('company_sectors')
      .upsert(rows, { onConflict: 'company_ats_registry_id,sector', ignoreDuplicates: false });
    if (error) throw new Error(error.message);
  }

  if (syncTracklists) await syncSectorTracklists(db, [registryId]);
}

// Process-lifetime cache of sector key -> system tracklist id. The system
// tracklists are seeded once at migration time and never renamed by users
// (system lists aren't user-editable, 4.6.9), so this never goes stale within
// a running process; a fresh deploy re-reads it on first use.
let systemTracklistIdCache = null;

async function systemTracklistIds(db) {
  if (systemTracklistIdCache) return systemTracklistIdCache;
  const { data, error } = await db.from('tracklists').select('id, name').eq('is_system', true);
  if (error) throw new Error(error.message);
  const labelToSector = new Map(Object.entries(COMPANY_SECTOR_LABELS).map(([sector, label]) => [label, sector]));
  const byId = new Map();
  for (const row of data || []) {
    const sector = labelToSector.get(row.name);
    if (sector) byId.set(sector, row.id);
  }
  systemTracklistIdCache = byId;
  return byId;
}

/**
 * Make tracklist_companies match company_sectors for the given registry ids —
 * insert missing system-list memberships, remove ones no longer warranted.
 * `registryIds` should be a small batch (single company or one classification
 * batch), not the whole registry, to keep each sync bounded.
 */
async function syncSectorTracklists(db, registryIds) {
  const ids = Array.from(new Set((registryIds || []).filter(Boolean)));
  if (!ids.length) return;

  const sectorToTracklist = await systemTracklistIds(db);
  const allTracklistIds = Array.from(sectorToTracklist.values());

  const [{ data: sectorRows, error: sErr }, { data: memberRows, error: mErr }] = await Promise.all([
    db.from('company_sectors').select('company_ats_registry_id, sector').in('company_ats_registry_id', ids),
    allTracklistIds.length
      ? db.from('tracklist_companies').select('id, tracklist_id, company_ats_registry_id').in('tracklist_id', allTracklistIds).in('company_ats_registry_id', ids)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (sErr) throw new Error(sErr.message);
  if (mErr) throw new Error(mErr.message);

  // Desired: for each registry id, the set of system-tracklist ids it should belong to.
  const desired = new Map(); // registryId -> Set<tracklistId>
  for (const row of sectorRows || []) {
    const tracklistId = sectorToTracklist.get(row.sector);
    if (!tracklistId) continue; // 'other' unmapped or a sector without a seeded list — shouldn't happen post-migration
    if (!desired.has(row.company_ats_registry_id)) desired.set(row.company_ats_registry_id, new Set());
    desired.get(row.company_ats_registry_id).add(tracklistId);
  }

  const currentByKey = new Map(); // `${registryId}:${tracklistId}` -> tracklist_companies.id
  for (const row of memberRows || []) currentByKey.set(`${row.company_ats_registry_id}:${row.tracklist_id}`, row.id);

  const toInsert = [];
  for (const registryId of ids) {
    const wantSet = desired.get(registryId) || new Set();
    for (const tracklistId of wantSet) {
      if (!currentByKey.has(`${registryId}:${tracklistId}`)) {
        toInsert.push({ tracklist_id: tracklistId, company_ats_registry_id: registryId });
      }
    }
  }
  const toDeleteIds = [];
  for (const [key, rowId] of currentByKey.entries()) {
    const [registryId, tracklistId] = key.split(':');
    const wantSet = desired.get(registryId) || new Set();
    if (!wantSet.has(tracklistId)) toDeleteIds.push(rowId);
  }

  if (toInsert.length) {
    const { error } = await db
      .from('tracklist_companies')
      .upsert(toInsert, { onConflict: 'tracklist_id,company_ats_registry_id', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }
  if (toDeleteIds.length) {
    const { error } = await db.from('tracklist_companies').delete().in('id', toDeleteIds);
    if (error) throw new Error(error.message);
  }
}

/**
 * The composed entry point every caller (bulk script, detection hooks) uses.
 * Classifies and applies sectors for a batch of companies in one AI call,
 * skipping companies that are already classified (unless force) and always
 * skipping companies an admin has manually overridden (source: 'admin') —
 * even under force, since an admin override exists specifically to survive
 * re-classification (see the company_sectors migration header).
 *
 * @param {object} db
 * @param {Array<{id, company_name_display, platform, slug_or_identifier}>} companies
 * @param {{source: 'ai_bulk'|'ai_detect', force?: boolean}} opts
 * @returns {Promise<{classified: number, skipped: number}>}
 */
async function classifyAndApply(db, companies, { source, force = false, syncTracklists = true } = {}) {
  const list = (companies || []).filter((c) => c && c.id);
  if (!list.length) return { classified: 0, skipped: 0 };

  const { data: existingRows, error } = await db
    .from('company_sectors')
    .select('company_ats_registry_id, source')
    .in(
      'company_ats_registry_id',
      list.map((c) => c.id)
    );
  if (error) throw new Error(error.message);

  const hasAny = new Set();
  const adminLocked = new Set();
  for (const row of existingRows || []) {
    hasAny.add(row.company_ats_registry_id);
    if (row.source === 'admin') adminLocked.add(row.company_ats_registry_id);
  }

  const toClassify = list.filter((c) => {
    if (adminLocked.has(c.id)) return false; // never overwrite an admin override
    if (hasAny.has(c.id) && !force) return false; // already classified, not forcing a re-pass
    return true;
  });

  const skipped = list.length - toClassify.length;
  if (!toClassify.length) return { classified: 0, skipped };

  const result = await classifyCompanies(toClassify);
  await logSectorUsage(db, result, { companyCount: toClassify.length });

  // Bounded pool rather than a sequential loop: each applySectors call touches
  // one distinct registry id and shares no mutable state with the others, so
  // there is nothing here for concurrent calls to race on. It was sequential
  // originally because the detection-time hook passes one or two companies at a
  // time and the difference was invisible; at a 100-company batch across a
  // registry-wide pass, those three round trips per company are the whole cost.
  // Measured: ~160 companies/minute sequential.
  const APPLY_CONCURRENCY = 8;
  let next = 0;
  await Promise.all(
    new Array(Math.min(APPLY_CONCURRENCY, toClassify.length)).fill(0).map(async () => {
      for (;;) {
        const i = next++;
        if (i >= toClassify.length) return;
        const c = toClassify[i];
        const sectors = result.byCompanyId.get(c.id) || ['other'];
        await applySectors(db, c.id, sectors, { source, syncTracklists });
      }
    })
  );

  return { classified: toClassify.length, skipped };
}

module.exports = {
  classifyCompanies,
  makeValidator,
  logSectorUsage,
  applySectors,
  syncSectorTracklists,
  classifyAndApply,
  getCompanySectors,
  CLASSIFY_SCHEMA,
  // exported for testing
  normalizeSectors,
  companiesBlock,
};

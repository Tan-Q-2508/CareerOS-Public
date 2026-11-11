const { ApifyClient } = require('apify-client');
const tunables = require('../tunables.json');
const { dedupKey } = require('./dedup');

// BYO Scraper sourcing via Apify (spec 4.2, 13.2). BYO Scraper is a BYOK,
// multi-actor path: every call resolves to the user's OWN key, and there is no
// house-run path at any tier. The hardcoded house token and built-in LinkedIn
// actor preset this file was built around are both gone — the multi-actor
// runtime landed in §15 #11/#15 and Core Scraper became the house source.
// Common contract:
//   sourceJobs({ title, location, keywords, count, postedWithinDays }) -> NormalizedJob[]
//
// There is deliberately no isConfigured() here, unlike every sibling adapter.
// One existed, reading a house APIFY_TOKEN, and was documented as dead and
// "kept for back-compat" — but nothing imported it, and a BYOK-only path has
// nothing house-level to report as configured. Its presence invited exactly
// the wrong gate.

// Build the public LinkedIn jobs search URL (spec 4.2). f_TPR=r<seconds> is the
// "posted within" window; recompute if the window becomes user-configurable.
function buildSearchUrl({ title, location, keywords, postedWithinDays }) {
  const kw = [title, keywords].filter(Boolean).join(' ').trim();
  const days = postedWithinDays || tunables.postedWithinDays;
  const seconds = Math.max(1, Math.round(days * 86400));
  const params = new URLSearchParams();
  params.set('keywords', kw);
  if (location) params.set('location', location);
  params.set('f_TPR', `r${seconds}`);
  params.set('position', '1');
  params.set('pageNum', '0');
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

// The actor has no formal output schema, so pluck tolerantly across the field
// names it may use; finalized against a real run.
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function toIso(v) {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toNumber(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Normalize one raw actor item into the internal schema (4.2). `mapping` (from a
// saved actor's field-mapping, 4.2) maps an internal field -> the actor's own key;
// when a field isn't mapped we fall back to the tolerant multi-key pick (this is
// exactly the built-in LinkedIn preset's behaviour — no mapping needed).
function normalizeItem(item, mapping) {
  const get = (field, keys) => {
    if (mapping && mapping[field]) {
      const v = item[mapping[field]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return pick(item, keys);
  };
  const title = get('title', ['title', 'jobTitle']);
  const link = get('link', ['link', 'jobUrl', 'url', 'jobPostingUrl', 'jobPostingLink']);
  const companyName = get('companyName', ['companyName', 'company', 'companyTitle']);
  const location = get('location', ['location', 'jobLocation', 'formattedLocation']);
  const descriptionText = get('descriptionText', [
    'descriptionText', 'jobDescriptionText', 'descriptionPlain', 'description', 'jobDescription',
  ]);
  const postedAt = toIso(get('postedAt', ['postedAt', 'listedAt', 'postedDate', 'publishedAt', 'postedTime']));
  const seniorityLevel = get('seniorityLevel', ['seniorityLevel', 'experienceLevel']);
  const employmentType = get('employmentType', ['employmentType', 'jobType', 'contractType']);
  const salaryMin = toNumber(get('salary', ['salaryMin', 'compensationMin', 'minSalary']));
  const salaryMax = toNumber(pick(item, ['salaryMax', 'compensationMax', 'maxSalary']));
  const id = pick(item, ['id', 'jobId', 'jobPostingId']);

  return {
    source: 'byo',
    title,
    companyName,
    location,
    postedAt,
    link,
    descriptionText,
    seniorityLevel,
    employmentType,
    salaryMin,
    salaryMax,
    dedupKey: dedupKey({ id, link, title, companyName, location }),
  };
}

// Substitute {{title}}/{{location}}/{{keywords}}/{{count}} placeholders in a
// saved actor's input template. A whole-value placeholder ("{{count}}") yields the
// real (typed) value; inline placeholders do string replacement.
function fillTemplate(tpl, vars) {
  const rep = (v) => {
    if (typeof v === 'string') {
      const whole = v.match(/^\{\{(\w+)\}\}$/);
      if (whole) return vars[whole[1]] !== undefined ? vars[whole[1]] : v;
      return v.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
    }
    if (Array.isArray(v)) return v.map(rep);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = rep(v[k]);
      return o;
    }
    return v;
  };
  return rep(tpl);
}

function buildActorInput(actor, { title, location, keywords, count, postedWithinDays }) {
  if (actor.inputTemplate) {
    return fillTemplate(actor.inputTemplate, {
      title,
      location,
      keywords,
      count: count || tunables.ldJobCount.default,
      postedWithinDays: postedWithinDays || tunables.postedWithinDays,
    });
  }
  // Default = the LinkedIn preset's input (also a sane default for LinkedIn-family actors).
  return {
    urls: [buildSearchUrl({ title, location, keywords, postedWithinDays })],
    count: count || tunables.ldJobCount.default,
    scrapeCompany: tunables.sourcing.scrapeCompany,
  };
}

/**
 * Source jobs from ONE saved BYO actor (spec 4.2 — multi-actor BYOK). Each actor
 * carries its OWN key — there is no shared/house Apify token anymore (the LinkedIn
 * preset was removed when Core Scraper landed, 4.2). Core Scraper uses jsearchAdapter.
 * @param actor { token, actorId, board?, outputMapping?, inputTemplate? }
 */
async function sourceJobs({ actor = {}, title, location, keywords, count, postedWithinDays }) {
  const token = actor.token;
  if (!token) throw new Error('BYO Scraper actor is missing its key');
  const actorId = actor.actorId || tunables.sourcing.apifyActorId;
  const client = new ApifyClient({ token });
  const input = buildActorInput(actor, { title, location, keywords, count, postedWithinDays });
  const run = await client.actor(actorId).call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  const normalized = (items || []).map((it) => normalizeItem(it, actor.outputMapping)).filter((j) => j.title && j.link);
  // Some actors don't strictly honor a count/limit input field internally —
  // enforce our own requested count here regardless, so cost control holds.
  return normalized.slice(0, count || tunables.ldJobCount.default);
}

// Run an actor once with a small result cap and return its RAW items (the actor's
// own field shape). Used to (a) validate a newly-connected key/actor and (b) get a
// sample listing for the per-actor field-mapping screen (spec 4.2). Uses a fresh
// client for the given token — never the cached hardcoded one.
async function fetchSample({ token, actorId, input, maxItems = 5 }) {
  if (!token) throw new Error('fetchSample: token is required');
  if (!actorId) throw new Error('fetchSample: actorId is required');
  const client = new ApifyClient({ token });
  const run = await client.actor(actorId).call(input || {});
  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: maxItems });
  return items || [];
}

module.exports = { sourceJobs, buildSearchUrl, normalizeItem, fetchSample, fillTemplate, buildActorInput };

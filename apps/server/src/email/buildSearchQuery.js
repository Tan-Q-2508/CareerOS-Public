// Build the Gmail search quer(ies) across all in-scope applications (spec
// §9.1.2 — a batched search, never one call per application). Zero AI: purely
// mechanical assembly of company/title terms into OR queries, time-bounded.
//
// Each application contributes its company name and its job title as quoted
// phrases; the classifier (classifyEmails.js) does the real matching, so this
// only needs decent recall — cast a slightly wide net, then let the AI filter.
//
// Returns an ARRAY of query strings, not one (bug fix 2026-07-28). Previously
// this built a single `q` and runEmailCheck.js capped the applications it fed
// in (tunables.emailCheck.maxSearchApps) specifically so the resulting query
// stayed under Gmail's practical length limit — with 101 real in-scope
// applications / 83 distinct companies, that cap silently dropped the newest
// half from BOTH the search and the classifier, which is exactly why the
// DOSS/Notion/Waymo confirmations (created within the same session) never
// surfaced. Every application's terms are now included; instead the terms are
// packed into multiple query strings, each kept under `charBudget`, and
// runEmailCheck.js runs all of them.
//
// Second-order version of the same bug (fixed 2026-08-12, live incident: a
// FluidStack application-confirmation email never surfaced) — at real scale
// (427 in-scope applications on one account) the number of term chunks can
// still exceed `maxQueries`, so SOME applications' terms get dropped again.
// This is now unavoidable at large enough scale (a hard char/request budget
// has to cut off somewhere), so instead of pretending it can't happen, this
// module tells the caller exactly WHICH applications' terms survived into an
// executed query, via `includedAppIds` — runEmailCheck.js uses that to stamp
// a per-application "last checked" timestamp and rotate coverage fairly
// across runs, so no application is ever *permanently* buried the way a pure
// newest-first sort would.

// Gmail treats a double-quote inside a quoted phrase as a terminator; strip
// quotes (and trim) so a company like `Say "Hi" Inc` can't break the query.
function sanitizeTerm(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

// E1a: a name with a qualifier (e.g. "Sauna by Wordware") never matches a real
// email that just says "Sauna" — the full-phrase term above only ever matches
// verbatim. Split on the first delimiter and keep the "core" text before it as
// an additional, separate OR term. Trades a little precision for recall, which
// is the right tradeoff here: the user confirms every suggestion before
// anything moves (§9.1.4), so a spurious extra candidate is cheap (one click
// to dismiss) while a silent miss is the expensive failure.
const CORE_TERM_DELIMITERS = [' by ', ' at ', ',', '(', ' - ', ' – '];
function coreTerm(t) {
  let cut = -1;
  for (const d of CORE_TERM_DELIMITERS) {
    const i = t.indexOf(d);
    if (i > 0 && (cut === -1 || i < cut)) cut = i;
  }
  return cut > 0 ? t.slice(0, cut).trim() : null;
}

// Company terms first (highest recall value — a rejection/confirmation
// subject line names the company far more reliably than the exact job title),
// deduped case-insensitively (a company like "Google" appears once no matter
// how many Google applications are tracked — this is what makes the whole
// term set compact enough to chunk instead of exploding per-application).
//
// Returns entries of {rendered, appIds} instead of plain strings — `appIds`
// is every application that contributed this exact term (post-dedup), so a
// truncation decision made on terms can be translated back to which
// applications were actually covered.
function uniqueTerms(applications) {
  const byKey = new Map(); // lowercased term -> entry
  const order = [];
  function add(raw, appId) {
    const key = raw.toLowerCase();
    let entry = byKey.get(key);
    if (!entry) {
      entry = { rendered: `"${raw}"`, appIds: new Set() };
      byKey.set(key, entry);
      order.push(key);
    }
    if (appId) entry.appIds.add(appId);
  }
  function addWithCore(raw, appId) {
    const t = sanitizeTerm(raw);
    // Single-word or very short terms are too noisy on their own; a title like
    // "Analyst" would match everything. Keep multi-word phrases and company
    // names; drop 1–2 char fragments.
    if (t.length < 3) return;
    add(t, appId);
    const core = coreTerm(t);
    if (core && core.length >= 3) add(core, appId);
  }
  for (const app of applications || []) addWithCore(app && app.company, app && app.id);
  for (const app of applications || []) addWithCore(app && app.title, app && app.id);
  return order.map((key) => byKey.get(key));
}

// Pack term entries into OR-groups, each rendered query kept under
// `charBudget` characters (Gmail's `q` has no documented hard limit, but very
// long queries get unreliable — this keeps each request comfortably sized
// instead of gambling on one giant query the way the single-string version
// implicitly did). Operates on {rendered, appIds} entries so chunk membership
// stays traceable back to applications.
function packTerms(entries, charBudget) {
  const chunks = [];
  let current = [];
  for (const entry of entries) {
    const term = entry.rendered;
    const currentLen = current.length
      ? current.map((e) => e.rendered).join(' OR ').length
      : 0;
    const candidateLen = current.length
      ? currentLen + ' OR '.length + term.length
      : term.length;
    if (current.length && candidateLen > charBudget) {
      chunks.push(current);
      current = [entry];
    } else {
      current.push(entry);
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * @param {Array<{id?: string, company?: string|null, title?: string|null}>} applications
 * @param {number} windowDays  only mail newer than this many days
 * @param {{charBudget?: number, maxQueries?: number}} [opts]
 * @returns {{queries: string[], includedAppIds: Set<string>, truncated: boolean}}
 *   `queries` — one or more Gmail `q` strings ([] if there are no usable terms).
 *   `includedAppIds` — every application id whose term(s) survived into a
 *   query that actually ran (i.e. excludes anything cut by the `maxQueries`
 *   truncation below). Applications passed without an `id` are simply absent
 *   from this set.
 *   `truncated` — true iff `maxQueries` actually cut some chunks this call.
 */
function buildSearchQuery(applications, windowDays = 45, opts = {}) {
  const charBudget = opts.charBudget || 1200;
  const entries = uniqueTerms(applications);
  if (entries.length === 0) return { queries: [], includedAppIds: new Set(), truncated: false };

  const chunks = packTerms(entries, charBudget);
  let truncated = false;
  // Loud, not silent, if this ever fires — mirrors the codebase's "fail this
  // job loudly (logged), don't drop it silently" convention (runScan.js) so a
  // future cap can never again silently reproduce this exact bug. Applications
  // whose only terms land in a dropped chunk are excluded from
  // `includedAppIds` below, which is what lets runEmailCheck.js rotate them to
  // the front of the NEXT run instead of just losing them.
  if (opts.maxQueries && chunks.length > opts.maxQueries) {
    truncated = true;
    console.error(
      `buildSearchQuery: ${chunks.length} query chunks for ${applications.length} applications exceeds maxQueries=${opts.maxQueries} — truncating; some applications' emails may be missed this run (they'll be prioritized on the next run)`
    );
    chunks.length = opts.maxQueries;
  }

  const includedAppIds = new Set();
  for (const chunk of chunks) {
    for (const entry of chunk) {
      for (const appId of entry.appIds) includedAppIds.add(appId);
    }
  }

  // E1b: real 1:1 hiring correspondence is essentially never in Gmail's
  // Promotions/Social categories, while a large fraction of the noise from a
  // huge OR query (many tracked applications) is — cut it directly at the
  // query level instead of relying on maxCandidates to not fill up with it.
  const suffix = ` newer_than:${windowDays}d -category:promotions -category:social`;
  const queries = chunks.map((chunk) => `(${chunk.map((e) => e.rendered).join(' OR ')})${suffix}`);
  return { queries, includedAppIds, truncated };
}

module.exports = { buildSearchQuery, sanitizeTerm, coreTerm, uniqueTerms, packTerms };

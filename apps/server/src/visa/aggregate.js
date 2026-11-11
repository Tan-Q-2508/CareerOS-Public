// CareerOS — company-wide sponsorship totals (spec 19.2).
//
// A large employer files through many named legal entities. Amazon files as
// `Amazon.com Services LLC`, `Amazon Web Services, Inc.` and three more;
// `Deloitte LLP` and `Deloitte Consulting LLP` are one company. Each is its own
// `visa_sponsors` row, because that is how DOL publishes them.
//
// Every surface used to show the LARGEST of those rows and call it the company.
// Amazon's badge read 13,707 when the real company-wide figure is roughly 20k —
// an understatement by a third, on a number 19.3 says someone may be making an
// immigration-relevant decision from. This module is the one place that folds
// those rows into a company.
//
// WHY THIS IS NOW SAFE, when 19.2 previously ruled it out. The original
// objection was that a sum needs the fiscal year and the wage-level
// distribution reconciled across rows. Both are answered:
//
//  - VINTAGE. One quarterly ETL run writes every row from one source file, so
//    the rows a company's entities produce share a fiscal year and quarter by
//    construction. That is a property of the pipeline, not a lucky accident —
//    but it is not enforced by the schema, so mixedVintage below CHECKS it and
//    refuses to blend rather than assuming it. A blended figure spanning two
//    quarters would be a number that describes no real period.
//  - DISTRIBUTION. A share is only meaningful against the count it came from,
//    so the blend is weighted by each entity's filing count. Averaging the
//    percentages unweighted would let a 3-filing entity swing a 13,000-filing
//    one, which is how a "20% Level I" employer would end up looking
//    entry-level friendly on the strength of a rounding error.
//
// ONE implementation, used by the badge (attachSponsors), the scoring fact
// (createSponsorResolver -> fitCall) and the sponsor tracklists alike, so the
// number a user reads, the number the model weighed and the list a user
// subscribes to can never disagree about what a company filed.

const { tunables } = require('@careeros/shared');

const CFG = tunables.visaSponsors;

const count = (r) => Number((r && r.filing_count_last_fy) || 0);

// The table's unique key, and therefore the identity of a filing entity. The
// resolution tiers overlap by design (a registry-id hit and an alias hit can
// name the same row), so the union must be de-duplicated or an entity would be
// counted twice — which would inflate the very number this module exists to
// get right.
const entityKey = (r) => r.employer_name_normalized || r.employer_name_display;

function vintageKey(r) {
  return `${r.source_fiscal_year}|${r.source_quarter}`;
}

/**
 * Fold one company's filing entities into a single company-wide record.
 *
 * @param {object[]} rows `visa_sponsors` rows believed to belong to one
 *   company. May contain duplicates; may be empty.
 * @returns {?object} a row-shaped object with two extra fields —
 *   `entity_count` and `entity_names` — or null when there is nothing to
 *   report. Never mutates its input.
 */
function aggregateSponsorRows(rows) {
  const unique = [];
  const seen = new Set();
  for (const r of rows || []) {
    if (!r) continue;
    const key = entityKey(r);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    unique.push(r);
  }
  if (!unique.length) return null;

  // Biggest first: the company's display name, its registry link and its
  // top-titles ordering all come from the largest entity, which is the one a
  // person recognises as "the company".
  const sorted = [...unique].sort((a, b) => count(b) - count(a));
  const primary = sorted[0];

  if (sorted.length === 1) {
    return { ...primary, entity_count: 1, entity_names: [primary.employer_name_display] };
  }

  // A company whose entities disagree about the reporting period cannot be
  // summed into one honest figure. Report the largest single entity instead —
  // an understatement, which is the failure direction 19.3 tolerates.
  const vintages = new Set(sorted.map(vintageKey));
  if (vintages.size > 1) {
    return { ...primary, entity_count: 1, entity_names: [primary.employer_name_display] };
  }

  const total = sorted.reduce((sum, r) => sum + count(r), 0);

  // Filing-count-weighted, so a large entity's mix dominates a small one's.
  // Falls back to unweighted only when every entity reports zero certified
  // filings, where there is no weight to apply and the badge treats the whole
  // record as unknown anyway.
  const dist = {};
  const weightOf = (r) => (total > 0 ? count(r) / total : 1 / sorted.length);
  for (const r of sorted) {
    const w = weightOf(r);
    for (const [level, share] of Object.entries(r.wage_level_distribution || {})) {
      const n = Number(share);
      if (!Number.isFinite(n) || n <= 0) continue;
      dist[level] = (dist[level] || 0) + n * w;
    }
  }
  // Same 3dp rounding sponsors.js's distributionOf uses, so a blended
  // distribution and a single-entity one are the same kind of object.
  for (const level of Object.keys(dist)) dist[level] = Math.round(dist[level] * 1000) / 1000;

  // Weighted over the entities that actually reported a wage. An entity with a
  // null avg_wage contributes nothing rather than dragging the mean toward zero.
  let wageSum = 0;
  let wageWeight = 0;
  for (const r of sorted) {
    const w = Number(r.avg_wage);
    if (!Number.isFinite(w) || w <= 0) continue;
    wageSum += w * count(r);
    wageWeight += count(r);
  }

  const titles = [];
  for (const r of sorted) {
    for (const t of r.top_job_titles || []) {
      if (!titles.includes(t)) titles.push(t);
    }
  }

  const retrievedAt = sorted
    .map((r) => r.retrieved_at)
    .filter(Boolean)
    .sort()
    .pop();

  return {
    ...primary,
    company_ats_registry_id: sorted.find((r) => r.company_ats_registry_id)?.company_ats_registry_id ?? null,
    filing_count_last_fy: total,
    wage_level_distribution: dist,
    avg_wage: wageWeight > 0 ? Math.round(wageSum / wageWeight) : null,
    top_job_titles: titles.slice(0, CFG.topJobTitles),
    retrieved_at: retrievedAt || primary.retrieved_at,
    entity_count: sorted.length,
    entity_names: sorted.map((r) => r.employer_name_display),
  };
}

module.exports = { aggregateSponsorRows };

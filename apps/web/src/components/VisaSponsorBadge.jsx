// Visa Sponsor badge (spec 19.5) — reuses 5.4's risk-tag visual language
// (.risk-tag pill + .dot) rather than introducing a second badge idiom.
//
// Fed by `job.visa_sponsor`, attached by the server's attachSponsors()
// (apps/server/src/visa/sponsorLookup.js) from real U.S. DOL/OFLC certified
// H-1B LCA filings.
//
// TWO RULES THIS COMPONENT EXISTS TO ENFORCE, both from 19.3:
//
// 1. It renders THREE STATES, not two, and the third is the point. A matched
//    record is a sponsor claim. No matched record is "we don't know" — it must
//    never say "no sponsorship" or "does not sponsor", because absence of a
//    filing is not evidence of refusal and large employers routinely file
//    under subsidiary legal names that never match their job-board name
//    (19.2). But rendering NOTHING for that case was itself misleading: on a
//    list of job cards, most of which have no match, a blank reads as a
//    settled "not a sponsor" rather than as an unanswered question. So the
//    unknown case is now explicit — a muted grey pill reading "No sponsorship
//    data", visually distinct from the green sponsor pill in dot colour, text
//    and tooltip. There is still deliberately NO "not a sponsor" state; this
//    product has no signal that could honestly produce one.
// 2. The vintage travels WITH the number, never separately and never omitted.
//    DOL publishes quarterly with a reporting lag, so this data is never more
//    current than roughly a quarter behind real hiring, and someone may be
//    making an immigration-relevant decision off it. A stale-but-unlabelled
//    stat is worse here than no stat at all — which is why the vintage is in
//    the visible line on the detail view and in the tooltip everywhere else,
//    rather than being a detail the caller can forget to pass.

// Compact wage-level mix, biggest share first ("II 39%, IV 13%"). Mirrors the
// server's wageLevelSummary() so the string a user reads and the string the
// scoring prompt weighed are the same one.
function wageLevelSummary(dist) {
  if (!dist || typeof dist !== 'object') return null;
  const parts = Object.entries(dist)
    .filter(([, share]) => Number(share) > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([level, share]) => `${level} ${Math.round(share * 100)}%`);
  return parts.length ? parts.join(', ') : null;
}

// On the detail view this badge is a block-level row between the risk tags and
// the keyword grid, so it needs the bottom spacing its siblings carry. On a job
// card it sits inline among other pills and must not. Same markup, one modifier.
function wrapClass(detailed) {
  return `visa-sponsor-badge-wrap${detailed ? ' is-detailed' : ''}`;
}

// 19.3's vintage string. Built from the row's own source_fiscal_year /
// source_quarter / retrieved_at — never hardcoded, never guessed.
export function sponsorVintage(sponsor) {
  if (!sponsor) return null;
  const retrieved = sponsor.retrieved_at ? String(sponsor.retrieved_at).slice(0, 10) : 'unknown date';
  return `Sponsorship data: FY${sponsor.source_fiscal_year} Q${sponsor.source_quarter}, retrieved ${retrieved}`;
}

/**
 * @param {object}  sponsor  a `visa_sponsors` row, or null/undefined
 * @param {boolean} detailed when true, renders the vintage as visible text
 *   beneath the pill (job detail view / company row). Otherwise the vintage
 *   lives in the tooltip, so the job card stays scannable — short, not a
 *   paragraph (19.5).
 */
export default function VisaSponsorBadge({ sponsor, detailed = false }) {
  // A row that matched but carries no certified filings is treated as unknown
  // too, not as a zero: the ETL only aggregates certified H-1B rows (19.1), so
  // a zero there means the aggregate said nothing, never "this employer filed
  // for nobody".
  if (!sponsor || !sponsor.filing_count_last_fy) {
    const unknownTitle = [
      'No sponsorship data',
      'No U.S. DOL/OFLC H-1B filing record matched this employer name.',
      'This is NOT evidence the company does not sponsor — large employers often file under a subsidiary legal name that does not match their job-board name.',
    ].join('\n');

    return (
      <span className={wrapClass(detailed)}>
        <span className="risk-tag visa-sponsor-unknown" title={unknownTitle}>
          <span className="dot none" />
          No sponsorship data
        </span>
        {detailed ? (
          <span className="visa-sponsor-vintage">
            No H-1B filing record matched this employer — not evidence the company does not sponsor.
          </span>
        ) : null}
      </span>
    );
  }

  const levels = wageLevelSummary(sponsor.wage_level_distribution);
  const vintage = sponsorVintage(sponsor);
  const count = Number(sponsor.filing_count_last_fy).toLocaleString();

  // A company-wide total across its filing entities (19.2), not one legal
  // entity's. Naming the entity count keeps the number honest: 20,431 is not a
  // figure anyone will find under a single employer name at DOL, and a reader
  // who wants to check it needs to know it is a sum. The entities themselves go
  // in the tooltip rather than the pill — 19.5 keeps the pill scannable.
  const entities = Array.isArray(sponsor.entity_names) ? sponsor.entity_names : [];
  const multi = Number(sponsor.entity_count) > 1;

  const title = [
    multi
      ? `${sponsor.employer_name_display} and ${sponsor.entity_count - 1} related filing ${
          sponsor.entity_count - 1 === 1 ? 'entity' : 'entities'
        } — ${count} certified H-1B filings in total`
      : `${sponsor.employer_name_display} — ${count} certified H-1B filings`,
    multi && entities.length ? `Filed as: ${entities.join('; ')}` : null,
    levels ? `Prevailing-wage levels: ${levels}` : null,
    sponsor.avg_wage ? `Average filed wage: $${Number(sponsor.avg_wage).toLocaleString()}` : null,
    vintage,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span className={wrapClass(detailed)}>
      <span className="risk-tag" title={title}>
        <span className="dot low" />
        H-1B sponsor: {count}
        {multi ? ` (${sponsor.entity_count} entities)` : ''}
        {levels ? ` · ${levels}` : ''}
      </span>
      {detailed && vintage ? <span className="visa-sponsor-vintage">{vintage}</span> : null}
    </span>
  );
}

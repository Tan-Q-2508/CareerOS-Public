// 4.6.11's mining PASS — the database half. Phase 4, §15 #25d.
//
// Loads every confirmed (display name, slug, platform) triple out of
// company_ats_registry, hands them to the pure analyzer
// (packages/shared/src/sourcing/ats/slugMining.js), and files the report in
// slug_pattern_runs so successive runs are comparable over time.
//
// Batch, not per-detection (4.6.11 is explicit): triggered on its own weekly
// GitHub Actions workflow near the re-sweep's cadence, via
// POST /api/internal/mine-slug-patterns. Costs nothing — no AI, no third-party
// calls, no probes; it is arithmetic over rows already in the table.
//
// It writes a REPORT and changes no behaviour. Promoting a rule into live
// name-guessing is a human editing tunables.atsDirect.detect.minedRules after
// reading that report — the deliberate manual gate 4.6.11 carries over from
// 4.6.2's false-positive discipline. Automating the promotion would be exactly
// the relaxation that section says this is not.

const {
  atsDirect: { analyzePairs },
  tunables,
} = require('@careeros/shared');

/**
 * Every active registry row, paged past PostgREST's 1000-row response cap
 * (the same cap §25b's sector pass hit — a plain .select() silently truncates).
 */
async function loadConfirmedTriples(db, { limit } = {}) {
  const pageSize = tunables.atsDirect.slugMining.pageSize || 1000;
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const want = limit ? Math.min(pageSize, limit - out.length) : pageSize;
    if (want <= 0) break;
    const { data, error } = await db
      .from('company_ats_registry')
      .select('company_name_display, slug_or_identifier, platform')
      .eq('status', 'active')
      .order('detected_at', { ascending: true })
      .range(from, from + want - 1);
    if (error) throw new Error(error.message);
    const rows = data || [];
    out.push(
      ...rows.map((r) => ({
        companyName: r.company_name_display,
        slug: r.slug_or_identifier,
        platform: r.platform,
      }))
    );
    if (rows.length < want) break;
  }
  return out;
}

/**
 * Run the pass.
 *
 * @param {object} db supabase admin client
 * @param {{limit?: number, persist?: boolean}} [opts] `persist` defaults true;
 *   the review script passes false for a read-only local run.
 * @returns {Promise<object>} the analyzer's report, plus `runId` when persisted
 */
async function mineSlugPatterns(db, { limit, persist = true } = {}) {
  const pairs = await loadConfirmedTriples(db, { limit });
  const report = analyzePairs(pairs, {
    gates: tunables.atsDirect.slugMining,
    minedRuleIds: tunables.atsDirect.detect.minedRules || [],
  });

  if (!persist) return report;

  const { data, error } = await db
    .from('slug_pattern_runs')
    .insert({
      pairs_analyzed: report.pairsAnalyzed,
      live_mined_rules: tunables.atsDirect.detect.minedRules || [],
      recommended_promotions: report.recommendedPromotions,
      regressions: report.regressions,
      report,
    })
    .select('id')
    .single();
  // A report that can't be filed is worth logging, not worth failing the pass —
  // the caller already has the numbers in hand.
  if (error) {
    console.error('mine-slug-patterns: could not persist run:', error.message);
    return report;
  }
  return { ...report, runId: data.id };
}

/**
 * One-line-per-rule summary for logs (Render's log tail is where this actually
 * gets read on the weekly run).
 */
function formatReport(report) {
  const lines = [
    `slug-pattern mining: ${report.pairsAnalyzed} confirmed pairs, ` +
      `baseline covers ${report.baseline.hits} (${(report.baseline.coverage * 100).toFixed(1)}%)`,
  ];
  for (const r of report.rules) {
    lines.push(
      `  [${r.tier}${r.live ? '/live' : ''}] ${r.id}: +${r.incrementalHits} incremental, ` +
        `${r.collisions} collisions (${(r.unverifiableCollisionRate * 100).toFixed(2)}% unverifiable) ` +
        `-> ${r.verdict}${r.regression ? ' !! REGRESSION' : ''}`
    );
  }
  if (report.recommendedPromotions.length) {
    lines.push(`  candidates for promotion (review, then edit tunables): ${report.recommendedPromotions.join(', ')}`);
  }
  if (report.regressions.length) {
    lines.push(`  !! LIVE RULES NO LONGER CLEARING THE GATE: ${report.regressions.join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = { mineSlugPatterns, loadConfirmedTriples, formatReport };

// Periodic re-sweep of company_ats_unresolved (4.6.3, the fourth entry point).
// Phase 4, §15 #23.
//
// Triggered every 2-3 days by its own GitHub Actions workflow
// (.github/workflows/company-resweep.yml) curling POST
// /api/internal/resweep-companies. Deliberately a SEPARATE workflow and endpoint
// from §12's scan scheduler: this re-sweeps the unresolved-company table, not
// scan_schedules, and never calls runScan.
//
// A company that failed name-guessing once may resolve later — either because a
// subsequent sighting backfilled a usable careers URL (registry.js does that on
// a repeat sighting) or after a manual correction from the review pass (4.6.3).

const {
  atsDirect: { detectPlatform },
  tunables,
} = require('@careeros/shared');
const { classifyAndApply } = require('./sectors');

const SWEEP_COLS =
  'id, company_name_normalized, company_name_display, match_attempt_type, careers_url_guess, source, check_count';

/**
 * Re-attempt detection on the least-recently-attempted unresolved companies.
 *
 * NO AUTO-TRACK here, unlike 4.6.3's other three entry points — nobody is
 * actively asking for this company in the moment, so resolving it makes it
 * available to track (via the browse list) rather than tracked for someone.
 *
 * @param {object} db supabase admin client
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{attempted: number, resolved: number, stillUnresolved: number, failed: number}>}
 */
async function resweepUnresolved(db, { limit } = {}) {
  const batchSize = limit || tunables.atsDirect.resweep.batchSize;

  // Least-recently-attempted first, so the sweep rotates through the whole table
  // across runs instead of re-grinding the same head rows forever.
  const { data: rows, error } = await db
    .from('company_ats_unresolved')
    .select(SWEEP_COLS)
    .order('last_attempt_at', { ascending: true })
    .limit(batchSize);
  if (error) throw new Error(error.message);

  const stats = { attempted: (rows || []).length, resolved: 0, stillUnresolved: 0, failed: 0 };
  // §15 #25b (4.6.9): "including the periodic re-sweep" — a company the sweep
  // newly resolves is just as much a real registry addition as one from a
  // live scan, so it gets sector-classified too. Unlike 4.6.10's auto-track,
  // which the re-sweep IS exempt from — this hook is deliberately NOT exempt.
  // Batched once at the end of the sweep, same shape as
  // resolveCompaniesFromJobs's fan-out.
  const promoted = [];

  // Sequential: this runs unattended on a timer with no user waiting, and
  // staying gentle on three third-party APIs matters more than finishing fast.
  for (const row of rows || []) {
    try {
      const detection = await detectPlatform({
        companyName: row.company_name_display,
        link: row.careers_url_guess || null,
      });

      if (detection.platform && detection.slug) {
        const company = await promoteToRegistry(db, row, detection);
        if (company) promoted.push(company);
        stats.resolved++;
      } else {
        await db
          .from('company_ats_unresolved')
          .update({
            last_attempt_at: new Date().toISOString(),
            // A later attempt can UPGRADE the signal (a URL backfilled since the
            // first sighting turns a name_guess_failed into a confirmed miss),
            // which is exactly what the review pass wants to see.
            match_attempt_type: detection.matchAttemptType || row.match_attempt_type,
          })
          .eq('id', row.id);
        stats.stillUnresolved++;
      }
    } catch (e) {
      // Per-row isolation (12.4): one company erroring can't abort the sweep.
      stats.failed++;
      console.error(`resweep: "${row.company_name_display}" failed:`, e.message || e);
    }
  }

  // §15 #25b: one batched classification call for the whole sweep's newly
  // promoted companies, inside its own try/catch so a classification failure
  // can never turn a successful sweep into a reported failure.
  if (promoted.length) {
    try {
      await classifyAndApply(
        db,
        promoted.map((c) => ({
          id: c.id,
          company_name_display: c.company_name_display,
          platform: c.platform,
          slug_or_identifier: c.slug_or_identifier,
        })),
        { source: 'ai_detect' }
      );
    } catch (e) {
      console.error('resweep: batch sector classify failed:', e.message || e);
    }
  }

  return stats;
}

/**
 * MOVE a now-resolved company from unresolved into the registry. 4.6.5 requires
 * a company to exist in exactly one of the two tables at a time — a move, never
 * a copy — so the delete is part of resolving, not cleanup.
 *
 * `source` is carried over from the unresolved row: 4.6.5 defines it as how the
 * company was FIRST detected, and the sweep is a retry of that original sighting,
 * not a new source of it.
 *
 * Returns the inserted registry row only when THIS call won the insert (so the
 * caller can sector-classify it, 4.6.9) — null on the 23505-race branch, where
 * a concurrent path already registered (and, structurally, already classified)
 * the same company.
 */
async function promoteToRegistry(db, row, detection) {
  const { data, error } = await db
    .from('company_ats_registry')
    .insert({
      company_name_normalized: row.company_name_normalized,
      company_name_display: row.company_name_display,
      platform: detection.platform,
      slug_or_identifier: detection.slug,
      status: 'active',
      source: row.source,
    })
    .select('id, company_name_display, platform, slug_or_identifier')
    .single();

  // A concurrent path may have registered it in the meantime; either way the
  // company is now resolved, so the unresolved row must go.
  const isRace = error && (error.code === '23505' || /duplicate key value/i.test(error.message || ''));
  if (error && !isRace) {
    throw new Error(error.message);
  }
  await db.from('company_ats_unresolved').delete().eq('id', row.id);
  return isRace ? null : data;
}

module.exports = { resweepUnresolved };

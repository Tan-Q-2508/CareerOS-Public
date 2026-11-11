// Registry probe-coverage signal (spec 4.6.3/4.6.5).
//
// scripts/park-dead-boards.js is the mechanism that verifies a registry row's
// board actually exists: it probes every row with `probed_at IS NULL`, moves a
// confirmed-dead board into company_ats_unresolved, and stamps the rest. Spec
// §4.6 names it as THAT mechanism — but nothing schedules it and nothing
// surfaces it, so newly-added rows accumulate unprobed indefinitely and the
// only way to find out is to remember to go and look.
//
// It is deliberately NOT put on a schedule. It mutates the registry (moving
// rows between tables) against live third-party endpoints, and an unattended
// destructive sweep is a different kind of decision from a missing cron. What
// IS safe to automate is noticing: this is a pure COUNT, no writes, no
// third-party calls, reported from the daily contract-check pass — exactly the
// posture checkSponsorFreshness already established for the disabled quarterly
// visa refresh, and for the same reason. Forgetting becomes visible instead of
// invisible.

// A handful of unprobed rows is just "some companies were added recently".
// The signal is meant to fire when a real backlog has built up, not on every
// detection. Lives here rather than in tunables.json because nothing else
// reads it and a knob with one reader in one file is not configuration.
const UNPROBED_WARN_THRESHOLD = 250;

/**
 * How much of the registry has never had its board verified?
 *
 * Pure read, no writes, never throws — a coverage check that breaks its caller
 * would be worse than the blind spot it reports (same contract as
 * checkSponsorFreshness).
 *
 * @param {object} db Supabase admin client
 * @returns {Promise<{ok: boolean, stale: boolean, unprobed: number|null,
 *   total: number|null, message: string}>}
 */
async function checkProbeCoverage(db) {
  const countOf = async (q) => {
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return count == null ? 0 : count;
  };

  try {
    const total = await countOf(
      db.from('company_ats_registry').select('id', { count: 'exact', head: true }).eq('status', 'active')
    );
    const unprobed = await countOf(
      db
        .from('company_ats_registry')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'active')
        .is('probed_at', null)
    );

    const stale = unprobed > UNPROBED_WARN_THRESHOLD;
    const pct = total ? ((unprobed / total) * 100).toFixed(1) : '0.0';
    return {
      ok: !stale,
      stale,
      unprobed,
      total,
      message: stale
        ? `company_ats_registry has ${unprobed} of ${total} active rows (${pct}%) never board-verified (limit ${UNPROBED_WARN_THRESHOLD}) — run "node scripts/park-dead-boards.js" to probe them. Nothing schedules that sweep: it moves dead boards into company_ats_unresolved, so it stays a deliberate, attended run.`
        : `company_ats_registry probe coverage is fine: ${unprobed} of ${total} active rows (${pct}%) unprobed (limit ${UNPROBED_WARN_THRESHOLD}).`,
    };
  } catch (e) {
    return { ok: false, stale: false, unprobed: null, total: null, message: `probe-coverage check failed: ${e.message || e}` };
  }
}

module.exports = { checkProbeCoverage, UNPROBED_WARN_THRESHOLD };

const { Router } = require('express');
const { getSupabaseAdmin, atsDirect } = require('@careeros/shared');
const { requireAdminSecret } = require('./admin');
const { runOneSchedule } = require('../scan/runDueScans');
const { claimDueSchedules, reapStaleScans } = require('../scan/scheduler');
const { reapAbandonedCopilotSessions } = require('../generation/copilotSessions');
const { resweepUnresolved } = require('../companies/resweep');
const { mineSlugPatterns, formatReport } = require('../companies/slugMining');
const { refreshVisaSponsors, checkSponsorFreshness } = require('../visa/sponsors');
const { checkProbeCoverage } = require('../companies/probeCoverage');

// Internal, non-user endpoint that the recurring-scan trigger (a GitHub Actions
// scheduled workflow, spec §12.2) calls on a timer. Guarded by the same shared
// X-Admin-Secret as /api/admin/*.
//
// Responds 202 immediately (the request just needs to land, not wait for scans
// to finish) and processes due schedules SEQUENTIALLY in the background — the
// same fire-and-forget shape POST /api/scan already uses for a single manual
// scan, just looped. The claim (§12.7's overlap guard) happens synchronously
// before responding, so the `dispatched` count in the response is accurate and
// a schedule can never be claimed by two overlapping triggers.

const router = Router();

router.post('/api/internal/run-due-scans', requireAdminSecret, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const reaped = await reapStaleScans(db);
    const claimed = await claimDueSchedules(db);
    // Copilot Mode session cleanup (spec 7.14.3) — same cadence, same guard,
    // no new infrastructure. See copilotSessions.js for the two stale states.
    const copilotReaped = await reapAbandonedCopilotSessions(db);

    res.status(202).json({ dispatched: claimed.length, reaped, copilotReaped });

    if (claimed.length) {
      // Fire and forget: run the already-claimed schedules sequentially (§12.7).
      // Runs them directly (not via runDueScans, which would re-claim and find
      // nothing left) since claiming already happened above, synchronously.
      (async () => {
        for (const row of claimed) {
          try {
            await runOneSchedule(db, row);
          } catch (e) {
            console.error(`run-due-scans: schedule ${row.id} failed:`, e.message || e);
          }
        }
      })().catch((e) => console.error('run-due-scans background pass failed:', e));
    }
  } catch (err) {
    next(err);
  }
});

// ATS Direct's periodic re-sweep of company_ats_unresolved (spec 4.6.3, entry
// point 4). Deliberately its own endpoint and its own GitHub Actions workflow
// (.github/workflows/company-resweep.yml, every 2-3 days) rather than riding the
// 30-minute scan trigger above: it re-sweeps the unresolved-company table, not
// scan_schedules, never calls runScan, and wants a completely different cadence.
router.post('/api/internal/resweep-companies', requireAdminSecret, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const limit = Number(req.body && req.body.limit) || undefined;

    // Same 202-then-work shape as run-due-scans: a detection sweep across up to
    // a batch of companies is far too slow to hold the request open, and the
    // caller (a curl in a workflow) only needs the trigger to land.
    res.status(202).json({ accepted: true });

    resweepUnresolved(db, { limit })
      .then((s) =>
        console.log(
          `resweep-companies: ${s.resolved} resolved, ${s.stillUnresolved} still unresolved, ${s.failed} failed of ${s.attempted} attempted`
        )
      )
      .catch((e) => console.error('resweep-companies background pass failed:', e.message || e));
  } catch (err) {
    next(err);
  }
});

// 4.6.11's slug-pattern mining pass, §15 #25d. Its own weekly workflow
// (.github/workflows/slug-pattern-mining.yml) — deliberately separate from
// resweep-companies above: this reads company_ats_registry, resweep reads
// company_ats_unresolved, and they don't need the same cadence. No third-party
// calls happen here (pure arithmetic over rows already in the table), so unlike
// the other two internal endpoints this can just run synchronously and return
// the report instead of the 202-then-background-work shape.
router.post('/api/internal/mine-slug-patterns', requireAdminSecret, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const limit = Number(req.body && req.body.limit) || undefined;
    const report = await mineSlugPatterns(db, { limit });
    console.log(formatReport(report));
    res.status(200).json(report);
  } catch (err) {
    next(err);
  }
});

// Contract-drift canary (spec 18.3, §15 #44) — one known-good query per
// Custom Adapter Tier adapter, asserting the response still carries the
// fields that adapter actually reads. Its own daily GitHub Actions workflow
// (.github/workflows/ats-contract-check.yml), deliberately separate from
// resweep-companies/mine-slug-patterns above: different table
// (ats_contract_checks), different purpose (platform-shape health, not
// company detection), no reason to share a cadence. Same 202-then-background
// shape as resweep-companies — this does real third-party HTTP calls per
// platform, so it's too slow to hold the request open for.
router.post('/api/internal/ats-contract-check', requireAdminSecret, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    res.status(202).json({ accepted: true });

    atsDirect
      .runContractChecks(db, { adapters: Object.values(atsDirect.adapters) })
      .then((s) => console.log(`ats-contract-check: ${s.ok} ok, ${s.failed} failed of ${s.checked} checked`))
      .catch((e) => console.error('ats-contract-check background pass failed:', e.message || e));

    // Piggy-backed on this pass rather than given its own workflow: it is the
    // same question ("is an external source still what we assume?") on the
    // same useful cadence, and it is one cheap indexed read. The visa refresh
    // workflow's schedule is disabled because it OOMs while reporting green
    // (19.1), so this warning is what keeps that staleness visible.
    checkSponsorFreshness(db)
      .then((f) => (f.stale ? console.warn(`ats-contract-check: ${f.message}`) : console.log(`ats-contract-check: ${f.message}`)))
      .catch((e) => console.error('visa_sponsors freshness check failed:', e.message || e));

    // Same rationale, different blind spot: park-dead-boards.js is what board-
    // verifies a registry row, and nothing schedules it (it moves dead boards
    // between tables, so it stays an attended run — see probeCoverage.js). This
    // is the cheap COUNT that makes the resulting backlog visible.
    checkProbeCoverage(db)
      .then((c) => (c.stale ? console.warn(`ats-contract-check: ${c.message}`) : console.log(`ats-contract-check: ${c.message}`)))
      .catch((e) => console.error('registry probe-coverage check failed:', e.message || e));
  } catch (err) {
    next(err);
  }
});

// Quarterly DOL/OFLC H-1B sponsorship refresh (spec 19.1, §15 #48). Its own
// quarterly workflow (.github/workflows/visa-sponsors-refresh.yml) — matching
// the source's own FY-quarter release cadence, which is nothing like any other
// job's here. Same 202-then-background shape as resweep-companies: this
// downloads a ~252 MB file and streams a ~1.6 GB worksheet, so it is far too
// slow to hold a request open for.
//
// MEMORY CAVEAT, deliberate and documented rather than designed around: a real
// run peaks near 330 MB RSS on top of the download, which does not fit Render's
// ~512 MB tier. This endpoint exists because 19.1 specifies the
// scheduled-internal-endpoint pattern and because it must share one code path
// with the batch, but the SUPPORTED path is scripts/refresh-visa-sponsors.js
// run locally. Expect this to OOM on the current host until it moves to a
// larger instance.
router.post('/api/internal/refresh-visa-sponsors', requireAdminSecret, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    res.status(202).json({ accepted: true });

    refreshVisaSponsors(db, {})
      .then((s) =>
        console.log(
          `refresh-visa-sponsors: FY${s.source.fiscalYear} Q${s.source.quarter} — ${s.employers} employers from ` +
            `${s.certifiedH1b} certified H-1B filings, ${s.registryMatched} matched to the registry, ${s.wrote} written`
        )
      )
      .catch((e) => console.error('refresh-visa-sponsors background pass failed:', e.message || e));
  } catch (err) {
    next(err);
  }
});

module.exports = router;

const { Router } = require('express');
const { getSupabaseAdmin } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const {
  resolveCompany,
  trackCompany,
  untrackCompany,
  listTrackedCompanies,
  listKnownCompanies,
} = require('../companies/registry');

// ATS Direct company management (spec 4.6.3/4.6.5; Phase 4, §15 #23).
//
// "Request a company" is 4.6.3's third entry point — the same dedup-then-detect
// pipeline as auto-detect, triggered manually instead of passively. The rest of
// this router is 4.6.5's per-user tracking layer: the tracked list, and the
// browse list for opting into companies another user's scan already resolved.
// §15 #24's scan-source selector reads the tracked list.

const router = Router();

// Detection fires up to ~15 outbound probes at three third-party APIs, and this
// codebase has no rate-limit infrastructure. Rather than adding some, one
// in-flight request per user is enough of a guard: the dedup gate (4.6.4) means
// a repeat request for an already-known company does zero outbound work anyway,
// so the only thing worth preventing is a user holding down the button.
const inFlight = new Set();

// POST /api/companies/request — { company, link? }.
// Synchronous rather than a 202-and-poll: detection is bounded (maxSlugCandidates
// x 3 platforms, at probeConcurrency), so a button spinner is the honest UX.
router.post('/api/companies/request', requireAuth, async (req, res, next) => {
  const userId = req.user.id;
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const body = req.body || {};
    const company = (body.company || '').trim();
    const link = (body.link || '').trim() || null;
    if (!company) return res.status(400).json({ error: 'Enter a company name' });

    if (inFlight.has(userId)) {
      return res.status(429).json({ error: 'Still looking up your last company — give it a moment' });
    }
    inFlight.add(userId);

    let result;
    try {
      // §15 #25c-1 (4.6.10): unlike the scan/manual-entry fan-outs, an explicit
      // "Request Company" ask keeps auto-tracking — the request itself IS the
      // intent to track, into the curated default list (not "Scraped
      // Companies", which is reserved for the passive Settings toggle).
      result = await resolveCompany(db, { companyName: company, link, source: 'user_request', userId, autoTrack: true });
    } finally {
      inFlight.delete(userId);
    }

    if (result.status === 'skipped') {
      return res.status(400).json({ error: 'That company name could not be read — try the full name' });
    }
    if (result.status === 'resolved') {
      return res.json({
        status: 'resolved',
        was_new: result.wasNew,
        company: result.company,
      });
    }
    return res.json({
      status: 'unresolved',
      was_new: result.wasNew,
      // 4.6.5's two miss types read very differently to a user: url_no_match is
      // a confirmed miss on a URL they supplied, name_guess_failed just means
      // the board isn't named after the company.
      match_attempt_type: (result.unresolved && result.unresolved.match_attempt_type) || 'name_guess_failed',
    });
  } catch (err) {
    inFlight.delete(userId);
    next(err);
  }
});

// GET /api/companies/tracked — this user's tracked companies (§15 #24's selector).
router.get('/api/companies/tracked', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    res.json({ companies: await listTrackedCompanies(db, req.user.id) });
  } catch (err) {
    next(err);
  }
});

// GET /api/companies/known?q= — 4.6.5's browse list: every globally-resolved
// company, each flagged with whether this user already tracks it.
router.get('/api/companies/known', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const q = (req.query.q || '').trim() || null;
    res.json({ companies: await listKnownCompanies(db, req.user.id, { q }) });
  } catch (err) {
    next(err);
  }
});

router.post('/api/companies/:registryId/track', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { data: company } = await db
      .from('company_ats_registry')
      .select('id')
      .eq('id', req.params.registryId)
      .maybeSingle();
    if (!company) return res.status(404).json({ error: 'Unknown company' });

    await trackCompany(db, req.user.id, company.id);
    res.json({ tracked: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/api/companies/:registryId/track', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    await untrackCompany(db, req.user.id, req.params.registryId);
    res.json({ tracked: false });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

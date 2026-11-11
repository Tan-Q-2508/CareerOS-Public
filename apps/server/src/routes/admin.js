const { Router } = require('express');
const crypto = require('crypto');
const { getSupabaseAdmin, constants, atsDirect } = require('@careeros/shared');
const { applySectors, getCompanySectors } = require('../companies/sectors');

const router = Router();

/**
 * Backend-only admin guard (spec 13.4). This is NOT a per-user feature and does
 * not use a Supabase JWT — it's a protected operational action gated by a shared
 * secret in the X-Admin-Secret header, matched against ADMIN_SECRET. Constant-time
 * compare so a wrong guess can't be narrowed down by response timing.
 */
function requireAdminSecret(req, res, next) {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'Admin endpoint not configured' });
  }

  const provided = req.get('X-Admin-Secret') || '';
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  if (
    expectedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, providedBuf)
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

/**
 * Phase 1 COS crediting (spec 13.4). No Stripe Checkout yet, so users get COS
 * through this protected action. It writes a real cos_transactions row tagged
 * action_type = 'admin_grant' AND increments users.cos_balance atomically via
 * the grant_cos() Postgres function — never a raw balance edit that bypasses
 * the ledger.
 */
router.post('/api/admin/grant-cos', requireAdminSecret, async (req, res, next) => {
  try {
    const { user_id: userId, amount, note } = req.body || {};

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'user_id (uuid) is required' });
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const { data, error } = await supabaseAdmin.rpc('grant_cos', {
      p_user_id: userId,
      p_amount: numericAmount,
      p_note: note ?? null,
    });

    if (error) {
      return next(Object.assign(new Error(error.message), { status: 400 }));
    }

    res.json({ ok: true, result: data });
  } catch (err) {
    next(err);
  }
});

/**
 * Sector admin override (spec 4.6.9): "A company's sector assignment can
 * change ... via a simple admin-editable override — not user-editable, since
 * sector tracklists are system-maintained." No admin UI exists in this app —
 * curl + ADMIN_SECRET, same as grant-cos above. GET inspects the current
 * assignment by registry id or (case-insensitive) display-name substring.
 */
router.get('/api/admin/company-sectors', requireAdminSecret, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { company } = req.query || {};
    if (!company) return res.status(400).json({ error: 'company (registry id or name substring) is required' });

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(company);
    let registryRows;
    if (isUuid) {
      const { data, error } = await db
        .from('company_ats_registry')
        .select('id, company_name_display, platform, slug_or_identifier')
        .eq('id', company);
      if (error) throw new Error(error.message);
      registryRows = data;
    } else {
      const { data, error } = await db
        .from('company_ats_registry')
        .select('id, company_name_display, platform, slug_or_identifier')
        .ilike('company_name_display', `%${company}%`)
        .limit(20);
      if (error) throw new Error(error.message);
      registryRows = data;
    }

    const results = await Promise.all(
      (registryRows || []).map(async (row) => ({ ...row, sectors: await getCompanySectors(db, row.id) }))
    );
    res.json({ companies: results });
  } catch (err) {
    next(err);
  }
});

/**
 * { company_ats_registry_id, sectors: string[] } — replaces the company's
 * sector assignment, tagged source: 'admin' so a later bulk/detection
 * re-classify pass leaves it alone (company_sectors migration header,
 * classifyAndApply's admin-lock check).
 */
router.post('/api/admin/company-sectors', requireAdminSecret, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { company_ats_registry_id: registryId, sectors } = req.body || {};

    if (!registryId || typeof registryId !== 'string') {
      return res.status(400).json({ error: 'company_ats_registry_id is required' });
    }
    if (!Array.isArray(sectors) || sectors.length === 0 || sectors.length > constants.MAX_SECTORS_PER_COMPANY) {
      return res.status(400).json({ error: `sectors must be an array of 1-${constants.MAX_SECTORS_PER_COMPANY} entries` });
    }
    const invalid = sectors.filter((s) => !constants.COMPANY_SECTORS.includes(s));
    if (invalid.length) {
      return res.status(400).json({ error: `unknown sector(s): ${invalid.join(', ')}` });
    }

    await applySectors(db, registryId, sectors, { source: 'admin' });
    res.json({ applied: true, company_ats_registry_id: registryId, sectors });
  } catch (err) {
    next(err);
  }
});

/**
 * ATS Direct HTTP diagnostics (spec 4.6.13, step 2) — per-origin socket-
 * connect count, current in-flight, and in-flight high-water mark from the
 * shared undici Agent (packages/shared/src/sourcing/ats/dispatcher.js),
 * plus process.memoryUsage(). Pollable from outside the box during a live
 * scan to verify the per-origin connection ceiling actually holds — not a
 * general-purpose ops endpoint, just this session's verification surface.
 */
router.get('/api/admin/ats-http-stats', requireAdminSecret, (req, res) => {
  res.json({ origins: atsDirect.getHttpStats(), memory: process.memoryUsage() });
});

/**
 * Contract-drift canary results (spec 18.3, §15 #44) — the latest check per
 * platform, newest first. Populated by POST /api/internal/ats-contract-check
 * (internal.js), which a daily GitHub Actions workflow triggers.
 *
 * Reading a failure: `missing_fields` non-empty is real drift — the endpoint
 * answered and its shape changed. An empty `missing_fields` with a
 * `status_code` of 429 or 503 is throttling, not drift (phenom's tenant does
 * this); the check already retried once and still got refused. An empty
 * `missing_fields` with a null `status_code` is transport — DNS, timeout,
 * abort — and no HTTP status ever came back.
 */
router.get('/api/admin/ats-contract-checks', requireAdminSecret, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { data, error } = await db
      .from('ats_contract_checks')
      .select('platform, checked_at, ok, missing_fields, error_message, status_code')
      .order('checked_at', { ascending: false })
      .limit(500);
    if (error) throw error;

    // Reduce to the latest row per platform for the headline view, but keep
    // the full recent list too — a maintainer reading this after a canary
    // fire wants both "is it broken right now" and "when did it start".
    const latestByPlatform = {};
    for (const row of data || []) {
      if (!latestByPlatform[row.platform]) latestByPlatform[row.platform] = row;
    }

    res.json({ latest: Object.values(latestByPlatform), recent: data || [] });
  } catch (err) {
    next(err);
  }
});

/**
 * DOL/OFLC sponsorship records (spec 19.2, §15 #48) — inspect what the
 * quarterly ETL actually stored, by employer-name substring or by the biggest
 * sponsors overall. No admin UI exists in this app: curl + ADMIN_SECRET, same
 * as company-sectors above.
 *
 * Always returns the 19.3 vintage fields alongside the numbers. That rule is
 * about every surface, this inspector included — a filing count read without
 * knowing which quarter it came from is exactly the stale-but-unlabelled stat
 * 19.3 exists to prevent.
 */
router.get('/api/admin/visa-sponsors', requireAdminSecret, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { employer, limit } = req.query || {};
    const cap = Math.min(Number(limit) || 25, 200);

    let q = db
      .from('visa_sponsors')
      .select(
        'employer_name_display, employer_name_normalized, company_ats_registry_id, filing_count_last_fy, avg_wage, wage_level_distribution, top_job_titles, source_fiscal_year, source_quarter, retrieved_at'
      )
      .order('filing_count_last_fy', { ascending: false })
      .limit(cap);
    if (employer) q = q.ilike('employer_name_display', `%${employer}%`);

    const { data, error } = await q;
    if (error) throw error;
    res.json({ sponsors: data || [] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.requireAdminSecret = requireAdminSecret;

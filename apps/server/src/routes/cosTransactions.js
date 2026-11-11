const { Router } = require('express');
const { getSupabaseAdmin, scanTitles } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');

// COS ledger history (spec 13.4's "optional expandable breakdown for anyone
// who wants to see the itemization") — a small window near the balance
// display listing recent transactions, each expandable to its flat/sourcing/
// AI cost breakdown. Read-only, no COS cost of its own.

const router = Router();

const ACTION_LABELS = {
  cs_scan: 'Core Scraper scan',
  byo_scan: 'BYO Scraper scan',
  ats_direct_scan: 'ATS Direct scan',
  resume_generation: 'Résumé generation',
  cover_letter_generation: 'Cover letter generation',
  email_check: 'Email status check',
  manual_entry: 'Manual job entry',
  copilot_session: 'Copilot session',
  admin_grant: 'Admin top-up',
};

// GET /api/cos-transactions?limit=30 — most recent first, capped at 100.
// Attaches a human-readable `label` (from action_type) and, where available,
// a `context` string (the related job/scan's title) so "which feature, for
// what" is legible without the caller needing to separately fetch jobs/scans.
router.get('/api/cos-transactions', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);

    const { data, error } = await db
      .from('cos_transactions')
      .select('id, action_type, flat_fee, sourcing_cost, ai_cost, total_cost, credit_amount, note, billed, related_scan_id, related_job_id, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));

    const rows = data || [];
    const jobIds = [...new Set(rows.map((t) => t.related_job_id).filter(Boolean))];
    const scanIds = [...new Set(rows.map((t) => t.related_scan_id).filter(Boolean))];

    const [{ data: jobs, error: jErr }, { data: scans, error: sErr }] = await Promise.all([
      jobIds.length
        ? db.from('jobs').select('id, title, company_name').in('id', jobIds)
        : Promise.resolve({ data: [] }),
      scanIds.length
        ? db.from('scan_history').select('id, config').in('id', scanIds)
        : Promise.resolve({ data: [] }),
    ]);
    if (jErr) return next(Object.assign(new Error(jErr.message), { status: 500 }));
    if (sErr) return next(Object.assign(new Error(sErr.message), { status: 500 }));

    const jobById = new Map((jobs || []).map((j) => [j.id, j]));
    const scanById = new Map((scans || []).map((s) => [s.id, s]));

    const transactions = rows.map((t) => {
      let context = null;
      const job = t.related_job_id ? jobById.get(t.related_job_id) : null;
      const scan = t.related_scan_id ? scanById.get(t.related_scan_id) : null;
      if (job) context = job.company_name ? `${job.title} @ ${job.company_name}` : job.title;
      else if (scan && scan.config) {
        const titles = scanTitles(scan.config);
        if (titles.length) context = titles.join(', ');
      }

      return {
        id: t.id,
        action_type: t.action_type,
        label: ACTION_LABELS[t.action_type] || t.action_type,
        context,
        flat_fee: t.flat_fee,
        sourcing_cost: t.sourcing_cost,
        ai_cost: t.ai_cost,
        total_cost: t.total_cost,
        credit_amount: t.credit_amount,
        note: t.note,
        billed: t.billed,
        created_at: t.created_at,
      };
    });

    res.json({ transactions });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

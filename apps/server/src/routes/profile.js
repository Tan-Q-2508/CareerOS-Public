const { Router } = require('express');
const { getSupabaseAdmin } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');

const router = Router();

function cleanStringArray(v) {
  if (!Array.isArray(v)) return null;
  return v.map((s) => String(s).trim()).filter(Boolean);
}

// PATCH /api/profile — manual override of the pre-filter inputs (spec 4.3).
// The hybrid's "override" half: résumé upload auto-seeds these; this wins.
router.patch('/api/profile', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const body = req.body || {};
    const patch = {};

    if (body.years_of_experience === null) {
      // Clear the override: go back to the live résumé-derived value (4.3).
      patch.years_of_experience_manual = false;
    } else if (body.years_of_experience !== undefined) {
      const y = Number(body.years_of_experience);
      if (!Number.isFinite(y) || y < 0 || y > 60) {
        return res.status(400).json({ error: 'years_of_experience must be 0–60' });
      }
      patch.years_of_experience = y;
      // C1: a manual override sticks — a later résumé upload must not silently
      // overwrite what the user explicitly set here.
      patch.years_of_experience_manual = true;
    }
    if (body.domain_keywords !== undefined) {
      const arr = cleanStringArray(body.domain_keywords);
      if (arr === null) return res.status(400).json({ error: 'domain_keywords must be an array of strings' });
      patch.domain_keywords = arr;
      patch.domain_keywords_manual = true;
    }
    if (body.off_domain_title_keywords !== undefined) {
      const arr = cleanStringArray(body.off_domain_title_keywords);
      if (arr === null) return res.status(400).json({ error: 'off_domain_title_keywords must be an array of strings' });
      patch.off_domain_title_keywords = arr;
    }
    // §15 #25c-1 (4.6.10) — "Automatically track companies I scrape" toggle.
    if (body.auto_track_scraped_companies !== undefined) {
      if (typeof body.auto_track_scraped_companies !== 'boolean') {
        return res.status(400).json({ error: 'auto_track_scraped_companies must be a boolean' });
      }
      patch.auto_track_scraped_companies = body.auto_track_scraped_companies;
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const { data, error } = await db
      .from('users')
      .update(patch)
      .eq('id', req.user.id)
      .select(
        'years_of_experience, domain_keywords, off_domain_title_keywords, years_of_experience_manual, domain_keywords_manual, auto_track_scraped_companies'
      )
      .single();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));

    res.json({ profile: data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

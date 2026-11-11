const { Router } = require('express');
const { getSupabaseAdmin, constants } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const { verdictFor } = require('../scoring/scoreJob');

const router = Router();

const STAGES = constants.APPLICATION_STAGES; // Saved/Applied/Interviewing/Offer/Rejected/Accepted (capitalized — matches the DB CHECK)

// Columns of the joined job shown on a tracker card.
const JOB_COLS = 'id, title, company_name, location, overall_fit, link, status';
const APP_COLS =
  'id, job_id, stage, notes, interview_date, interview_round, prep_link, posting_link, created_at, updated_at';

function shapeApp(a) {
  const job = a.job || null;
  return {
    id: a.id,
    job_id: a.job_id,
    stage: a.stage,
    notes: a.notes,
    interview_date: a.interview_date,
    interview_round: a.interview_round,
    prep_link: a.prep_link,
    posting_link: a.posting_link,
    created_at: a.created_at,
    updated_at: a.updated_at,
    job: job
      ? {
          id: job.id,
          title: job.title,
          company_name: job.company_name,
          location: job.location,
          overall_fit: job.overall_fit,
          link: job.link,
          verdict: verdictFor(job.overall_fit),
        }
      : null,
  };
}

// GET /api/applications — the user's applications with each one's job display fields.
router.get('/api/applications', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('applications')
      .select(`${APP_COLS}, job:jobs(${JOB_COLS})`)
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false });
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    res.json({ applications: (data || []).map(shapeApp) });
  } catch (err) {
    next(err);
  }
});

// POST /api/applications — save a job to the tracker (spec §9). Body: { job_id }.
// Free, no COS. Deduped by (user_id, job_id): a second save returns the existing row.
router.post('/api/applications', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const userId = req.user.id;
    const jobId = req.body && req.body.job_id;
    if (!jobId) return res.status(400).json({ error: 'job_id is required' });

    // The job must exist and belong to the user.
    const { data: job, error: jErr } = await db
      .from('jobs')
      .select('id, link')
      .eq('id', jobId)
      .eq('user_id', userId)
      .maybeSingle();
    if (jErr) return next(Object.assign(new Error(jErr.message), { status: 500 }));
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Dedup in code (no unique constraint): return the existing row if present.
    const { data: existing } = await db
      .from('applications')
      .select(`${APP_COLS}, job:jobs(${JOB_COLS})`)
      .eq('user_id', userId)
      .eq('job_id', jobId)
      .maybeSingle();
    if (existing) return res.status(200).json({ application: shapeApp(existing), already_tracked: true });

    const { data: created, error: insErr } = await db
      .from('applications')
      .insert({ user_id: userId, job_id: jobId, stage: 'Saved', posting_link: job.link || null })
      .select(`${APP_COLS}, job:jobs(${JOB_COLS})`)
      .single();
    if (insErr) return next(Object.assign(new Error(insErr.message), { status: 500 }));
    res.status(201).json({ application: shapeApp(created) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/applications/:id — move stage / edit fields. Ownership-scoped, free.
router.patch('/api/applications/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const body = req.body || {};
    const patch = {};

    if (body.stage !== undefined) {
      if (!STAGES.includes(body.stage)) {
        return res.status(400).json({ error: `stage must be one of: ${STAGES.join(', ')}` });
      }
      patch.stage = body.stage;
    }
    for (const f of ['notes', 'prep_link', 'posting_link', 'interview_round']) {
      if (body[f] !== undefined) patch[f] = body[f] === '' ? null : String(body[f]);
    }
    if (body.interview_date !== undefined) {
      patch.interview_date = body.interview_date || null; // ISO string or null
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });

    const { data, error } = await db
      .from('applications')
      .update(patch)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select(`${APP_COLS}, job:jobs(${JOB_COLS})`)
      .maybeSingle();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!data) return res.status(404).json({ error: 'Application not found' });
    res.json({ application: shapeApp(data) });
  } catch (err) {
    next(err);
  }
});

// POST /api/applications/not-for-me — "Not for me": upsert this job's application
// to the terminal "Deemed Not Suitable" bucket (2026-07-21). Update the existing
// row if there is one (the common case — every scored job is already Saved), else
// create one. Removes the job from the dashboard (dashboard shows Saved only).
router.post('/api/applications/not-for-me', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    const userId = req.user.id;
    const jobId = req.body && req.body.job_id;
    if (!jobId) return res.status(400).json({ error: 'job_id is required' });

    const { data: job, error: jErr } = await db
      .from('jobs')
      .select('id, link')
      .eq('id', jobId)
      .eq('user_id', userId)
      .maybeSingle();
    if (jErr) return next(Object.assign(new Error(jErr.message), { status: 500 }));
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const { data: existing } = await db
      .from('applications')
      .select('id')
      .eq('user_id', userId)
      .eq('job_id', jobId)
      .maybeSingle();

    const q = existing
      ? db.from('applications').update({ stage: 'Deemed Not Suitable' }).eq('id', existing.id).eq('user_id', userId)
      : db.from('applications').insert({ user_id: userId, job_id: jobId, stage: 'Deemed Not Suitable', posting_link: job.link || null });

    const { data, error } = await q.select(`${APP_COLS}, job:jobs(${JOB_COLS})`).single();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    res.json({ application: shapeApp(data) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

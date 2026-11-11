const { Router } = require('express');
const { getSupabaseAdmin, normalizeQuestion } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const { activeResumeVersion } = require('./resume');

// Application Autofill API (spec 0.1 Phase 5, §15 session 28).
//
// Everything here is deliberately free and AI-free: the extension fills
// standard fields from data CareerOS already has, and reuses answers the user
// has already given. No COS is charged by any route in this file, and no
// route makes an AI call — §28's deliverable is explicitly "zero AI cost."
//
// The extension is the only client. It authenticates with the SAME Supabase
// JWT the web app already holds (read out of the web origin by the token
// bridge content script), so there is no new credential surface here — just
// requireAuth, same as every other route.

const router = Router();
const RESUME_BUCKET = 'resumes';
const SIGNED_URL_TTL_SECONDS = 300;

// ---------------------------------------------------------------------------
// GET /api/autofill/profile — everything the DOM matcher needs, in one trip.
//
// One round trip matters here: the content script runs on page load of a real
// application form, and N round trips would be N chances to be slower than
// the user typing. Contact fields come from `users` (13.1's onboarding
// capture); employer/school/degree are derived from the active résumé's
// parsed profile (16.2) rather than stored separately, so they can't drift
// from the résumé the user actually uploads.
// ---------------------------------------------------------------------------
router.get('/api/autofill/profile', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { data: user, error: uErr } = await db
      .from('users')
      .select(
        'contact_name, contact_email, contact_phone, contact_city_state, contact_links, years_of_experience, email, full_name'
      )
      .eq('id', req.user.id)
      .single();
    if (uErr) return next(Object.assign(new Error(uErr.message), { status: 500 }));

    const resume = await activeResumeVersion(db, req.user.id);
    const parsed = (resume && resume.parsed_profile) || {};
    const roles = Array.isArray(parsed.roles) ? parsed.roles : [];
    const education = Array.isArray(parsed.education) ? parsed.education : [];

    // "Most recent" = first role, matching how the parser is instructed to
    // order them (16.2) and how renderResume.js already treats the list.
    const currentRole = roles[0] || null;
    const topEducation = education[0] || null;

    // First URL seen per link type, from users.contact_links (7.2).
    const linkByType = {};
    for (const l of Array.isArray(user.contact_links) ? user.contact_links : []) {
      if (l && l.type && l.url && !linkByType[l.type]) linkByType[l.type] = l.url;
    }

    res.json({
      profile: {
        fullName: user.contact_name || user.full_name || null,
        email: user.contact_email || user.email || null,
        phone: user.contact_phone || null,
        location: user.contact_city_state || null,
        // Recognised header links (7.2) come from users.contact_links, keyed
        // by type. Each field the extension's fieldMap knows is exposed
        // explicitly; a type the résumé doesn't carry is null so the extension
        // shows "no value" rather than matching it to the wrong URL.
        linkedin: linkByType.linkedin || null,
        portfolio: linkByType.portfolio || linkByType.website || null,
        website: linkByType.website || null,
        github: linkByType.github || null,
        gitlab: linkByType.gitlab || null,
        twitter: linkByType.twitter || null,
        currentCompany: currentRole ? currentRole.company || null : null,
        currentTitle: currentRole ? currentRole.title || null : null,
        school: topEducation ? topEducation.institution || null : null,
        degree: topEducation
          ? [topEducation.degree, topEducation.field].filter(Boolean).join(', ') || null
          : null,
        yearsOfExperience: user.years_of_experience ?? null,
      },
      resume: resume
        ? { id: resume.id, version_number: resume.version_number, filename: resume.original_filename }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/autofill/answers/lookup — { questions: [{ text }] }
//
// Exact match on the normalized key only. No fuzzy matching server-side, on
// purpose: a wrong fuzzy hit here would silently put a previous application's
// answer into a different question, which is exactly the failure mode the
// answer bank must never have. Tolerance for phrasing lives in
// normalizeQuestion, where it's explicit and testable.
// ---------------------------------------------------------------------------
router.post('/api/autofill/answers/lookup', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const questions = Array.isArray(req.body && req.body.questions) ? req.body.questions : [];
    const keys = [
      ...new Set(
        questions
          .map((q) => normalizeQuestion(typeof q === 'string' ? q : q && q.text))
          .filter(Boolean)
      ),
    ];
    if (!keys.length) return res.json({ answers: {} });

    const { data, error } = await db
      .from('application_answers')
      .select('question_normalized, question_original, answer_text, answer_type, times_used')
      .eq('user_id', req.user.id)
      .in('question_normalized', keys);
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));

    const answers = {};
    for (const row of data || []) answers[row.question_normalized] = row;
    res.json({ answers });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/autofill/answers — store one answer the user explicitly gave.
//
// Only ever called from the review panel's inline inputs, i.e. only with text
// the user typed or picked themselves. Upsert on (user_id,
// question_normalized) so re-answering updates rather than duplicating.
// ---------------------------------------------------------------------------
router.post('/api/autofill/answers', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { question, answer, answer_type: answerType, platform } = req.body || {};
    const normalized = normalizeQuestion(question);
    if (!normalized) return res.status(400).json({ error: 'question is required' });
    if (answer === undefined || answer === null || String(answer).trim() === '') {
      return res.status(400).json({ error: 'answer is required' });
    }

    const now = new Date().toISOString();
    const { data: existing, error: exErr } = await db
      .from('application_answers')
      .select('id, times_used')
      .eq('user_id', req.user.id)
      .eq('question_normalized', normalized)
      .maybeSingle();
    if (exErr) return next(Object.assign(new Error(exErr.message), { status: 500 }));

    if (existing) {
      const { data, error } = await db
        .from('application_answers')
        .update({
          question_original: String(question),
          answer_text: String(answer),
          answer_type: answerType || 'text',
          times_used: (existing.times_used || 0) + 1,
          last_used_at: now,
          updated_at: now,
        })
        .eq('id', existing.id)
        .select('id, question_normalized, answer_text, times_used')
        .single();
      if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
      return res.json({ answer: data, created: false });
    }

    const { data, error } = await db
      .from('application_answers')
      .insert({
        user_id: req.user.id,
        question_normalized: normalized,
        question_original: String(question),
        answer_text: String(answer),
        answer_type: answerType || 'text',
        first_seen_platform: platform || null,
      })
      .select('id, question_normalized, answer_text, times_used')
      .single();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    res.status(201).json({ answer: data, created: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/autofill/answers — everything the answer bank holds for this user.
//
// The read half of the bank had no route at all: answers went in through the
// review panel and could only be seen again by landing on a form that asked
// the same question. That was flagged the day self-identification answers
// started being stored — gender, race, veteran and disability status, pronouns
// — and carried forward unchanged by the next session. Demographic data a
// person cannot list or delete is not a missing nicety; §17.3 is explicit that
// these are only ever stored because the user typed them, and that promise is
// hollow without a way to take them back.
//
// Ordered by last use, so the bank reads as "what am I actually reusing".
// question_original (not the normalized key) is what the UI shows — the
// column exists for exactly this, per its own schema comment.
// ---------------------------------------------------------------------------
router.get('/api/autofill/answers', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { data, error } = await db
      .from('application_answers')
      .select('id, question_original, question_normalized, answer_text, answer_type, first_seen_platform, times_used, last_used_at, created_at')
      .eq('user_id', req.user.id)
      .order('last_used_at', { ascending: false });
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));

    res.json({ answers: data || [] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/autofill/answers/:id — forget one answer.
//
// Scoped by user_id as well as id: the service-role client bypasses RLS, so
// the ownership check has to be in the query rather than assumed from the
// policy. A miss is 404, never a silent 200 — "delete succeeded" about a row
// that still exists is the worst possible answer on this surface.
// ---------------------------------------------------------------------------
router.delete('/api/autofill/answers/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { data, error } = await db
      .from('application_answers')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select('id');
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
    if (!data || !data.length) return res.status(404).json({ error: 'Answer not found' });

    res.json({ deleted: data.length });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/autofill/answers — forget all of them.
//
// Requires ?confirm=true. Not a nicety: this is the only route in the app that
// empties a whole table for a user, and the UI asking twice is not a guarantee
// the API should rely on.
// ---------------------------------------------------------------------------
router.delete('/api/autofill/answers', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    if (String(req.query.confirm) !== 'true') {
      return res.status(400).json({ error: 'confirm=true is required to clear the whole answer bank' });
    }

    const { data, error } = await db
      .from('application_answers')
      .delete()
      .eq('user_id', req.user.id)
      .select('id');
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));

    res.json({ deleted: (data || []).length });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/autofill/job-match?url=... — which of the user's jobs is this page?
//
// Used to decide WHICH résumé to attach: the one generated for this specific
// job if it exists, otherwise the master résumé. Matching is by the ATS's own
// posting id extracted from the URL, because the same Greenhouse posting is
// reachable under several hostnames (job-boards.greenhouse.io,
// boards.greenhouse.io, and an embedding host like app.careerpuck.com) — all
// of which appear in real sourced rows, so hostname matching would miss.
// ---------------------------------------------------------------------------
function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function extractPostingId(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const ghJid = parsed.searchParams.get('gh_jid');
  if (ghJid) return ghJid;
  const host = parsed.hostname.toLowerCase();
  // Workday: .../<site>/job/<location>/<title>_<REQ ID>[/apply[/applyManually]],
  // with an optional /en-US/ locale prefix. The id is whatever follows the
  // LAST underscore of the segment two past "job" — real shapes seen in stored
  // links: R14177-1, JR2026140895, REQ-14463, R-0000186586, 2026046. Checked
  // BEFORE the Greenhouse numeric-path rule below, because a Workday location
  // segment can itself start with a number (/job/2000-Main-St/) and would
  // otherwise be read as a Greenhouse posting id. Kept in agreement with
  // apps/extension/src/adapters/workday.js by test.
  if (/(^|\.)myworkday(jobs|site)\.com$/.test(host)) {
    const segs = parsed.pathname.split('/').filter(Boolean);
    const jobIdx = segs.indexOf('job');
    const titleSeg = jobIdx >= 0 ? segs[jobIdx + 2] : null;
    const m = titleSeg ? titleSeg.match(/_([A-Za-z0-9-]*\d[A-Za-z0-9-]*)$/) : null;
    return m ? m[1] : null;
  }
  // Workable: apply.workable.com/j/<SHORTCODE> (stored link) and
  // apply.workable.com/<slug>/j/<SHORTCODE>/apply (the form). Kept in agreement
  // with apps/extension/src/adapters/workable.js by test.
  if (/(^|\.)workable\.com$/.test(host)) {
    const segs = parsed.pathname.split('/').filter(Boolean);
    const j = segs.indexOf('j');
    const code = j >= 0 ? segs[j + 1] : null;
    return code && /^[0-9a-z]{10}$/i.test(code) ? code.toUpperCase() : null;
  }
  // Greenhouse's JS embed: the form runs inside an iframe on the company's own
  // domain, and the URL the extension reports is that iframe's own
  // (job-boards.greenhouse.io/embed/job_app?for=<board>&token=<posting id>),
  // not the address bar's. Scoped to this path because `token` means "auth
  // token" on most other URLs. Kept in agreement with
  // apps/extension/src/adapters/greenhouse.js by test.
  if (/\/embed\/job_app\b/.test(parsed.pathname)) {
    const token = parsed.searchParams.get('token');
    if (token && /^\d{4,}$/.test(token)) return token;
  }
  const m = parsed.pathname.match(/\/jobs?\/(\d{4,})/);
  if (m) return m[1];
  // Lever posting ids are UUIDs, not numbers:
  // jobs.lever.co/<slug>/<uuid>[/apply] (also jobs.eu.lever.co). Kept in
  // agreement with apps/extension/src/adapters/lever.js by test.
  const segments = parsed.pathname.split('/').filter(Boolean);
  const uuid = segments.find((part) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)
  );
  if (uuid) return uuid.toLowerCase();
  // Last resort, for a company running its own application system (§17.2's
  // generic adapter): a long numeric posting id in the path. Meta carries the
  // same 16-digit id on /jobs/<id>/ and on
  // /profile/create_application/<id>/, which is what makes the match work.
  //
  // Seven digits is the floor, and only when the path has exactly one such
  // number. Matching below is `link LIKE %<id>%` against the user's own jobs,
  // so a short or ambiguous number would eventually attach the résumé written
  // for a DIFFERENT job — silently, since nobody re-reads an attachment. No
  // match is already a supported state (master résumé, §28); a wrong one is
  // not. Kept in agreement with apps/extension/src/adapters/generic.js by
  // test. Reached only after every platform rule above has declined, so no
  // Greenhouse/Lever/Ashby URL ever gets here.
  const numeric = segments.filter((part) => /^\d{7,}$/.test(part));
  if (numeric.length === 1) return numeric[0];
  return null;
}

router.get('/api/autofill/job-match', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const postingId = extractPostingId(url);
    let job = null;

    if (postingId) {
      const { data, error } = await db
        .from('jobs')
        .select('id, title, company_name, link, overall_fit')
        .eq('user_id', req.user.id)
        .like('link', `%${postingId}%`)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
      const rows = data || [];
      // Workday req ids are prefixes of each other often enough to matter —
      // `R14177-1` is a substring of `R14177-10` — so a LIKE hit is only a
      // candidate there, and the row's own link must parse to the same id.
      // Other platforms keep the first hit, as before.
      job = /(^|\.)myworkday(jobs|site)\.com$/i.test(safeHost(url))
        ? rows.find((row) => extractPostingId(row.link) === postingId) || null
        : rows[0] || null;
    }

    if (!job) {
      return res.json({ job: null, resume_document: null, cover_letter_document: null, posting_id: postingId });
    }

    // Latest COMPLETED document of each type generated for this job — same
    // shape/filter as GET /api/jobs/:id/documents, which the web app already
    // uses for its Download button. Cover letters have no master-résumé-style
    // fallback (spec §8, generated per-job only), so a job with none simply
    // returns null and the extension leaves that upload for the user.
    const { data: docs, error: dErr } = await db
      .from('generated_documents')
      .select('id, doc_type, status, created_at')
      .eq('user_id', req.user.id)
      .eq('job_id', job.id)
      .in('doc_type', ['resume', 'cover_letter'])
      .eq('status', 'completed')
      .order('created_at', { ascending: false });
    if (dErr) return next(Object.assign(new Error(dErr.message), { status: 500 }));

    const latestByType = {};
    for (const d of docs || []) if (!latestByType[d.doc_type]) latestByType[d.doc_type] = d;

    res.json({
      job,
      resume_document: latestByType.resume || null,
      cover_letter_document: latestByType.cover_letter || null,
      posting_id: postingId,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/autofill/resume-file[?document_id=...] — a signed URL for whichever
// résumé should be attached.
//
// Résumé selection rule (§28): the résumé generated FOR THIS JOB if one
// exists, otherwise the active master résumé. The caller passes
// `document_id` when job-match found one; with no id this returns the master.
// Both live in the same private bucket, so both are served the same way —
// short-lived signed URL, never a permanent public one (11.2).
// ---------------------------------------------------------------------------
// The name a file carries when autofill attaches it to an application:
// FirstName_LastName_Resume.docx / FirstName_LastName_Cover_Letter.docx. What a
// recruiter's inbox shows is the candidate's name, which a Company-Title name
// (the web app's own Download, generate.js downloadFilename) does not say —
// that one is organised for the user's own disk, this one for the reader.
// First and last whitespace token only: "Jane Kumar Doe" is still
// Jane_Doe. Accents are folded and anything else non-alphanumeric
// dropped, so the name survives every ATS's filename sanitiser unchanged.
function autofillFilename(fullName, docType, ext) {
  const clean = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9-]/g, '');
  const tokens = String(fullName || '').trim().split(/\s+/).map(clean).filter(Boolean);
  const nameParts = tokens.length > 1 ? [tokens[0], tokens[tokens.length - 1]] : tokens;
  const kind = docType === 'cover_letter' ? 'Cover_Letter' : 'Resume';
  const extension = String(ext || 'docx').replace(/^\./, '').toLowerCase() || 'docx';
  return `${[...nameParts, kind].join('_')}.${extension}`;
}

function extensionOf(pathOrName) {
  const m = String(pathOrName || '').match(/\.([A-Za-z0-9]{2,5})$/);
  return m ? m[1] : null;
}

router.get('/api/autofill/resume-file', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const { data: userRow } = await db
      .from('users')
      .select('contact_name, full_name')
      .eq('id', req.user.id)
      .maybeSingle();
    const fullName = (userRow && (userRow.contact_name || userRow.full_name)) || '';

    let storagePath = null;
    let filename = null;
    let source = null;

    if (req.query.document_id) {
      const { data: doc, error } = await db
        .from('generated_documents')
        .select('id, status, storage_path, doc_type, job_id')
        .eq('id', req.query.document_id)
        .eq('user_id', req.user.id)
        .maybeSingle();
      if (error) return next(Object.assign(new Error(error.message), { status: 500 }));
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      if (doc.status !== 'completed' || !doc.storage_path) {
        return res.status(409).json({ error: 'Document is not ready yet' });
      }
      // Named for the candidate, not the storage UUID — see autofillFilename.
      storagePath = doc.storage_path;
      filename = autofillFilename(fullName, doc.doc_type, extensionOf(doc.storage_path));
      source = 'job_specific';
    } else {
      const resume = await activeResumeVersion(db, req.user.id);
      if (!resume) return res.status(404).json({ error: 'No master resume uploaded yet' });
      storagePath = resume.storage_path;
      filename = autofillFilename(
        fullName,
        'resume',
        extensionOf(resume.original_filename) || extensionOf(storagePath)
      );
      source = 'master';
    }

    const { data: signed, error: sErr } = await db.storage
      .from(RESUME_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS, { download: filename });
    if (sErr) return next(Object.assign(new Error(sErr.message), { status: 500 }));

    res.json({ url: signed.signedUrl, filename, source, expires_in: SIGNED_URL_TTL_SECONDS });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.extractPostingId = extractPostingId;
module.exports.autofillFilename = autofillFilename;
module.exports.extensionOf = extensionOf;

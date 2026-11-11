const { Router } = require('express');
const multer = require('multer');
const { getSupabaseAdmin, geminiAdapter, groundResumeProfile } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const aiRouter = require('../lib/aiRouter');
const { parseResume } = require('../resume/parseResume');
const { deriveProfileInputs } = require('../resume/deriveProfile');
const { resolveContact } = require('../generation/extractContact');
const { refreshKeywordCoverageSoon } = require('../generation/refreshKeywordCoverage');

// Hybrid pre-filter inputs (spec 4.3): auto-seed users.* from the parsed resume.
// C1: years_of_experience/domain_keywords now RE-DERIVE AND OVERWRITE on every
// upload (not just when null) — a fresh résumé should actually refresh these —
// unless the corresponding *_manual flag is set (PATCH /api/profile), which
// means the user explicitly overrode it and it must never be clobbered.
//
// CHANGED 2026-08-02 (Phase 3 bug fix — "extra keywords when master CV
// changes"): domain_keywords was a straight overwrite, so a keyword the OLD
// résumé implied but the new one's wording doesn't could silently disappear
// on re-upload even with no manual override. Union with what's already
// stored instead of replacing — same case-insensitive-dedupe idiom as
// mergeForwardSkills below, new-parse spelling wins on a case collision.
function unionCaseInsensitive(prevList, nextList) {
  const seen = new Map(); // lowercase -> chosen (new-parse) spelling
  for (const s of nextList || []) {
    const k = String(s).toLowerCase().trim();
    if (k) seen.set(k, s);
  }
  for (const s of prevList || []) {
    const k = String(s).toLowerCase().trim();
    if (k && !seen.has(k)) seen.set(k, s);
  }
  return [...seen.values()];
}

async function seedProfileInputs(supabaseAdmin, userId, parsedProfile) {
  const { data: u } = await supabaseAdmin
    .from('users')
    .select('off_domain_title_keywords, domain_keywords, years_of_experience_manual, domain_keywords_manual')
    .eq('id', userId)
    .single();
  if (!u) return;

  const derived = deriveProfileInputs(parsedProfile);
  const patch = {};
  if (!u.years_of_experience_manual && derived.yearsOfExperience != null) {
    patch.years_of_experience = derived.yearsOfExperience;
  }
  if (!u.domain_keywords_manual && derived.domainKeywords.length) {
    patch.domain_keywords = unionCaseInsensitive(u.domain_keywords, derived.domainKeywords);
  }
  // No universal fallback for off_domain_title_keywords (spec 4.3, corrected
  // 2026-08-05) — there is no legitimate auto-derivation source for this
  // field, so it's left unset here; prefilter.js skips Step 3 entirely when
  // the user has no derived domain_keywords, and a manual PATCH /api/profile
  // override is the only other way it gets populated.
  if (Object.keys(patch).length) {
    await supabaseAdmin.from('users').update(patch).eq('id', userId);
  }
}

// CHANGED 2026-08-02 (Phase 3 bug fix — "extra keywords when master CV
// changes"): "make sure that when a new master CV is parsed then the
// existing keywords and skills are not affected but only new ones are
// added." Each résumé upload writes a wholly new immutable parsed_profile
// snapshot (correct, unchanged) — but a re-parse that misses a skill/cert the
// PREVIOUS version's parse caught (different resume wording, an OCR/parse
// miss, a section the new .docx dropped) would silently lose it from
// `skills_declared`/`certifications` with no signal. Union the previous
// active version's flat skill/cert lists forward into the new parse,
// case-insensitive dedupe, new-parse spelling wins on a spelling collision.
// Deliberately NOT applied to `roles`/`projects`/per-bullet
// `skills_demonstrated` — those are positionally ID'd (parseResume.js's
// assignBulletIds) and merging them across two independently-parsed
// documents would corrupt grounding, not just add noise.
function mergeForwardSkills(previousProfile, parsedProfile) {
  if (!previousProfile) return { parsedProfile, addedSkills: [], addedCerts: [] };
  const prevSkills = previousProfile.skills_declared || [];
  const prevCerts = previousProfile.certifications || [];
  const nextSkills = parsedProfile.skills_declared || [];
  const nextCerts = parsedProfile.certifications || [];
  const mergedSkills = unionCaseInsensitive(prevSkills, nextSkills);
  const mergedCerts = unionCaseInsensitive(prevCerts, nextCerts);
  const addedSkills = mergedSkills.filter((s) => !nextSkills.some((n) => String(n).toLowerCase() === String(s).toLowerCase()));
  const addedCerts = mergedCerts.filter((s) => !nextCerts.some((n) => String(n).toLowerCase() === String(s).toLowerCase()));
  return {
    parsedProfile: { ...parsedProfile, skills_declared: mergedSkills, certifications: mergedCerts },
    addedSkills,
    addedCerts,
  };
}

const router = Router();

const RESUME_BUCKET = 'resumes';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

async function activeResumeVersion(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('resume_versions')
    .select('id, storage_path, original_filename, version_number, parsed_profile, created_at')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  return data;
}

// Onboarding gate helper (spec 13.1) — reused by /api/me.
async function hasActiveResume(supabaseAdmin, userId) {
  const { count, error } = await supabaseAdmin
    .from('resume_versions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_active', true);
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  return (count || 0) > 0;
}

// POST /api/resume — upload a .docx master resume, store it privately, parse it
// into the structured profile (16.2), create resume_versions row, log AI usage.
router.post('/api/resume', requireAuth, upload.single('resume'), async (req, res, next) => {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

    const userId = req.user.id;
    const credential = await aiRouter.resolveAiCredential(supabaseAdmin, userId);
    if (credential.mode === 'cai' && !geminiAdapter.isConfigured()) {
      return res.status(503).json({ error: 'AI provider not configured' });
    }

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Missing "resume" file (.docx)' });
    const isDocx = file.mimetype === DOCX_MIME || /\.docx$/i.test(file.originalname || '');
    if (!isDocx) return res.status(400).json({ error: 'Only .docx resumes are accepted' });

    // Parse first — if the AI/parse fails we haven't mutated any state yet.
    const { parsedProfile: rawFreshProfile, resumeText, usage, costUsd, model, connectionMode } = await parseResume(file.buffer, credential);

    // Ground the fresh parse against the résumé's own text (2026-08-13
    // root-cause pass) — parseResume is AI-only with no prior code-level
    // check that an extracted skill genuinely appears in the résumé. Runs
    // BEFORE mergeForwardSkills so a previous version's already-grounded
    // skills aren't re-filtered against THIS version's (different) text.
    const freshProfile = groundResumeProfile(rawFreshProfile, resumeText);

    // Load the previous active version (if any) BEFORE it's deactivated below,
    // so its skills/certifications can be merged forward — see
    // mergeForwardSkills' header comment.
    const previousActive = await activeResumeVersion(supabaseAdmin, userId);
    const { parsedProfile, addedSkills, addedCerts } = mergeForwardSkills(previousActive && previousActive.parsed_profile, freshProfile);

    // Next version number.
    const { data: latest, error: latestErr } = await supabaseAdmin
      .from('resume_versions')
      .select('version_number')
      .eq('user_id', userId)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) return next(Object.assign(new Error(latestErr.message), { status: 500 }));
    const versionNumber = (latest?.version_number || 0) + 1;

    // Store the file privately at resumes/{user_id}/v{n}.docx.
    const storagePath = `${userId}/v${versionNumber}.docx`;
    const { error: uploadErr } = await supabaseAdmin.storage
      .from(RESUME_BUCKET)
      .upload(storagePath, file.buffer, { contentType: DOCX_MIME, upsert: true });
    if (uploadErr) return next(Object.assign(new Error(uploadErr.message), { status: 500 }));

    // Deactivate prior active version BEFORE inserting the new one (the partial
    // unique index allows only one active row per user).
    const { error: deactErr } = await supabaseAdmin
      .from('resume_versions')
      .update({ is_active: false })
      .eq('user_id', userId)
      .eq('is_active', true);
    if (deactErr) return next(Object.assign(new Error(deactErr.message), { status: 500 }));

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('resume_versions')
      .insert({
        user_id: userId,
        storage_path: storagePath,
        original_filename: file.originalname || null,
        version_number: versionNumber,
        is_active: true,
        parsed_profile: parsedProfile,
      })
      .select('id, version_number, created_at')
      .single();
    if (insertErr) return next(Object.assign(new Error(insertErr.message), { status: 500 }));

    // Raw AI-usage log (16.10) — parsing is free (no cos_transactions row).
    const { error: usageErr } = await supabaseAdmin.from('ai_usage_log').insert({
      user_id: userId,
      action_type: 'resume_parse',
      provider: credential.mode === 'cai' ? 'gemini' : credential.provider,
      connection_mode: connectionMode,
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cached_tokens: usage.cached_tokens,
      total_tokens: usage.total_tokens,
      raw_usage: usage.raw,
      cost_usd: costUsd,
      related_resume_version_id: inserted.id,
    });
    if (usageErr) console.error('ai_usage_log insert failed:', usageErr.message);

    // Auto-seed the pre-filter inputs (spec 4.3) from the parsed resume.
    try {
      await seedProfileInputs(supabaseAdmin, userId, parsedProfile);
    } catch (e) {
      console.error('seedProfileInputs failed:', e.message);
    }
    // Every job's "Keywords X/Y" is measured against the active résumé.
    refreshKeywordCoverageSoon(supabaseAdmin, userId);

    // Refresh contact info (name/city/phone/email/LinkedIn/portfolio/website)
    // from the newly uploaded .docx right away, rather than waiting for the
    // next generation call to discover it (2026-08-13 stale-portfolio-link
    // fix). resolveContact() already does the actual re-extraction +
    // per-field-provenance work (extractContact.js) — this just makes that
    // refresh happen immediately on upload instead of on next use, which is
    // the direct fix for "I uploaded a new résumé with a new portfolio link
    // but generated résumés still have the old one."
    try {
      const { data: u } = await supabaseAdmin.from('users').select('full_name').eq('id', userId).maybeSingle();
      await resolveContact(supabaseAdmin, userId, supabaseAdmin, storagePath, u && u.full_name);
    } catch (e) {
      console.error('resolveContact refresh on upload failed:', e.message);
    }

    res.status(201).json({
      resume_version: {
        id: inserted.id,
        version_number: inserted.version_number,
        original_filename: file.originalname || null,
        created_at: inserted.created_at,
      },
      parsed_profile: parsedProfile,
      // Observable, per mergeForwardSkills' header comment — how many
      // skills/certifications from the PREVIOUS version this new parse
      // missed and were carried forward rather than silently dropped.
      merged_forward: { skills: addedSkills, certifications: addedCerts },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/resume — current active version metadata + parsed profile.
router.get('/api/resume', requireAuth, async (req, res, next) => {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
    const active = await activeResumeVersion(supabaseAdmin, req.user.id);
    if (!active) return res.status(404).json({ error: 'No master resume uploaded yet' });
    res.json({ resume_version: active });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.hasActiveResume = hasActiveResume;
module.exports.activeResumeVersion = activeResumeVersion;

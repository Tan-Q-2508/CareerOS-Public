const { Router } = require('express');
const { getSupabaseAdmin } = require('@careeros/shared');
const { requireAuth } = require('../middleware/requireAuth');
const { hasActiveResume, activeResumeVersion } = require('./resume');
const { experienceBreakdown } = require('../resume/deriveProfile');

const router = Router();

// Object storage is one bucket, keyed by a `{userId}/...` prefix (11.1) — which
// is what makes 13.7's "files in object storage belonging to that user are
// deleted in the same operation" expressible as a prefix sweep rather than a
// join against every table that might reference a path.
const STORAGE_BUCKET = 'resumes';

router.get('/api/me', requireAuth, async (req, res, next) => {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) {
      return next(Object.assign(new Error(error.message), { status: 500 }));
    }

    const onboarded = await hasActiveResume(supabaseAdmin, req.user.id);

    // The years the pre-filter and scoring actually use when there is no
    // manual override (4.3) — computed live from the active résumé, with its
    // breakdown, so Settings can show where the number comes from.
    let experience = null;
    const resume = await activeResumeVersion(supabaseAdmin, req.user.id).catch(() => null);
    if (resume && resume.parsed_profile) experience = experienceBreakdown(resume.parsed_profile);

    res.json({ user: data, has_active_resume: onboarded, experience });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/me — account-level display name.
//
// §3.1 names "account-level display name/email" as a Profile & Resume surface
// and then records that it has no server route; this is that route, for the
// name half.
//
// The EMAIL half is deliberately NOT here. public.users.email is a mirror of
// auth.users.email, maintained by the handle_new_user trigger — writing it
// directly would desynchronise the row from the identity the user actually
// signs in with, so a real email change belongs to Supabase Auth's own
// verification flow, not to a PATCH on a mirrored column. Building the easy,
// wrong version of it would leave someone locked out of an account whose
// displayed address looked correct.
//
// full_name is real résumé input, not decoration: extractContact prefers it for
// the header name line (7.2) when the parsed résumé has no better candidate.
// ---------------------------------------------------------------------------
router.patch('/api/me', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    // Email is checked FIRST. Checking full_name first meant a request that
    // sent only `email` got "full_name is required" — technically true and
    // completely unhelpful about the actual reason the call cannot work.
    if (req.body && 'email' in req.body) {
      return res.status(400).json({
        error: 'Email is managed by your sign-in identity and cannot be changed here.',
      });
    }
    if (!req.body || !('full_name' in req.body)) {
      return res.status(400).json({ error: 'full_name is required' });
    }

    // An empty string clears the override and lets the parsed résumé's own name
    // win again — that is a meaningful choice, not a validation failure.
    const raw = req.body.full_name;
    const fullName = raw === null ? null : String(raw).trim().slice(0, 200) || null;

    const { data, error } = await db
      .from('users')
      .update({ full_name: fullName })
      .eq('id', req.user.id)
      .select('id, email, full_name')
      .single();
    if (error) return next(Object.assign(new Error(error.message), { status: 500 }));

    res.json({ user: data });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/me?confirm=true — delete the account and everything in it.
//
// Open since Phase 1 Session 2, which found that "deleting a user cascades all
// DB rows, but the user's Storage objects are NOT auto-removed (had to delete
// them manually in tests)" and re-flagged it a session later. §13.7 has
// specified the contract ever since — cascade for rows, "files in object
// storage belonging to that user are deleted in the same operation" — and
// nothing implemented it, because account deletion itself was never built.
//
// ORDER MATTERS, and it is storage first. The row cascade is what makes the
// storage paths findable; if the auth user were deleted first and the storage
// sweep then failed, the files would be orphaned with nothing left pointing at
// them. Doing it the other way round, a failed cascade leaves an account whose
// files are gone — recoverable by retrying the delete, and visibly broken
// rather than invisibly leaked.
//
// Deleting the auth.users row is what triggers the cascade: public.users.id is
// `references auth.users(id) on delete cascade`, and every user-scoped table
// cascades from public.users in turn. That is 13.7's "real foreign-key cascade
// rules, not an application-layer loop that can partially fail".
// ---------------------------------------------------------------------------
router.delete('/api/me', requireAuth, async (req, res, next) => {
  try {
    const db = getSupabaseAdmin();
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    if (String(req.query.confirm) !== 'true') {
      return res.status(400).json({ error: 'confirm=true is required to delete your account' });
    }

    const userId = req.user.id;

    const removed = await deleteUserStorage(db, userId);

    const { error: authErr } = await db.auth.admin.deleteUser(userId);
    if (authErr) {
      // The storage sweep already ran. Say so rather than reporting a clean
      // failure — the user needs to know the account still exists but its
      // generated files do not.
      return next(
        Object.assign(
          new Error(`Account rows were NOT deleted (${authErr.message}), but ${removed} stored file(s) were already removed. Retry the deletion.`),
          { status: 500 }
        )
      );
    }

    res.json({ deleted: true, storage_files_removed: removed });
  } catch (err) {
    next(err);
  }
});

/**
 * Remove every object under this user's storage prefix (11.1's `{userId}/...`
 * layout). Recurses because Supabase Storage's list() is one directory deep and
 * generated documents live a level down (`{userId}/generated/...`).
 *
 * @returns {Promise<number>} how many objects were removed
 */
async function deleteUserStorage(db, userId) {
  const paths = [];

  async function walk(prefix) {
    const { data, error } = await db.storage.from(STORAGE_BUCKET).list(prefix, { limit: 1000 });
    if (error) throw new Error(`storage list failed at "${prefix}": ${error.message}`);
    for (const entry of data || []) {
      const full = `${prefix}/${entry.name}`;
      // Supabase marks a real object with an id; a "folder" is a synthesized
      // prefix row with id null.
      if (entry.id) paths.push(full);
      else await walk(full);
    }
  }

  await walk(userId);
  if (!paths.length) return 0;

  const { error } = await db.storage.from(STORAGE_BUCKET).remove(paths);
  if (error) throw new Error(`storage remove failed: ${error.message}`);
  return paths.length;
}

module.exports = router;
module.exports.deleteUserStorage = deleteUserStorage;

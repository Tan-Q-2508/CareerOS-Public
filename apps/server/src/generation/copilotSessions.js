const { tunables } = require('@careeros/shared');
const { contentTreeFromAssembly } = require('./copilotTree');
const { resolvedPromptVersion } = require('./generateResume');

// Copilot Mode session cleanup (spec 7.14.3) — the direct analogue of
// scan/scheduler.js's reapStaleScans: Render's free tier restarts mid-process
// with no persistent job queue, so a session can get stuck rather than fail
// cleanly. Two distinct stale states:
//   - 'editing' sessions the user never returned to: marked 'abandoned' after
//     tunables.copilot.abandonedSessionTimeoutHours (24h) of no activity —
//     every mutating endpoint (PATCH, rewrite, inject-keyword, export) bumps
//     updated_at, so that IS the definition of activity. No refund (7.14.3):
//     the flat fee paid for the Director+shotgun calls already made.
//   - 'seeding' sessions whose seed process died before finishing: marked
//     'failed' after tunables.copilot.staleSeedingMinutes (30min) — mirrors a
//     `generated_documents` row stuck at 'running'.
// No user notification (unlike scan_orphaned) — 7.14.3 doesn't ask for one.
async function reapAbandonedCopilotSessions(db) {
  const abandonCutoff = new Date(Date.now() - tunables.copilot.abandonedSessionTimeoutHours * 60 * 60 * 1000).toISOString();
  const { data: abandoned, error: aErr } = await db
    .from('resume_edit_sessions')
    .update({ status: 'abandoned' })
    .eq('status', 'editing')
    .lt('updated_at', abandonCutoff)
    .select('id');
  if (aErr) throw aErr;

  const seedingCutoff = new Date(Date.now() - tunables.copilot.staleSeedingMinutes * 60 * 1000).toISOString();
  const { data: failed, error: fErr } = await db
    .from('resume_edit_sessions')
    .update({ status: 'failed', error_message: `Orphaned: the process restarted during session seeding (stale >${tunables.copilot.staleSeedingMinutes}m)` })
    .eq('status', 'seeding')
    .lt('updated_at', seedingCutoff)
    .select('id');
  if (fErr) throw fErr;

  return { abandoned: (abandoned || []).length, failed: (failed || []).length };
}

// Persist a one-click generation's content_tree (spec 15 #20(f) / 7.14.2 /
// 7.14.8) as a `completed_generation` resume_edit_sessions row — what
// "Continue in Copilot" (Session 21) will re-open, without re-running (and
// re-billing) the Content Director + shotgun draft. NOT flag-gated (unlike
// Stages 1-2): Session 21 needs this row regardless of which scoring path
// ran the generation. One row per (user_id, job_id) — enforced by a partial
// unique index (20260729000000 migration) — updated in place on
// re-generation rather than inserted fresh each time, matched by
// select-then-insert-or-update (not .upsert({onConflict}), which can't
// target a partial unique index; see CLAUDE.md's standing gotcha).
async function persistCompletedGenerationTree({ db, userId, job, resume, documentId, result, contact }) {
  const tree = contentTreeFromAssembly({
    asm: result.asm,
    draft: result.draft,
    contact,
    profile: resume.parsed_profile,
    roleTargets: result.roleTargets,
    projectTargets: result.projectTargets,
    promptVersion: resolvedPromptVersion(),
  });

  const { data: existing, error: selErr } = await db
    .from('resume_edit_sessions')
    .select('id')
    .eq('user_id', userId)
    .eq('job_id', job.id)
    .eq('status', 'completed_generation')
    .maybeSingle();
  if (selErr) throw selErr;

  const fields = {
    resume_version_id: resume.id,
    content_tree: tree,
    origin_tree: tree,
    generated_document_id: documentId,
    error_message: null,
  };

  if (existing) {
    const { error: updErr } = await db.from('resume_edit_sessions').update(fields).eq('id', existing.id);
    if (updErr) throw updErr;
  } else {
    const { error: insErr } = await db.from('resume_edit_sessions').insert({
      user_id: userId,
      job_id: job.id,
      status: 'completed_generation',
      ...fields,
    });
    if (insErr) throw insErr;
  }
}

module.exports = { reapAbandonedCopilotSessions, persistCompletedGenerationTree };

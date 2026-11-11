const { CancelledError } = require('./cancellation');

// Best-effort progress logger for long-running async pipelines (résumé/cover
// letter generation, scans, manual-entry scoring). Purely additive — appends
// `{step, label, at}` entries to a jsonb array column so the frontend's
// progress console (2026-07-27) has something real to poll for beyond
// queued/running/completed/failed. A progress WRITE never throws and is never
// allowed to affect pipeline behavior: every failure there is caught and
// logged, not surfaced, since a progress write is observability, not a
// pipeline step.
//
// Read-then-write rather than a Postgres jsonb append operator so this stays
// a plain Supabase client call (no raw SQL RPC needed) — acceptable because
// call sites use this sparingly (a handful of milestones per run), not per
// item in a loop; scan's own per-job counter (jobs_scored_count) already
// covers the high-frequency signal without going through this at all.
//
// CANCELLATION rides on the read this already does. With `cancellable: true`
// the same SELECT also fetches `status`, and a row the user has cancelled
// throws CancelledError — so a cancel costs no extra round-trip and takes
// effect at whatever milestones the pipeline already reports. That throw is
// the one exception to "never throws": it is a control signal, not a failed
// write, and the distinction is why the two live behind one flag rather than
// being conflated.
function makeProgressLogger(db, table, id, { cancellable = false } = {}) {
  return async function logProgress(step, label) {
    let row;
    try {
      const { data, error } = await db
        .from(table)
        .select(cancellable ? 'progress, status' : 'progress')
        .eq('id', id)
        .single();
      if (error || !data) return;
      row = data;
      const prev = Array.isArray(data.progress) ? data.progress : [];
      const next = [...prev, { step, label, at: new Date().toISOString() }];
      const { error: updErr } = await db.from(table).update({ progress: next }).eq('id', id);
      if (updErr) console.error(`progress log failed (${table}/${id}):`, updErr.message);
    } catch (err) {
      console.error(`progress log threw (${table}/${id}):`, err.message || err);
    }
    // Outside the try on purpose: a CancelledError raised in there would be
    // swallowed by the catch that exists to protect the pipeline from progress
    // writes, and the run would carry on after being cancelled.
    if (cancellable && row && row.status === 'cancelled') {
      throw new CancelledError();
    }
  };
}

module.exports = { makeProgressLogger };

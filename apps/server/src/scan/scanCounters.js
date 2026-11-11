// Live telemetry for one scan_history row (§26 regression fix — see
// CareerOS_Changelog.md §4.6.12) — a single throttled, single-writer counter
// bag shared by the ATS Direct pipeline and jobScorer.js, so the row's live
// counter columns (jobs_found_count, jobs_survived_prefilter_count,
// jobs_scored_count, jobs_above_threshold_count, companies_queried_count,
// companies_total_count) always have exactly one writer instead of the ATS
// pipeline and jobScorer each racing their own absolute-value updates.
//
// Throttle shape lifted verbatim from the old per-scorer version of this
// (jobScorer.js's now-removed maybeWriteProgress) — proven safe under the
// concurrent scoring pool: `writeInFlight` + a synchronous "attempt on every
// call, throttled by a time check" scheme, never a background timer, so once
// flush() resolves nothing can land after it. Never throws — best-effort
// observability, same contract as lib/progress.js.

const PROGRESS_THROTTLE_MS = 3000;

const FIELDS = [
  'jobs_found_count',
  'jobs_survived_prefilter_count',
  'jobs_scored_count',
  'jobs_above_threshold_count',
  'companies_queried_count',
  'companies_total_count',
  'jobs_location_filtered_count',
  'jobs_location_unsure_count',
];

// jsonb columns carried by the same single writer: why the pre-filter dropped
// what it dropped ({ "work_auth:citizen_only": 4, "years_gap": 11, … }) and
// which job boards failed after retries ([{company, platform, kind, message}]).
const JSON_FIELDS = { prefilter_drop_counts: () => ({}), board_failures: () => [] };

// "work_auth:citizen_only: \"must be a us citizen\"" -> "work_auth:citizen_only";
// "years_gap(5 vs 4.2)" -> "years_gap".
function dropReasonKey(reason) {
  const r = String(reason || 'unknown');
  const m = r.match(/^(work_auth:\w+|[a-z_]+)/);
  return m ? m[1] : 'unknown';
}

function createScanCounters(db, scanId) {
  const values = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  const written = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  const json = Object.fromEntries(Object.entries(JSON_FIELDS).map(([f, init]) => [f, init()]));
  const jsonVersion = Object.fromEntries(Object.keys(JSON_FIELDS).map((f) => [f, 0]));
  const jsonWritten = { ...jsonVersion };
  let writeInFlight = false;
  let lastWriteAt = 0;

  async function maybeWrite(force) {
    const dirty = FIELDS.filter((f) => values[f] !== written[f]);
    const dirtyJson = Object.keys(JSON_FIELDS).filter((f) => jsonVersion[f] !== jsonWritten[f]);
    if (!dirty.length && !dirtyJson.length) return;
    if (writeInFlight) return;
    if (!force && Date.now() - lastWriteAt < PROGRESS_THROTTLE_MS) return;
    writeInFlight = true;
    const snapshot = Object.fromEntries(dirty.map((f) => [f, values[f]]));
    const jsonSnap = Object.fromEntries(dirtyJson.map((f) => [f, jsonVersion[f]]));
    for (const f of dirtyJson) snapshot[f] = json[f];
    try {
      const { error } = await db.from('scan_history').update(snapshot).eq('id', scanId);
      if (error) {
        console.error(`scanCounters: write failed for scan ${scanId}:`, error.message);
      } else {
        for (const f of dirty) written[f] = snapshot[f];
        for (const f of dirtyJson) jsonWritten[f] = jsonSnap[f];
      }
      lastWriteAt = Date.now();
    } finally {
      writeInFlight = false;
    }
  }

  return {
    // Increments a field in memory, then attempts a (throttled) write.
    async add(field, n) {
      values[field] += n;
      await maybeWrite(false);
    },
    // Sets a field outright (companies_total_count — known once, not accumulated).
    async set(field, n) {
      values[field] = n;
      await maybeWrite(false);
    },
    // Tallies prefilter()'s dropped[] by reason family.
    async addDrops(dropped) {
      if (!dropped || !dropped.length) return;
      for (const d of dropped) {
        const k = dropReasonKey(d.reason);
        json.prefilter_drop_counts[k] = (json.prefilter_drop_counts[k] || 0) + 1;
      }
      jsonVersion.prefilter_drop_counts += 1;
      await maybeWrite(false);
    },
    async addBoardFailure(failure) {
      json.board_failures.push(failure);
      jsonVersion.board_failures += 1;
      await maybeWrite(false);
    },
    getJson(field) {
      return json[field];
    },
    get(field) {
      return values[field];
    },
    // Unthrottled final write — guarantees the row reflects every add()/set()
    // call made before this resolves.
    async flush() {
      await maybeWrite(true);
    },
  };
}

module.exports = { createScanCounters, dropReasonKey };

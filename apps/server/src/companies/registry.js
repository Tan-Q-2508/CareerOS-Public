// ATS Direct company registry — 4.6.4's dedup gate + 4.6.5's data model.
// Phase 4, §15 #23.
//
// resolveCompany() is the ONE function all four of 4.6.3's entry points call
// (scan results, manual JD entry, the user-facing request, and the periodic
// re-sweep via resweep.js). There is no second dedup or detection path — #22
// built one shared detectPlatform() precisely so this layer stays single too.
//
// Follows the house helper-module shape: a plain module taking the supabase
// client as its first argument (no DAO layer exists in this codebase).

const {
  atsDirect: { detectPlatform, normalizeCompanyName, isUsableCompanyLink },
  tunables,
} = require('@careeros/shared');
const { defaultTracklistId, scrapedTracklistId, getOwnedTracklistOrSubscribed } = require('./tracklists');
const { classifyAndApply } = require('./sectors');

// PostgREST caps an unfiltered .select() at 1000 rows (the 25b gotcha,
// CLAUDE.md) — a single sector tracklist can hold thousands of companies, so
// any membership read here must page past it rather than silently truncating.
async function selectAllPages(query) {
  const pageSize = 1000;
  const all = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

const REGISTRY_COLS =
  'id, company_name_normalized, company_name_display, platform, slug_or_identifier, status, source, detected_at, last_seen_at';

// A job's `source` (4.2's internal schema) vs the registry's `source` enum
// (4.6.5) — the vocabularies differ, so map rather than pass through.
const SOURCE_BY_JOB_SOURCE = { cs: 'cs', byo: 'byo_scraper', ats_direct: 'cs' };

function autoDetectCfg() {
  return tunables.atsDirect.autoDetect;
}

/** Postgres unique-violation. Two concurrent scans can race on a new company. */
function isUniqueViolation(error) {
  return error && (error.code === '23505' || /duplicate key value/i.test(error.message || ''));
}

// ---------------------------------------------------------------------------
// Tracking (4.6.5's per-user layer on the global registry) — §15 #25a
// retargets this onto the tracklist model (4.6.8), replacing
// user_tracked_companies. Signatures are UNCHANGED from #23/#24 so every
// caller outside this file (routes/companies.js, runScan.js's
// listScanCompanies call) keeps working with zero edits — only what backs
// "tracked" changed, not what it means to call these functions.
// ---------------------------------------------------------------------------

/**
 * Track a resolved company for a user: adds it to a lazily-created personal
 * tracklist. Idempotent — tracklist_companies' plain (non-partial) unique
 * index makes the underlying upsert in addCompaniesToTracklists safe.
 *
 * @param {'default'|'scraped'} [target='default'] which list to add to —
 *   'default' is "My Tracked Companies" (explicit user actions: the per-job
 *   "Track this company" picker, POST /api/companies/:id/track,
 *   POST /api/companies/request); 'scraped' is "Scraped Companies" (4.6.10's
 *   opt-in auto-track toggle) — kept separate so automatic and curated
 *   tracking stay visibly distinct.
 */
async function trackCompany(db, userId, registryId, { target = 'default' } = {}) {
  if (!userId || !registryId) return;
  try {
    const tracklistId =
      target === 'scraped' ? await scrapedTracklistId(db, userId) : await defaultTracklistId(db, userId);
    const { error } = await db
      .from('tracklist_companies')
      .upsert(
        { tracklist_id: tracklistId, company_ats_registry_id: registryId },
        { onConflict: 'tracklist_id,company_ats_registry_id', ignoreDuplicates: true }
      );
    if (error) throw error;
  } catch (e) {
    console.error('trackCompany failed:', e.message || e);
  }
}

/**
 * Untrack: removes the company from ALL of the user's tracklists — the honest
 * read of "untrack" under a multi-list model, since a single-list "untrack"
 * button gives no way to say which list to remove it from.
 */
async function untrackCompany(db, userId, registryId) {
  const { data: lists, error: listErr } = await db.from('tracklists').select('id').eq('user_id', userId);
  if (listErr) throw new Error(listErr.message);
  const listIds = (lists || []).map((l) => l.id);
  if (!listIds.length) return;
  const { error } = await db
    .from('tracklist_companies')
    .delete()
    .in('tracklist_id', listIds)
    .eq('company_ats_registry_id', registryId);
  if (error) throw new Error(error.message);
}

/**
 * The user's tracked companies: the deduped union of every company across
 * their personal tracklists plus any system tracklists they're subscribed to
 * (4.6.8/4.6.9 — no system rows exist yet as of #25a, so this is currently
 * equivalent to "personal tracklists only", but the union is built in now so
 * 25b's sector subscriptions need no further change here).
 */
async function listTrackedCompanies(db, userId) {
  const [{ data: personalLists, error: plErr }, { data: subs, error: sErr }] = await Promise.all([
    db.from('tracklists').select('id').eq('user_id', userId),
    db.from('tracklist_subscriptions').select('tracklist_id').eq('user_id', userId),
  ]);
  if (plErr) throw new Error(plErr.message);
  if (sErr) throw new Error(sErr.message);

  const listIds = Array.from(new Set([...(personalLists || []).map((l) => l.id), ...(subs || []).map((s) => s.tracklist_id)]));
  if (!listIds.length) return [];

  const { data, error } = await db
    .from('tracklist_companies')
    .select(`added_at, company:company_ats_registry (${REGISTRY_COLS})`)
    .in('tracklist_id', listIds)
    .order('added_at', { ascending: false });
  if (error) throw new Error(error.message);

  // A company can sit in more than one selected list — dedup by registry id,
  // keeping the earliest-seen (first, i.e. most-recent-added_at since the
  // query is already sorted desc) occurrence for a stable tracked_at.
  const byId = new Map();
  for (const r of data || []) {
    if (!r.company || byId.has(r.company.id)) continue;
    byId.set(r.company.id, { ...r.company, tracked_at: r.added_at });
  }
  return [...byId.values()];
}

/**
 * 4.6.5's opt-in browse list: every globally-resolved active company, flagged
 * with whether this user already tracks it (anywhere across their tracklists).
 * A company another user's scan resolved is visible to opt into, never
 * silently added.
 */
async function listKnownCompanies(db, userId, { q, limit = 200 } = {}) {
  let query = db
    .from('company_ats_registry')
    .select(REGISTRY_COLS)
    .eq('status', 'active')
    .order('company_name_display', { ascending: true })
    .limit(limit);
  if (q) query = query.ilike('company_name_display', `%${q}%`);

  const [{ data, error }, tracked] = await Promise.all([query, listTrackedCompanies(db, userId)]);
  if (error) throw new Error(error.message);

  const trackedIds = new Set(tracked.map((c) => c.id));
  return (data || []).map((c) => ({ ...c, tracked: trackedIds.has(c.id) }));
}

/**
 * §15 #24's scan-source resolver — the user's tracked companies (now the
 * tracklist union above), filtered to `status: 'active'` (4.6.5:
 * `pending_adapter` is reachable once Tier 3 lands and must be filtered out
 * here, not assumed away) and optionally intersected with a saved selection of
 * registry ids (4.6.6's multi-select, or a saved schedule's
 * `tracked_company_ids`). Empty/omitted `registryIds` means "all currently
 * tracked", matching 4.6.6's stated default.
 *
 * Unchanged behavior/signature from #24 — this is the seam that keeps ATS
 * Direct scans and existing schedules working across the #25a cutover with no
 * changes to runScan.js. 25c is what changes the SELECTION model (tracklist/
 * subscription ids instead of a flat registryIds array); this function's
 * contract stays as-is until then.
 */
async function listScanCompanies(db, userId, registryIds) {
  const tracked = await listTrackedCompanies(db, userId);
  const active = tracked.filter((c) => c.status === 'active');
  if (!registryIds || !registryIds.length) return active;
  const wanted = new Set(registryIds);
  return active.filter((c) => wanted.has(c.id));
}

/**
 * §15 #25c-2's selector resolver (4.6.6, revised) — an ATS Direct scan's
 * company selection is now a chosen combination of the user's own personal
 * tracklists and any system (sector) tracklists they're subscribed to
 * (4.6.8), optionally narrowed to a specific-companies sub-picker
 * (`registryIds` — the same field §24's flat selector used, kept as the
 * legacy/narrow input per 25c-1's decision 3, not removed).
 *
 * Ownership/subscription is checked per tracklist via
 * getOwnedTracklistOrSubscribed (already handles both cases) — a `tracklistId`
 * that doesn't resolve (not owned, not subscribed, or deleted) is reported
 * back in `missingTracklistIds` rather than thrown, since this is also the
 * mechanism 12.3's schedule narrow/notify behavior needs: a schedule finding
 * out one of its saved tracklists vanished must degrade gracefully, not error.
 *
 * With no `tracklistIds` at all, this delegates to the pre-25c-2
 * `listScanCompanies` path UNCHANGED — the seam that keeps every schedule
 * created before this session (only ever wrote `tracked_company_ids`)
 * resolving exactly as it did under §24/25a.
 *
 * @param {object} db
 * @param {string} userId
 * @param {{tracklistIds?: string[], registryIds?: string[]}} selection
 * @returns {Promise<{companies: object[], resolvedTracklistIds: string[], missingTracklistIds: string[]}>}
 */
async function resolveScanSelection(db, userId, { tracklistIds, registryIds } = {}) {
  const wantedTracklists = Array.from(new Set((tracklistIds || []).filter(Boolean)));

  if (!wantedTracklists.length) {
    const companies = await listScanCompanies(db, userId, registryIds);
    return { companies, resolvedTracklistIds: [], missingTracklistIds: [] };
  }

  const resolvedTracklistIds = [];
  const missingTracklistIds = [];
  await Promise.all(
    wantedTracklists.map(async (id) => {
      const tl = await getOwnedTracklistOrSubscribed(db, userId, id);
      if (tl) resolvedTracklistIds.push(id);
      else missingTracklistIds.push(id);
    })
  );

  let companyIds = new Set();
  if (resolvedTracklistIds.length) {
    const memberRows = await selectAllPages(
      db
        .from('tracklist_companies')
        .select('company_ats_registry_id')
        .in('tracklist_id', resolvedTracklistIds)
        .order('company_ats_registry_id', { ascending: true })
    );
    companyIds = new Set(memberRows.map((r) => r.company_ats_registry_id));
  }

  if (registryIds && registryIds.length) {
    const wanted = new Set(registryIds);
    companyIds = new Set([...companyIds].filter((id) => wanted.has(id)));
  }

  if (!companyIds.size) return { companies: [], resolvedTracklistIds, missingTracklistIds };

  // .in() with thousands of ids in one call risks an oversized request URL —
  // batch the registry fetch, same defensive posture as the membership page
  // size above (both guard against 25b's "a sector list can be huge" scale).
  const idList = [...companyIds];
  const BATCH = 500;
  const companies = [];
  for (let i = 0; i < idList.length; i += BATCH) {
    const batch = idList.slice(i, i + BATCH);
    const { data, error } = await db
      .from('company_ats_registry')
      .select(REGISTRY_COLS)
      .in('id', batch)
      .eq('status', 'active');
    if (error) throw new Error(error.message);
    companies.push(...(data || []));
  }

  return { companies, resolvedTracklistIds, missingTracklistIds };
}

// ---------------------------------------------------------------------------
// The dedup-then-detect core (4.6.4 → 4.6.2)
// ---------------------------------------------------------------------------

/**
 * Dedup an incoming company and, only if it's genuinely new, detect its ATS
 * platform. Never throws — every entry point calls this as isolated side work.
 *
 * @param {object} db supabase admin client
 * @param {object} input
 * @param {string} input.companyName raw display name
 * @param {string} [input.link] a source URL, if any — filtered by isUsableCompanyLink
 * @param {'cs'|'byo_scraper'|'user_request'|'manual'} input.source
 * @param {string} [input.userId] triggering user, for auto-tracking
 * @param {boolean} [input.autoTrack=false] whether this sighting also tracks the
 *   company for `userId` — §15 #25c-1 (4.6.10) flips this default from `true` to
 *   `false`: detection/sector-tagging always run on a sighting, but tracking is
 *   now an explicit opt-in (the per-job "Track this company" action, or the
 *   "Automatically track companies I scrape" Settings toggle), not an automatic
 *   side effect of every scan/manual-entry sighting. `POST /api/companies/request`
 *   (an explicit ask) and the "Track this company" picker pass `true` deliberately.
 * @param {'default'|'scraped'} [input.autoTrackTarget='default'] which personal
 *   list `autoTrack` adds to — 'scraped' routes to the dedicated "Scraped
 *   Companies" list (4.6.10's toggle), kept separate from curated tracking.
 * @param {boolean} [input.classifyOnInsert=true] §15 #25b (4.6.9): sector-classify a
 *   genuinely NEW registry row inline, awaited, one call. Single-company entry points
 *   (manual entry, user request) want this — the request is already synchronous behind
 *   a spinner doing ~15 outbound probes, so one more cheap AI call is honest. The
 *   scan fan-out (resolveCompaniesFromJobs) passes false and batches its own new
 *   companies into ONE call after the whole pool finishes, instead of up to 25.
 * @returns {Promise<{status: 'resolved'|'unresolved'|'skipped', wasNew: boolean, company?: object, unresolved?: object, reason?: string}>}
 */
async function resolveCompany(db, { companyName, link, source, userId, autoTrack = false, autoTrackTarget = 'default', classifyOnInsert = true } = {}) {
  // 4.6.4: normalize FIRST — this is the lookup key. Imported from the shared
  // ats package, never re-implemented: a second, subtly-different normalizer
  // would desync the dedup key from the detection key (#22's handoff).
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return { status: 'skipped', wasNew: false, reason: 'no_company_name' };

  const display = String(companyName).trim();
  // Only a plausible company URL counts as context; an aggregator link is not
  // one, and passing it through would mislabel the miss (see sourceLink.js).
  const usableLink = isUsableCompanyLink(link) ? link.trim() : null;

  // --- Already resolved? Do nothing but note the sighting (4.6.4).
  const { data: known } = await db
    .from('company_ats_registry')
    .select(REGISTRY_COLS)
    .eq('company_name_normalized', normalized)
    .maybeSingle();

  if (known) {
    await db
      .from('company_ats_registry')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', known.id);
    // Tracking is now opt-in (§15 #25c-1, 4.6.10) — `autoTrack` defaults to
    // false, so a plain sighting only bumps last_seen_at. When a caller does
    // pass autoTrack (the "Track this company" action, a request, or the
    // Settings auto-track toggle), the same "any sighting counts" behavior
    // from the pre-4.6.10 always-on era still applies: it's not gated on
    // `wasNew`, since a caller explicitly asking to track a company that
    // merely wasn't new to the *registry* should still succeed.
    if (autoTrack) await trackCompany(db, userId, known.id, { target: autoTrackTarget });
    return { status: 'resolved', wasNew: false, company: known };
  }

  // --- Already parked as unresolved? Bump the sighting counters, don't re-detect.
  const { data: parked } = await db
    .from('company_ats_unresolved')
    .select('id, check_count, careers_url_guess, match_attempt_type')
    .eq('company_name_normalized', normalized)
    .maybeSingle();

  if (parked) {
    const patch = {
      last_seen_at: new Date().toISOString(),
      check_count: (parked.check_count || 0) + 1,
    };
    // 4.6.3: a company that failed once may resolve later "if more context has
    // accumulated" — a usable URL from a later sighting is exactly that context,
    // and backfilling it here is what gives the re-sweep something new to try.
    if (usableLink && !parked.careers_url_guess) patch.careers_url_guess = usableLink;
    await db.from('company_ats_unresolved').update(patch).eq('id', parked.id);
    return {
      status: 'unresolved',
      wasNew: false,
      unresolved: { id: parked.id, match_attempt_type: parked.match_attempt_type },
    };
  }

  // --- Genuinely new (4.6.4): the only case that triggers detection.
  const detection = await detectPlatform({ companyName: display, link: usableLink });

  if (detection.platform && detection.slug) {
    const { company, created } = await insertRegistryRow(db, {
      normalized,
      display,
      platform: detection.platform,
      slug: detection.slug,
      source,
    });
    if (company && autoTrack) await trackCompany(db, userId, company.id, { target: autoTrackTarget });
    // Sector classification (4.6.9) fires ONLY on a genuine new insert — the
    // 23505-race branch inside insertRegistryRow returns created:false for the
    // existing row it re-selects, so a race never double-classifies, and the
    // re-sighting branch above (the `known` block) never reaches this code at
    // all, satisfying 4.6.9's "never on a re-sighting" requirement structurally.
    if (company && created && classifyOnInsert) {
      try {
        await classifyAndApply(
          db,
          [{ id: company.id, company_name_display: company.company_name_display, platform: company.platform, slug_or_identifier: company.slug_or_identifier }],
          { source: 'ai_detect' }
        );
      } catch (e) {
        // resolveCompany's contract is "never throws" — a classification hiccup
        // must not fail the caller's registry resolution.
        console.error(`sector classify failed for "${company.company_name_display}":`, e.message || e);
      }
    }
    return { status: 'resolved', wasNew: true, company };
  }

  const unresolved = await insertUnresolvedRow(db, {
    normalized,
    display,
    // detectPlatform's matchAttemptType is already exactly this column's two
    // values (4.6.5), so it persists as-is with no translation.
    matchAttemptType: detection.matchAttemptType || 'name_guess_failed',
    careersUrlGuess: usableLink,
    source,
  });
  return { status: 'unresolved', wasNew: true, unresolved };
}

/**
 * Insert a resolved company, converging rather than erroring if a concurrent
 * caller won the race on the same normalized name.
 *
 * status is always 'active' today: detection only probes platforms that have
 * adapters, so 4.6.5's 'pending_adapter' is currently unreachable. Left in the
 * schema rather than designed around — a Tier 3 detector (4.6.1) would produce it.
 *
 * Returns { company, created } — `created` distinguishes a genuine new row
 * from the 23505-race branch's re-selected existing row, which is what lets
 * the caller (resolveCompany) gate sector classification (4.6.9) on "actually
 * new" rather than "resolved", so a race can't double-classify.
 */
async function insertRegistryRow(db, { normalized, display, platform, slug, source }) {
  const { data, error } = await db
    .from('company_ats_registry')
    .insert({
      company_name_normalized: normalized,
      company_name_display: display,
      platform,
      slug_or_identifier: slug,
      status: 'active',
      source,
    })
    .select(REGISTRY_COLS)
    .single();

  if (!error) return { company: data, created: true };
  if (isUniqueViolation(error)) {
    const { data: existing } = await db
      .from('company_ats_registry')
      .select(REGISTRY_COLS)
      .eq('company_name_normalized', normalized)
      .maybeSingle();
    if (existing) return { company: existing, created: false };
  }
  console.error('insertRegistryRow failed:', error.message || error);
  return { company: null, created: false };
}

async function insertUnresolvedRow(db, { normalized, display, matchAttemptType, careersUrlGuess, source }) {
  const { data, error } = await db
    .from('company_ats_unresolved')
    .insert({
      company_name_normalized: normalized,
      company_name_display: display,
      match_attempt_type: matchAttemptType,
      careers_url_guess: careersUrlGuess,
      source,
    })
    .select('id, match_attempt_type, careers_url_guess')
    .single();

  if (!error) return data;
  if (isUniqueViolation(error)) {
    // Someone else parked it first — count this as a sighting rather than losing it.
    const { data: existing } = await db
      .from('company_ats_unresolved')
      .select('id, check_count, match_attempt_type, careers_url_guess')
      .eq('company_name_normalized', normalized)
      .maybeSingle();
    if (existing) {
      await db
        .from('company_ats_unresolved')
        .update({ last_seen_at: new Date().toISOString(), check_count: (existing.check_count || 0) + 1 })
        .eq('id', existing.id);
      return existing;
    }
  }
  console.error('insertUnresolvedRow failed:', error.message || error);
  return null;
}

// ---------------------------------------------------------------------------
// Batch entry point for scan results (4.6.3)
// ---------------------------------------------------------------------------

/**
 * Collapse a scan's job list to distinct companies and resolve each.
 *
 * Called with the FULL sourced set — before the pre-filter and before the
 * storage-threshold drop — because 4.6 is explicit that a job scoring below its
 * scan's threshold still gets its company detection-checked.
 *
 * @param {object} db
 * @param {string} userId
 * @param {Array<object>} jobs 4.2-shaped normalized jobs
 * @param {object} [opts]
 * @param {boolean} [opts.autoTrack=false] §15 #25c-1 (4.6.10): the scan fan-out no
 *   longer tracks by default — pass true only when the triggering user has the
 *   "Automatically track companies I scrape" Settings toggle on, in which case
 *   every company this pass resolves/re-sights is routed to "Scraped Companies"
 *   (autoTrackTarget: 'scraped'), never the curated default list.
 */
async function resolveCompaniesFromJobs(db, userId, jobs, { autoTrack = false } = {}) {
  const cfg = autoDetectCfg();

  // One entry per normalized company, preferring a representative that carries
  // a usable company URL — that's what lets detection take the cheap,
  // deterministic URL-match path instead of guessing (4.6.2).
  const byName = new Map();
  for (const job of jobs || []) {
    const normalized = normalizeCompanyName(job && job.companyName);
    if (!normalized) continue;
    const usable = isUsableCompanyLink(job.link);
    const existing = byName.get(normalized);
    if (!existing) {
      byName.set(normalized, {
        companyName: job.companyName,
        link: usable ? job.link : null,
        source: SOURCE_BY_JOB_SOURCE[job.source] || 'cs',
      });
    } else if (usable && !existing.link) {
      existing.link = job.link;
    }
  }

  // A first scan can surface dozens of new companies, each costing a probe
  // sweep. Cap the per-scan work; anything over the cap is simply seen again on
  // the next scan (no state is written for it, so nothing is lost or mislabeled).
  const companies = [...byName.values()].slice(0, cfg.maxCompaniesPerScan);
  const results = { resolved: 0, unresolved: 0, skipped: 0, considered: byName.size, attempted: companies.length };

  // §15 #25b (4.6.9): companies newly inserted by this pool get sector-
  // classified in ONE batched call after the pool finishes, instead of up to
  // maxCompaniesPerScan individual calls — resolveCompany is told NOT to
  // classify inline (classifyOnInsert: false) so this stays the only call.
  const newlyInserted = [];

  let next = 0;
  const workers = new Array(Math.max(1, Math.min(cfg.companyConcurrency, companies.length)))
    .fill(0)
    .map(async () => {
      for (;;) {
        const i = next++;
        if (i >= companies.length) return;
        const c = companies[i];
        try {
          const r = await resolveCompany(db, {
            ...c,
            userId,
            autoTrack,
            autoTrackTarget: 'scraped',
            classifyOnInsert: false,
          });
          if (r.status === 'resolved') {
            results.resolved++;
            if (r.wasNew && r.company) newlyInserted.push(r.company);
          } else if (r.status === 'unresolved') results.unresolved++;
          else results.skipped++;
        } catch (e) {
          results.skipped++;
          console.error(`resolveCompaniesFromJobs: "${c.companyName}" failed:`, e.message || e);
        }
      }
    });
  await Promise.all(workers);

  if (newlyInserted.length) {
    try {
      await classifyAndApply(
        db,
        newlyInserted.map((c) => ({
          id: c.id,
          company_name_display: c.company_name_display,
          platform: c.platform,
          slug_or_identifier: c.slug_or_identifier,
        })),
        { source: 'ai_detect' }
      );
    } catch (e) {
      console.error('resolveCompaniesFromJobs: batch sector classify failed:', e.message || e);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Backfill jobs.company_ats_registry_id (4.6.10's "previously unflagged gap")
// — §15 #25c-1
// ---------------------------------------------------------------------------

/**
 * Link `jobs` rows to the registry rows their company name resolves to.
 *
 * NOT threaded through resolveCompany's/resolveCompaniesFromJobs' result —
 * detection's fan-out caps at tunables.atsDirect.autoDetect.maxCompaniesPerScan
 * (25) distinct companies per scan, so a company past that cap would never get
 * linked if this relied on the detection result directly. A bulk normalized-
 * name lookup against the full ~11.5k-row registry covers every company
 * regardless of the detection cap, at the cost of one extra query. Reuses
 * normalizeCompanyName — the same normalizer dedup/detection use — so no
 * second name-matching path is introduced (4.6.4's stated risk).
 *
 * Idempotent and never throws: re-running it (a second call in the same scan,
 * or the standalone backfill script) just re-sets the same ids.
 *
 * @param {object} db
 * @param {string} userId
 * @param {object} [opts]
 * @param {string} [opts.scanId] scope the DB-requery path to one scan_history_id
 * @param {Array<{companyName: string, dedupKey: string}>} [opts.jobs] pass the
 *   in-memory sourced-job set directly (runScan's `found` array shape) to skip
 *   the requery — used right after the jobs upsert, when the just-inserted rows
 *   are already known. Omit to re-query `jobs` rows with a null
 *   company_ats_registry_id for this user (used by the standalone backfill
 *   script and the post-detection follow-up call).
 * @returns {Promise<{linked: number}>}
 */
async function linkJobsToRegistry(db, userId, { scanId, jobs } = {}) {
  if (!userId) return { linked: 0 };
  try {
    let entries;
    if (jobs && jobs.length) {
      entries = jobs
        .map((j) => ({ companyName: j.companyName, dedupKey: j.dedupKey }))
        .filter((j) => j.companyName && j.dedupKey);
    } else {
      let q = db
        .from('jobs')
        .select('company_name, dedup_key')
        .eq('user_id', userId)
        .is('company_ats_registry_id', null);
      if (scanId) q = q.eq('scan_history_id', scanId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      entries = (data || []).map((r) => ({ companyName: r.company_name, dedupKey: r.dedup_key }));
    }
    if (!entries.length) return { linked: 0 };

    const byNormalized = new Map();
    for (const e of entries) {
      const norm = normalizeCompanyName(e.companyName);
      if (!norm || !e.dedupKey) continue;
      if (!byNormalized.has(norm)) byNormalized.set(norm, []);
      byNormalized.get(norm).push(e.dedupKey);
    }
    if (!byNormalized.size) return { linked: 0 };

    const { data: registryRows, error: regErr } = await db
      .from('company_ats_registry')
      .select('id, company_name_normalized')
      .in('company_name_normalized', [...byNormalized.keys()]);
    if (regErr) throw new Error(regErr.message);

    let linked = 0;
    for (const reg of registryRows || []) {
      const dedupKeys = byNormalized.get(reg.company_name_normalized);
      if (!dedupKeys || !dedupKeys.length) continue;
      const { error: updErr } = await db
        .from('jobs')
        .update({ company_ats_registry_id: reg.id })
        .eq('user_id', userId)
        .in('dedup_key', dedupKeys);
      if (updErr) {
        console.error(`linkJobsToRegistry: update failed for registry ${reg.id}:`, updErr.message);
        continue;
      }
      linked += dedupKeys.length;
    }
    return { linked };
  } catch (e) {
    console.error('linkJobsToRegistry failed:', e.message || e);
    return { linked: 0 };
  }
}

module.exports = {
  resolveCompany,
  resolveCompaniesFromJobs,
  linkJobsToRegistry,
  trackCompany,
  untrackCompany,
  listTrackedCompanies,
  listKnownCompanies,
  listScanCompanies,
  resolveScanSelection,
  REGISTRY_COLS,
  SOURCE_BY_JOB_SOURCE,
  // Shared with bulkRegister.js (§15 #65) so a bulk import inserts through
  // the same race-safe path as live detection, not a second copy of it.
  insertRegistryRow,
  isUniqueViolation,
};

const { getSupabaseAdmin, geminiAdapter, tunables } = require('@careeros/shared');
const googleOAuth = require('../lib/googleOAuth');
const gmailClient = require('../lib/gmailClient');
const { buildSearchQuery } = require('./buildSearchQuery');
const { classifyEmails } = require('./classifyEmails');
const cosGuard = require('../lib/cosGuard');
const aiRouter = require('../lib/aiRouter');
const { makeProgressLogger } = require('../lib/progress');

// Orchestrates the button-triggered Gmail status check (spec §9.1): load the
// in-scope applications, run ONE batched Gmail search + a capped message fetch,
// run ONE AI classification call, and return per-application suggestions. It
// NEVER moves a stage — findings require explicit per-item confirmation in the
// UI (§9.1.4). Billed as an unbilled `email_check` COS row in Phase 1 (13.4).

// The active pipeline is checked (dashboard/tracker unification, 2026-07-21):
// Saved (a job the user may have applied to externally — catch the confirmation),
// Applied, Interviewing, Offer. Terminal/user-final stages (Rejected, Accepted,
// Deemed Not Suitable) are left untouched.
const IN_SCOPE_STAGES = ['Saved', 'Applied', 'Interviewing', 'Offer'];

// A classified signal maps to a suggested stage move. recruiter_followup and
// ambiguous are informational (surfaced, but no stage change proposed);
// unrelated / unmatched emails are dropped entirely. application_confirmation
// promotes Saved -> Applied (only Saved; a no-op for already-Applied+ jobs).
const SIGNAL_TO_STAGE = {
  application_confirmation: 'Applied',
  rejection: 'Rejected',
  interview_scheduling: 'Interviewing',
  offer: 'Offer',
  recruiter_followup: null,
  ambiguous: null,
};

// Actionability + suggested-stage for one (application, classified result)
// pair — shared by the direct-match and the clarify path below so both agree
// on when a signal is worth surfacing at all.
function suggestionForApp(app, r) {
  const suggestedStage = SIGNAL_TO_STAGE[r.signal_type] || null;
  const round = r.interview_round || null;
  const changesStage = suggestedStage && suggestedStage !== app.stage;
  // Skip only when nothing actionable: no stage change AND no interview
  // date/round to record. A new interview round for an already-Interviewing
  // app still surfaces (to update the date/round).
  const actionable = Boolean(changesStage || r.interview_date || round);
  return { suggestedStage: changesStage ? suggestedStage : null, round, actionable };
}

// Build one suggestion per application (`kind: 'match'`), plus a clarify
// suggestion (`kind: 'clarify'`) for a company that sent a generic email
// naming no specific role (bug fix 2026-07-28 — e.g. Google's boilerplate
// "Thanks for applying to Google", which the classifier used to have to
// force onto whichever Google application happened to already be `Applied`,
// silently overwriting the WRONG job's status when the user had several open
// Google applications). classifyEmails.js now leaves matched_application_id
// null and lists every plausible application in candidate_application_ids for
// that case; this turns that into a "which of these did you apply to?" row
// instead of a guess. When several emails match the same application (or the
// same company+signal, for a clarify), the MOST RECENT one (max internalDate)
// wins — it reflects the current status (an old rejection can't override a
// newer interview). `emails` supplies the recency timestamps keyed by email id.
function toSuggestions(classified, appById, emailById) {
  const latestByApp = new Map();
  // key = `${company.toLowerCase()}::${signal_type}` -> latest clarify result
  const latestClarifyByCompanySignal = new Map();

  for (const r of classified) {
    if (r.signal_type === 'unrelated') continue;
    const ts = (emailById.get(r.email_id) || {}).internalDate || 0;

    if (r.matched_application_id && appById.has(r.matched_application_id)) {
      const cur = latestByApp.get(r.matched_application_id);
      if (!cur || ts >= cur.ts) latestByApp.set(r.matched_application_id, { r, ts });
      continue;
    }

    const candidateIds = Array.isArray(r.candidate_application_ids)
      ? r.candidate_application_ids.filter((id) => appById.has(id))
      : [];
    if (candidateIds.length === 0) continue; // genuinely unmatched/unrelated — drop
    const company = appById.get(candidateIds[0]).company || null;
    const key = `${(company || '').toLowerCase()}::${r.signal_type}`;
    const cur = latestClarifyByCompanySignal.get(key);
    if (!cur || ts >= cur.ts) latestClarifyByCompanySignal.set(key, { r, ts, candidateIds, company });
  }

  const out = [];
  for (const [appId, { r }] of latestByApp) {
    const app = appById.get(appId);
    const { suggestedStage, round, actionable } = suggestionForApp(app, r);
    if (!actionable) continue;
    out.push({
      kind: 'match',
      application_id: app.id,
      job_title: app.title,
      company: app.company,
      current_stage: app.stage,
      signal_type: r.signal_type,
      suggested_stage: suggestedStage,
      interview_date: r.interview_date || null,
      interview_round: round,
      detail: r.detail || null,
    });
  }

  for (const { r, candidateIds, company } of latestClarifyByCompanySignal.values()) {
    const candidates = candidateIds
      .map((id) => appById.get(id))
      .map((app) => ({ app, ...suggestionForApp(app, r) }))
      .filter((c) => c.actionable)
      .map((c) => ({
        application_id: c.app.id,
        job_title: c.app.title,
        current_stage: c.app.stage,
        suggested_stage: c.suggestedStage,
      }));
    if (candidates.length === 0) continue;

    // Suppress the clarify row if this same batch already produced a specific
    // match for the same company + signal — the real role already got the
    // update, no need to also ask "which one" for the same news.
    const alreadyMatched = [...latestByApp.values()].some(({ r: mr }) => {
      if (mr.signal_type !== r.signal_type) return false;
      const matchedApp = appById.get(mr.matched_application_id);
      return (
        matchedApp && matchedApp.company && company &&
        matchedApp.company.toLowerCase() === company.toLowerCase()
      );
    });
    if (alreadyMatched) continue;

    out.push({
      kind: 'clarify',
      company,
      signal_type: r.signal_type,
      interview_date: r.interview_date || null,
      interview_round: r.interview_round || null,
      detail: r.detail || null,
      candidates,
    });
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.runId]  an `email_check_runs` row id (progress console,
 *   bug batch 2026-07-28) — when present, milestones are logged to it via the
 *   shared makeProgressLogger and the terminal row (completed/failed + result)
 *   is written before returning/throwing. Optional so this stays directly
 *   callable without a run row if ever needed (e.g. a future scheduled check).
 * @returns {{ suggestions, checked_count, candidate_count, cos }}
 * @throws  googleOAuth.GmailNotConnectedError if Gmail isn't connected
 */
async function runEmailCheck(userId, opts = {}) {
  const db = getSupabaseAdmin();
  const { runId } = opts;
  const logProgress = runId ? makeProgressLogger(db, 'email_check_runs', runId) : async () => {};
  const mark = (fields) => (runId ? db.from('email_check_runs').update(fields).eq('id', runId) : Promise.resolve());

  // Every early-return path below goes through this so the run row always
  // gets its terminal write, not just the final one at the bottom.
  async function finish(result) {
    await logProgress('done', `${result.suggestions.length} suggestion(s) found`);
    await mark({
      status: 'completed',
      completed_at: new Date().toISOString(),
      result,
      checked_count: result.checked_count,
      candidate_count: result.candidate_count,
    });
    return result;
  }

  try {
    if (runId) await mark({ status: 'running', started_at: new Date().toISOString() });

    const credential = await aiRouter.resolveAiCredential(db, userId);
    if (credential.mode === 'cai' && !geminiAdapter.isConfigured()) {
      throw Object.assign(new Error('AI provider not configured'), { status: 503 });
    }

    await logProgress('scope', 'Loading your active applications');

    // In-scope applications joined with their job's company/title.
    const { data: apps, error: appErr } = await db
      .from('applications')
      .select('id, stage, created_at, last_email_checked_at, job:jobs(company_name, title)')
      .eq('user_id', userId)
      .in('stage', IN_SCOPE_STAGES);
    if (appErr) throw Object.assign(new Error(appErr.message), { status: 500 });

    const allApps = (apps || []).map((a) => ({
      id: a.id,
      stage: a.stage,
      createdAt: a.created_at,
      lastCheckedAt: a.last_email_checked_at,
      company: a.job ? a.job.company_name : null,
      title: a.job ? a.job.title : null,
    }));
    if (allApps.length === 0) {
      return await finish({ suggestions: [], checked_count: 0, candidate_count: 0, cos: null });
    }

    // Every in-scope application goes to the Gmail search AND the classifier —
    // no cap (bug fix 2026-07-28: the former maxSearchApps:50 cap silently
    // dropped roughly half of a 101-application account, invisibly to both the
    // search and the classifier — confirmed live as the cause of missed
    // DOSS/Notion/Waymo confirmations, all created in the same newest scan).
    //
    // At real scale the term/candidate budgets below (maxSearchQueries,
    // maxCandidates) can still truncate — that's now unavoidable past some
    // application count, not a bug in itself. What WAS a bug (fixed
    // 2026-08-12, live incident: a FluidStack confirmation email never
    // surfaced) is sorting by newest-created-first: a burst of newer
    // Saved-stage applications (e.g. from an unrelated scan) permanently
    // buried an older, still-recent real application behind the truncation
    // point on every single run, since its position in a newest-first sort
    // never improves. Sort by least-recently-checked instead (NULL — never
    // checked — first), same rotating-fairness idea as the ATS Direct scan
    // cursor (spec §25c-2): whatever gets left out of THIS run's budget is
    // exactly what's most likely to be included in the NEXT one, so no
    // application is buried forever. Stage priority still breaks ties first
    // (an active-pipeline app is more likely to have relevant mail).
    const priority = { Offer: 0, Interviewing: 1, Applied: 2, Saved: 3 };
    const applications = [...allApps].sort((a, b) => {
      const p = (priority[a.stage] ?? 9) - (priority[b.stage] ?? 9);
      if (p !== 0) return p;
      const at = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : -Infinity;
      const bt = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : -Infinity;
      if (at !== bt) return at - bt; // oldest/never-checked first
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0); // tie-break: newest first
    });

    // Access token is minted server-side from the stored refresh token; throws
    // GmailNotConnectedError if the user hasn't connected Gmail.
    const accessToken = await googleOAuth.getAccessToken(userId);

    const { queries, includedAppIds, truncated } = buildSearchQuery(
      applications,
      tunables.emailCheck.searchWindowDays,
      {
        charBudget: tunables.emailCheck.queryCharBudget,
        maxQueries: tunables.emailCheck.maxSearchQueries,
      }
    );
    if (queries.length === 0) {
      return await finish({ suggestions: [], checked_count: applications.length, candidate_count: 0, cos: null });
    }

    // Stamp every application whose terms actually made it into an executed
    // query — this is what next run's sort above rotates on. Applications cut
    // by truncation are left untouched (still NULL or stale), so they sort to
    // the front next time instead of losing their place forever. Best-effort:
    // a failure here shouldn't fail the whole check.
    if (includedAppIds.size > 0) {
      const ids = [...includedAppIds];
      const { error: stampErr } = await db
        .from('applications')
        .update({ last_email_checked_at: new Date().toISOString() })
        .in('id', ids);
      if (stampErr) console.error('runEmailCheck: last_email_checked_at stamp failed:', stampErr.message);
    }
    if (truncated) {
      await logProgress(
        'search',
        `${applications.length} applications exceeded this run's search budget — the ones not covered this time are prioritized next run`
      );
    }

    await logProgress('search', `Searching Gmail across ${applications.length} application(s)`);

    // Run every query chunk (bug fix 2026-07-28 — see buildSearchQuery.js), merge
    // ids preserving first-seen order, dedupe, then cap to maxCandidates. One
    // application's terms landing in a different chunk than another's no longer
    // matters — both chunks run, so recall is the same as one giant query would
    // have given, just split across a few requests instead of one.
    //
    // Per-query fetch is capped to a FAIR SHARE of maxCandidates (bug fix
    // 2026-08-12), not the full global cap — previously every query requested
    // up to maxCandidates on its own, so query #1 alone could fill the entire
    // final merged-and-truncated list, silently starving every later chunk's
    // results regardless of relevance (this is what made the newest-first sort
    // above so damaging: it wasn't just about which apps got search terms, it
    // was also about whose results survived the final truncation).
    const perQueryCap = Math.max(15, Math.ceil(tunables.emailCheck.maxCandidates / queries.length));
    const idSet = new Set();
    const ids = [];
    for (const q of queries) {
      const found = await gmailClient.searchMessages(accessToken, q, perQueryCap);
      for (const id of found) {
        if (!idSet.has(id)) {
          idSet.add(id);
          ids.push(id);
        }
      }
    }
    ids.length = Math.min(ids.length, tunables.emailCheck.maxCandidates);
    if (ids.length === 0) {
      await logProgress('search', `${queries.length} search${queries.length === 1 ? '' : 'es'} run, no candidate messages found`);
      return await finish({ suggestions: [], checked_count: applications.length, candidate_count: 0, cos: null });
    }
    await logProgress('search', `Found ${ids.length} candidate message(s) across ${queries.length} search${queries.length === 1 ? '' : 'es'}`);

    // Gmail enforces a per-user concurrent-request limit ("Too many concurrent
    // requests for user") — fetch in small batches rather than all at once.
    // Confirmed live: firing all of maxCandidates:50 in parallel hits this;
    // batches of 8 don't. Only matters now that E1 raised maxCandidates 25->50.
    await logProgress('fetch', `Fetching ${ids.length} message(s)`);
    const emails = [];
    const FETCH_BATCH_SIZE = 8;
    for (let i = 0; i < ids.length; i += FETCH_BATCH_SIZE) {
      const batch = ids.slice(i, i + FETCH_BATCH_SIZE);
      const results = await Promise.all(batch.map((id) => gmailClient.getMessage(accessToken, id)));
      emails.push(...results);
    }

    // ONE AI classification call for the whole batch.
    await logProgress('classify', `Classifying ${emails.length} email(s) against ${applications.length} application(s)`);
    const classified = await classifyEmails({ applications, emails, credential });

    const appById = new Map(applications.map((a) => [a.id, a]));
    const emailById = new Map(emails.map((e) => [e.id, e]));
    const suggestions = toSuggestions(classified.results, appById, emailById);

    // Usage + COS ledger (13.4). Email check = flat fee + the single
    // classification call's AI fee (same shape as a scan's AI fee).
    const { error: logErr } = await db.from('ai_usage_log').insert({
      user_id: userId,
      action_type: 'email_check',
      provider: credential.mode === 'cai' ? 'gemini' : credential.provider,
      connection_mode: classified.connectionMode,
      model: classified.model,
      input_tokens: classified.usage.input_tokens,
      output_tokens: classified.usage.output_tokens,
      cached_tokens: classified.usage.cached_tokens,
      total_tokens: classified.usage.total_tokens,
      raw_usage: classified.usage.raw,
      cost_usd: classified.costUsd,
    });
    if (logErr) console.error('ai_usage_log insert failed:', logErr.message);

    const aiCostCos = aiRouter.computeAiFeeCos({ credential, usages: [{ usage: classified.usage, costUsd: classified.costUsd, tier: 'cheap' }] });
    const aiNote = credential.mode === 'cai'
      ? `real AI cost $${(classified.costUsd || 0).toFixed(6)}`
      : `BYOK (${credential.provider}) AI fee ${aiCostCos} COS`;
    await cosGuard.debitCos(db, userId, {
      actionType: 'email_check',
      flatFee: tunables.flatFees.email_check,
      aiCost: aiCostCos,
      note: `Email status check: ${emails.length} email(s) classified, ${suggestions.length} suggestion(s), ${aiNote}`,
    });

    return await finish({
      suggestions,
      checked_count: applications.length,
      candidate_count: emails.length,
      cos: { flat_fee: tunables.flatFees.email_check, ai_cost: aiCostCos },
    });
  } catch (err) {
    console.error('runEmailCheck failed:', err.message || err);
    await logProgress('failed', String(err.message || err).slice(0, 200));
    if (runId) {
      const errorCode = err instanceof googleOAuth.GmailNotConnectedError || err.code === 'gmail_not_connected' ? 'gmail_not_connected' : null;
      await mark({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: String(err.message || err).slice(0, 500),
        error_code: errorCode,
      });
    }
    throw err;
  }
}

module.exports = { runEmailCheck, toSuggestions, SIGNAL_TO_STAGE, IN_SCOPE_STAGES };

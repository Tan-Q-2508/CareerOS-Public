const { tunables } = require('@careeros/shared');

// COS enforcement, Stripe-free (spec 0.1/13/15#13, Phase 2 session 13). Single
// seam for both halves of "COS is a real constraint": a pre-check gate (before
// a billable action starts, against its known flat fee — the AI-cost
// component isn't known until the call actually runs) and a post-hoc debit
// (once the real cost is measured). Both are gated behind
// tunables.enforceCosBalance so Phase-1 behavior (unbilled logging only, never
// blocks) is unchanged until that flag flips — see scheduler.js, which already
// established this exact gating pattern for scheduled scans; this module
// generalizes it to every manually-triggered billable action too.

// Every action_type in cos_transactions except admin_grant, plus two
// pseudo-types that don't map 1:1 to a flat fee: 'scan' (resolved to
// cs_scan/byo_scan by sources) and 'copilot_edit' (Copilot Mode Stage 1,
// spec 7.14.7) — a bullet/rewrite or bullet/inject-keyword call is billed
// `flat_fee: 0` under the real 'copilot_session' action_type (its per-call AI
// cost is the only charge), so gating it against the 8-COS session flat fee
// would be wrong; it needs its own small minimum-balance floor instead.
function requiredCosFor(actionType, opts = {}) {
  if (actionType === 'scan') {
    const sources = Array.isArray(opts.sources) ? opts.sources : [];
    if (sources.includes('cs')) return tunables.flatFees.cs_scan;
    if (sources.includes('ats_direct')) return tunables.flatFees.ats_direct_scan;
    return tunables.flatFees.byo_scan;
  }
  if (actionType === 'copilot_edit') return tunables.copilot.minEditBalance;
  // On-demand scoring (spec 4.7) folds its AI cost into the originating scan's
  // row — no flat fee of its own — so it gates on a small floor, like a
  // Copilot edit.
  if (actionType === 'job_score') return tunables.onDemandScoring.minBalance;
  const fee = tunables.flatFees[actionType];
  if (fee === undefined) throw new Error(`cosGuard: unknown action type "${actionType}"`);
  return fee;
}

// Returns { ok, balance, required }. When enforceCosBalance is false, always
// ok (balance/required still computed for callers that want to display them).
async function checkCosBalance(db, userId, actionType, opts = {}) {
  const required = requiredCosFor(actionType, opts);
  if (!tunables.enforceCosBalance) return { ok: true, balance: null, required };
  const { data: user, error } = await db.from('users').select('cos_balance').eq('id', userId).single();
  if (error) throw error;
  const balance = Number(user.cos_balance) || 0;
  return { ok: balance >= required, balance, required };
}

// Clear paywall messaging (spec 13.6) — never a silent failure. Funding still
// runs through the admin-grant endpoint in Phase 2 (no Checkout yet), so the
// message points there rather than at a "Buy COS" flow that isn't live.
function paywallMessage(balance, required) {
  return (
    `Insufficient COS balance to run this action (you have ${balance}, it needs at least ${required}). ` +
    `Ask an admin to top up your balance to continue — purchasing isn't open yet.`
  );
}

// Post-hoc debit for a billable action whose real cost is now known. Mirrors
// the exact field shape every call site already built for its unbilled insert
// (action_type, flat_fee, sourcing_cost, ai_cost, note, related_scan_id,
// related_job_id) — this function is a drop-in replacement for
// `db.from('cos_transactions').insert({...billed:false})`.
//
// enforceCosBalance=false: preserves Phase-1 behavior exactly (unbilled log
// row, balance untouched). enforceCosBalance=true: calls the debit_cos()
// Postgres function so the balance decrement and the billed:true ledger row
// are atomic (mirrors grant_cos's existing atomicity for credits).
async function debitCos(db, userId, fields) {
  const { actionType, flatFee, sourcingCost, aiCost, note, relatedScanId, relatedJobId } = fields;
  // flatFee is undefined for call sites that have nothing to charge here (e.g.
  // runScan.js's per-job AI-cost debit — the flat fee was already billed once
  // at scan start). Normalize to 0, NOT null: `JSON.stringify` drops
  // undefined-valued keys entirely, so an un-normalized `p_flat_fee: undefined`
  // silently vanished from the RPC body below. debit_cos()'s p_flat_fee has no
  // SQL default (unlike every other param), so PostgREST couldn't match the
  // call and failed with a misleading "could not find the function" error —
  // caught by the `if (error)` below and never surfaced, so the balance just
  // never got decremented. Confirmed live (2026-07-28): 513 COS of real AI
  // cost across 3 scans / 2 users went uncharged this way before this fix.
  const normalizedFlatFee = flatFee ?? 0;

  if (!tunables.enforceCosBalance) {
    const { data, error } = await db
      .from('cos_transactions')
      .insert({
        user_id: userId,
        action_type: actionType,
        flat_fee: normalizedFlatFee,
        sourcing_cost: sourcingCost ?? null,
        ai_cost: aiCost ?? null,
        note: note ?? null,
        billed: false,
        related_scan_id: relatedScanId ?? null,
        related_job_id: relatedJobId ?? null,
      })
      .select()
      .single();
    if (error) console.error('cos_transactions insert failed:', error.message);
    return data || null;
  }

  const { data, error } = await db.rpc('debit_cos', {
    p_user_id: userId,
    p_action_type: actionType,
    p_flat_fee: normalizedFlatFee,
    p_sourcing_cost: sourcingCost ?? null,
    p_ai_cost: aiCost ?? null,
    p_note: note ?? null,
    p_related_scan_id: relatedScanId ?? null,
    p_related_job_id: relatedJobId ?? null,
  });
  if (error) {
    console.error('debit_cos rpc failed:', error.message);
    // The AI/sourcing cost was already genuinely incurred — don't let a debit
    // failure lose it silently the way the bug above did for a full day.
    // Non-fatal (a billing hiccup must never kill a scan/generation mid-run),
    // but now recoverable: shows up as a billed:false row in cos_transactions
    // (visible in the COS History popover) instead of nothing at all.
    const { data: fallbackData, error: fallbackErr } = await db
      .from('cos_transactions')
      .insert({
        user_id: userId,
        action_type: actionType,
        flat_fee: normalizedFlatFee,
        sourcing_cost: sourcingCost ?? null,
        ai_cost: aiCost ?? null,
        note: `[UNBILLED — debit_cos rpc failed: ${error.message}] ${note ?? ''}`.slice(0, 500),
        billed: false,
        related_scan_id: relatedScanId ?? null,
        related_job_id: relatedJobId ?? null,
      })
      .select()
      .single();
    if (fallbackErr) console.error('debit_cos fallback ledger insert also failed:', fallbackErr.message);
    return fallbackData || null;
  }
  return data || null;
}

// Accumulates further ai_cost/sourcing_cost into an EXISTING cos_transactions
// row (see debit_cos_into migration comment) rather than creating a new row —
// this is how a scan's per-job AI debits (jobScorer.js) fold into the single
// flat-fee row runScan.js created at scan start, so the COS History panel
// shows one line per scan instead of one per billed job. Falls back to a
// plain insert-based debitCos call when `transactionId` is falsy (e.g.
// scoreManualJob.js, which has no scan-level row to fold into).
async function debitCosInto(db, userId, transactionId, fields) {
  const { actionType, sourcingCost, aiCost, note, relatedScanId, relatedJobId } = fields;
  if (!transactionId) {
    return debitCos(db, userId, { actionType, sourcingCost, aiCost, note, relatedScanId, relatedJobId });
  }

  if (!tunables.enforceCosBalance) {
    const { data: cur, error: readErr } = await db
      .from('cos_transactions')
      .select('ai_cost, sourcing_cost')
      .eq('id', transactionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (readErr) {
      console.error('debitCosInto: read failed:', readErr.message);
      return null;
    }
    const { data, error } = await db
      .from('cos_transactions')
      .update({
        ai_cost: (Number(cur?.ai_cost) || 0) + (aiCost || 0),
        sourcing_cost: (Number(cur?.sourcing_cost) || 0) + (sourcingCost || 0),
        note: note ?? undefined,
      })
      .eq('id', transactionId)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) console.error('debitCosInto: unbilled update failed:', error.message);
    return data || null;
  }

  const { data, error } = await db.rpc('debit_cos_into', {
    p_transaction_id: transactionId,
    p_user_id: userId,
    p_ai_cost: aiCost ?? null,
    p_sourcing_cost: sourcingCost ?? null,
    p_note: note ?? null,
  });
  if (error) {
    console.error('debit_cos_into rpc failed:', error.message);
    // Same non-fatal, don't-lose-the-charge fallback as debitCos above — a
    // real cost was already incurred, so it still needs a ledger trace even
    // if it can't fold into the scan's row this time.
    return debitCos(db, userId, {
      actionType,
      sourcingCost,
      aiCost,
      note: `[UNBILLED — debit_cos_into rpc failed: ${error.message}] ${note ?? ''}`.slice(0, 500),
      relatedScanId,
      relatedJobId,
    });
  }
  return data || null;
}

module.exports = { requiredCosFor, checkCosBalance, paywallMessage, debitCos, debitCosInto };

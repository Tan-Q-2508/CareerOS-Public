// Shared rate-limit/retry primitives for ATS Direct HTTP callers.
//
// These lived inside workable.js, which was the only caller that needed them
// while it was the only platform being actively throttled. The contract-drift
// canary (18.3) needs the same three decisions — "is this status worth
// retrying", "how long does the server say to wait", "how long do we wait when
// it doesn't say" — and workable.js registers no contractCheck, so the canary
// could not reach them. Extracted here rather than reimplemented: one
// rate-limit policy across the ATS layer, not two that drift apart.
//
// Deliberately NOT here: workable.js's MAX_ATTEMPTS and its serialized request
// gate. Those are per-platform tuning, not shared policy — the canary retries
// once, Workable retries five times, and both are right for their caller.

// 429 is the explicit rate limit. 503 is a load-shed. 403 is here because
// several ATS platforms return it for throttling rather than for a genuine
// authorization failure — an unauthenticated public endpoint has nothing to
// authorize, so a 403 from one is far more likely to be a bot-defence
// throttle than a permanent refusal.
const RETRYABLE_STATUS = new Set([429, 403, 503]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry-After is defined as either delta-seconds or an HTTP-date; both forms
// appear in the wild. Returns milliseconds, or null when the header is absent
// or unparseable (the caller then falls back to backoffMs).
function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

// Exponential backoff capped at 30s, plus jitter so concurrent callers backing
// off the same origin don't re-collide in lockstep.
function backoffMs(attempt) {
  return Math.min(30000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
}

// What a failed board fetch actually was (4.6.12), for retry decisions and for
// telling the user something truer than "couldn't reach":
//   board_gone    404/410 — the board moved or closed; retrying won't help
//   rate_limited  429 / throttling 403
//   server_error  5xx
//   timeout       our own abort timer fired
//   network       connection reset, DNS, TLS
//   other         anything else (a parse error, an adapter contract break)
function classifyFetchError(e) {
  const status = e && e.status;
  if (status === 404 || status === 410) return 'board_gone';
  if (status === 429 || status === 403) return 'rate_limited';
  if (status >= 500) return 'server_error';
  const msg = String((e && (e.message || e.name)) || '').toLowerCase();
  const cause = String((e && e.cause && (e.cause.code || e.cause.message)) || '').toLowerCase();
  if ((e && e.name === 'AbortError') || /aborted|timeout|timed out/.test(msg)) return 'timeout';
  if (/fetch failed|econnreset|enotfound|eai_again|socket|tls|econnrefused|und_err/.test(`${msg} ${cause}`)) return 'network';
  return 'other';
}

const RETRYABLE_KINDS = new Set(['timeout', 'rate_limited', 'server_error', 'network']);

// Retry an async request on a retryable failure, honouring a server's
// Retry-After (err.retryAfter, header value) when one was sent.
async function withRetry(fn, { attempts = 3, maxWaitMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const kind = classifyFetchError(e);
      if (attempt === attempts || !RETRYABLE_KINDS.has(kind)) throw e;
      // A throttle with no Retry-After (Microsoft's Phenom tenant sends none)
      // needs a real cool-down, not the 0.5s first step of the generic curve
      // — measured: it allows ~1 request/second sustained.
      const floor = kind === 'rate_limited' ? 5000 * attempt : 0;
      const wait = parseRetryAfter(e && e.retryAfter) ?? Math.max(floor, backoffMs(attempt));
      await sleep(Math.min(wait, maxWaitMs));
    }
  }
  throw lastErr;
}

module.exports = { RETRYABLE_STATUS, RETRYABLE_KINDS, parseRetryAfter, backoffMs, sleep, classifyFetchError, withRetry };

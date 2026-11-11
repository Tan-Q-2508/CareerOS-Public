// Per-origin connection ceiling for ATS Direct's HTTP layer (spec 4.6.13,
// step 2). One module-level undici Agent, shared by every request the five
// platform adapters make — board fetches AND detection probes alike (a
// ceiling that ignored probe traffic wouldn't actually bound the origin,
// since probes fire in bulk during a name-guess sweep or the periodic
// unresolved re-sweep, 4.6.3).
//
// What this actually buys, MEASURED not assumed (see the handoff for the
// real numbers): Node's global fetch already runs on undici and already
// keep-alives SEQUENTIAL same-origin requests reasonably well on its own —
// a live measurement found 5 sequential requests to the same Greenhouse
// origin opened exactly 1 socket under the default dispatcher. The real gap
// the default dispatcher has is CONCURRENT same-origin load: 8 concurrent
// requests to one origin opened 8 simultaneous sockets under the default
// dispatcher, with no per-origin ceiling at all — exactly the risk this
// session set out to close (companyFetchConcurrency was a GLOBAL cap across
// whichever platform each company happened to resolve to; the registry's
// platform-clustered bulk imports mean several consecutive companies in the
// rotating cursor are often the same platform). The same 8-concurrent-request
// test against an Agent configured with connections:3 capped at exactly 3
// sockets/in-flight, queuing the rest client-side rather than opening more —
// that's the property this module provides.
//
// The `pooled()` per-adapter/per-detect helpers elsewhere in this codebase
// (detect.js, atsDirectRun.js) already cap CONCURRENCY of async work; this
// module caps CONNECTIONS at the transport layer specifically, which matters
// because the fetch pool's concurrency is global across all five platforms,
// not per-platform.

const { Agent } = require('undici');
const diagnostics = require('node:diagnostics_channel');
const tunables = require('../../tunables.json');

const agent = new Agent({
  connections: tunables.atsDirect.perOriginConnections,
  keepAliveTimeout: tunables.atsDirect.keepAliveTimeoutMs,
  keepAliveMaxTimeout: tunables.atsDirect.keepAliveMaxTimeoutMs,
  // Third-party public APIs we don't control — pipelining multiple requests
  // onto one connection ahead of a response is not worth the risk of a
  // misbehaving server serializing/rejecting it.
  pipelining: 1,
});

// ---------------------------------------------------------------------------
// Instrumentation — per-origin socket-connect count, current in-flight count,
// and an in-flight HIGH-WATER MARK (the hard evidence that the ceiling never
// gets exceeded). Surfaced via GET /api/admin/ats-http-stats. Subscribing to
// diagnostics_channel has no effect on requests that don't go through THIS
// agent — the global default dispatcher (still used by anything that doesn't
// pass `dispatcher`) fires the same channel names, so these counters are
// scoped to origin only, not to "requests through this agent specifically."
// That's fine for this module's purpose: once every ATS Direct HTTP call
// passes this agent (this session's actual change), the counters describe
// exactly the traffic this module is responsible for bounding.
// ---------------------------------------------------------------------------

// Bounded — found live this session: Workday's per-TENANT origin structure
// (every company is its own hostname, unlike the shared origins the other
// four platforms use) means this map's key count tracks distinct COMPANIES
// ever contacted by this process, not distinct PLATFORMS — 5,724 companies
// queried in one real broad scan left 923 entries here, 916 of them Workday
// tenants. Individually tiny (~250 bytes/entry, so 923 entries is under
// 250 KB — not what was driving that scan's own ~90 MB RSS growth, measured
// separately), but genuinely unbounded over the life of a long-running
// server process with no eviction, so it's capped defensively regardless.
const MAX_TRACKED_ORIGINS = 2000;
const stats = new Map(); // origin -> { connected, inFlight, highWater, requests, errors }

function evictOneIdleOrigin() {
  // Map iteration is insertion order, so the first idle (inFlight: 0) entry
  // found is also the oldest-inserted one still safe to drop — never evicts
  // an origin with a request actually in flight, so an in-progress request's
  // accounting is never lost mid-flight.
  for (const [origin, s] of stats) {
    if (s.inFlight === 0) {
      stats.delete(origin);
      return;
    }
  }
}

function forOrigin(origin) {
  let s = stats.get(origin);
  if (!s) {
    if (stats.size >= MAX_TRACKED_ORIGINS) evictOneIdleOrigin();
    s = { connected: 0, inFlight: 0, highWater: 0, requests: 0, errors: 0 };
    stats.set(origin, s);
  }
  return s;
}

diagnostics.subscribe('undici:client:connected', (msg) => {
  const origin = msg && msg.connectParams && msg.connectParams.protocol && msg.connectParams.host
    ? `${msg.connectParams.protocol}//${msg.connectParams.host}`
    : null;
  if (!origin) return;
  forOrigin(origin).connected += 1;
});

diagnostics.subscribe('undici:request:create', (msg) => {
  const origin = msg && msg.request && msg.request.origin;
  if (!origin) return;
  const s = forOrigin(String(origin));
  s.requests += 1;
  s.inFlight += 1;
  if (s.inFlight > s.highWater) s.highWater = s.inFlight;
});

function settle(msg) {
  const origin = msg && msg.request && msg.request.origin;
  if (!origin) return;
  const s = stats.get(String(origin));
  if (s) s.inFlight = Math.max(0, s.inFlight - 1);
}
diagnostics.subscribe('undici:request:trailers', settle);
diagnostics.subscribe('undici:request:error', (msg) => {
  settle(msg);
  const origin = msg && msg.request && msg.request.origin;
  if (origin) forOrigin(String(origin)).errors += 1;
});

/** Snapshot of per-origin counters, for GET /api/admin/ats-http-stats. */
function getHttpStats() {
  const out = {};
  for (const [origin, s] of stats) out[origin] = { ...s };
  return out;
}

module.exports = { agent, getHttpStats };

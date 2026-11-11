// Scan-time vs probe-time HTTP behaviour for ATS Direct (spec 4.6.13).
//
// A probe (detection, registry import, park-dead-boards) asks a board one
// tiny question — a HEAD, or a ~30-byte GET — so a short timeout is right. A
// SCAN downloads the whole board: Greenhouse's `?content=true` listing runs to
// several MB for SpaceX/Stripe/Databricks-sized boards, and the old shared
// 8-second timer covered connection-pool queueing plus that entire download.
// Boards that probed healthy then "couldn't be reached" in every scan — the
// failures were "This operation was aborted", i.e. our own timer, not the
// board.
//
// Rather than thread a flag through ten adapters' call signatures,
// sourceCompanyJobs runs each company's fetch inside runInScan(), and every
// adapter asks requestTimeoutMs() — which answers with the scan budget inside
// that context and the probe budget everywhere else.

const { AsyncLocalStorage } = require('node:async_hooks');
const tunables = require('../../tunables.json');

const als = new AsyncLocalStorage();

function inScan() {
  const ctx = als.getStore();
  return !!(ctx && ctx.scan);
}

function requestTimeoutMs() {
  return inScan() ? tunables.atsDirect.scan.requestTimeoutMs : tunables.atsDirect.detect.requestTimeoutMs;
}

function runInScan(fn) {
  return als.run({ scan: true }, fn);
}

// Minimum spacing between requests to one host during a scan
// (tunables.atsDirect.scan.minHostIntervalMs, keyed by platform with a
// `default`). Paginated platforms (Phenom, Workday) fire page after page at
// one host; Microsoft's Phenom tenant 429'd at page 8 without spacing.
const lastAt = new Map(); // host -> timestamp of the last request started
// A platform-wide floor, applied to probes as well as scans
// (tunables.atsDirect.minPlatformIntervalMs). Per-host spacing cannot bound a
// platform that gives every company its own hostname but throttles them all
// as one: Recruitee answers each tenant from `{slug}.recruitee.com` and 429s
// across tenants at a sustained ~20 requests/second, while 300 requests at
// 250ms spacing drew none.
const platformNextAt = new Map(); // platform -> earliest start for its next request
async function pacePlatform(platform) {
  const gap = (tunables.atsDirect.minPlatformIntervalMs || {})[platform];
  if (!gap) return;
  const now = Date.now();
  const next = Math.max(now, platformNextAt.get(platform) || 0);
  platformNextAt.set(platform, next + gap);
  if (next > now) await new Promise((r) => setTimeout(r, next - now));
}

async function paceHost(url, platform) {
  await pacePlatform(platform);
  if (!inScan()) return;
  const cfg = tunables.atsDirect.scan.minHostIntervalMs || {};
  const gap = cfg[platform] ?? cfg.default ?? 0;
  if (!gap) return;
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  const now = Date.now();
  const next = Math.max(now, (lastAt.get(host) || 0) + gap);
  lastAt.set(host, next);
  if (next > now) await new Promise((r) => setTimeout(r, next - now));
  if (lastAt.size > 5000) lastAt.clear();
}

module.exports = { requestTimeoutMs, runInScan, inScan, paceHost, pacePlatform };

// Shared HTTP for the ATS Direct adapters (spec 4.6.1). All three Tier 1
// platforms expose public, unauthenticated endpoints, so there's no key
// handling here — just a timeout and a couple of safety behaviours the three
// adapters would otherwise each reimplement.
//
// getJsonArrayStreamed (spec 4.6.13) adds a size-threshold streaming path for
// the board-listing endpoints: a board response can run up to ~12 MB, which
// buffers to ~24 MB as a V8 string via response.json() before anything
// filters it — real OOM risk on Render's free-tier ~512 MB host at any
// meaningful fetch concurrency. Above the threshold, the response body is
// piped through stream-json's streamArray so individual job objects are
// handed to the caller's `onItem` as they're tokenized, never materialized as
// one array; below it, plain JSON.parse is cheaper (token-by-token JS parsing
// costs real CPU on Render's shared-CPU free tier, and most boards are small).
//
// stream-json 3.x / stream-chain 4.x (the current majors, and the only ones
// on the registry — there is no maintained CJS-line fallback) turned out to
// be ESM-only, discovered only once actually installed (`"type": "module"`,
// no `require()`-visible entry point) — this repo is CommonJS throughout.
// Rather than converting @careeros/shared to ESM (a much larger, riskier
// change rippling into every other adapter/server file that `require()`s it)
// or hand-rolling a JSON tokenizer (the exact risk — silent corruption on an
// escaped quote inside a description — this dependency was chosen to avoid),
// the four ESM exports are loaded once via dynamic `import()`, memoized in
// `loadStreamJsonEsm()` below. This is a standard, well-supported Node
// CJS-from-ESM interop pattern (the same one widely used for node-fetch v3,
// chalk v5, etc.), not a workaround specific to this codebase — flagged here
// because it wasn't anticipated when the dependency was chosen, not because
// it's fragile.
const { Readable } = require('node:stream');
const tunables = require('../../tunables.json');
const { agent: defaultDispatcher } = require('./dispatcher');
const { requestTimeoutMs } = require('./scanContext');

let esmModulesPromise = null;
function loadStreamJsonEsm() {
  if (!esmModulesPromise) {
    esmModulesPromise = Promise.all([
      import('stream-json'),
      import('stream-json/filters/pick.js'),
      import('stream-json/streamers/stream-array.js'),
      import('stream-chain'),
    ]).then(([sj, pickMod, streamArrayMod, chainMod]) => ({
      parser: sj.parser,
      pickFilter: pickMod.pick,
      streamArray: streamArrayMod.streamArray,
      chain: chainMod.default,
    }));
  }
  return esmModulesPromise;
}

// Probe budget normally; the (much longer) scan budget inside a scan — see
// scanContext.js for why the two differ.
function timeoutMs() {
  return requestTimeoutMs();
}

const UA = 'CareerOS/1.0 (ATS Direct; +https://careeros.app)';

// --- Bounded body reads (4.6.13, memory) ----------------------------------
//
// `resp.json()` / `resp.text()` buffer a whole response with no ceiling. One
// Recruitee board (emplyfy) answers 70 MB: read as text and JSON.parse'd, that
// is a ~250 MB transient on top of a server already holding ~260 MB mid-scan —
// past Render's 512 MB limit, which killed two real scans (2026-10-18). Every
// buffered read therefore goes through readBodyText, which counts bytes as
// they arrive and aborts the moment the cap is exceeded, so an oversize board
// fails ONE company (a normal per-company failure, 12.4) instead of the whole
// process. Boards that can legitimately be this large are streamed instead
// (streamJsonArray / webFetch.streamBoard) and never reach this cap.
class BodyTooLargeError extends Error {
  constructor(url, bytes, maxBytes) {
    super(`Response from ${url} exceeds ${maxBytes} bytes (read ${bytes}) — too large to buffer`);
    this.name = 'BodyTooLargeError';
    this.status = null;
  }
}

function maxBufferedBodyBytes() {
  return tunables.atsDirect.maxBufferedBodyBytes || 16 * 1024 * 1024;
}

async function readBodyText(resp, { url = resp.url, maxBytes = maxBufferedBodyBytes() } = {}) {
  const declared = Number(resp.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await resp.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(url, declared, maxBytes);
  }
  if (!resp.body) return '';
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(url, total, maxBytes);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
}

async function readBodyJson(resp, opts) {
  return JSON.parse(await readBodyText(resp, opts));
}

/**
 * GET and parse JSON. Throws on a non-2xx so the caller's per-company error
 * isolation (12.4) sees a real failure; returns the parsed body otherwise.
 *
 * `dispatcher` (spec 4.6.13, step 2) is an optional undici Agent/Pool override
 * — defaults to the shared per-origin agent (dispatcher.js), which every ATS
 * Direct HTTP call routes through unless a caller explicitly overrides it
 * (e.g. a test wanting the bare default global dispatcher).
 */
async function getJson(url, { ms, dispatcher = defaultDispatcher } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || timeoutMs());
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: controller.signal,
      dispatcher,
    });
    if (!resp.ok) {
      // Don't leave the body dangling on an error path.
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${resp.status} from ${url}`);
      err.status = resp.status;
      throw err;
    }
    return await readBodyJson(resp, { url });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET a JSON array (optionally nested under `pick`), streaming above a size
 * threshold and falling back to plain JSON.parse below it
 * (`tunables.atsDirect.streamParseThresholdBytes`) — see this module's header
 * comment for why both paths exist. Invokes `onItem(rawItem)` synchronously
 * for every array element, in response order; if `onItem` returns `false`,
 * the remaining response is never parsed (used once a company's own
 * post-filter keep-cap is reached, so a huge board isn't tokenized past the
 * point it matters).
 *
 * Throws on a non-2xx, same contract as getJson.
 *
 * @param {string} url
 * @param {object} opts
 * @param {string|null} [opts.pick] key the array is nested under (e.g.
 *   'jobs'); null for a bare-array response body (Lever).
 * @param {(item: any) => boolean|void} opts.onItem
 * @param {number} [opts.ms] request timeout override
 * @param {*} [opts.dispatcher] see getJson
 * @returns {Promise<{streamed: boolean}>} whether the streaming path was
 *   taken (vs. the buffered JSON.parse fallback) — surfaced for tests/
 *   verification only, not consumed by production callers.
 */
async function getJsonArrayStreamed(url, { pick: pickKey = null, onItem, ms, dispatcher = defaultDispatcher } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || timeoutMs());
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: controller.signal,
      dispatcher,
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${resp.status} from ${url}`);
      err.status = resp.status;
      throw err;
    }

    const lenHeader = resp.headers.get('content-length');
    const len = lenHeader != null ? Number(lenHeader) : null;
    const threshold = tunables.atsDirect.streamParseThresholdBytes;

    // Content-Length present and small: buffered parse is the common case and
    // cheaper in CPU. Missing (many of these hosts chunk their responses) or
    // large: stream, since "unknown size" must be treated as "could be the
    // 12 MB case" for the memory guarantee to actually hold.
    if (len != null && Number.isFinite(len) && len < threshold) {
      const body = await resp.json();
      const arr = pickKey ? (body && body[pickKey]) || [] : Array.isArray(body) ? body : [];
      for (const item of arr) {
        if (onItem(item) === false) break;
      }
      return { streamed: false };
    }

    await streamJsonArray(resp.body, { pickKey, onItem });
    return { streamed: true };
  } finally {
    clearTimeout(timer);
  }
}

// Pipes a fetch Response's web ReadableStream through stream-json's
// parser -> (optional pick) -> streamArray, calling onItem per element.
// Destroys the pipeline the moment onItem signals "stop" so the rest of a
// large board is never tokenized — that early destroy is expected to produce
// a stream error/close event, which is swallowed (not surfaced to the
// caller) rather than rejecting an otherwise-successful fetch.
async function streamJsonArray(webStream, { pickKey, onItem }) {
  const { parser, pickFilter, streamArray, chain } = await loadStreamJsonEsm();
  return new Promise((resolve, reject) => {
    const nodeStream = Readable.fromWeb(webStream);
    const stages = [nodeStream, parser()];
    if (pickKey) stages.push(pickFilter({ filter: pickKey }));
    stages.push(streamArray());
    const pipeline = chain(stages);

    let stoppedEarly = false;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    pipeline.on('data', ({ value }) => {
      if (stoppedEarly) return;
      if (onItem(value) === false) {
        stoppedEarly = true;
        pipeline.destroy();
      }
    });
    pipeline.on('error', (e) => {
      if (stoppedEarly) return finish(resolve);
      finish(reject, e);
    });
    pipeline.on('end', () => finish(resolve));
    pipeline.on('close', () => finish(resolve));
  });
}

/**
 * Existence probe: status code only, body never downloaded.
 *
 * This is what makes name-guess mode (4.6.2) affordable — a full board is
 * 0.3-12 MB (OpenAI's Ashby board measured 12 MB), and name-guessing issues
 * several probes per company across three platforms. HEAD gets the 200/404
 * without the payload; when a platform needs a GET instead (Greenhouse, whose
 * board endpoint also returns the board's display name for cross-checking),
 * the caller uses getJson on the cheap 30-byte endpoint rather than the
 * listing endpoint.
 *
 * Never throws for an HTTP error — a 404 is a legitimate "no such board"
 * answer, not a failure. Network/timeout errors surface as ok:false with the
 * error attached, so one platform being down can't abort detection against
 * the other two.
 */
async function probeHead(url, { ms, dispatcher = defaultDispatcher } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || timeoutMs());
  try {
    const resp = await fetch(url, {
      method: 'HEAD',
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: controller.signal,
      dispatcher,
    });
    await resp.body?.cancel().catch(() => {});
    return { ok: resp.ok, status: resp.status, error: null };
  } catch (e) {
    return { ok: false, status: 0, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getJson,
  readBodyText,
  readBodyJson,
  BodyTooLargeError,
  getJsonArrayStreamed,
  probeHead,
  UA,
  // Exposed for workable.js, whose fetchJobs needs the same size-threshold
  // streaming decision but layered under its own rate-gate + backoff
  // wrapper (getJsonWithBackoff can't just delegate to getJsonArrayStreamed
  // above, since that function owns its own fetch() call and workable.js's
  // gate/backoff needs to own that call instead) — not part of the public
  // per-adapter contract otherwise.
  streamJsonArray,
  streamParseThreshold: () => tunables.atsDirect.streamParseThresholdBytes,
};

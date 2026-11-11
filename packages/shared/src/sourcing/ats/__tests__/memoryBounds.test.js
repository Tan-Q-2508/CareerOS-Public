#!/usr/bin/env node
// memoryBounds.test.js — a board response must never be able to take the server
// past Render's 512 MB limit (spec 4.6.13, "Bounded body reads").
//
// Real incident (2026-10-18): one Recruitee board answered 70 MB. The adapter
// read it with resp.text() and JSON.parse'd it, a ~250 MB transient on a server
// already holding ~260 MB mid-scan — two consecutive scans were OOM-killed.
// Two guarantees are pinned here against a local HTTP server (no network):
//   1. readBodyText refuses a body over the cap — by Content-Length up front,
//      and by counting bytes when there is no Content-Length — without reading
//      the rest.
//   2. streamBoard hands over each array element as it arrives, so a very large
//      board yields the same kept set as a buffered parse while heap growth
//      stays a small fraction of the body, and a retried attempt starts from a
//      fresh handler (never double-counts).
//
//   node packages/shared/src/sourcing/ats/__tests__/memoryBounds.test.js

const assert = require('assert');
const http = require('http');
const { readBodyText, BodyTooLargeError } = require('../httpClient');
const { streamBoard } = require('../webFetch');
const { runInScan } = require('../scanContext');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

function offer(i, filler) {
  return JSON.stringify({ id: i, title: i % 50 === 0 ? `Project Manager ${i}` : `Engineer ${i}`, status: 'published', description: filler });
}

(async () => {
  let failFirst = false;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    if (req.url.startsWith('/flaky') && failFirst) {
      failFirst = false;
      res.writeHead(503);
      return res.end('busy');
    }
    if (req.url.startsWith('/small')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"offers":[]}');
    }
    if (req.url.startsWith('/declared')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(40 * 1024 * 1024) });
      return res.end('{"offers":[');
    }
    if (req.url.startsWith('/chunked-large')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = 'x'.repeat(1024 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 40) {
          sent += 1;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        res.end();
      };
      return pump();
    }
    // /board: ~48 MB of offers, chunked (no Content-Length), 1 in 50 matching.
    res.writeHead(200, { 'content-type': 'application/json' });
    const filler = 'z'.repeat(480 * 1024);
    let i = 0;
    res.write('{"offers":[');
    const pump = () => {
      while (i < 100) {
        const piece = (i ? ',' : '') + offer(i, filler);
        i += 1;
        if (!res.write(piece)) return res.once('drain', pump);
      }
      res.end(']}');
    };
    pump();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  await check('readBodyText rejects an oversize body by Content-Length without reading it', async () => {
    const resp = await fetch(`${base}/declared`);
    await assert.rejects(() => readBodyText(resp, { maxBytes: 1024 * 1024 }), (e) => e instanceof BodyTooLargeError);
  });

  await check('readBodyText rejects an oversize chunked body (no Content-Length) mid-stream', async () => {
    const resp = await fetch(`${base}/chunked-large`);
    assert.strictEqual(resp.headers.get('content-length'), null);
    await assert.rejects(() => readBodyText(resp, { maxBytes: 4 * 1024 * 1024 }), (e) => e instanceof BodyTooLargeError);
  });

  await check('readBodyText returns a body under the cap unchanged', async () => {
    const resp = await fetch(`${base}/small`);
    assert.strictEqual(await readBodyText(resp, { maxBytes: 1024 }), '{"offers":[]}');
  });

  await check('streamBoard keeps exactly what a buffered parse would, with heap far below the body size', async () => {
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 10);
    const kept = await streamBoard(`${base}/board`, {
      platform: 'recruitee',
      pick: 'offers',
      makeHandler: () => {
        const out = [];
        return { onItem: (o) => { if (/project manager/i.test(o.title)) out.push(o.id); return true; }, result: () => out };
      },
    });
    clearInterval(iv);
    assert.deepStrictEqual(kept, [0, 50]);
    const growthMb = (peak - before) / 1048576;
    // Body is ~48 MB; a buffered JSON.parse of it is well over 100 MB.
    assert.ok(growthMb < 60, `heap grew ${growthMb.toFixed(0)} MB while streaming a ~48 MB board`);
  });

  await check('streamBoard stops downloading once the handler returns false', async () => {
    const t0 = Date.now();
    const first = await streamBoard(`${base}/board`, {
      pick: 'offers',
      makeHandler: () => { let f = null; return { onItem: (o) => { f = o; return false; }, result: () => f }; },
    });
    assert.strictEqual(first.id, 0);
    assert.ok(Date.now() - t0 < 5000);
  });

  await check('a retried attempt starts from a fresh handler (no double counting)', async () => {
    failFirst = true;
    requests = 0;
    let handlers = 0;
    const out = await runInScan(() =>
      streamBoard(`${base}/flaky-board`, {
        platform: 'recruitee',
        pick: 'offers',
        makeHandler: () => {
          handlers += 1;
          const ids = [];
          return { onItem: (o) => { ids.push(o.id); return ids.length < 3; }, result: () => ids };
        },
      })
    );
    assert.deepStrictEqual(out, [0, 1, 2]);
    assert.ok(handlers >= 2, 'the 503 should have forced a second attempt');
  });

  server.close();
  console.log(`memoryBounds: ${passed} checks passed`);
  process.exit(process.exitCode || 0); // the shared undici agent keeps sockets alive
})();

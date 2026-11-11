#!/usr/bin/env node
// check-migration-timestamps.js — pre-push safety check. Two separate
// sessions have created migration files sharing the same leading timestamp
// prefix (2026-08-10, then again 20260811010000 during the pre-Phase-5
// cleanup batch) — Supabase applies migrations in filename order, so a
// collision is silently ambiguous rather than a hard error until push time.
// Refuse to push if any two migration files share a timestamp prefix.
//
// Invoked by .git/hooks/pre-push alongside check-no-running-scans.js. Exit 0
// = safe to push, exit 1 = blocked. Bypass is git's own `--no-verify`.

const fs = require('fs');
const path = require('path');

function main() {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));

  const byTimestamp = new Map();
  for (const file of files) {
    const match = file.match(/^(\d{14})_/);
    if (!match) continue;
    const ts = match[1];
    if (!byTimestamp.has(ts)) byTimestamp.set(ts, []);
    byTimestamp.get(ts).push(file);
  }

  const collisions = [...byTimestamp.entries()].filter(([, fs]) => fs.length > 1);
  if (!collisions.length) process.exit(0);

  console.error('');
  console.error('BLOCKED: push refused — duplicate migration timestamp(s) found.');
  console.error('Supabase applies migrations in filename order; a collision is ambiguous.');
  console.error('Rename one of the colliding files to a unique timestamp, or bypass with');
  console.error('`git push --no-verify` if you mean it.');
  console.error('');
  for (const [ts, fs] of collisions) {
    console.error(`  - ${ts}:`);
    for (const f of fs) console.error(`      ${f}`);
  }
  console.error('');
  process.exit(1);
}

main();

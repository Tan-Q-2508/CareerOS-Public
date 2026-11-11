#!/usr/bin/env node
// scheduler.test.js — regression suite for computeNextRunAt (bug fix
// 2026-08-15: scheduled scans gained a chosen wall-clock time + timezone
// instead of running at whatever instant the schedule was created/claimed
// at). No test framework in this repo (no jest/mocha) — plain Node + assert,
// runnable directly:
//   node apps/server/src/scan/__tests__/scheduler.test.js
// Exits non-zero on any failure.

const assert = require('assert');
const { computeNextRunAt } = require('../scheduler');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

function iso(y, m, d, h, min, tz = 'UTC') {
  // Small helper: builds an ISO string for a plain UTC instant, only used to
  // construct `from` fixtures below (all in UTC for readability).
  return new Date(Date.UTC(y, m - 1, d, h, min)).toISOString();
}

// Renders a UTC instant as HH:MM in a given IANA zone, for asserting the
// pinned wall clock landed where expected.
function wallClockIn(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(date);
}
function calendarDateIn(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

console.log('computeNextRunAt — legacy/default behavior (no options, UTC 09:00):');

check('daily: always exactly one day ahead, pinned to 09:00 UTC', () => {
  const from = new Date(iso(2026, 8, 15, 3, 0)); // Sat 2026-08-15 03:00 UTC
  const next = computeNextRunAt('daily', from);
  assert.strictEqual(calendarDateIn(next, 'UTC'), '2026-08-16');
  assert.strictEqual(wallClockIn(next, 'UTC'), '09:00');
});

check('weekdays: Friday -> Monday (skips the weekend)', () => {
  const from = new Date(iso(2026, 8, 14, 12, 0)); // Fri 2026-08-14
  const next = computeNextRunAt('weekdays', from);
  assert.strictEqual(calendarDateIn(next, 'UTC'), '2026-08-17'); // Monday
});

check('weekdays: Saturday -> Monday', () => {
  const from = new Date(iso(2026, 8, 15, 12, 0)); // Sat 2026-08-15
  const next = computeNextRunAt('weekdays', from);
  assert.strictEqual(calendarDateIn(next, 'UTC'), '2026-08-17'); // Monday
});

check('weekly: always exactly 7 days ahead', () => {
  const from = new Date(iso(2026, 8, 15, 3, 0));
  const next = computeNextRunAt('weekly', from);
  assert.strictEqual(calendarDateIn(next, 'UTC'), '2026-08-22');
});

check('result is always strictly after `from`', () => {
  const from = new Date();
  for (const freq of ['daily', 'weekdays', 'weekly']) {
    assert.ok(computeNextRunAt(freq, from).getTime() > from.getTime(), `${freq} must be in the future`);
  }
});

check('unknown frequency throws', () => {
  assert.throws(() => computeNextRunAt('hourly', new Date()));
});

console.log('\ncomputeNextRunAt — chosen time-of-day + timezone:');

check('pins the wall clock to the chosen time in a non-UTC zone (America/Los_Angeles)', () => {
  const from = new Date(iso(2026, 8, 15, 3, 0)); // Fri 2026-08-14 evening in LA (PDT, UTC-7)
  const next = computeNextRunAt('daily', from, { runAtTime: '18:30', timezone: 'America/Los_Angeles' });
  assert.strictEqual(wallClockIn(next, 'America/Los_Angeles'), '18:30');
});

check('local calendar date is used, not UTC — 11pm local Monday stays "Monday" for weekdays', () => {
  // 2026-08-17 06:00 UTC is still 2026-08-16 23:00 in Los Angeles (Sunday
  // night PDT) — a daily-at-9am-LA schedule evaluating "today" should treat
  // this as Sunday, so the next occurrence (+1 day) is Monday, not Tuesday.
  const from = new Date(iso(2026, 8, 17, 6, 0));
  const next = computeNextRunAt('daily', from, { runAtTime: '09:00', timezone: 'America/Los_Angeles' });
  assert.strictEqual(calendarDateIn(next, 'America/Los_Angeles'), '2026-08-17'); // Monday LA-local
});

check('DST-boundary zone: "spring forward" (America/New_York, 2026-03-08) still lands at the chosen wall clock', () => {
  // US DST starts 2026-03-08 02:00 -> 03:00 local. A schedule set for 09:00
  // ET the day before should land at 09:00 ET the day after, correctly
  // spanning the gap.
  const from = new Date(iso(2026, 3, 7, 12, 0)); // Sat 2026-03-07
  const next = computeNextRunAt('daily', from, { runAtTime: '09:00', timezone: 'America/New_York' });
  assert.strictEqual(calendarDateIn(next, 'America/New_York'), '2026-03-08');
  assert.strictEqual(wallClockIn(next, 'America/New_York'), '09:00');
});

check('DST-boundary zone: "fall back" (America/New_York, 2026-11-01) still lands at the chosen wall clock', () => {
  const from = new Date(iso(2026, 10, 31, 12, 0)); // Sat 2026-10-31
  const next = computeNextRunAt('daily', from, { runAtTime: '09:00', timezone: 'America/New_York' });
  assert.strictEqual(calendarDateIn(next, 'America/New_York'), '2026-11-01');
  assert.strictEqual(wallClockIn(next, 'America/New_York'), '09:00');
});

check('India Standard Time (UTC+5:30, a half-hour offset) still pins exactly', () => {
  const from = new Date(iso(2026, 8, 15, 3, 0));
  const next = computeNextRunAt('weekly', from, { runAtTime: '20:00', timezone: 'Asia/Kolkata' });
  assert.strictEqual(wallClockIn(next, 'Asia/Kolkata'), '20:00');
  assert.strictEqual(calendarDateIn(next, 'Asia/Kolkata'), '2026-08-22');
});

check('malformed run_at_time falls back to 09:00 rather than throwing', () => {
  const from = new Date(iso(2026, 8, 15, 3, 0));
  const next = computeNextRunAt('daily', from, { runAtTime: 'garbage', timezone: 'UTC' });
  assert.strictEqual(wallClockIn(next, 'UTC'), '09:00');
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('\nSome checks FAILED.');
} else {
  console.log('All checks passed.');
}

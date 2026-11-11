// Display-only helpers. Nothing here drives money — Phase 1 is unbilled (spec 0.1),
// purchasing is disabled, and real COS cost is measured post-generation. These
// estimates exist only to render the mockup's "— N COS" affordance honestly.
export const COS_ESTIMATE = {
  resume: 9,
  cover_letter: 8,
  manual: 5,
  copilot: 8,
  copilot_continue: 3,
};

// spec 7.14.13's gaming guardrail: a newly-added JD keyword whose bullet
// gained fewer than this many net words per added term reads as "tacked on"
// rather than written into a real sentence — see lib/atsEngine.js's
// naturalnessHint(). Tuning knob only, not billing-relevant.
export const NATURALNESS_HINT = { wordsPerAddedTerm: 2 };

// Backend emits uppercase verdicts (PURSUE/REVIEW/PASS, spec 5.2); normalize.
export function verdictClass(verdict) {
  const v = String(verdict || '').toLowerCase();
  if (v === 'pursue') return 'pursue';
  if (v === 'review') return 'review';
  return 'pass';
}

export function fmtScore(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toFixed(1);
}

export function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

// Multi-title scans (4.6.15) — a scan_history config's job_titles (canonical)
// falls back to the legacy scalar job_title, joined for display. Mirrors
// packages/shared/src/scanTitles.js's contract; duplicated here in plain JS
// because apps/web doesn't import @careeros/shared.
export function scanTitleLabel(config, fallback = 'Scan') {
  if (!config) return fallback;
  if (Array.isArray(config.job_titles) && config.job_titles.length) return config.job_titles.join(', ');
  return config.job_title || fallback;
}

// Risk severity → dot class. Risk tags (5.4) arrive as { category, level } or as
// strings; normalize the level word to one of none/low/medium/high.
export function riskLevelClass(level) {
  const l = String(level || 'none').toLowerCase();
  if (l.startsWith('h')) return 'high';
  if (l.startsWith('m')) return 'medium';
  if (l.startsWith('l')) return 'low';
  return 'none';
}

// Scheduled-scan time-of-day (2026-08-15) — 48 half-hour slots, "00:00" ..
// "23:30". Matches the scheduler's own every-30-min claim cron
// (.github/workflows/scheduler.yml), so a chosen time is never
// finer-grained than what the infra can actually honor; the server enforces
// the same set (apps/server/src/routes/scanSchedules.js's RUN_AT_TIME_RE).
// Shared by NewScanModal (creating a schedule) and SettingsView (editing
// one) so the two pickers can't drift apart.
export const HALF_HOUR_SLOTS = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, '0');
  const m = i % 2 === 0 ? '00' : '30';
  return `${h}:${m}`;
});

export function formatSlotLabel(slot) {
  const [h, m] = String(slot).split(':').map(Number);
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// Defaults a Time picker to the next upcoming half-hour slot in the
// browser's own local time, so leaving it untouched still schedules
// something sensible ("soon") rather than always defaulting to midnight.
// Whole-number balances round cleanly; a fractional balance (real after the
// 2026-08-15 fix, since a scan's ai_cost now accrues live in fractional COS
// as jobs score) previously rounded to the nearest whole COS via
// Math.round, which could show "13672" both before and after a 0.4 COS
// debit — the balance LOOKED frozen even though it was moving. One decimal
// place whenever there's a fractional part; whole numbers stay whole.
export function formatCosBalance(balance) {
  const n = Number(balance) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function nextHalfHourSlot() {
  const now = new Date();
  let h = now.getHours();
  let m = now.getMinutes() < 30 ? 30 : 0;
  if (m === 0) h = (h + 1) % 24;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 'Saved' is the entry/triage stage that backs the dashboard (not shown as a
// tracker board column). 'Deemed Not Suitable' is the terminal "Not for me"
// bucket. See the dashboard/tracker unification (2026-07-21).
const APPLICATION_STAGES = ['Saved', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Accepted', 'Deemed Not Suitable'];

// All eight COS action types (spec 13.4). `manual_entry` and `admin_grant` were
// added after the original 5-value list — admin_grant is what the Phase 1
// COS-crediting endpoint tags its ledger rows with. `copilot_session` (spec
// 7.14.7, Copilot Mode Stage 1) covers both the session-start flat fee and
// the per-edit (flat_fee: 0) bullet/rewrite and bullet/inject-keyword rows.
const COS_ACTION_TYPES = [
  'cs_scan',
  'byo_scan',
  'ats_direct_scan',
  'resume_generation',
  'cover_letter_generation',
  'email_check',
  'manual_entry',
  'admin_grant',
  'copilot_session',
  'watchlist_curate',
];

const PROVIDER_TYPES = ['sourcing', 'ai'];

const PROVIDER_NAMES = ['apify', 'scraperapi', 'anthropic', 'openai_compatible', 'gemini'];

// 'cs' = Core Scraper (house), 'byo' = BYO Scraper (BYOK, multi-actor), 'manual',
// 'ats_direct' = ATS Direct (house, company job-board sourcing, §15 #24).
const JOB_SOURCES = ['cs', 'byo', 'manual', 'ats_direct'];

const SCAN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'];

// 'sourced' / 'scoring' are on-demand scoring (spec 4.7): a pre-filter survivor
// left unscored by choice, and one the user has asked to score.
const JOB_STATUSES = ['prefiltered', 'scored', 'archived', 'failed', 'sourced', 'scoring'];

const SCORE_MODES = ['auto', 'on_demand'];
// Anything but an explicit 'on_demand' is the default automatic mode, so an
// old client, an old schedule row or a typo keeps scoring as it always has.
function normalizeScoreMode(v) {
  return v === 'on_demand' ? 'on_demand' : 'auto';
}

const SCAN_FREQUENCIES = ['daily', 'weekdays', 'weekly'];

// Every AI call logs a row to ai_usage_log (spec 16.10), even free ones like
// resume parsing. Extended as scoring/generation/JD-extraction land.
//   score_jd_ats — Session 4 call 1 (cheap tier): JD profile + ATS Match.
//   score_fit    — Session 4 call 2 (strong tier): callback/preference/tags/note.
//   email_check  — Session 10 (cheap tier): batched Gmail email classification.
//   copilot_bullet_rewrite / copilot_bullet_inject_keyword — Copilot Mode
//     Stage 1 (cheap tier): the two new per-bullet AI edit call sites (7.14.6).
//   sector_classify — §15 #25b (spec 4.6.9, cheap tier): batched company→sector
//     classification, both the one-time bulk pass and the going-forward
//     detection-time hook. Platform overhead — user_id is null on these rows
//     (ai_usage_log.user_id made nullable for exactly this, 20260807010000),
//     never billed via cos_transactions.
const AI_USAGE_ACTION_TYPES = ['resume_parse', 'score_jd_ats', 'score_fit', 'resume_generation', 'cover_letter_generation', 'email_check', 'copilot_bullet_rewrite', 'copilot_bullet_inject_keyword', 'sector_classify', 'watchlist_target_spec', 'watchlist_curate'];

const AI_CONNECTION_MODES = ['vertex', 'developer'];

// company_sectors.sector (spec 4.6.9) — a fixed, maintained list. Also lives as
// a DB CHECK on company_sectors in 20260807000000_company_sectors.sql, which
// seeds one system tracklist per key here (order = system-tracklist UI order).
// Adding a sector means: migration (CHECK + system-tracklist insert) + this
// constant + COMPANY_SECTOR_LABELS below — the same three-place pattern
// company_ats_registry.platform already has.
const COMPANY_SECTORS = [
  'fintech',
  'healthtech',
  'ecommerce',
  'devtools',
  'ai_ml',
  'gaming',
  'cybersecurity',
  'logistics',
  'real_estate',
  'edtech',
  'biotech',
  'enterprise_saas',
  'consumer',
  'media_entertainment',
  'climate_energy',
  // Added §15 #51 from a real coverage analysis of the live registry: `other`
  // held 16.9% of classified companies, and sampling it turned up whole
  // industries the original sixteen had no room for, not a long tail of
  // oddities. hardware_semiconductors is the exception — those companies
  // weren't landing in `other`, they were being absorbed into
  // enterprise_saas/devtools, which is actively wrong rather than vague.
  'aerospace_defense',
  'manufacturing_industrial',
  'hardware_semiconductors',
  'professional_services',
  'nonprofit_government',
  'food_hospitality',
  'other',
];

// Display name for each sector's system tracklist row (tracklists.name).
const COMPANY_SECTOR_LABELS = {
  fintech: 'Fintech',
  healthtech: 'Healthtech',
  ecommerce: 'Ecommerce',
  devtools: 'Developer Tools',
  ai_ml: 'AI & ML',
  gaming: 'Gaming',
  cybersecurity: 'Cybersecurity',
  logistics: 'Logistics',
  real_estate: 'Real Estate',
  edtech: 'Edtech',
  biotech: 'Biotech',
  enterprise_saas: 'Enterprise SaaS',
  consumer: 'Consumer',
  media_entertainment: 'Media & Entertainment',
  climate_energy: 'Climate & Energy',
  aerospace_defense: 'Aerospace & Defense',
  manufacturing_industrial: 'Manufacturing & Industrial',
  hardware_semiconductors: 'Hardware & Semiconductors',
  professional_services: 'Professional Services',
  nonprofit_government: 'Nonprofit & Government',
  food_hospitality: 'Food & Hospitality',
  other: 'Other',
};

// Max sectors a single company can carry — bounds both the classification
// prompt's output and the admin-override endpoint's input.
//
// Raised from 3 to 7 in §15 #51. The cap was NOT the binding constraint, and
// measuring that first changed the fix: across 18,436 classified companies only
// 164 (0.9%) ever reached three sectors, and the mean was 1.41. What actually
// flattened conglomerates was the classifier prompt's own "most companies
// belong in 1-2 sectors, not 3" guidance, which is why that line was rewritten
// in the same session rather than the cap being raised on its own. The cap is
// now genuine headroom for a real conglomerate rather than a limit anything
// routinely hits.
const MAX_SECTORS_PER_COMPANY = 7;

// Which generation of the classifier produced a company_sectors row
// (company_sectors.classifier_version, 4.6.9). This is what makes a
// re-classification pass resumable and incremental instead of all-or-nothing:
// the bulk script selects companies with no rows, or rows stamped with any
// other version, and stamps this value on every write. A completed pass
// therefore selects nothing, and a crashed one resumes exactly where it left
// off.
//
// BUMP THIS whenever a change would produce different output for the same
// company — a prompt rewrite, a sector added or removed, a cap change. Do not
// bump it for a refactor that cannot change output; that would re-run ~19,600
// AI calls to write back identical rows.
//
// 1: the 22-sector taxonomy under the pre-tiering prompt.
// 2: the tiered-lane pass — same 22 sectors, prompt no longer nudges focused
//    companies toward 1-2 sectors, and conglomerates are classified in small
//    batches where classification depth measurably improves.
const SECTOR_CLASSIFIER_VERSION = 2;

// notifications.type has no DB CHECK (Session 12, spec §12.5) — enforced here
// in JS only. scan_skipped_low_cos: a scheduled run was skipped for low COS.
// schedule_auto_paused: a schedule auto-paused after repeated skips (§12.4).
// byo_actor_failed: a scheduled scan failed (sourcing-side, isolated per §12.4).
// scan_orphaned: a `running` scan was reaped as stale (process died mid-run,
// no persistent job queue) — surfaced so a silent crash isn't invisible to the
// user, since reapStaleScans runs outside the normal runOneSchedule completion
// path that would otherwise have sent a failure notification (2026-07-26).
// ats_direct_company_failed: one tracked company's board was unreachable during
// an ATS Direct scan (manual or scheduled) — per-company isolation (12.4/4.6.6),
// added §15 #24.
// watchlist_suggestions.evidence_type (spec 20) — which kind of real,
// checkable data point a suggestion cites. Also a DB CHECK in
// 20260828020000_watchlist_suggestions.sql; same three-place pattern as
// COMPANY_SECTORS. The validator drops any candidate whose citation does not
// resolve to a row that was actually passed into the call, so this list is an
// enforcement surface, not a label.
const WATCHLIST_EVIDENCE_TYPES = ['visa_sponsor', 'sector', 'resume_match'];

const NOTIFICATION_TYPES = [
  'scan_skipped_low_cos',
  'schedule_auto_paused',
  'byo_actor_failed',
  'scan_orphaned',
  'ats_direct_company_failed',
  // There is no ats_direct_scan_truncated. It was declared for a per-run
  // queried-companies budget that was never built — the tunable it named
  // (atsDirect.maxCompaniesQueriedPerScan) never existed, and the type had zero
  // emit sites for its whole life. §25c-2's rotating cursor, and then the
  // 30-minute wall-clock auto-continue that replaced the per-run cap outright,
  // removed the condition it would have reported. Removed in §15 #59 rather
  // than building a guard nothing wants.
  // §15 #25c-2 (12.3's deleted-tracklist-still-referenced-by-a-schedule
  // decision): a schedule's saved tracklist_ids narrowed because one or more
  // of them no longer resolve (deleted, or — for a subscribed system list —
  // unsubscribed) at live re-resolve time. schedule_auto_paused (pre-existing)
  // is reused for the "nothing left at all" case rather than adding a second
  // pause-flavored type, since that type already means exactly that.
  'schedule_selection_narrowed',
];

module.exports = {
  SCORE_MODES,
  normalizeScoreMode,
  APPLICATION_STAGES,
  COS_ACTION_TYPES,
  PROVIDER_TYPES,
  PROVIDER_NAMES,
  JOB_SOURCES,
  SCAN_STATUSES,
  JOB_STATUSES,
  SCAN_FREQUENCIES,
  AI_USAGE_ACTION_TYPES,
  AI_CONNECTION_MODES,
  NOTIFICATION_TYPES,
  COMPANY_SECTORS,
  COMPANY_SECTOR_LABELS,
  MAX_SECTORS_PER_COMPANY,
  SECTOR_CLASSIFIER_VERSION,
  WATCHLIST_EVIDENCE_TYPES,
};

// ATS Direct (spec 4.6) — Tier 1 platform adapters + the shared detection
// service. Built as §15 #22, Phase 4.
//
// Tier 2 (Workday, Workable) is §15 #27 — each gets its own dedicated parser
// (Workday's POST/pagination shape, Workable's single-request widget) rather
// than being folded into the Tier 1 GET-based adapters (4.6.1 is explicit
// that sharing that logic is the wrong move).

const greenhouse = require('./greenhouse');
const lever = require('./lever');
const ashby = require('./ashby');
const workday = require('./workday');
const workable = require('./workable');
const oracle = require('./oracle');
const eightfold = require('./eightfold');
const avature = require('./avature');
const apple = require('./custom/apple');
const amazon = require('./custom/amazon');
const google = require('./custom/google');
const meta = require('./custom/meta');
const phenom = require('./phenom');
// §15 #65: the SMB/startup set, the enterprise set found in the top-200
// research (data/ats-research/fortune200_us.csv), and YC's startup board.
const smartrecruiters = require('./smartrecruiters');
const recruitee = require('./recruitee');
const bamboohr = require('./bamboohr');
const breezy = require('./breezy');
const rippling = require('./rippling');
const successfactors = require('./successfactors');
const taleo = require('./taleo');
const icims = require('./icims');
const jibe = require('./jibe');
const radancy = require('./radancy');
const ycombinator = require('./ycombinator');
const { detectPlatform, fetchCompanyJobs, ADAPTERS, BY_PLATFORM } = require('./detect');
const { normalizeCompanyName } = require('./companyName');
const { slugCandidates, generateCandidates, SLUG_RULES, MINED_RULE_IDS } = require('./slugRules');
const { analyzePairs } = require('./slugMining');
const { isUsableCompanyLink } = require('./sourceLink');
const { htmlToText } = require('./htmlToText');
const { getHttpStats } = require('./dispatcher');
const { runContractChecks } = require('./contractCheck');

module.exports = {
  greenhouse,
  lever,
  ashby,
  workday,
  workable,
  oracle,
  eightfold,
  avature,
  apple,
  amazon,
  google,
  meta,
  phenom,
  smartrecruiters,
  recruitee,
  bamboohr,
  breezy,
  rippling,
  successfactors,
  taleo,
  icims,
  jibe,
  radancy,
  ycombinator,
  adapters: BY_PLATFORM,
  ADAPTERS,
  detectPlatform,
  fetchCompanyJobs,
  normalizeCompanyName,
  slugCandidates,
  generateCandidates,
  SLUG_RULES,
  MINED_RULE_IDS,
  analyzePairs,
  isUsableCompanyLink,
  htmlToText,
  // Per-origin HTTP dispatcher diagnostics (4.6.13, step 2) — surfaced via
  // GET /api/admin/ats-http-stats.
  getHttpStats,
  // Contract-drift canary (18.3) — reads each registered adapter's own
  // `contractCheck`. ALL 24 adapters carry one (the 11 added in §15 #65
  // shipped with theirs). The original 13: the Custom Adapter Tier
  // four (§15 #44), Tier 2.5's four (§15 #52), and Tier 1 + Tier 2's five,
  // enrolled last despite sourcing the most jobs. collectContractChecks still
  // skips an adapter without one, so a future adapter is not forced to carry a
  // canary before it has a stable board to point at. Surfaced via
  // POST /api/internal/ats-contract-check.
  runContractChecks,
};

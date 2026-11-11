const { getSupabaseAdmin } = require('./supabaseAdmin');
const tunables = require('./tunables.json');
const constants = require('./constants');
const geminiAdapter = require('./ai/geminiAdapter');
const openaiCompatibleAdapter = require('./ai/openaiCompatibleAdapter');
const anthropicAdapter = require('./ai/anthropicAdapter');
const apifyAdapter = require('./sourcing/apifyAdapter');
const scraperApiAdapter = require('./sourcing/scraperApiAdapter');
const jsearchAdapter = require('./sourcing/jsearchAdapter');
const atsDirectAdapter = require('./sourcing/atsDirectAdapter');
const locationMatch = require('./sourcing/locationMatch');
const { prefilter, maxYearsRequired, extractYearsRequired, domainOverlap, detectUsOnlySignal, detectVisaReject, detectWorkAuthReject } = require('./sourcing/prefilter');
const dedup = require('./sourcing/dedup');
const atsDirect = require('./sourcing/ats');
const { calculateAtsScore, calculateKeywordMatch, skillPresent, synonymsFor } = require('./ats/calculateAtsScore');
const { summarizeAts } = require('./ats/atsSummary');
const { normalizeJdTerm, normalizeJdSkillLists, normalizeJdProfile, isAtomicTerm } = require('./ats/normalizeJdTerms');
const {
  matchesTerm,
  isConfirmableSkill,
  isJdKeyword,
  buildJdIndex,
  buildTextIndex,
  isGrounded,
  namedExamplesFor,
  sanitizeJdProfile,
  groundResumeProfile,
  jdGroundingText,
} = require('./ats/keywordPipeline');
const { equivalentsFor } = require('./ats/equivalents');
const { scanTitles, normalizeTitles, scanLocations, locationLabel } = require('./scanTitles');
const { normalizeQuestion } = require('./autofill/normalizeQuestion');
const humanizer = require('./writing/humanizer');
const {
  LINK_TYPES,
  MAX_LINKS: MAX_CONTACT_LINKS,
  classifyLink,
  isKnownLinkType,
  labelForLink,
  labelForType,
  orderLinks,
  normalizeLinkUrl,
  selectableLinkTypes,
} = require('./contact/linkTypes');

module.exports = {
  getSupabaseAdmin,
  tunables,
  constants,
  geminiAdapter,
  openaiCompatibleAdapter,
  anthropicAdapter,
  apifyAdapter,
  scraperApiAdapter,
  jsearchAdapter,
  atsDirectAdapter,
  locationMatch,
  prefilter,
  maxYearsRequired,
  extractYearsRequired,
  detectWorkAuthReject,
  domainOverlap,
  detectUsOnlySignal,
  detectVisaReject,
  dedup,
  atsDirect,
  calculateAtsScore,
  calculateKeywordMatch,
  skillPresent,
  synonymsFor,
  summarizeAts,
  normalizeJdTerm,
  normalizeJdSkillLists,
  normalizeJdProfile,
  isAtomicTerm,
  matchesTerm,
  isConfirmableSkill,
  isJdKeyword,
  equivalentsFor,
  buildJdIndex,
  buildTextIndex,
  isGrounded,
  namedExamplesFor,
  sanitizeJdProfile,
  groundResumeProfile,
  jdGroundingText,
  scanTitles,
  normalizeTitles,
  scanLocations,
  locationLabel,
  normalizeQuestion,
  humanizer,
  LINK_TYPES,
  MAX_CONTACT_LINKS,
  classifyLink,
  isKnownLinkType,
  labelForLink,
  labelForType,
  orderLinks,
  normalizeLinkUrl,
  selectableLinkTypes,
};

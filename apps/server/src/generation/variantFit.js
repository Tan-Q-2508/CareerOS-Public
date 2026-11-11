const { tunables } = require('@careeros/shared');
const { measureLine, geometry, SIZE, DEFAULT_RENDER } = require('./metrics');

// Deterministic repair for an AI-written short/one_line/two_line variant set
// (2026-08-04 2nd bullet-fill bug fix). Shared by every place that produces
// or re-produces these three strings — draftResume.js's runShotgunDraft,
// fillPass.js's runFillPass, and bulletEdit.js's pickVariants — so there is
// exactly one implementation of "what do we do when the model overshoots,"
// not three that could quietly drift.
//
// Why this exists: charTargets() (draftResume.js) gives the model a genuine
// char-count DIAL, and measured against real bullet prose the model tracks it
// closely — but a fixed char count still produces a spread of real L (line-
// fill) values because glyph widths differ, so pushing the target high enough
// to reliably fill a line also means a real fraction of bullets overshoot
// into wrapping. The FIRST bug fix (2026-08-04) solved that by lowering the
// target until nothing overflowed — but that just traded overflow for
// visible underfill (median L~0.93 instead of a full line). The actual fix is
// this: keep the target high, and when a variant overflows its band, trim it
// at a word boundary instead of discarding it outright (which is what used to
// silently collapse EVERY bullet to `short` — see draftResume.js's history).

const T = tunables.bulletFill.strict;
const TWO_LINE_CEILING = tunables.generation.twoLineSafetyCeiling || 1.9;

function measureVar(text, geom) {
  return measureLine(text, SIZE.bullet, geom.bulletAvailW, false, T);
}

// Truncate text to the longest word-boundary prefix that still measures
// within `maxL` line-units — the same algorithm already proven at
// generateResume.js's truncateToFit, lifted here so it has one home instead
// of being reimplemented per call site.
function truncateToFit(text, geom, maxL) {
  const words = String(text || '').split(' ').filter(Boolean);
  if (!words.length) return '';
  let lo = 1;
  let hi = words.length;
  let best = words[0];
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = words.slice(0, mid).join(' ');
    if (measureVar(candidate, geom).L <= maxL) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return /[.!?]$/.test(best) ? best : `${best}.`;
}

// Repair one variant map ({ short, one_line, two_line }, any subset of keys
// present). Returns { variants, repaired } — `variants` has the same keys as
// the input (untouched values passed through unchanged), `repaired` lists
// which keys were trimmed, for logging/telemetry if ever needed.
//
// - short / one_line: trimmed to <=0.99 (safely inside 1 line) if they
//   measure >1 line. Nothing is done for underfill — that's what the raised
//   char target + shortFloor/oneCap prompt guidance is for; trimming can only
//   shorten text, never lengthen it truthfully.
// - two_line: trimmed to the safety ceiling if it measures >2 lines OR over
//   the ceiling (mirrors bulletChoices()'s existing 2-line safety net in
//   generateResume.js, applied here one step earlier so pickVariants/
//   bulletChoices see an already-safe candidate).
//
// An overflowing variant is never cut mid-thought. Cutting at the last word
// that fits turned "...and set migration sequencing across 6 platforms" into
// "...and set migration." — a sentence that no longer says anything. The
// order is now:
//   1. fitWholeClause: drop whole trailing clauses (", avoiding shortages")
//      until it fits, never leaving a list or a phrase unfinished;
//   2. the bullet's own shorter variant, which the model wrote complete;
//   3. only if neither exists, lastResortTrim (a word trim that at least never
//      ends on a dangling "to"/"and"/"for"). fitStats counts every path so a
//      batch run shows how often each one fires.

const fitStats = { clause: 0, sibling: 0, lastResort: 0 };

// Words a sentence cannot end on.
const DANGLING = new Set(['to', 'and', 'or', 'for', 'with', 'by', 'of', 'the', 'a', 'an', 'in', 'on', 'at', 'across', 'into', 'from', 'as', 'via', 'per', 'than', 'while', 'including', 'such', 'its', 'their', 'our', 'using', 'through', 'within', 'between', 'over', 'under', 'toward', 'towards', 'that', 'which', 'who', 'so', 'but', 'both', 'each', 'every', 'more', 'less', 'most', 'key', 'new']);

const lastWord = (s) => (s.match(/([A-Za-z'-]+)\W*$/) || [, ''])[1].toLowerCase();
const endSentence = (s) => {
  const t = s.replace(/[\s,;:(\-–—]+$/, '');
  return /[.!?]$/.test(t) ? t : `${t}.`;
};
const balanced = (s) => (s.match(/\(/g) || []).length === (s.match(/\)/g) || []).length;

// Candidate cut points: before a ", " / "; " / " while " / " and ", where
// what is kept is a complete statement and what is dropped is not the tail of
// a list ("scope, manage risks, and set sequencing" must not become "scope,
// manage risks.").
function clauseCuts(text) {
  const cuts = [];
  const re = /(,|;)\s+|\s+(and|while|with|including|so)\s+/g;
  let m;
  while ((m = re.exec(text))) {
    const kept = text.slice(0, m.index);
    const rest = text.slice(m.index + m[0].length);
    if (m[1] === ',' && /^(and|or)\b/i.test(rest)) continue; // Oxford-comma list end
    if (m[1] === ',' && /^[^,]{0,60}?,?\s(and|or)\s/i.test(rest) && !/^(resulting|leading|reducing|cutting|improving|saving|raising|avoiding|enabling|driving|which|while|so)\b/i.test(rest)) continue; // mid-list
    if (m[2] && /,\s*$/.test(kept)) continue; // ", and" closes a list
    if (m[2] === 'and' && /,[^,]*$/.test(kept) && !/;/.test(kept)) continue; // "a, b and c" list
    cuts.push(kept);
  }
  return cuts;
}

/**
 * The longest whole-clause prefix of `text` that measures within `maxL` and
 * `maxLines`, or null. Never returns a fragment that is under half the
 * original or ends on a dangling word.
 */
function fitWholeClause(text, geom, maxL, maxLines = maxL > 1 ? 2 : 1) {
  const src = String(text || '').trim();
  const cuts = clauseCuts(src).sort((a, b) => b.length - a.length);
  for (const kept of cuts) {
    const candidate = endSentence(kept);
    if (candidate.length < src.length * 0.5) break;
    if (DANGLING.has(lastWord(kept)) || !balanced(candidate)) continue;
    const m = measureVar(candidate, geom);
    if (m.L <= maxL && m.lineCount <= maxLines) return candidate;
  }
  return null;
}

// Word-boundary trim that backs off dangling words. Only reached when there
// is no whole clause to cut and no complete shorter variant to use.
function lastResortTrim(text, geom, maxL) {
  let t = truncateToFit(text, geom, maxL).replace(/\.$/, '');
  const words = t.split(' ');
  while (words.length > 3 && DANGLING.has(lastWord(words[words.length - 1]))) words.pop();
  t = words.join(' ');
  return endSentence(t);
}

function repairVariants(rawVariants) {
  const geom = geometry(DEFAULT_RENDER.marginIn);
  const out = {};
  const repaired = [];
  const fits = (text, maxL, maxLines) => {
    if (!text) return false;
    const m = measureVar(text, geom);
    return m.L <= maxL && m.lineCount <= maxLines;
  };
  // short first, then one_line, then two_line: each fallback can use the
  // already-repaired shorter sibling.
  for (const key of ['short', 'one_line', 'two_line']) {
    const text = rawVariants && rawVariants[key];
    if (!text) {
      out[key] = text;
      continue;
    }
    const [maxL, maxLines] = key === 'two_line' ? [TWO_LINE_CEILING, 2] : [0.99, 1];
    if (fits(text, maxL, maxLines)) {
      out[key] = text;
      continue;
    }
    repaired.push(key);
    const clause = fitWholeClause(text, geom, maxL, maxLines);
    if (clause) {
      fitStats.clause += 1;
      out[key] = clause;
      continue;
    }
    const sibling = key === 'two_line'
      ? [rawVariants.one_line, out.one_line, out.short].find((s) => fits(s, maxL, maxLines))
      : key === 'one_line' ? [out.short].find((s) => fits(s, maxL, maxLines)) : null;
    if (sibling) {
      fitStats.sibling += 1;
      out[key] = sibling;
      continue;
    }
    fitStats.lastResort += 1;
    out[key] = lastResortTrim(text, geom, maxL);
  }
  return { variants: out, repaired };
}

module.exports = { truncateToFit, repairVariants, fitWholeClause, lastResortTrim, fitStats };

const { tunables, humanizer } = require('@careeros/shared');
const { runDraft } = require('./draftCoverLetter');
const { renderCoverLetter, buildLetterModel } = require('./renderCoverLetter');
const { wordCount, bannedPhraseHits, measureOnePage } = require('./coverLetterChecks');

// Orchestrates the 8.5 pipeline (restructured 2026-07-19, explicit sign-off — same
// shape as 7.12): CODE strictly MEASURES/FLAGS (word count 283-350, one-page fit,
// zero banned phrases 8.3); the AI owns every content decision and repair. Best-
// version tracking rolls back any repair that BREAKS a previously-passing check.
// After the draft budget, ship the BEST letter and flag what didn't clear.

function usageFrom(r) {
  return { actionType: 'cover_letter_generation', model: r.model, connectionMode: r.connectionMode, usage: r.usage, costUsd: r.costUsd, tier: r.tier };
}

// Measure one letter draft. quality: no banned phrases dominates (hard gate 8.3),
// then one-page, then word-count in band, tie-broken by proximity to ~325 words.
function evaluateLetter(draft, contact, jobContext) {
  const wc = tunables.coverLetter.wordCount;
  const model = buildLetterModel(draft, contact, jobContext);
  const words = wordCount(model.paragraphs);
  const banned = bannedPhraseHits(model.paragraphs.join(' '));
  const page = measureOnePage(model);
  const noBanned = banned.length === 0;
  const wordInBand = words >= wc.min && words <= wc.idealMax;
  const allOk = noBanned && page.onePage && wordInBand;
  const quality =
    (noBanned ? 1e6 : 0) + (page.onePage ? 1e4 : 0) + (wordInBand ? 1e2 : 0) - Math.abs(words - 325) / 1000;
  // Humanizer tells (spec 8.7) ride along on a repair round the checks above
  // already triggered; they never trigger one on their own.
  const tells = humanizer.isEnabled() ? humanizer.rewriteHits(model.paragraphs.join('\n'), { allow: humanizer.jdAllowList(jobContext) }) : [];
  return { draft, model, words, banned, page, noBanned, wordInBand, allOk, quality, tells };
}

function buildLetterRepairInstructions(best) {
  const wc = tunables.coverLetter.wordCount;
  const { words, banned, page } = best;
  const lines = [
    'An automated check flagged the issues below. Return the FULL corrected 4-paragraph letter fixing them while KEEPING the strongest, most specific existing content and every truthful JD keyword already used.',
  ];
  if (banned.length) lines.push(`Remove these banned generic phrases entirely (and any close paraphrase): ${banned.join(', ')}.`);
  if ((best.tells || []).length) lines.push(`${humanizer.describeHits(best.tells, 'Part of the letter')}.`);
  if (!page.onePage) lines.push(`The letter overflows one page. Tighten wording and cut redundancy to ${wc.idealMin}-${wc.idealMax} words across 4 paragraphs.`);
  if (words < wc.min) lines.push(`The letter is too short (${words} words). Expand with real, truthful detail from the résumé toward ${wc.idealMin}-${wc.idealMax} words (never below ${wc.min}) across 4 paragraphs — no filler.`);
  else if (words > wc.idealMax) lines.push(`The letter is too long (${words} words). Trim to ${wc.idealMin}-${wc.idealMax} words across 4 paragraphs, keeping the strongest content.`);
  return lines.join('\n');
}

async function generateCoverLetter({ profile, contact, jobContext, confirmedSkills = [], confirmedContext = [], credential, onProgress = async () => {} }) {
  const wc = tunables.coverLetter.wordCount;
  const maxDrafts = tunables.repairLoopCap.total; // total AI drafts incl. the first

  await onProgress('draft', 'Drafting cover letter');
  const first = await runDraft({ profile, jobContext, confirmedSkills, confirmedContext, credential });
  let draft = first.draft;
  const usages = [usageFrom(first)];

  let best = null;
  for (let d = 0; ; d++) {
    await onProgress('evaluate', 'Checking length, tone, and page fit');
    const cur = evaluateLetter(draft, contact, jobContext);
    if (!best || cur.quality > best.quality) best = cur; // never keep a draft that broke a check
    if (best.allOk) break;
    if (d >= maxDrafts - 1) break;

    await onProgress('repair', `Repairing draft (round ${d + 1})`);
    const instructions = buildLetterRepairInstructions(best);
    const r = await runDraft({ profile, jobContext, confirmedSkills, confirmedContext, repairInstructions: instructions, credential });
    usages.push(usageFrom(r));
    draft = r.draft;
  }

  const { model, words, banned, page } = best;
  const unresolved = [];
  if (banned.length) unresolved.push('banned_phrase');
  if (!page.onePage) unresolved.push('one_page');
  if (words < wc.min || words > wc.idealMax) unresolved.push('word_count');

  await onProgress('render', 'Rendering document');
  const docxBuffer = await renderCoverLetter(model);
  return {
    docxBuffer,
    wordCount: words,
    checksPassed: {
      wordCount: words >= wc.min && words <= wc.idealMax,
      onePage: page.onePage,
      noBannedPhrases: banned.length === 0,
      repairRounds: usages.length - 1,
      unresolved,
    },
    usages,
  };
}

module.exports = { generateCoverLetter };

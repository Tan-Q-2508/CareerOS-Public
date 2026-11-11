const { tunables } = require('@careeros/shared');
const { measureTextWidth, lineHeight, PT_PER_IN, PAGE_W, PAGE_H } = require('./metrics');

// Deterministic checks for the cover letter (spec 8.1/8.2/8.3). Word count is the
// real driver of the repair loop; banned-phrase and one-page are hard gates.

// Usable area for the LOCKED 1in-margin business-letter format (8.1).
function geom() {
  const marginPt = tunables.coverLetter.marginIn * PT_PER_IN;
  return { usableW: PAGE_W - 2 * marginPt, usableH: PAGE_H - 2 * marginPt };
}

function wordCount(paragraphs) {
  const text = (paragraphs || []).join(' ').trim();
  return text ? text.split(/\s+/).length : 0;
}

// Case-insensitive scan for the banned generic AI-cover-letter phrases (8.3).
function bannedPhraseHits(text, list = tunables.coverLetter.bannedPhrases) {
  const lc = String(text || '').toLowerCase();
  return list.filter((p) => lc.includes(String(p).toLowerCase()));
}

// Lightweight one-page height estimate (8.1) — a 300-350-word 11pt letter at 1in
// margins is comfortably one page, but verify rather than assume.
function measureOnePage(model) {
  const { usableW, usableH } = geom();
  const size = tunables.coverLetter.bodySizePt;
  const lh = lineHeight(size, 1.0);
  const BLOCK_GAP = 8; // pt between letter blocks
  const linesOf = (text) => Math.max(1, Math.ceil(measureTextWidth(text, size) / usableW - 1e-9));

  let h = 0;
  for (const l of model.senderLines || []) h += lh;
  h += BLOCK_GAP;
  h += lh + BLOCK_GAP; // date
  for (const l of model.recipientLines || []) h += lh;
  h += BLOCK_GAP;
  h += lh + BLOCK_GAP; // subject
  h += lh + BLOCK_GAP; // greeting
  for (const p of model.paragraphs || []) h += linesOf(p) * lh + BLOCK_GAP;
  for (const l of model.closingLines || []) h += lh;

  const contentHeightPt = Number(h.toFixed(2));
  return { contentHeightPt, usableHeightPt: usableH, onePage: contentHeightPt <= usableH };
}

module.exports = { wordCount, bannedPhraseHits, measureOnePage, geom };

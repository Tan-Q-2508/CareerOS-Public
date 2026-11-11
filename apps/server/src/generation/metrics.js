const fs = require('fs');
const path = require('path');
const fontkit = require('fontkit');
const { tunables, orderLinks, labelForLink } = require('@careeros/shared');

// Deterministic measurement engine for the LOCKED Section-7 checks (7.1, 7.6).
// Pure JS, no PDF render: Word renders resumes in Calibri; Carlito is a
// metric-identical FOSS proxy (7.6), so glyph advance widths + line height
// measured here match Word's layout. All geometry is in PostScript points (pt).
//
// The layout is measured under a `render` options set — margins, line spacing,
// header scale, inter-element spacing — the SAME set renderResume applies, so
// the page-fit search (fitToPage) can tune those knobs against a faithful
// estimate and the produced .docx matches what was measured.

const PT_PER_IN = 72;
const PAGE_W = 8.5 * PT_PER_IN; // 612
const PAGE_H = 11 * PT_PER_IN; // 792

// Carlito's true single-line height factor, read straight from its font metrics
// (hhea/OS-2/typo all agree at 1.2207) — this is what Word uses for single line
// spacing, and is the calibration that makes the vertical estimate accurate.
const BASE_LINE_FACTOR = 1.2207;

// LOCKED font sizes (pt) per 7.2/7.3/7.5/7.6/7.10.
const SIZE = {
  name: 18, title: 14, contact: 10, sectionHeader: 11,
  // Role/project header lines dropped 11 -> 10 (2026-07-20): 11pt read too large
  // next to 10pt bullets; bold keeps them clearly distinct at 10pt.
  roleTitle: 10, roleDates: 10, bullet: 10, education: 10,
  // Skills category labels 11 -> 10 (2026-07-20): same size as body, bold keeps them distinct.
  skillsLabel: 10, skillsBody: 10,
};

// Inter-element vertical spacing (pt) — scalable by render.spacingScale.
const SPACE = {
  afterName: 1, afterTitle: 2, afterContact: 8,
  sectionHeaderBefore: 6, sectionHeaderAfter: 3,
  afterBullet: 1, afterRoleHeader: 1, afterRoleBlock: 4, afterProjectBlock: 4,
  afterEducationLine: 1, afterSkillRow: 1,
};

const BULLET_INDENT = 12; // tight manual marker hanging indent (7.7)

// Separator between two Skills category rows sharing one physical line
// (7.10, added 2026-07-28 for the Skills-section packing fix) — matches the
// contact line's existing ' | ' idiom (the only other multi-field single line
// in the document), just widened slightly to read clearly against a row that
// itself ends in a comma-separated item list.
const SKILL_SEP = '  |  ';

const DEFAULT_RENDER = { marginIn: 0.5, lineSpacing: 1.0, headerScale: 1.0, spacingScale: 1.0 };

// Usable area for a given margin (0.5in locked default; fitToPage may widen to
// 0.75in to fill a thin résumé, per the calibration rules).
function geometry(marginIn) {
  const marginPt = marginIn * PT_PER_IN;
  const usableW = PAGE_W - 2 * marginPt;
  return { marginPt, usableW, usableH: PAGE_H - 2 * marginPt, bulletAvailW: usableW - BULLET_INDENT };
}

let cachedFonts = null;
function fonts() {
  if (cachedFonts) return cachedFonts;
  const dir = path.join(__dirname, 'fonts');
  cachedFonts = {
    regular: fontkit.create(fs.readFileSync(path.join(dir, 'Carlito-Regular.woff'))),
    bold: fontkit.create(fs.readFileSync(path.join(dir, 'Carlito-Bold.woff'))),
  };
  return cachedFonts;
}

function measureTextWidth(text, sizePt, bold = false) {
  if (!text) return 0;
  const font = bold ? fonts().bold : fonts().regular;
  const run = font.layout(String(text));
  let units = 0;
  for (const g of run.glyphs) units += g.advanceWidth;
  return (units * sizePt) / font.unitsPerEm;
}

// --- Divergence D/C: real greedy word-wrap ---------------------------------
//
// wrappedLineCount() above divides total text width by the available width and
// takes the ceiling. That is a UNIFORM-DENSITY model: it assumes text packs
// perfectly to the margin on every line. Word does not pack — it breaks at word
// boundaries and leaves a ragged right edge — so the real line count is always
// >= the estimate, and sometimes one higher.
//
// Phase 3's bug-fix handoff called this "the highest-risk item in the plan":
// it feeds fitToPage, the shotgun variant picker, the fill pass and the export
// page-overflow gate, so changing it can retroactively flip which variant an
// already-generated document would have picked, and can make an in-flight
// Copilot session start failing page_overflow with no user action. That session
// shipped no code for it on purpose and asked for an offline diff over every
// existing row first.
//
// This function is that diff's measuring stick. It is DELIBERATELY NOT WIRED
// INTO ANYTHING — nothing in the render or fit path calls it. See
// scripts/diff-wrap-metrics.js for the blast-radius report it exists to
// produce, and §7.6 for where the decision stands.
//
// Greedy, first-fit, break-on-whitespace — the same algorithm Word uses for
// simple runs (no hyphenation, no justification). A single word wider than the
// line gets its own line rather than looping forever; that is a real case
// (a long URL in a project bullet) and Word would break it mid-word, so this
// UNDER-counts there rather than pretending otherwise.
function wrappedLineCountGreedy(text, sizePt, availWidthPt, bold = false) {
  const str = String(text || '').trim();
  if (!str) return 1;
  const words = str.split(/\s+/).filter(Boolean);
  if (!words.length) return 1;

  let lines = 1;
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    // Measured as a whole string, not as a sum of word widths, so kerning
    // across the space is accounted for the same way measureTextWidth does it
    // everywhere else.
    if (measureTextWidth(candidate, sizePt, bold) <= availWidthPt || !current) {
      current = candidate;
    } else {
      lines += 1;
      current = word;
    }
  }
  return lines;
}

function lineHeight(sizePt, lineSpacing = 1.0) {
  return sizePt * BASE_LINE_FACTOR * lineSpacing;
}

// A bullet must be a nearly-full single line OR nearly-full two lines (7.6):
// L (= width in line-units) >= oneLine for one line, or >= twoLine for two; the
// stubby middle and 3+ lines are out of band. `thresholds` is strict|relaxed.
function bulletFillStatus(L, thresholds) {
  const t = thresholds || tunables.bulletFill.strict;
  const lineCount = Math.max(1, Math.ceil(L - 1e-9));
  let inBand = false;
  let want = null;
  if (lineCount === 1) {
    inBand = L >= t.oneLine;
    want = inBand ? null : `fill the single line (target ${t.oneLine}-1.0)`;
  } else if (lineCount === 2) {
    inBand = L >= t.twoLine;
    want = inBand ? null : `fill two full lines (target ${t.twoLine}-2.0) — its 2nd line is a short stub`;
  } else {
    want = `too long (${lineCount} lines) — trim to one or two full lines`;
  }
  return { lineCount, inBand, want };
}

// Greedy-pack Skills & Certifications category rows onto as few physical
// lines as possible (7.10, 2026-07-28) — a short row (e.g. a lone
// `Certifications: X`) no longer wastes a full line's height. A category is
// NEVER split across lines, only whole rows are placed; a row wider than
// availWidthPt on its own still wraps to Math.ceil(width/availWidthPt) lines,
// same as it silently did before this change, and never shares a line with
// anything else. Pure/deterministic so renderResume and measureLayout can't
// disagree — both call this against the SAME geometry(marginIn).usableW.
function packSkillRows(rows, availWidthPt) {
  const sepWidth = measureTextWidth(SKILL_SEP, SIZE.skillsBody, false);
  const widths = rows.map((row) =>
    measureTextWidth(`${row.label}: `, SIZE.skillsLabel, true) +
    measureTextWidth((row.items || []).join(', '), SIZE.skillsBody, false)
  );
  const groups = [];
  let cur = null;
  let curWidth = 0;
  rows.forEach((row, i) => {
    const w = widths[i];
    if (w > availWidthPt) {
      // Doesn't fit even alone — stands on its own, spanning multiple lines.
      if (cur) { groups.push({ rowIndexes: cur, lineCount: 1 }); cur = null; curWidth = 0; }
      groups.push({ rowIndexes: [i], lineCount: Math.max(1, Math.ceil(w / availWidthPt)) });
      return;
    }
    if (cur && curWidth + sepWidth + w <= availWidthPt) {
      cur.push(i);
      curWidth += sepWidth + w;
      return;
    }
    if (cur) groups.push({ rowIndexes: cur, lineCount: 1 });
    cur = [i];
    curWidth = w;
  });
  if (cur) groups.push({ rowIndexes: cur, lineCount: 1 });
  return groups;
}

// How many physical lines a string of `text` occupies at `sizePt` across
// `availWidthPt` — the same ceil(width / avail) model packSkillRows and
// bulletFillStatus use, isolated for the contact line (7.2).
function wrappedLineCount(text, sizePt, availWidthPt) {
  if (!text) return 1;
  return Math.max(1, Math.ceil(measureTextWidth(text, sizePt, false) / availWidthPt - 1e-9));
}

// Trim `contact.links` (7.2) to the set that keeps the contact line within
// `maxLines` (2, so it can wrap once but never blow the one-page rule 7.1).
// Links are considered in registry priority order; the first that doesn't fit
// stops the scan and it plus everything lower-priority is dropped. Returns the
// kept links, the dropped types (recorded as a shortfall, same convention as
// bullet shortfalls), and the exact contact-line string the renderer/measurer
// should both use.
function fitContactLinks(contact, opts = {}) {
  const r = { ...DEFAULT_RENDER, ...(opts.render || {}) };
  const usableW = geometry(r.marginIn).usableW;
  const maxLines = opts.maxLines
    || (tunables.generation && tunables.generation.contactLinks && tunables.generation.contactLinks.maxRenderedLines)
    || 2;
  const prefix = [contact && contact.cityState, contact && contact.phone, contact && contact.email].filter(Boolean);
  const ordered = orderLinks((contact && contact.links) || []);

  const kept = [];
  const dropped = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const trial = [...prefix, ...kept.map(labelForLink), labelForLink(ordered[i])].join(' | ');
    if (wrappedLineCount(trial, SIZE.contact, usableW) <= maxLines) {
      kept.push(ordered[i]);
    } else {
      dropped.push(...ordered.slice(i));
      break;
    }
  }
  const contactLine = [...prefix, ...kept.map(labelForLink)].join(' | ');
  return { links: kept, dropped: dropped.map((l) => l.type), contactLine };
}

function measureLine(text, sizePt, availWidthPt, bold = false, thresholds = null) {
  const width = measureTextWidth(text, sizePt, bold);
  const L = width / availWidthPt;
  const { lineCount, inBand, want } = bulletFillStatus(L, thresholds);
  return { text, width, L, lineCount, ratio: Number((L / lineCount).toFixed(4)), inBand, want };
}

// Measure a full résumé layout model under a render options set. Separates
// line-height (scales with lineSpacing/headerScale) from inter-element spacing
// (scales with spacingScale) so fitToPage can solve each knob, and returns both
// totals for that solve.
function measureLayout(model, opts = {}) {
  const thresholds = opts.thresholds || tunables.bulletFill.strict;
  const r = { ...DEFAULT_RENDER, ...(opts.render || {}) };
  const geom = geometry(r.marginIn);
  let lineAcc = 0;
  let spaceAcc = 0;
  // Running document-flow position (pt), Copilot Mode addition (2026-07-27):
  // addLine/addSpace already scale identically to how contentHeightPt is
  // computed below (spaceAcc * spacingScale) — summing per-increment instead
  // of scaling once at the end is mathematically identical (linearity), so
  // this is purely additive bookkeeping, not a second measurement system.
  let cursorPt = 0;
  const bullets = [];
  const addLine = (v) => { lineAcc += v; cursorPt += v; };
  const addSpace = (v) => { spaceAcc += v; cursorPt += v * r.spacingScale; };
  const hSize = (s) => s * r.headerScale; // name/title/section headers can grow to fill

  const addBullet = (path_, text) => {
    const m = measureLine(text, SIZE.bullet, geom.bulletAvailW, false, thresholds);
    addLine(m.lineCount * lineHeight(SIZE.bullet, r.lineSpacing));
    addSpace(SPACE.afterBullet);
    // endPt: cumulative position after this bullet + its trailing space —
    // lets a caller (Copilot's export gate) name exactly which bullet crossed
    // usableHeightPt, rather than just knowing the page overflowed overall.
    bullets.push({ path: path_, text, width: m.width, L: Number(m.L.toFixed(3)), lineCount: m.lineCount, ratio: m.ratio, inBand: m.inBand, want: m.want, endPt: Number(cursorPt.toFixed(2)) });
  };
  const sectionHeader = () => {
    addSpace(SPACE.sectionHeaderBefore);
    addLine(lineHeight(hSize(SIZE.sectionHeader), r.lineSpacing));
    addSpace(SPACE.sectionHeaderAfter);
  };

  addLine(lineHeight(hSize(SIZE.name), r.lineSpacing)); addSpace(SPACE.afterName);
  addLine(lineHeight(hSize(SIZE.title), r.lineSpacing)); addSpace(SPACE.afterTitle);
  // The contact line (7.2) can now carry many links and wrap to a 2nd line —
  // measure its real width instead of assuming one line. Clamped to 2: the
  // link set is pre-trimmed to fit two lines (fitContactLinks), the clamp only
  // guards a pathological single unbreakable token.
  const contactLineText = (model.header && model.header.contactLine) || '';
  const contactLines = Math.min(2, wrappedLineCount(contactLineText, SIZE.contact, geom.usableW));
  addLine(contactLines * lineHeight(SIZE.contact, r.lineSpacing)); addSpace(SPACE.afterContact);

  sectionHeader();
  (model.summary || []).forEach((b, i) => addBullet(`summary[${i}]`, b));

  sectionHeader();
  (model.experience || []).forEach((role, ri) => {
    addLine(lineHeight(SIZE.roleTitle, r.lineSpacing)); addSpace(SPACE.afterRoleHeader);
    (role.bullets || []).forEach((b, bi) => addBullet(`experience[${ri}].bullets[${bi}]`, b));
    addSpace(SPACE.afterRoleBlock);
  });

  if ((model.projects || []).length) {
    sectionHeader();
    model.projects.forEach((proj, pi) => {
      addLine(lineHeight(SIZE.roleTitle, r.lineSpacing)); addSpace(SPACE.afterRoleHeader);
      (proj.bullets || []).forEach((b, bi) => addBullet(`projects[${pi}].bullets[${bi}]`, b));
      addSpace(SPACE.afterProjectBlock);
    });
  }

  sectionHeader();
  (model.education || []).forEach(() => { addLine(lineHeight(SIZE.education, r.lineSpacing)); addSpace(SPACE.afterEducationLine); });

  sectionHeader();
  const skillLines = packSkillRows(model.skills || [], geom.usableW);
  skillLines.forEach((group) => {
    addLine(group.lineCount * lineHeight(SIZE.skillsBody, r.lineSpacing));
    addSpace(SPACE.afterSkillRow);
  });

  const contentHeightPt = Number((lineAcc + spaceAcc * r.spacingScale).toFixed(2));
  return {
    contentHeightPt,
    lineAccPt: Number(lineAcc.toFixed(2)),
    spacingSumPt: Number(spaceAcc.toFixed(2)),
    usableHeightPt: geom.usableH,
    fillFraction: Number((contentHeightPt / geom.usableH).toFixed(4)),
    onePage: contentHeightPt <= geom.usableH,
    wellFilled: contentHeightPt >= geom.usableH * thresholds.pageFillMin,
    render: r,
    bullets,
    skillLines,
  };
}

// Vertical cost (pt) of one more bullet at the given line count, under a given
// render options set — the same `lineHeight`/`SPACE.afterBullet` constants
// measureLayout already accumulates with, just isolated for a single bullet
// so leftover page room can be converted into "how many more bullets fit."
function bulletLineCostPt(lines, render = DEFAULT_RENDER) {
  const r = { ...DEFAULT_RENDER, ...render };
  return lines * lineHeight(SIZE.bullet, r.lineSpacing) + SPACE.afterBullet * (r.spacingScale ?? 1);
}

// How much genuinely leftover room exists, expressed as bullet counts rather
// than a raw point figure or the existing fillFraction ratio (fill-pass, added
// 2026-07-27) — must be measured BEFORE fitToPage's cosmetic stretch consumes
// the room, see generateResume.js's assemble() (preFitMeas).
function leftoverBulletBudget(meas, render = DEFAULT_RENDER) {
  const remainingPt = Math.max(0, meas.usableHeightPt - meas.contentHeightPt);
  return {
    remainingPt: Number(remainingPt.toFixed(2)),
    oneLineBullets: Math.floor(remainingPt / bulletLineCostPt(1, render)),
    twoLineBullets: Math.floor(remainingPt / bulletLineCostPt(2, render)),
  };
}

module.exports = {
  PT_PER_IN, PAGE_W, PAGE_H, BASE_LINE_FACTOR, SIZE, SPACE, BULLET_INDENT, DEFAULT_RENDER,
  SKILL_SEP, geometry, measureTextWidth, lineHeight, measureLine, measureLayout, packSkillRows,
  bulletLineCostPt, leftoverBulletBudget, fitContactLinks, wrappedLineCount,
  // Measurement-only (Divergence D/C) — nothing in the render or fit path uses it.
  wrappedLineCountGreedy,
};

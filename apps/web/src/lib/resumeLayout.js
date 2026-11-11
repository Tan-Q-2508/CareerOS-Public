import { useEffect, useState } from 'react';
import { api } from './api';

// Copilot Mode Stage 2 (spec 7.14.5) — every layout number the Canvas uses is
// derived from GET /api/resume/layout-config, never hand-typed here. This
// file re-implements two of metrics.js's own PURE formulas (lineHeight,
// bulletFillStatus's band check) against numbers the server already reports —
// not a second, separately-tuned set of layout constants (7.14.10). Actual
// GLYPH WIDTHS are never guessed: they come from measuring real text against
// the same Carlito font file metrics.js reads via fontkit (see
// measureTextWidthPx below), served byte-identical by GET /api/resume/fonts/*.

const BASE = import.meta.env.VITE_API_BASE_URL || '';
const CSS_PX_PER_PT = 96 / 72; // CSS spec: 1in = 96px; typography: 1in = 72pt.

export function ptToPx(pt, zoom = 1) {
  return pt * CSS_PX_PER_PT * zoom;
}

export function pxToPt(px, zoom = 1) {
  return px / (CSS_PX_PER_PT * zoom);
}

let configPromise = null;
let fontsPromise = null;

// Loads the two Carlito weights via the CSS Font Loading API (not a <style>
// @font-face + hope-it's-ready-in-time) so `useLayoutConfig()` only reports
// loading:false once text measurement against them is actually reliable.
function loadFonts(cfg) {
  if (!fontsPromise) {
    fontsPromise = (async () => {
      const regular = new FontFace('Carlito', `url('${BASE}${cfg.font.regularUrl}')`, { weight: '400' });
      const bold = new FontFace('Carlito', `url('${BASE}${cfg.font.boldUrl}')`, { weight: '700' });
      const [r, b] = await Promise.all([regular.load(), bold.load()]);
      document.fonts.add(r);
      document.fonts.add(b);
    })();
  }
  return fontsPromise;
}

function loadLayoutConfig() {
  if (!configPromise) {
    configPromise = api
      .layoutConfig()
      .then(async (cfg) => {
        await loadFonts(cfg);
        return cfg;
      })
      .catch((e) => {
        configPromise = null;
        throw e;
      });
  }
  return configPromise;
}

// One fetch + one font-load per session, shared across every component that
// calls this hook (module-level promise cache).
export function useLayoutConfig() {
  const [state, setState] = useState({ config: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    loadLayoutConfig()
      .then((config) => {
        if (!cancelled) setState({ config, loading: false, error: null });
      })
      .catch((e) => {
        if (!cancelled) setState({ config: null, loading: false, error: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

// Mirrors metrics.js:49 geometry() — usable page area for a margin. `renderOpts`
// is the session's own solved render options (the `opts` field on the
// server's `layout` response, i.e. fitToPage's chosen margin/spacing/scale for
// THIS résumé) layered over layout-config's DEFAULT_RENDER baseline.
export function geometryFor(cfg, renderOpts) {
  const r = { ...cfg.render, ...(renderOpts || {}) };
  const marginPt = r.marginIn * cfg.page.ptPerIn;
  const usableW = cfg.page.widthPt - 2 * marginPt;
  const usableH = cfg.page.heightPt - 2 * marginPt;
  return { marginPt, usableW, usableH, bulletAvailW: usableW - cfg.bulletIndentPt, render: r };
}

// Mirrors metrics.js:75 lineHeight().
export function lineHeightPt(sizePt, cfg, lineSpacing = 1) {
  return sizePt * cfg.baseLineFactor * lineSpacing;
}

// A header/name/section-header size can grow under fitToPage's headerScale
// knob (metrics.js:125 hSize) — bullets/body text never do.
export function headerSizePt(sizePt, renderOpts) {
  return sizePt * ((renderOpts && renderOpts.headerScale) || 1);
}

// Mirrors metrics.js:82 bulletFillStatus() exactly — same three-branch band
// check (single full line / two full lines / too long), evaluated against
// whatever thresholds layout-config reports (never a locally re-tuned number).
export function bulletFillStatus(L, thresholds) {
  const lineCount = Math.max(1, Math.ceil(L - 1e-9));
  if (lineCount === 1) {
    const inBand = L >= thresholds.oneLine;
    return { lineCount, inBand, want: inBand ? null : `fill the single line (target ${thresholds.oneLine}-1.0)` };
  }
  if (lineCount === 2) {
    const inBand = L >= thresholds.twoLine;
    return { lineCount, inBand, want: inBand ? null : `fill two full lines (target ${thresholds.twoLine}-2.0) — its 2nd line is a short stub` };
  }
  return { lineCount, inBand: false, want: `too long (${lineCount} lines) — trim to one or two full lines` };
}

// --- Browser-native text measurement -------------------------------------
// A single hidden, off-screen, white-space:nowrap span reused across calls —
// measures against the SAME Carlito font-face the visible Canvas renders
// with, so the browser's own font rasterizer is the source of truth. No
// glyph-advance table is ported from fontkit (7.14.10's "no independent
// Shadow DOM measurement logic").
let measurerEl = null;
function measurer() {
  if (measurerEl) return measurerEl;
  const el = document.createElement('span');
  el.style.position = 'absolute';
  el.style.visibility = 'hidden';
  el.style.whiteSpace = 'nowrap';
  el.style.left = '-99999px';
  el.style.top = '0';
  el.style.fontFamily = "'Carlito', sans-serif";
  document.body.appendChild(el);
  measurerEl = el;
  return el;
}

// Natural (unwrapped) width in px of `text` at `sizePt` (ptToPx at zoom=1 —
// L below is a ratio, so the zoom factor cancels out regardless).
export function measureTextWidthPx(text, sizePt, bold = false) {
  const el = measurer();
  el.style.fontWeight = bold ? '700' : '400';
  el.style.fontSize = `${ptToPx(sizePt)}px`;
  el.textContent = text || '';
  return el.getBoundingClientRect().width;
}

// L = width-in-line-units, the same ratio metrics.js:99-101 measureLine()
// computes (naturalWidth / availWidth), evaluated with the browser's own
// loaded Carlito metrics instead of fontkit's.
export function measureBulletL(text, sizePt, availWidthPt, bold, thresholds) {
  const widthPx = measureTextWidthPx(text, sizePt, bold);
  const availPx = ptToPx(availWidthPt);
  const L = availPx > 0 ? widthPx / availPx : 0;
  return { L: Number(L.toFixed(3)), ...bulletFillStatus(L, thresholds) };
}

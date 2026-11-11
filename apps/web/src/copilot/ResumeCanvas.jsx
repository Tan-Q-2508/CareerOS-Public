import { useEffect, useMemo, useRef, useState } from 'react';
import { useCopilot, isReconciling } from './CopilotContext';
import Spinner from '../components/Spinner';
import { useLayoutConfig, geometryFor, lineHeightPt, headerSizePt, measureBulletL, pxToPt } from '../lib/resumeLayout';

// The WYSIWYG live preview (spec 7.14.3 step 3 / 7.14.5). Renders a real
// 8.5x11in page in Carlito, using nothing but CSS `pt` units so the browser's
// own layout engine does the pt->px conversion — no ported measurement loop.
// Section order mirrors renderResume.js's buildLayoutModel exactly: name,
// title, contact line, Summary, Experience, Projects, Education, Skills.

const SECTION_TITLES = {
  summary: 'Professional Summary',
  experience: 'Work Experience',
  projects: 'Relevant Projects',
  education: 'Education',
  skills: 'Skills & Certifications',
};

function bulletText(b) {
  return b.picked === 'custom' ? b.custom_text : b.variants && b.variants[b.picked];
}

function activeSorted(entries) {
  return (entries || []).filter((e) => !e.graveyard).slice().sort((a, b) => a.order - b.order);
}

// Case-insensitive highlight of matched-keyword substrings (spec 5.3), longest
// keyword first so a longer phrase wins over a shorter substring of it.
function highlightKeywords(text, keywords) {
  if (!text || !keywords || !keywords.length) return text;
  const terms = [...new Set(keywords.filter(Boolean))].sort((a, b) => b.length - a.length);
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return text;
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(re);
  return parts.map((part, i) =>
    terms.some((t) => t.toLowerCase() === part.toLowerCase()) ? (
      <mark key={i} className="cv-kw">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

// F/G (Phase 3 bug fix, 2026-08-02):
// F — .cv-section-heading's border-bottom+padding-bottom (~2.6pt) was pure
//   preview-only height, absent from metrics.sectionHeader(). Rather than
//   drop the rule (it's a real, wanted visual element), the marginBottom
//   below is shrunk by that same amount so the heading's TOTAL footprint
//   matches what the server measured, instead of exceeding it.
// G — the previous marginTop here collapsed with the preceding bullet's own
//   marginBottom (CSS sibling margin collapsing) into max(a,b), where the
//   server and Word both SUM the two — ~5pt lost per section boundary. A
//   sibling spacer with an explicit height (not a margin) cannot collapse
//   with anything, so marginTop is dropped to 0 here and the space moves
//   into that spacer instead.
const SECTION_RULE_PT = 1.5 * 0.75 + 2 * 0.75; // border-bottom 1.5px + padding-bottom 2px, in pt (96px/in -> 0.75pt/px)
function SectionHeading({ text, cfg, opts }) {
  const size = headerSizePt(cfg.sizes.sectionHeader, opts);
  return (
    <>
      <div style={{ height: `${cfg.spacing.sectionHeaderBefore}pt` }} aria-hidden="true" />
      <div
        className="cv-section-heading"
        style={{
          fontSize: `${size}pt`,
          lineHeight: `${lineHeightPt(size, cfg, opts.lineSpacing)}pt`,
          marginTop: 0,
          marginBottom: `${Math.max(0, cfg.spacing.sectionHeaderAfter - SECTION_RULE_PT)}pt`,
        }}
      >
        {text.toUpperCase()}
      </div>
    </>
  );
}

function BulletLine({ bulletId, text, cfg, geom, opts, matchedKeywords, marginBottomPt, isSelected }) {
  // The load-bearing measurement (spec 7.14.5): L / lineCount / inBand,
  // computed via the browser's own loaded Carlito metrics (resumeLayout.js),
  // NOT a ported glyph table. Exposed as data-* attributes so a verification
  // pass can diff these against the server's authoritative layout.bullets.
  const status = useMemo(
    () => measureBulletL(text, cfg.sizes.bullet, geom.bulletAvailW, false, cfg.thresholds),
    [text, cfg, geom.bulletAvailW]
  );
  const dotClass = status.inBand ? 'ok' : status.lineCount > (cfg.thresholds.maxLines || 2) ? 'over' : 'stub';
  return (
    <div
      id={`cv-b-${bulletId}`}
      className={`cv-bullet${isSelected ? ' is-selected' : ''}`}
      data-bullet-id={bulletId}
      data-local-l={status.L}
      data-local-linecount={status.lineCount}
      data-local-inband={status.inBand}
      style={{
        fontSize: `${cfg.sizes.bullet}pt`,
        lineHeight: `${lineHeightPt(cfg.sizes.bullet, cfg, opts.lineSpacing)}pt`,
        marginBottom: `${marginBottomPt}pt`,
        paddingLeft: `${cfg.bulletIndentPt}pt`,
        textIndent: `-${cfg.bulletIndentPt}pt`,
      }}
    >
      {/* A (Phase 3 bug fix, 2026-08-02): the dot used to sit INLINE, first in
          the text flow, stealing ~7.5pt of line-1 width from the preview only
          — the direct cause of a bullet that's one line in the exported .docx
          wrapping to two lines here. Absolute-positioned into the 12pt
          hanging-indent gutter (.cv-bullet is already position:relative) so
          it no longer participates in text layout at all. */}
      <span className={`cv-fill-dot ${dotClass}`} title={status.want || 'Fills the line well'} />
      {'•  '}
      {highlightKeywords(text, matchedKeywords)}
    </div>
  );
}

function RoleHeader({ title, company, dates, cfg, opts }) {
  const left = company ? `${title} — ${company}` : title;
  return (
    <div
      className="cv-role-header"
      style={{
        fontSize: `${cfg.sizes.roleTitle}pt`,
        lineHeight: `${lineHeightPt(cfg.sizes.roleTitle, cfg, opts.lineSpacing)}pt`,
        marginBottom: `${cfg.spacing.afterRoleHeader}pt`,
      }}
    >
      <span className="cv-role-left">{left}</span>
      <span className="cv-role-dates">{dates}</span>
    </div>
  );
}

export default function ResumeCanvas() {
  const { state } = useCopilot();
  const { config: cfg, loading: cfgLoading, error: cfgError } = useLayoutConfig();
  const wrapRef = useRef(null);
  const pageRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [localHeightPt, setLocalHeightPt] = useState(0);

  const opts = (state.layout && state.layout.opts) || (cfg && cfg.render) || null;
  const geom = cfg && opts ? geometryFor(cfg, opts) : null;

  // Fit-to-pane zoom, using CSS `zoom` (not `transform: scale`) so the browser
  // still lays the page out at its real size for measurement purposes —
  // getBoundingClientRect below is divided back out by this same factor.
  useEffect(() => {
    if (!wrapRef.current || !cfg) return;
    const el = wrapRef.current;
    const compute = () => {
      const paneWidthPt = pxToPt(el.clientWidth - 32);
      setZoom(Math.max(0.3, Math.min(1, paneWidthPt / cfg.page.widthPt)));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cfg]);

  // Local page-fit measurement (spec 7.14.5's second half): the rendered
  // page's own natural content height IS the measurement — no accumulation
  // loop ported from metrics.js.
  useEffect(() => {
    if (!pageRef.current) return;
    const el = pageRef.current;
    const compute = () => setLocalHeightPt(pxToPt(el.getBoundingClientRect().height, zoom));
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state.tree, cfg, opts, zoom]);

  // Layout-parity self-check (Phase 3 bug fix, 2026-08-02) — mirrors the ATS
  // parity check CopilotContext.jsx already runs (spec 7.14.13): the
  // per-bullet `data-local-l`/`data-local-linecount` attrs (BulletLine above)
  // were being written for "a verification pass" that never existed. Dev-only
  // console.warn, once per drift, never user-facing — after the A/B/E/F/G
  // preview fixes this should read zero drift on a real session; if it
  // doesn't, that's a divergence not yet accounted for. Deliberately does
  // NOT surface a second number to the user (see the header block below) —
  // two disagreeing percentages are worse than one occasionally-wrong one.
  const parityDriftRef = useRef(false);
  useEffect(() => {
    if (!import.meta.env.DEV || !pageRef.current || !state.layout || isReconciling(state)) return undefined;
    const t = setTimeout(() => {
      const el = pageRef.current;
      if (!el) return;
      const heightDriftPt = Math.abs(localHeightPt - state.layout.contentHeightPt);
      const mismatched = [];
      (state.layout.bullets || []).forEach((b) => {
        if (!b.bullet_id) return;
        const node = el.querySelector(`[data-bullet-id="${b.bullet_id}"]`);
        if (!node) return;
        const localLineCount = Number(node.getAttribute('data-local-linecount'));
        if (localLineCount && localLineCount !== b.lineCount) {
          mismatched.push({ bulletId: b.bullet_id, server: b.lineCount, local: localLineCount });
        }
      });
      if ((heightDriftPt > 2 || mismatched.length) && !parityDriftRef.current) {
        parityDriftRef.current = true;
        // eslint-disable-next-line no-console
        console.warn('[layout parity] preview/server layout diverged', { heightDriftPt, mismatched });
      } else if (heightDriftPt <= 2 && !mismatched.length) {
        parityDriftRef.current = false;
      }
    }, 50); // let fonts/layout settle after the tree update before comparing
    return () => clearTimeout(t);
  }, [state, localHeightPt]);

  if (cfgLoading || !state.tree || !geom) {
    return (
      <div className="cv-loading">
        <Spinner />
      </div>
    );
  }
  if (cfgError) return <div className="error-text">Couldn&apos;t load layout config: {cfgError}</div>;

  const tree = state.tree;
  const experience = activeSorted(tree.entries.filter((e) => e.kind === 'experience'));
  const projects = activeSorted(tree.entries.filter((e) => e.kind === 'project'));
  const summary = (tree.summary || []).slice().sort((a, b) => a.order - b.order);
  const sortedBullets = (e) => (e.bullets || []).slice().sort((a, b) => a.order - b.order);

  const localOnePage = localHeightPt <= geom.usableH;
  const server = state.layout;
  const kw = state.matchedKeywords;
  const header = state.renderHeader || { name: '', title: '', contact_line: '' };
  // The server's own layout object is authoritative (spec 7.14.5) — while a
  // local mutation hasn't been confirmed by the debounced PATCH yet, dim it
  // rather than presenting a verdict that may no longer match the tree.
  const layoutStale = isReconciling(state);
  const isSelected = (bulletId) => state.hoveredBulletId === bulletId || state.pinnedBulletId === bulletId;

  return (
    <div className="cv-pane">
      <div className={`cv-verdict-strip${layoutStale ? ' is-stale' : ''}`}>
        {server ? (
          <>
            <span className={server.onePage ? 'ok-text' : 'error-text'}>
              {server.onePage ? '✓ Fits one page' : '⚠ Over one page'}
            </span>
            <span className="cv-verdict-dim"> · server-verified · {(server.fillFraction * 100).toFixed(0)}% filled</span>
            {layoutStale && <span className="cv-verdict-dim"> · recalculating…</span>}
            {/* The one user-visible parity signal (Phase 3 bug fix,
                2026-08-02) — only for the case that actually costs the user
                something: the browser thinks it overflows while the server,
                which is what actually gates export, says it fits. Never a
                second percentage — the server number above stays the only
                quantitative one shown, because it's the one that decides. */}
            {!layoutStale && server.onePage && !localOnePage && (
              <span className="cv-verdict-dim"> · your browser lays this out slightly longer — the exported .docx is what counts</span>
            )}
          </>
        ) : (
          <span className="cv-verdict-dim">Awaiting server verdict…</span>
        )}
      </div>
      <div className="cv-scroll" ref={wrapRef}>
        <div
          className="cv-page"
          style={{
            width: `${cfg.page.widthPt}pt`,
            padding: `${geom.marginPt}pt`,
            zoom,
            fontFamily: "'Carlito', sans-serif",
          }}
        >
          {!localOnePage && (
            <div className="cv-overflow-line" style={{ top: `calc(${geom.marginPt}pt + ${geom.usableH}pt)` }}>
              <span>Page 1 ends here</span>
            </div>
          )}

          {/* Content-only wrapper (no padding) — pageRef measures JUST the
             content flow height here, so it lines up with usableH (page
             height minus both margins), not the padded box's own height. */}
          <div ref={pageRef}>
          {/* E (Phase 3 bug fix, 2026-08-02): these three previously set no
              lineHeight and inherited body{line-height:1.5} instead of the
              server's BASE_LINE_FACTOR (~1.2207) — ~+11.7pt of preview-only
              phantom height across the three lines combined. Now explicit,
              matching SectionHeading/BulletLine, which always set it. */}
          <div
            className="cv-name"
            style={{
              fontSize: `${headerSizePt(cfg.sizes.name, opts)}pt`,
              lineHeight: `${lineHeightPt(headerSizePt(cfg.sizes.name, opts), cfg, opts.lineSpacing)}pt`,
              marginBottom: `${cfg.spacing.afterName}pt`,
            }}
          >
            {header.name}
          </div>
          <div
            className="cv-title"
            style={{
              fontSize: `${headerSizePt(cfg.sizes.title, opts)}pt`,
              lineHeight: `${lineHeightPt(headerSizePt(cfg.sizes.title, opts), cfg, opts.lineSpacing)}pt`,
              marginBottom: `${cfg.spacing.afterTitle}pt`,
            }}
          >
            {header.title}
          </div>
          <div
            className="cv-contact"
            style={{
              fontSize: `${cfg.sizes.contact}pt`,
              lineHeight: `${lineHeightPt(cfg.sizes.contact, cfg, opts.lineSpacing)}pt`,
              marginBottom: `${cfg.spacing.afterContact}pt`,
            }}
          >
            {header.contact_line}
          </div>

          <SectionHeading text={SECTION_TITLES.summary} cfg={cfg} opts={opts} />
          {summary.map((b) => (
            <BulletLine
              key={b.bullet_id}
              bulletId={b.bullet_id}
              text={bulletText(b)}
              cfg={cfg}
              geom={geom}
              opts={opts}
              matchedKeywords={kw}
              marginBottomPt={cfg.spacing.afterBullet}
              isSelected={isSelected(b.bullet_id)}
            />
          ))}

          <SectionHeading text={SECTION_TITLES.experience} cfg={cfg} opts={opts} />
          {experience.map((e) => {
            const bullets = sortedBullets(e);
            return (
              <div key={e.entry_id}>
                <RoleHeader title={e.header.title} company={e.header.company} dates={e.header.dates} cfg={cfg} opts={opts} />
                {bullets.map((b, i) => (
                  <BulletLine
                    key={b.bullet_id}
                    bulletId={b.bullet_id}
                    text={bulletText(b)}
                    cfg={cfg}
                    geom={geom}
                    opts={opts}
                    matchedKeywords={kw}
                    marginBottomPt={i === bullets.length - 1 ? cfg.spacing.afterBullet + cfg.spacing.afterRoleBlock : cfg.spacing.afterBullet}
                    isSelected={isSelected(b.bullet_id)}
                  />
                ))}
              </div>
            );
          })}

          {projects.length > 0 && (
            <>
              <SectionHeading text={SECTION_TITLES.projects} cfg={cfg} opts={opts} />
              {projects.map((e) => {
                const bullets = sortedBullets(e);
                return (
                  <div key={e.entry_id}>
                    <RoleHeader title={e.header.title} company="" dates={e.header.dates} cfg={cfg} opts={opts} />
                    {bullets.map((b, i) => (
                      <BulletLine
                        key={b.bullet_id}
                        bulletId={b.bullet_id}
                        text={bulletText(b)}
                        cfg={cfg}
                        geom={geom}
                        opts={opts}
                        matchedKeywords={kw}
                        marginBottomPt={i === bullets.length - 1 ? cfg.spacing.afterBullet + cfg.spacing.afterProjectBlock : cfg.spacing.afterBullet}
                        isSelected={isSelected(b.bullet_id)}
                      />
                    ))}
                  </div>
                );
              })}
            </>
          )}

          <SectionHeading text={SECTION_TITLES.education} cfg={cfg} opts={opts} />
          {(tree.education || []).map((e, i) => (
            <div
              key={i}
              className="cv-edu-row"
              style={{ fontSize: `${cfg.sizes.education}pt`, lineHeight: `${lineHeightPt(cfg.sizes.education, cfg, opts.lineSpacing)}pt`, marginBottom: `${cfg.spacing.afterEducationLine}pt` }}
            >
              <span className="cv-edu-left">
                {e.degreeField && <b>{e.degreeField}</b>}
                {e.degreeField && e.institution ? ' — ' : ''}
                {e.institution}
              </span>
              {e.dates && <span className="cv-edu-dates">{e.dates}</span>}
            </div>
          ))}

          <SectionHeading text={SECTION_TITLES.skills} cfg={cfg} opts={opts} />
          {(() => {
            const skillRows = tree.skills || [];
            // Packed groups (7.10, 2026-07-28) come straight from the server's
            // layout.skillLines — the same packSkillRows decision the .docx
            // renders with. Falls back to one row per line (pre-fix shape) if
            // an older cached layout payload lacks skillLines, rather than
            // rendering blank.
            const groups = (state.layout && state.layout.skillLines) || skillRows.map((_, i) => ({ rowIndexes: [i] }));
            return groups.map((group, gi) => (
              <div
                key={gi}
                className="cv-skills-row"
                style={{ fontSize: `${cfg.sizes.skillsBody}pt`, lineHeight: `${lineHeightPt(cfg.sizes.skillsBody, cfg, opts.lineSpacing)}pt`, marginBottom: `${cfg.spacing.afterSkillRow}pt` }}
              >
                {group.rowIndexes.map((idx, i) => {
                  const row = skillRows[idx];
                  if (!row) return null;
                  return (
                    <span key={idx}>
                      {i > 0 ? '  |  ' : ''}
                      <b>{row.label}: </b>
                      {highlightKeywords((row.items || []).join(', '), kw)}
                    </span>
                  );
                })}
              </div>
            ));
          })()}
          </div>
        </div>
      </div>
    </div>
  );
}

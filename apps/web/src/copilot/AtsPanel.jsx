import { useMemo, useState } from 'react';
import { useCopilot } from './CopilotContext';
import { skillPresent } from '../lib/atsEngine';

// Live ATS Scoreboard + Missing Keywords pane (spec 7.14.13 / 7.14.12),
// rendered at the top of the Workbench rail (maintainer decision, Session
// 21b) rather than a third screen column — .wb-pane is already "separate
// from the Canvas" per 7.14.12's wording, and a third ~300px rail would
// push the comfortable minimum width from ~1324px to ~1644px, auto-zooming
// the résumé page itself down on anything smaller than that. Sticky inside
// the already-scrolling .wb-pane so the score stays visible while editing.

function bulletTextOf(b) {
  return b && (b.picked === 'custom' ? b.custom_text : b.variants && b.variants[b.picked]);
}

// First bullet, in the same traversal order assembleFromTree/sectionsFromTree
// walk (summary, then experience, then projects), whose text demonstrates
// `term` — what a green/yellow chip click points at.
function findDemonstratingBullet(tree, term) {
  const sortedB = (list) => (list || []).slice().sort((a, b) => a.order - b.order);
  const active = (kind) => (tree.entries || []).filter((e) => e.kind === kind && !e.graveyard).slice().sort((a, b) => a.order - b.order);
  for (const b of sortedB(tree.summary)) {
    const t = bulletTextOf(b);
    if (t && skillPresent(t.toLowerCase(), term)) return b.bullet_id;
  }
  for (const e of [...active('experience'), ...active('project')]) {
    for (const b of sortedB(e.bullets)) {
      const t = bulletTextOf(b);
      if (t && skillPresent(t.toLowerCase(), term)) return b.bullet_id;
    }
  }
  return null;
}

const TIER_CLASS = { core: 'wb-kw-chip-core', skills_only: 'wb-kw-chip-skills', missing: 'wb-kw-chip-missing' };
const TIER_TITLE = {
  core: 'Demonstrated in a bullet — full credit',
  skills_only: 'Only in Skills or Summary, not a real bullet — partial credit only. Click to weave it into a bullet.',
  missing: 'Not in this résumé yet — click to weave it into a bullet.',
};

// Resume improvement suggestions (A5, spec 7.14.12) — a ranked, actionable
// list derived ENTIRELY from data the scoring engine already computes: the
// same `ats.terms` tiers the chip grid renders (missing / skills_only) plus
// the job row's own scan-time critical/important/nice-to-have tiering (5.3,
// threaded onto session state by CopilotContext's SESSION_UPDATE), plus a
// deterministic quantified-metric check over the tree's own bullet text. No
// new AI call — every suggestion here is one click away from a mechanic the
// panel already has (stageKeyword's AI-weave banner, or the same pin-and-
// scroll a core chip uses).
const METRIC_RE = /\d/;

function bulletTextForSuggestion(b) {
  return b && (b.picked === 'custom' ? b.custom_text : b.variants && b.variants[b.picked]);
}

// Every active (non-graveyarded) bullet with no digit anywhere in its text —
// a cheap, deterministic proxy for "no quantified result" (spec 7.12 step 5
// targets ≥50% of bullets resume-wide carrying a truthful quantified metric;
// this surfaces the ones that don't, one at a time, for the user to judge —
// never auto-injects a fabricated number).
function findBulletsLackingMetric(tree) {
  const out = [];
  const scan = (label, list) => {
    for (const b of (list || []).slice().sort((a, c) => a.order - c.order)) {
      const t = bulletTextForSuggestion(b);
      if (t && !METRIC_RE.test(t)) out.push({ bulletId: b.bullet_id, label, text: t });
    }
  };
  scan('Professional Summary', tree.summary);
  for (const e of (tree.entries || []).filter((e) => !e.graveyard).slice().sort((a, b) => a.order - b.order)) {
    scan(e.header.title, e.bullets);
  }
  return out;
}

// Is `term` (an atomized JD keyword) named anywhere in this scan-tiered list
// of looser AI-written phrases (e.g. critical_missing might read "5+ years
// leading a data team" rather than the atom "data team lead")? Bidirectional
// skillPresent, same rule the confirm-once gate (routes/copilot.js's
// isVouchedKeyword) uses for the identical "short atom vs. looser phrase"
// matching problem — never a third comparison method.
function tierIncludes(term, list) {
  const t = String(term || '').toLowerCase();
  return (list || []).some((phrase) => {
    const p = String(phrase || '').toLowerCase();
    return skillPresent(p, t) || skillPresent(t, p);
  });
}

function buildSuggestions({ ats, tree, criticalMissing, importantMissing }) {
  if (!ats || !tree) return [];
  const out = [];

  for (const t of ats.terms) {
    if (t.tier === 'missing') {
      if (tierIncludes(t.term, criticalMissing)) {
        out.push({
          key: `crit-${t.term}`, rank: 0, severity: 'critical', kind: 'stage', term: t.term,
          text: `Critical requirement "${t.term}" is missing from your résumé — click to weave it into a bullet.`,
        });
      } else if (tierIncludes(t.term, importantMissing)) {
        out.push({
          key: `imp-${t.term}`, rank: 1, severity: 'important', kind: 'stage', term: t.term,
          text: `"${t.term}" is an important requirement not yet in your résumé — click to weave it into a bullet.`,
        });
      }
    } else if (t.tier === 'skills_only') {
      out.push({
        key: `sk-${t.term}`, rank: 2, severity: 'skills_only', kind: 'stage', term: t.term,
        text: `"${t.term}" is only listed in Skills — move it into a bullet to score higher.`,
      });
    }
  }

  for (const b of findBulletsLackingMetric(tree)) {
    out.push({
      key: `metric-${b.bulletId}`, rank: 3, severity: 'metric', kind: 'bullet', bulletId: b.bulletId,
      text: `"${b.label}" bullet has no number or metric — consider quantifying the impact.`,
    });
  }

  // Uncategorized/nice-to-have missing terms — real gaps, just the lowest
  // priority (never blocked the score much to begin with, NICE_WEIGHT=0.5).
  for (const t of ats.terms) {
    if (t.tier === 'missing' && !tierIncludes(t.term, criticalMissing) && !tierIncludes(t.term, importantMissing)) {
      out.push({
        key: `nice-${t.term}`, rank: 4, severity: 'nice', kind: 'stage', term: t.term,
        text: `"${t.term}" would strengthen your match — click to weave it into a bullet.`,
      });
    }
  }

  return out.sort((a, b) => a.rank - b.rank);
}

const SUGGESTION_COLOR = {
  critical: 'var(--danger)',
  important: 'var(--caution)',
  skills_only: 'var(--caution)',
  metric: 'var(--text-dim)',
  nice: 'var(--text-dim)',
};

const SUGGESTIONS_SHOWN_DEFAULT = 6;

function SuggestionRow({ s, dispatch, stageKeyword }) {
  const onClick = () => {
    if (s.kind === 'bullet') {
      dispatch({ type: 'PIN_BULLET', bulletId: s.bulletId });
      document.getElementById(`wb-b-${s.bulletId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    stageKeyword(s.term);
  };
  return (
    <li style={{ listStyle: 'none' }}>
      <button
        type="button"
        onClick={onClick}
        title="Click to jump to the relevant bullet"
        style={{
          display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
          borderLeft: `2px solid ${SUGGESTION_COLOR[s.severity] || 'var(--text-dim)'}`,
          padding: '3px 0 3px 8px', margin: '3px 0', fontSize: 11, color: 'var(--text)', cursor: 'pointer',
        }}
      >
        {s.text}
      </button>
    </li>
  );
}

function SuggestionsList({ suggestions, dispatch, stageKeyword }) {
  const [expanded, setExpanded] = useState(false);
  if (!suggestions.length) return null;
  const shown = expanded ? suggestions : suggestions.slice(0, SUGGESTIONS_SHOWN_DEFAULT);
  const hiddenCount = suggestions.length - shown.length;
  return (
    <div className="wb-ats-gap-hint" style={{ color: 'var(--text-dim)' }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>Suggestions to improve your score</div>
      <ul style={{ margin: 0, padding: 0 }}>
        {shown.map((s) => (
          <SuggestionRow key={s.key} s={s} dispatch={dispatch} stageKeyword={stageKeyword} />
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 11, cursor: 'pointer', padding: '3px 0 0 8px' }}
        >
          +{hiddenCount} more
        </button>
      )}
    </div>
  );
}

function scoreClass(score, target) {
  if (score == null) return '';
  if (target != null && score >= target) return 'wb-ats-score-good';
  if (target != null && score >= target - 10) return 'wb-ats-score-warn';
  return 'wb-ats-score-bad';
}

// A red (missing) chip used to be `disabled` with nothing behind it, then
// (Session 21b) opened the Vault with no injector path at all. CHANGED
// 2026-08-02 (Phase 3 bug fix — "keyword add doesn't allow it"): now STAGES
// the term for the keyword injector (Workbench's stagedKeyword banner — pick
// any bullet's ✦ to weave it in through one billed AI call) rather than only
// opening the Vault. The Vault stays reachable as a secondary link in that
// banner — a real omitted bullet that already demonstrates the term is a
// better, free answer than an AI weave when one exists. Only the green (core)
// chip keeps the pin-and-scroll behavior.
// CHANGED 2026-08-05 (bug fix): yellow (skills_only) chips used to fall into
// the pin-and-scroll branch below, but findDemonstratingBullet can never find
// a bullet for a skills-only term BY DEFINITION (it's not in any bullet) —
// so clicking a yellow chip silently did nothing. Its fix is identical to a
// red chip's: stage it for the same AI weave.
function Chip({ term, tier, required, dispatch, tree, pinnedBulletId, stageKeyword }) {
  const onClick = () => {
    if (tier !== 'core') {
      stageKeyword(term);
      return;
    }
    const bulletId = findDemonstratingBullet(tree, term);
    if (!bulletId) return;
    const next = pinnedBulletId === bulletId ? null : bulletId;
    dispatch({ type: 'PIN_BULLET', bulletId: next });
    if (next) document.getElementById(`wb-b-${next}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  return (
    <button
      type="button"
      className={`wb-kw-chip ${TIER_CLASS[tier] || ''}${required ? '' : ' wb-kw-chip-nice'}`}
      title={TIER_TITLE[tier]}
      onClick={onClick}
    >
      {term}
    </button>
  );
}

export default function AtsPanel() {
  const { state, dispatch, ats, stageKeyword } = useCopilot();
  const [expanded, setExpanded] = useState(false);

  const suggestions = useMemo(
    () => buildSuggestions({ ats, tree: state.tree, criticalMissing: state.criticalMissing, importantMissing: state.importantMissing }),
    [ats, state.tree, state.criticalMissing, state.importantMissing]
  );

  if (!ats || !ats.terms.length) return null;

  const required = ats.terms.filter((t) => t.required);
  const nice = ats.terms.filter((t) => !t.required);

  return (
    <>
      {/* Sticky: just the score + bar, so it stays visible while scrolling
          bullets below without eating most of the pane's screen space.
          Suggestions/chips used to live in here too (all sticky together) —
          with up to 6 suggestions shown by default that permanently ate
          200-300px of the pane's viewport, leaving barely any room to see
          bullets while editing (live user complaint 2026-08-14). Moved to
          wb-ats-panel-body below, which scrolls away normally. */}
      <div className="wb-ats-panel">
        <div className="wb-ats-score-row">
          <span className={`wb-ats-score ${scoreClass(ats.score, ats.target)}`}>
            {ats.score == null ? '—' : ats.score.toFixed(1)}
          </span>
          <span className="wb-ats-score-label">
            ATS keyword match{ats.target != null ? ` · target ${ats.target}` : ''}
            {ats.reconciling && <span className="wb-ats-reconciling"> · reconciling…</span>}
          </span>
        </div>
        <div className="wb-ats-bar" aria-hidden="true">
          <div className="wb-ats-bar-fill" style={{ width: `${Math.max(0, Math.min(100, ats.score || 0))}%` }} />
        </div>
      </div>

      <div className="wb-ats-panel-body">
        {/* Explains the common "every keyword is present, score still isn't 100"
            confusion: a skills_only term only earns partial credit until it's
            woven into a real bullet — the score itself won't say this, only the
            tier breakdown does. */}
        {ats.counts.skills_only > 0 && (
          <div className="wb-ats-gap-hint">
            {ats.counts.skills_only} keyword{ats.counts.skills_only === 1 ? ' is' : 's are'} only in Skills, not yet in
            a bullet — that's partial credit, not full. Click a yellow chip below to weave it in and close the gap.
          </div>
        )}

        <SuggestionsList suggestions={suggestions} dispatch={dispatch} stageKeyword={stageKeyword} />

        <button type="button" className="wb-ats-summary" onClick={() => setExpanded((e) => !e)} title="Keyword coverage — in a bullet, listed in Skills only, or missing">
          {expanded ? '▾' : '▸'}{' '}
          <span className="wb-ats-count wb-kw-chip-core" title="In a bullet">{ats.counts.core}</span>{' '}
          <span className="wb-ats-count wb-kw-chip-skills" title="Skills section only">{ats.counts.skills_only}</span>{' '}
          <span className="wb-ats-count wb-kw-chip-missing" title="Missing">{ats.counts.missing}</span>{' '}
          <span className="wb-ats-summary-label">keyword coverage</span>
        </button>

        {expanded && (
          <div className="wb-kw-chips wb-ats-chips">
            {required.map((t) => (
              <Chip key={t.term} term={t.term} tier={t.tier} required dispatch={dispatch} tree={state.tree} pinnedBulletId={state.pinnedBulletId} stageKeyword={stageKeyword} />
            ))}
            {nice.length > 0 && <span className="wb-ats-divider" aria-hidden="true" />}
            {nice.map((t) => (
              <Chip key={t.term} term={t.term} tier={t.tier} required={false} dispatch={dispatch} tree={state.tree} pinnedBulletId={state.pinnedBulletId} stageKeyword={stageKeyword} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

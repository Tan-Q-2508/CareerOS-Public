import { useEffect, useRef } from 'react';

// Code-style progress/results console (2026-07-27 UI request): a single,
// monospace window that replaces the scattered spinner + one-word status +
// separate "ready" row + separate error line + separate pending-skill chips
// that used to live around the generation buttons. One or more `sections`
// (one per in-flight or finished action — e.g. Résumé, Cover Letter) are
// rendered as a small log; a section still running gets a blinking cursor on
// its last line so a 40-90s generation visibly looks alive without trying to
// mirror the pipeline's internals — just short status lines.
//
// section: {
//   id, title,
//   tone: 'running' | 'ok' | 'err',
//   lines: [{ text?, node?, tone?: 'dim'|'ok'|'err' }],
// }
export default function ProgressConsole({ sections, emptyHint }) {
  const bodyRef = useRef(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sections]);

  const list = sections || [];

  return (
    <div className="console-panel">
      <div className="console-body" ref={bodyRef}>
        {list.length === 0 ? (
          <div className="console-empty">{emptyHint || 'No activity yet.'}</div>
        ) : (
          list.map((s) => (
            <div className="console-section" key={s.id}>
              <div className={`console-section-title console-${s.tone}`}>
                {s.tone === 'running' ? '›' : s.tone === 'err' ? '✗' : '✓'} {s.title}
              </div>
              {(s.lines || []).map((line, i) => {
                const isLast = i === (s.lines.length - 1);
                const active = s.tone === 'running' && isLast;
                return (
                  <div
                    key={i}
                    className={`console-line console-line-${active ? 'active' : line.tone || 'done'}`}
                  >
                    <span className="console-line-marker">{active ? '›' : line.tone === 'err' ? '✗' : '✓'}</span>
                    <span className="console-line-text">
                      {line.node || line.text}
                      {active && <span className="console-cursor" />}
                    </span>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

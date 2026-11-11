// The Quick read (spec 4.7) — the deterministic, no-AI hint on a job that has
// not been scored yet. A pill, not a number and not a verdict stamp: it helps
// pick what is worth scoring and never stands in for a score. Server:
// apps/server/src/scan/triage.js.

const BANDS = {
  strong: { label: 'Strong match', cls: 'qr-strong' },
  possible: { label: 'Possible', cls: 'qr-possible' },
  long_shot: { label: 'Long shot', cls: 'qr-long' },
  below_threshold: { label: 'Can’t reach your minimum', cls: 'qr-below' },
};

export function quickReadBand(triage) {
  return (triage && BANDS[triage.band]) || null;
}

export function QuickReadChip({ triage }) {
  const band = quickReadBand(triage);
  if (!band) return null;
  const label = triage.band === 'below_threshold' && triage.ceiling != null ? `Tops out at ${triage.ceiling}` : band.label;
  return (
    <span className={`risk-tag quick-read-chip ${band.cls}`} title="Quick read — a match estimate from your résumé, not a score">
      {label}
    </span>
  );
}

// Reason lines, most useful first: a ceiling reason explains a "tops out" chip,
// then résumé-term overlap, then title fit.
export function QuickReadSignals({ triage, max = 2 }) {
  if (!triage || !Array.isArray(triage.signals) || !triage.signals.length) return null;
  const order = { ceiling: 0, terms: 1, title: 2, senior: 3 };
  const lines = [...triage.signals].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9)).slice(0, max);
  return (
    <div className="quick-read-signals">
      {lines.map((s) => (
        <div key={s.kind} className={`qr-signal qr-signal-${s.tone || 'neutral'}`}>
          {s.text}
        </div>
      ))}
    </div>
  );
}

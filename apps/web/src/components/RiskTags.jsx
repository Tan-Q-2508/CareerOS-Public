import { riskLevelClass } from '../lib/display';

// risk_tags (5.4) come from the model (scoring/fitCall.js) as objects shaped
// { type, severity, reason }. Also tolerate older/alt shapes and plain strings.
function normalize(tag) {
  if (typeof tag === 'string') {
    const [cat, lvl] = tag.split(':').map((s) => s.trim());
    return { label: cat || tag, level: lvl || 'none', reason: '' };
  }
  if (tag && typeof tag === 'object') {
    return {
      label: tag.type || tag.category || tag.label || tag.name || 'Risk',
      level: tag.severity || tag.level || 'none',
      reason: tag.reason || '',
    };
  }
  return { label: String(tag), level: 'none', reason: '' };
}

function cap(s) {
  const str = String(s || '');
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export default function RiskTags({ tags }) {
  const list = Array.isArray(tags) ? tags.map(normalize) : [];
  if (!list.length) return null;
  return (
    <div className="tags-row">
      {list.map((t, i) => (
        <span className="risk-tag" key={i} title={t.reason || undefined}>
          <span className={`dot ${riskLevelClass(t.level)}`} />
          {cap(t.label)}: {String(t.level).toLowerCase()}
        </span>
      ))}
    </div>
  );
}

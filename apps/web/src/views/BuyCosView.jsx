import { useNavigate } from 'react-router-dom';
import { useMe } from '../context/MeContext';

// Visually complete, fully disabled (spec 0.1 / 15#7). Phase 2 (Stripe) wires the
// real purchase flow. Bundles are illustrative; nothing here charges anything.
const BUNDLES = [
  { cos: 100, price: '$5', note: 'Starter' },
  { cos: 250, price: '$10', note: 'Most popular', highlight: true },
  { cos: 600, price: '$20', note: 'Best value' },
];

const PRICING = [
  ['BYO Scraper scan', '5 COS + measured AI usage'],
  ['Core Scraper scan', '1 COS + measured AI usage'],
  ['Résumé generation', '5 COS + measured AI usage'],
  ['Cover letter generation', '5 COS + measured AI usage'],
  ['Email status check', '5 COS + measured AI usage'],
  ['Manual job entry', '5 COS + measured AI usage'],
];

export default function BuyCosView() {
  const navigate = useNavigate();
  const { me } = useMe();
  const balance = me?.user?.cos_balance;

  return (
    <div>
      <div className="view-header">
        <div>
          <div className="view-title">Buy COS</div>
          <div className="view-sub">
            Current balance: {balance == null ? '—' : Math.round(balance)} COS
          </div>
        </div>
        <button className="btn btn-ghost" onClick={() => navigate('/settings')}>
          ← Settings
        </button>
      </div>

      <div className="empty-state" style={{ borderStyle: 'solid', marginBottom: 20 }}>
        Purchasing isn&apos;t open yet. In Phase 1, COS is admin-granted. This screen is the
        full experience Phase 2 will switch on.
      </div>

      <div className="settings-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {BUNDLES.map((b) => (
          <div
            className="setting-card"
            key={b.cos}
            style={b.highlight ? { borderColor: 'var(--accent)' } : undefined}
          >
            <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: 26 }}>{b.cos} COS</h3>
            <p style={{ marginBottom: 8 }}>
              {b.price} · {b.note}
            </p>
            <button className="btn btn-primary disabled" disabled title="Purchasing isn't open yet">
              Purchase
            </button>
          </div>
        ))}
      </div>

      <div className="setting-card" style={{ marginTop: 20 }}>
        <h3>What each action costs</h3>
        <p>
          Phase 1 logs these unbilled for price calibration. &ldquo;Measured AI usage&rdquo; is the
          real token cost × margin, added on top of the flat fee.
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {PRICING.map(([action, cost]) => (
              <tr key={action} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ padding: '8px 0' }}>{action}</td>
                <td style={{ padding: '8px 0', color: 'var(--text-dim)', textAlign: 'right' }}>
                  {cost}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import Spinner from './Spinner';

// COS ledger history (spec 13.4's "optional expandable breakdown") — a small
// popover near the balance display listing recent transactions (feature +
// amount + date), each expandable via "+" to its flat/sourcing/AI cost
// breakdown. Mirrors NotificationsBell's popover pattern (click-outside
// catcher, position:absolute anchored to the trigger).
function fmtAmount(n) {
  const num = Number(n) || 0;
  return num.toFixed(num % 1 === 0 ? 0 : 2);
}

function TransactionRow({ t }) {
  const [open, setOpen] = useState(false);
  const isCredit = t.credit_amount != null && Number(t.credit_amount) > 0;
  const amount = isCredit ? Number(t.credit_amount) : Number(t.total_cost) || 0;

  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '8px 6px', fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{t.label}</div>
          {t.context && (
            <div style={{ fontSize: 10.5, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.context}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span
            style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: isCredit ? 'var(--ok, #4caf7d)' : 'var(--text)' }}
          >
            {isCredit ? '+' : '-'}{fmtAmount(amount)}
          </span>
          <button
            className="link-btn"
            style={{ fontSize: 11, padding: '0 2px' }}
            onClick={() => setOpen((o) => !o)}
            title="Show breakdown"
          >
            {open ? '−' : '+'}
          </button>
        </div>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>
        {new Date(t.created_at).toLocaleString()}
      </div>
      {open && (
        <div style={{ marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--line)', fontSize: 11 }}>
          {isCredit ? (
            <div>Credited: {fmtAmount(t.credit_amount)} COS</div>
          ) : (
            <>
              <div>Flat fee: {fmtAmount(t.flat_fee)} COS</div>
              {t.sourcing_cost != null && <div>Sourcing cost: {fmtAmount(t.sourcing_cost)} COS</div>}
              {t.ai_cost != null && <div>AI cost: {fmtAmount(t.ai_cost)} COS</div>}
              <div style={{ fontWeight: 600, marginTop: 2 }}>Total: {fmtAmount(t.total_cost)} COS</div>
            </>
          )}
          {t.note && <div style={{ marginTop: 4, color: 'var(--text-dim)', fontStyle: 'italic' }}>{t.note}</div>}
        </div>
      )}
    </div>
  );
}

export default function CosHistoryPopover() {
  const [open, setOpen] = useState(false);
  const [transactions, setTransactions] = useState(null);
  const [error, setError] = useState(null);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);

  const load = useCallback(() => {
    setError(null);
    api
      .listCosTransactions(30)
      .then(({ transactions }) => setTransactions(transactions || []))
      .catch((e) => setError(e.message));
  }, []);

  // Position is computed from the trigger's real viewport coordinates and the
  // panel is portaled to <body> (2026-07-27 fix) — it used to be
  // position:absolute inside the sidebar (bottom:100%, right:0), which the
  // sidebar's own bounds clipped whenever the trigger sat too close to the
  // top of a short viewport. Flips to open downward, and shrinks its own
  // max-height, whenever there isn't enough room in the preferred direction.
  const computePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = 300;
    const preferredMax = 360;
    const margin = 8;
    const spaceAbove = rect.top - margin;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const openUp = spaceAbove >= spaceBelow;
    const maxHeight = Math.max(160, Math.min(preferredMax, openUp ? spaceAbove : spaceBelow));
    const top = openUp ? Math.max(margin, rect.top - maxHeight - margin) : rect.bottom + margin;
    const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin);
    setPos({ top, left, maxHeight });
  }, []);

  function toggle() {
    setOpen((o) => {
      const next = !o;
      if (next) {
        computePosition();
        // Refetch on every open (2026-08-15 fix), not just the first —
        // otherwise a scan that bills more COS while this panel sat open
        // once before shows stale/missing rows on every later look.
        load();
      }
      return next;
    });
  }

  // Keep the panel correctly placed if the window resizes or the page
  // scrolls while it's open.
  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('resize', computePosition);
    window.addEventListener('scroll', computePosition, true);
    return () => {
      window.removeEventListener('resize', computePosition);
      window.removeEventListener('scroll', computePosition, true);
    };
  }, [open, computePosition]);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggle}
        className="link-btn"
        style={{ fontSize: 10.5, padding: 0 }}
        title="COS transaction history"
      >
        History
      </button>

      {open && pos && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: 300,
              maxHeight: pos.maxHeight,
              overflowY: 'auto',
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              borderRadius: 4,
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
              zIndex: 21,
              padding: 8,
            }}
          >
            <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)', padding: '2px 6px 6px' }}>
              COS Transaction History
            </div>
            {error && <div style={{ fontSize: 12, color: 'var(--danger)', padding: 8 }}>{error}</div>}
            {!error && transactions === null && (
              <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: 8 }}>
                <Spinner /> &nbsp;Loading…
              </div>
            )}
            {!error && transactions && transactions.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: 8 }}>No transactions yet.</div>
            )}
            {!error && transactions && transactions.map((t) => <TransactionRow key={t.id} t={t} />)}
          </div>
        </>,
        document.body
      )}
    </>
  );
}

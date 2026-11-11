import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';

// In-app notifications (spec §12.5) — scheduler skip/pause/failure alerts.
// Polls every 60s (a bell doesn't need scan-poll cadence) and shows a small
// dropdown list on click; each unread row can be marked read.
//
// Position is computed from the trigger's real viewport coordinates and the
// panel is portaled to <body> (mirrors CosHistoryPopover's 2026-07-27 fix) —
// it used to be position:absolute inside the sidebar (bottom:100%, left:0),
// which the sidebar's own overflow bounds clipped horizontally, and long
// unbroken message text (e.g. a job-board URL) overflowed the fixed-width
// box uncontained.
export default function NotificationsBell() {
  const [notifications, setNotifications] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const pollRef = useRef(null);
  const triggerRef = useRef(null);

  const load = useCallback(() => {
    api
      .listNotifications()
      .then(({ notifications, unread_count }) => {
        setNotifications(notifications);
        setUnread(unread_count);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    function tick() {
      load();
      pollRef.current = setTimeout(tick, 60000);
    }
    pollRef.current = setTimeout(tick, 60000);
    return () => clearTimeout(pollRef.current);
  }, [load]);

  const computePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = 300;
    const preferredMax = 320;
    const margin = 8;
    const spaceAbove = rect.top - margin;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const openUp = spaceAbove >= spaceBelow;
    const maxHeight = Math.max(160, Math.min(preferredMax, openUp ? spaceAbove : spaceBelow));
    const top = openUp ? Math.max(margin, rect.top - maxHeight - margin) : rect.bottom + margin;
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
    setPos({ top, left, maxHeight });
  }, []);

  function toggle() {
    setOpen((o) => {
      const next = !o;
      if (next) computePosition();
      return next;
    });
  }

  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('resize', computePosition);
    window.addEventListener('scroll', computePosition, true);
    return () => {
      window.removeEventListener('resize', computePosition);
      window.removeEventListener('scroll', computePosition, true);
    };
  }, [open, computePosition]);

  async function markRead(id) {
    setNotifications((cur) => cur.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnread((u) => Math.max(0, u - 1));
    try {
      await api.markNotificationRead(id);
    } catch {
      load();
    }
  }

  async function markAllRead() {
    setNotifications((cur) => cur.map((n) => ({ ...n, read: true })));
    setUnread(0);
    try {
      await api.markAllNotificationsRead();
    } catch {
      load();
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        onClick={toggle}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          padding: '6px 0',
          color: 'var(--text)',
        }}
      >
        <span>🔔 Notifications</span>
        {unread > 0 && <span className="badge-pending">{unread}</span>}
      </button>

      {open && pos && createPortal(
        <>
          {/* Click-outside catcher */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: 300,
              maxHeight: pos.maxHeight,
              overflowY: 'auto',
              overflowX: 'hidden',
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              borderRadius: 4,
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
              zIndex: 21,
              padding: 8,
            }}
          >
            {notifications.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: 8 }}>No notifications yet.</div>
            ) : (
              <>
                {unread > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 6px 6px' }}>
                    <button className="link-btn" style={{ fontSize: 10.5 }} onClick={markAllRead}>
                      Mark all read
                    </button>
                  </div>
                )}
                {notifications.map((n) => (
                  <div
                    key={n.id}
                    style={{
                      padding: '8px 6px',
                      borderTop: '1px solid var(--line)',
                      fontSize: 12,
                      opacity: n.read ? 0.6 : 1,
                    }}
                  >
                    <div style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}>{n.message}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                      <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                        {new Date(n.created_at).toLocaleString()}
                      </span>
                      {!n.read && (
                        <button className="link-btn" style={{ fontSize: 10.5 }} onClick={() => markRead(n.id)}>
                          Mark read
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

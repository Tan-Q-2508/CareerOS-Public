import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useMe } from '../context/MeContext';
import Spinner from './Spinner';
import NotificationsBell from './NotificationsBell';
import CosHistoryPopover from './CosHistoryPopover';
import { formatCosBalance } from '../lib/display';

const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/manual', label: 'Manual Entry' },
  { to: '/tracker', label: 'Tracker' },
  { to: '/settings', label: 'Settings' },
];

export default function Sidebar() {
  const { me, loading } = useMe();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // A real 0 renders as "0" (this account simply hasn't been granted COS — Phase 1
  // balances are admin-granted). While /api/me is still in flight (Render free-tier
  // cold starts can make this slow) show a spinner rather than a stray placeholder.
  const isActive = (to) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  return (
    <aside className="sidebar">
      <div className="wordmark">
        Career<span>OS</span>
      </div>

      <nav className="nav">
        {NAV.map((item) => (
          <button
            key={item.to}
            className={isActive(item.to) ? 'active' : ''}
            onClick={() => navigate(item.to)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <NotificationsBell />

        <div className="cos-box">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="cos-label" style={{ marginBottom: 0 }}>COS Balance</div>
            <CosHistoryPopover />
          </div>
          <div className="cos-amount">
            {loading && !me ? <Spinner /> : formatCosBalance(me?.user?.cos_balance)}
          </div>
          <button
            className="cos-buy disabled"
            title="Purchasing isn't open yet"
            onClick={() => navigate('/buy-cos')}
          >
            Buy COS
          </button>
          <div className="disabled-note">Purchasing isn't open yet</div>
        </div>

        <div className="user-line">
          <span>{user?.email}</span>
          <button onClick={() => signOut()}>Sign out</button>
        </div>
      </div>
    </aside>
  );
}

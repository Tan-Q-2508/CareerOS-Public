import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';

const MeContext = createContext(null);

// Holds GET /api/me (user row incl. cos_balance + pre-filter profile, and
// has_active_resume). Refreshable so the sidebar balance / onboarding gate stay
// current after a scan, upload, or profile edit.
export function MeProvider({ children }) {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.me();
      setMe(data);
      setError(null);
      return data;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  // C1 (bug #7): the balance previously only updated on mount or after a
  // specific action explicitly called refreshMe — an admin grant, background
  // scan billing, or another tab's activity never appeared until a full
  // reload. A light interval poll plus a refresh-on-focus listener close that
  // gap while keeping every existing post-action refreshMe() call intact for
  // immediate feedback.
  useEffect(() => {
    const POLL_MS = 60000;
    const interval = setInterval(() => {
      refresh().catch(() => {});
    }, POLL_MS);
    const onFocus = () => {
      refresh().catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return (
    <MeContext.Provider value={{ me, loading, error, refresh }}>{children}</MeContext.Provider>
  );
}

export function useMe() {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error('useMe must be used within MeProvider');
  return ctx;
}

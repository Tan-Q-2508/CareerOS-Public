import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { api } from '../lib/api';

const AuthContext = createContext(null);

// Gmail (spec §9.1) + Drive (spec §11.3) integrations. Login stays minimal-scope;
// connecting either is a separate opt-in OAuth grant so Google returns a refresh
// token. Both features share ONE grant (googleOAuth.js stores one row per user),
// so every connect request asks for the UNION of scopes — connecting from either
// the Gmail or the Drive entry point grants both. We flag the flow (which entry
// point, so we know which endpoint to POST to) in sessionStorage right before the
// redirect so the post-redirect handler knows to capture provider_refresh_token
// (present only on that grant) and hand it to the server — normal logins never
// set the flag, so their tokens are ignored.
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GOOGLE_SCOPES = `${GMAIL_SCOPE} ${DRIVE_SCOPE}`;
const GOOGLE_CONNECT_FLAG = 'careeros_google_connect';

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      // Capture the one-time refresh token immediately after the connect grant
      // returns, then clear the flag so it runs exactly once. Which endpoint we
      // POST to doesn't change what gets stored (one shared row) — it's kept
      // aligned with the entry point the user actually clicked for clearer logs.
      const kind = sessionStorage.getItem(GOOGLE_CONNECT_FLAG);
      if (s?.provider_refresh_token && kind) {
        sessionStorage.removeItem(GOOGLE_CONNECT_FLAG);
        const connect = kind === 'drive' ? api.connectDrive : api.connectGmail;
        connect({
          refresh_token: s.provider_refresh_token,
          google_email: s.user?.email,
          scopes: GOOGLE_SCOPES,
        }).catch((e) => console.error('Google connect failed:', e.message));
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signInWithGoogle = useCallback(
    () =>
      supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      }),
    []
  );
  const signOut = useCallback(() => supabase.auth.signOut(), []);

  // Opt-in Gmail/Drive connect: re-run Google consent asking for the UNION of
  // scopes both features need, so either entry point grants both. redirectTo
  // brings the user back to where they started, where the post-redirect handler
  // above stores the captured refresh token.
  const connectGoogle = useCallback(
    (kind, redirectTo) => {
      sessionStorage.setItem(GOOGLE_CONNECT_FLAG, kind);
      return supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          scopes: GOOGLE_SCOPES,
          redirectTo: redirectTo || `${window.location.origin}/tracker`,
          queryParams: { access_type: 'offline', prompt: 'consent' },
        },
      });
    },
    []
  );
  const connectGmail = useCallback((redirectTo) => connectGoogle('gmail', redirectTo), [connectGoogle]);
  const connectDrive = useCallback((redirectTo) => connectGoogle('drive', redirectTo), [connectGoogle]);

  const value = { session, user: session?.user || null, loading, signInWithGoogle, signOut, connectGmail, connectDrive };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
